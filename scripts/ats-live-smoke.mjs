#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { careerAtsForUrl } from "../server/career-ats.ts";
import { CHROMIUM_EGRESS_FLAGS, PinnedBrowserProxy, resolveBrowserAddresses } from "../server/career-egress-proxy.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(projectRoot, ".playwright-browsers");
const { chromium } = await import("playwright");

export const DEFAULT_TIMEOUT_MS = 15000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 60000;
export const MAX_TARGETS = 20;
const OMIT_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "cookie2", "referer"]);

function stripHash(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

export function validateAtsUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) return { ok: false, reason: "invalid_url" };
  let url;
  try { url = new URL(value.trim()); } catch { return { ok: false, reason: "invalid_url" }; }
  if (url.protocol !== "https:") return { ok: false, reason: "https_required" };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  if (url.port) return { ok: false, reason: "custom_port_not_allowed" };
  if (url.search) return { ok: false, reason: "query_not_allowed" };
  const ats = careerAtsForUrl(url.href);
  if (!ats) return { ok: false, reason: "unsupported_ats_host" };
  url.hash = "";
  return { ok: true, target: { url: url.href, origin: url.origin, host: url.hostname.toLowerCase(), ats } };
}

function sameTenant(from, to, ats) {
  if (from.origin === to.origin) return true;
  if (ats === "greenhouse" || ats === "lever") {
    const a = from.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    const b = to.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    return Boolean(a && a === b);
  }
  if (ats === "recruitee") {
    const tenant = url => url.hostname.match(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.s)?\.recruitee\.com$/i)?.[1]?.toLowerCase();
    return Boolean(tenant(from) && tenant(from) === tenant(to));
  }
  return false;
}

export function allowsReadOnlyRequest({ target, url, method, resourceType, isNavigationRequest = false, isInitialNavigation = false, isRedirect = false, fromUrl = target.url }) {
  if (String(method).toUpperCase() !== "GET") return false;
  let from, to;
  try { from = new URL(fromUrl); to = new URL(url); } catch { return false; }
  if (to.protocol !== "https:" || to.port || to.username || to.password) return false;
  if (isNavigationRequest && !isInitialNavigation && !isRedirect) return false;
  if (isInitialNavigation) return to.origin === target.origin && stripHash(to.href) === target.url;
  if (to.origin === from.origin) return true;
  if (target.ats === "greenhouse" && to.hostname.toLowerCase() === "static.greenhouse.io") {
    return !to.search
      && /^\/assets\/[A-Za-z0-9_./-]+\.(?:css|woff2?|ttf|otf)$/i.test(to.pathname)
      && (resourceType === "stylesheet" || resourceType === "font");
  }
  return careerAtsForUrl(to.href) === target.ats && sameTenant(from, to, target.ats);
}

export function stripSensitiveHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([name]) => !OMIT_HEADERS.has(name.toLowerCase())));
}

export function createSmokeEgressResolver(initialHosts, resolveAddresses = resolveBrowserAddresses) {
  const allowedHosts = new Set(initialHosts.map(host => String(host).toLowerCase().replace(/\.$/, "")));
  return {
    allow: hostname => allowedHosts.add(String(hostname).toLowerCase().replace(/\.$/, "")),
    resolve: async hostname => {
      const normalized = String(hostname).toLowerCase().replace(/\.$/, "");
      if (!allowedHosts.has(normalized)) throw new Error("egress_host_not_allowed");
      return resolveAddresses(hostname);
    },
  };
}

export function classifyPageSignals({ captcha = false, login = false, httpStatus = null } = {}) {
  if (captcha) return "captcha";
  if (login || httpStatus === 401 || httpStatus === 403) return "login";
  if (httpStatus === null || httpStatus < 200 || httpStatus >= 400) return "inaccessible";
  return "accessible";
}

