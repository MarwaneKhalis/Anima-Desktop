import type { Page } from "playwright";

export type CareerAts = "greenhouse" | "lever" | "ashby" | "recruitee" | "workable" | "smartrecruiters" | "teamtailor" | "workday";
export type ResourceKind = "document" | "stylesheet" | "image" | "media" | "font" | "script" | "texttrack" | "xhr" | "fetch" | "eventsource" | "websocket" | "manifest" | "other";

const GREENHOUSE_PAGES = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io", "boards.eu.greenhouse.io"]);
const LEVER_PAGES = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);
const ASHBY_PAGES = new Set(["jobs.ashbyhq.com"]);
const GREENHOUSE_STATIC = new Set(["static.greenhouse.io"]);
const SMARTRECRUITERS_PAGES = new Set(["jobs.smartrecruiters.com", "careers.smartrecruiters.com"]);
const TEAMTAILOR_TENANT = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.teamtailor\.com$/;
const WORKDAY_TENANT = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.wd\d+\.myworkdayjobs\.com$/;
const RECRUITEE_TENANT = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.s)?\.recruitee\.com$/;
const WORKABLE_ACCOUNT = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.workable\.com$/;

export function careerAtsForHostname(hostname: string): CareerAts | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (SMARTRECRUITERS_PAGES.has(host)) return "smartrecruiters";
  if (TEAMTAILOR_TENANT.test(host)) return "teamtailor";
  if (WORKDAY_TENANT.test(host)) return "workday";
  if (GREENHOUSE_PAGES.has(host)) return "greenhouse";
  if (LEVER_PAGES.has(host)) return "lever";
  if (ASHBY_PAGES.has(host)) return "ashby";
  const recruiteeTenant = RECRUITEE_TENANT.exec(host)?.[1];
  if (recruiteeTenant && recruiteeTenant !== "s") return "recruitee";
  if (host === "apply.workable.com" || WORKABLE_ACCOUNT.test(host)) return "workable";
  return null;
}

/** Only the named public job-board hosts are form destinations. Never infer vendor trust from a suffix. */
export function careerAtsForUrl(value: string): CareerAts | null {
  try { return careerAtsForHostname(new URL(value).hostname); } catch { return null; }
}

/** A cross-origin document is accepted only for an exact explicit Apply target, or a
 * public ATS redirect within the same vendor family. Redirects to ordinary domains fail closed. */
export function allowsCareerAtsNavigation(input: {
  from: string; to: string; pendingAtsOrigin?: string; initialNavigation: boolean;
  redirected: boolean; remoteOkApplyRedirect?: boolean; testOrigins: ReadonlySet<string>;
}): boolean {
  let from: URL; let to: URL;
  try { from = new URL(input.from); to = new URL(input.to); } catch { return false; }
  const toAts = careerAtsForUrl(to.href);
  if (input.remoteOkApplyRedirect && input.redirected
    && ((to.protocol === "https:" && toAts !== null) || input.testOrigins.has(to.origin))) return true;
  // A test fixture may model a visible cross-origin Apply link, but it must still
  // be selected explicitly as the pending destination before navigation is allowed.
  if (input.testOrigins.has(to.origin)) return input.pendingAtsOrigin === to.origin
    || (input.initialNavigation && input.redirected);
  if (to.protocol !== "https:") return false;
  const fromAts = careerAtsForUrl(from.href);
  if (!toAts) return false;
  if ((fromAts === "smartrecruiters" || fromAts === "teamtailor" || fromAts === "workday") && toAts === fromAts && from.origin !== to.origin
    && (input.redirected || input.pendingAtsOrigin !== to.origin)) return false;
  return input.pendingAtsOrigin === to.origin
    || (input.initialNavigation && input.redirected && (!fromAts || fromAts === toAts))
    || (input.redirected && fromAts !== null && fromAts === toAts);
}

/** Permit cross-origin bytes only for explicitly enumerated, passive vendor assets. */
export function allowsCareerAtsResource(input: {
  from: string; to: string; method: string; kind: ResourceKind;
}): boolean {
  let from: URL; let to: URL;
  try { from = new URL(input.from); to = new URL(input.to); } catch { return false; }
  if (to.protocol !== "https:" || input.method.toUpperCase() !== "GET") return false;
  const ats = careerAtsForUrl(from.href);
  if ((ats === "workable" || ats === "smartrecruiters" || ats === "teamtailor" || ats === "workday") && from.origin !== to.origin) return false;
  if (!ats || careerAtsForUrl(to.href) !== ats) {
    if (ats !== "greenhouse" || !GREENHOUSE_STATIC.has(to.hostname.toLowerCase())) return false;
    // Static Greenhouse is only for stylesheet/font bytes, never scripts, pixels, or data.
    // Query strings and non-assets are denied so it cannot be used as a beacon endpoint.
    if (to.search || !/^\/assets\/[A-Za-z0-9_./-]+\.(?:css|woff2?|ttf|otf)$/i.test(to.pathname)) return false;
    return input.kind === "stylesheet" || input.kind === "font";
  }
  // Pages and data-bearing requests are never third-party resources.
  return ["stylesheet", "image", "media", "font", "script"].includes(input.kind);
}

export type ApplyLink = { href: string; vendor: CareerAts | "test" | "remoteok"; index: number };

const REMOTE_OK_REDIRECTORS = new Set(["remoteok.com", "www.remoteok.com"]);

export function isRemoteOkApplyRedirectorUrl(value: string, testOrigins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(value);
    const remoteOk = url.protocol === "https:" && REMOTE_OK_REDIRECTORS.has(url.hostname.toLowerCase());
    return (remoteOk || testOrigins.has(url.origin)) && /^\/l\/\d+$/.test(url.pathname);
  } catch { return false; }
}

function isTeamtailorApplicationUrl(value: string, testOrigins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(value);
    return (careerAtsForUrl(url.href) === "teamtailor" || testOrigins.has(url.origin))
      && /^\/jobs\/[^/]+\/applications\/new(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

/**
 * Find one unambiguous visible Apply link. We inspect anchors only; no guessed form action,
 * hidden link, script URL, or arbitrary external redirect is followed.
 */
export async function findApplyLink(page: Page, testOrigins: ReadonlySet<string>): Promise<ApplyLink | null | "ambiguous"> {
  const links = await page.locator("a[href]").evaluateAll(nodes => nodes.flatMap((node, index) => {
    const a = node as HTMLAnchorElement;
    const text = `${a.innerText || ""} ${a.getAttribute("aria-label") || ""} ${a.title || ""}`.trim();
    const style = getComputedStyle(a);
    if (style.display === "none" || style.visibility === "hidden" || !a.getClientRects().length) return [];
    return [{ href: a.href, index, text }];
  }));
  const candidateLinks = links.filter(({ href, text }) =>
    /\b(apply|apply now|apply for this job|postuler|candidater|postulez|i['’]?m interested|interested in this job)\b/i.test(text)
    || isTeamtailorApplicationUrl(href, testOrigins));
  const candidates = [...new Map(candidateLinks.map(link => [link.href, link])).values()];
  if (candidates.length > 1) return "ambiguous";
  const allowed: ApplyLink[] = candidates.flatMap<ApplyLink>(({ href, index }) => {
    try {
      const url = new URL(href);
      if (url.protocol !== "https:" && !testOrigins.has(url.origin)) return [];
      if (isRemoteOkApplyRedirectorUrl(url.href, testOrigins)) return [{ href: url.href, vendor: "remoteok", index }];
      const vendor = careerAtsForUrl(url.href);
      if (vendor) return [{ href: url.href, vendor, index }];
      if (testOrigins.has(url.origin)) return [{ href: url.href, vendor: "test", index }];
      return [];
    } catch { return []; }
  });
  if (allowed.length > 1) return "ambiguous";
  return allowed[0] || null;
}