async function inspectSignals(page) {
  return page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const headings = Array.from(document.querySelectorAll("h1, h2, [role='alert']"))
      .map(element => element.innerText || element.textContent || "").join(" ").toLowerCase();
    const challengeElement = document.querySelector(
      "iframe[src*='captcha' i], iframe[src*='challenge' i], [id*='captcha' i], [class*='captcha' i], [data-sitekey]",
    );
    const passwordPrompt = Array.from(document.querySelectorAll("input[type='password']")).some(visible);
    const applyLinkVisible = Array.from(document.querySelectorAll("a[href]")).some(anchor => {
      if (!visible(anchor)) return false;
      const label = (anchor.innerText || "") + " " + (anchor.getAttribute("aria-label") || "") + " " + (anchor.title || "");
      return /\b(apply|apply now|apply for this job|postuler|candidater|postulez|i['’]?m interested|interested in this job)\b/i.test(label);
    });
    const applicationFormVisible = Array.from(document.querySelectorAll("form")).some(form =>
      visible(form) && Array.from(form.querySelectorAll("input, select, textarea")).some(visible),
    );
    return {
      captcha: Boolean(challengeElement) || /verify (that )?you are (human|not a robot)|are you a robot|security challenge|captcha|recaptcha|hcaptcha/i.test(headings),
      login: passwordPrompt || /sign in to continue|log in to continue|please sign in|please log in|connectez-vous pour postuler|identifiez-vous pour postuler/i.test(headings),
      applyLinkVisible,
      applicationFormVisible,
    };
  });
}

export async function installReadOnlyGuards(context, target, allowEgressHost = () => {}) {
  if (typeof context.routeWebSocket !== "function") throw new Error("websocket_routing_unavailable");
  const counters = { blockedRequests: 0, blockedWebSockets: 0 };
  let initialNavigationSeen = false;
  await context.route("**/*", async route => {
    const request = route.request();
    const redirectedFrom = request.redirectedFrom();
    const requestUrl = request.url();
    const isNavigationRequest = request.isNavigationRequest();
    let isInitialNavigation = false;
    if (isNavigationRequest && !redirectedFrom && !initialNavigationSeen && stripHash(requestUrl) === target.url) {
      isInitialNavigation = true;
      initialNavigationSeen = true;
    }
    let fromUrl = target.url;
    try {
      const frameUrl = request.frame().url();
      if (frameUrl && frameUrl !== "about:blank") fromUrl = frameUrl;
    } catch { /* Requests without an attached frame use the supplied ATS URL. */ }

    const allowed = allowsReadOnlyRequest({
      target, url: requestUrl, method: request.method(), resourceType: request.resourceType(),
      isNavigationRequest, isInitialNavigation, isRedirect: Boolean(redirectedFrom), fromUrl,
    });
    if (!allowed) {
      counters.blockedRequests++;
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    allowEgressHost(new URL(requestUrl).hostname);
    try {
      await route.continue({ headers: stripSensitiveHeaders(await request.allHeaders()) });
    } catch {
      counters.blockedRequests++;
      await route.abort("blockedbyclient").catch(() => {});
    }
  });
  await context.routeWebSocket("**/*", webSocketRoute => {
    counters.blockedWebSockets++;
    webSocketRoute.close(1008, "Read-only smoke test");
  });
  return counters;
}

async function inspectTarget(browser, target, index, timeoutMs, allowEgressHost) {
  const startedAt = Date.now();
  let context;
  let guardCounters;
  let httpStatus = null;
  try {
    context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, permissions: [], viewport: { width: 1100, height: 760 } });
    context.setDefaultTimeout(timeoutMs);
    context.setDefaultNavigationTimeout(timeoutMs);
    guardCounters = await installReadOnlyGuards(context, target, allowEgressHost);
    const page = await context.newPage();
    page.on("popup", popup => { void popup.close().catch(() => {}); });
    let response;
    try {
      response = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      httpStatus = response?.status() ?? null;
      await page.waitForTimeout(Math.min(500, Math.floor(timeoutMs / 10)));
    } catch (error) {
      return {
        index, ats: target.ats, host: target.host, status: "inaccessible",
        issue: error?.name === "TimeoutError" ? "timeout" : "navigation_failed",
        httpStatus, blockedRequests: guardCounters.blockedRequests,
        blockedWebSockets: guardCounters.blockedWebSockets, durationMs: Date.now() - startedAt,
      };
    }
    let signals;
    try { signals = await inspectSignals(page); } catch { signals = null; }
    const status = classifyPageSignals({ captcha: signals?.captcha, login: signals?.login, httpStatus });
    return {
      index, ats: target.ats, host: target.host, status,
      ...(status === "inaccessible" ? { issue: httpStatus === null ? "no_response" : "http_error" } : {}),
      httpStatus,
      ...(signals ? { applyLinkVisible: signals.applyLinkVisible, applicationFormVisible: signals.applicationFormVisible } : {}),
      blockedRequests: guardCounters.blockedRequests,
      blockedWebSockets: guardCounters.blockedWebSockets, durationMs: Date.now() - startedAt,
    };
  } catch {
    return {
      index, ats: target.ats, host: target.host, status: "inaccessible", issue: "read_only_guard_unavailable",
      httpStatus, blockedRequests: guardCounters?.blockedRequests ?? 0,
      blockedWebSockets: guardCounters?.blockedWebSockets ?? 0, durationMs: Date.now() - startedAt,
    };
  } finally { await context?.close().catch(() => {}); }
}

export async function runAtsLiveSmoke(rawUrls, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  browserType = chromium,
  proxyFactory = resolveAddresses => new PinnedBrowserProxy({ resolveAddresses }),
} = {}) {
  const checkedAt = new Date().toISOString();
  const results = rawUrls.map((rawUrl, index) => {
    const validation = validateAtsUrl(rawUrl);
    return validation.ok
      ? { index, target: validation.target, result: null }
      : { index, target: null, result: { index, ats: null, host: null, status: "rejected", issue: validation.reason } };
  });

  const pending = results.filter(item => item.target && !item.result);
  if (pending.length) {
    let browser;
    let proxy;
    const egress = createSmokeEgressResolver(pending.map(item => item.target.host));
    try {
      proxy = proxyFactory(egress.resolve);
      const proxyServer = await proxy.listen();
      browser = await browserType.launch({
        headless: true,
        timeout: timeoutMs,
        proxy: { server: proxyServer, bypass: "<-loopback>" },
        args: [...CHROMIUM_EGRESS_FLAGS],
      });
    }
    catch {
      for (const item of pending) item.result = {
        index: item.index, ats: item.target.ats, host: item.target.host, status: "inaccessible", issue: "browser_unavailable",
      };
    }
    if (browser) {
      try {
        for (const item of pending) {
          item.result = await inspectTarget(browser, item.target, item.index, timeoutMs, egress.allow);
        }
      } finally {
        await browser.close().catch(() => {});
        await proxy?.close().catch(() => {});
      }
    } else await proxy?.close().catch(() => {});
  }
  return { schemaVersion: 1, mode: "read-only", checkedAt, results: results.map(item => item.result) };
}

export function parseCliArgs(argv) {
  const args = [...argv];
  if (args[0] === "--") args.shift();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const urls = [];
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    let timeoutValue;
    if (arg === "--timeout-ms") {
      timeoutValue = args[++index];
      if (timeoutValue === undefined) return { error: "missing_timeout_value" };
    } else if (arg.startsWith("--timeout-ms=")) {
      timeoutValue = arg.slice("--timeout-ms=".length);
    } else if (arg.startsWith("-")) return { error: "unknown_option" };
    else { urls.push(arg); continue; }
    if (!/^\d+$/.test(timeoutValue)) return { error: "invalid_timeout" };
    timeoutMs = Number(timeoutValue);
    if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) return { error: "timeout_out_of_range" };
  }
  if (help) return { help: true, timeoutMs, urls };
  if (!urls.length) return { error: "at_least_one_url_required" };
  if (urls.length > MAX_TARGETS) return { error: "too_many_urls" };
  return { help: false, timeoutMs, urls };
}

function usage() {
  return [
    "Usage: pnpm ats:live-smoke -- <ATS-URL> [<ATS-URL> ...] [--timeout-ms 15000]",
    "Accepte uniquement HTTPS et les hôtes ATS publics reconnus.",
    "Lecture seule : aucun profil, compte, CV, saisie, clic Apply ou soumission.",
    "Rapport JSON minimal sans URL complète, HTML ou valeur de champ.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), output = process.stdout, errorOutput = process.stderr) {
  const parsed = parseCliArgs(argv);
  if (parsed.error) {
    errorOutput.write(usage() + "\nErreur: " + parsed.error + "\n");
    return 2;
  }
  if (parsed.help) { output.write(usage() + "\n"); return 0; }
  output.write(JSON.stringify(await runAtsLiveSmoke(parsed.urls, { timeoutMs: parsed.timeoutMs }), null, 2) + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
