import assert from "node:assert/strict";
import test from "node:test";
import { CHROMIUM_EGRESS_FLAGS } from "../server/career-egress-proxy.ts";
import {
  allowsReadOnlyRequest,
  classifyPageSignals,
  createSmokeEgressResolver,
  installReadOnlyGuards,
  parseCliArgs,
  runAtsLiveSmoke,
  stripSensitiveHeaders,
  validateAtsUrl,
} from "../scripts/ats-live-smoke.mjs";

test("ATS smoke accepts only supported public HTTPS job-board hosts", () => {
  const valid = validateAtsUrl("https://boards.greenhouse.io/acme/jobs/123");
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.target.ats, "greenhouse");
  assert.equal(valid.target.host, "boards.greenhouse.io");
  assert.equal(validateAtsUrl("http://boards.greenhouse.io/acme/jobs/123").reason, "https_required");
  assert.equal(validateAtsUrl("https://boards.greenhouse.io.evil.example/acme").reason, "unsupported_ats_host");
  assert.equal(validateAtsUrl("https://user:secret@boards.greenhouse.io/acme").reason, "credentials_in_url");
  assert.equal(validateAtsUrl("https://boards.greenhouse.io:444/acme").reason, "custom_port_not_allowed");
  assert.equal(validateAtsUrl("https://boards.greenhouse.io/acme/jobs/123?token=private").reason, "query_not_allowed");
  assert.equal(validateAtsUrl("not a URL").reason, "invalid_url");
});

test("ATS smoke strips fragments and validates CLI timeout and target count", () => {
  const valid = validateAtsUrl("https://jobs.lever.co/acme/role#private-fragment");
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.target.url, "https://jobs.lever.co/acme/role");
  assert.deepEqual(parseCliArgs(["--", "--timeout-ms", "5000", "https://jobs.lever.co/acme/role"]), {
    help: false, timeoutMs: 5000, urls: ["https://jobs.lever.co/acme/role"],
  });
  assert.equal(parseCliArgs(["--timeout-ms", "0", "https://jobs.lever.co/acme/role"]).error, "timeout_out_of_range");
  assert.equal(parseCliArgs(["--timeout-ms", "abc", "https://jobs.lever.co/acme/role"]).error, "invalid_timeout");
  assert.equal(parseCliArgs([]).error, "at_least_one_url_required");
  assert.equal(parseCliArgs(Array(21).fill("https://jobs.lever.co/acme/role")).error, "too_many_urls");
});

test("ATS smoke routes Chromium through the pinned proxy and closes it after inspection", async () => {
  const target = "https://jobs.lever.co/acme/role";
  const page = {
    on: () => {},
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
    evaluate: async () => ({ captcha: false, login: false, applyLinkVisible: false, applicationFormVisible: false }),
  };
  const context = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    route: async () => {},
    routeWebSocket: async () => {},
    newPage: async () => page,
    close: async () => {},
  };
  let launchOptions: Record<string, unknown> | undefined;
  let proxyClosed = false;
  let proxyResolver: ((hostname: string) => Promise<Array<{ address: string; family: number }>>) | undefined;
  const browserType = {
    launch: async (options: Record<string, unknown>) => {
      launchOptions = options;
      return {
        newContext: async () => context,
        close: async () => {},
      };
    },
  };
  const report = await runAtsLiveSmoke([target], {
    browserType,
    proxyFactory: resolveAddresses => {
      proxyResolver = resolveAddresses;
      return {
        listen: async () => "http://127.0.0.1:43210",
        close: async () => { proxyClosed = true; },
      };
    },
  });
  assert.equal(report.results[0].status, "accessible");
  assert.ok(launchOptions);
  assert.deepEqual(launchOptions.proxy, { server: "http://127.0.0.1:43210", bypass: "<-loopback>" });
  assert.deepEqual(launchOptions.args, [...CHROMIUM_EGRESS_FLAGS]);
  assert.equal(proxyClosed, true);
  assert.ok(proxyResolver);
  await assert.rejects(proxyResolver("browser-telemetry.example"), /egress_host_not_allowed/);

  const resolvedHosts: string[] = [];
  const egress = createSmokeEgressResolver(["jobs.lever.co"], async hostname => {
    resolvedHosts.push(hostname);
    return [{ address: "93.184.216.34", family: 4 }];
  });
  await assert.rejects(egress.resolve("analytics.example"), /egress_host_not_allowed/);
  assert.deepEqual(resolvedHosts, []);
  egress.allow("static.greenhouse.io");
  await egress.resolve("static.greenhouse.io");
  assert.deepEqual(resolvedHosts, ["static.greenhouse.io"]);

  let failedProxyClosed = false;
  const failedLaunch = await runAtsLiveSmoke([target], {
    browserType: { launch: async () => { throw new Error("sensitive browser error"); } },
    proxyFactory: () => ({
      listen: async () => "http://127.0.0.1:43212",
      close: async () => { failedProxyClosed = true; },
    }),
  });
  assert.equal(failedLaunch.results[0].status, "inaccessible");
  assert.equal(failedLaunch.results[0].issue, "browser_unavailable");
  assert.equal(JSON.stringify(failedLaunch).includes("sensitive browser error"), false);
  assert.equal(failedProxyClosed, true);
});

test("ATS smoke blocks mutations, off-provider requests and unprompted navigation", () => {
  const target = validateAtsUrl("https://boards.greenhouse.io/acme/jobs/123");
  assert.equal(target.ok, true);
  if (!target.ok) return;
  assert.equal(allowsReadOnlyRequest({
    target: target.target, url: target.target.url, method: "GET", resourceType: "document", isNavigationRequest: true, isInitialNavigation: true,
  }), true);
  assert.equal(allowsReadOnlyRequest({
    target: target.target, url: "https://boards.greenhouse.io/acme/jobs/123/apply", method: "GET", resourceType: "document", isNavigationRequest: true,
  }), false);
  assert.equal(allowsReadOnlyRequest({
    target: target.target, url: "https://boards.greenhouse.io/acme/jobs/123/apply", method: "GET", resourceType: "document", isNavigationRequest: true, isRedirect: true,
  }), true);
  assert.equal(allowsReadOnlyRequest({
    target: target.target, url: "https://boards.greenhouse.io/acme/candidates", method: "POST", resourceType: "fetch", fromUrl: target.target.url,
  }), false);
  assert.equal(allowsReadOnlyRequest({
    target: target.target, url: "https://evil.example/pixel", method: "GET", resourceType: "image", fromUrl: target.target.url,
  }), false);
  assert.equal(allowsReadOnlyRequest({
    target: target.target, url: "https://job-boards.greenhouse.io/other-company/assets/app.js", method: "GET", resourceType: "script", fromUrl: target.target.url,
  }), false);
  assert.equal(allowsReadOnlyRequest({
    target: target.target, url: "https://job-boards.greenhouse.io/acme/assets/app.js", method: "GET", resourceType: "script", fromUrl: target.target.url,
  }), true);
});

test("ATS smoke allows only inert shared Greenhouse styles and fonts", () => {
  const target = validateAtsUrl("https://boards.greenhouse.io/acme/jobs/123");
  assert.equal(target.ok, true);
  if (!target.ok) return;
  assert.equal(allowsReadOnlyRequest({
    target: target.target, url: "https://static.greenhouse.io/assets/site.css", method: "GET", resourceType: "stylesheet", fromUrl: target.target.url,
  }), true);
  assert.equal(allowsReadOnlyRequest({
    target: target.target, url: "https://static.greenhouse.io/assets/logo.svg", method: "GET", resourceType: "image", fromUrl: target.target.url,
  }), false);
  assert.equal(allowsReadOnlyRequest({
    target: target.target, url: "https://static.greenhouse.io/assets/site.css?email=user%40example.test", method: "GET", resourceType: "stylesheet", fromUrl: target.target.url,
  }), false);
});

test("ATS smoke removes cookies, auth and referrer headers", () => {
  assert.deepEqual(stripSensitiveHeaders({
    accept: "text/html", cookie: "session=private", authorization: "Bearer secret",
    "proxy-authorization": "private", referer: "https://boards.greenhouse.io/acme?token=private",
    "user-agent": "test",
  }), { accept: "text/html", "user-agent": "test" });
});

test("ATS smoke classifies accessible pages, login walls and CAPTCHA", () => {
  assert.equal(classifyPageSignals({ httpStatus: 200 }), "accessible");
  assert.equal(classifyPageSignals({ login: true, httpStatus: 200 }), "login");
  assert.equal(classifyPageSignals({ captcha: true, login: true, httpStatus: 200 }), "captcha");
  assert.equal(classifyPageSignals({ httpStatus: 403 }), "login");
  assert.equal(classifyPageSignals({ httpStatus: 404 }), "inaccessible");
});

test("ATS smoke installs HTTP and WebSocket guards before any page load", async () => {
  const target = validateAtsUrl("https://boards.greenhouse.io/acme/jobs/123");
  assert.equal(target.ok, true);
  if (!target.ok) return;
  let httpHandler: ((route: any) => Promise<void>) | undefined;
  let webSocketHandler: ((route: { close(code?: number, reason?: string): void }) => void) | undefined;
  const context = {
    route: async (pattern: string, handler: (route: any) => Promise<void>) => { assert.equal(pattern, "**/*"); httpHandler = handler; },
    routeWebSocket: async (pattern: string, handler: (route: { close(code?: number, reason?: string): void }) => void) => { assert.equal(pattern, "**/*"); webSocketHandler = handler; },
  };
  const allowedHosts = new Set<string>();
  const counters = await installReadOnlyGuards(context, target.target, host => allowedHosts.add(host));
  const request = (method: string, url: string, isNavigationRequest = false) => ({
    redirectedFrom: () => null,
    url: () => url,
    isNavigationRequest: () => isNavigationRequest,
    frame: () => ({ url: () => "about:blank" }),
    method: () => method,
    resourceType: () => isNavigationRequest ? "document" : "fetch",
    allHeaders: async () => ({
      accept: "text/html", cookie: "session=private", authorization: "Bearer private",
      referer: target.target.url + "?token=private",
    }),
  });
  const invoke = async (req: ReturnType<typeof request>) => {
    const observed: { aborted?: string; headers?: Record<string, string> } = {};
    if (!httpHandler) throw new Error("HTTP route was not registered");
    await httpHandler({
      request: () => req,
      abort: async (reason: string) => { observed.aborted = reason; },
      continue: async (options: { headers: Record<string, string> }) => { observed.headers = options.headers; },
    });
    return observed;
  };

  const first = await invoke(request("GET", target.target.url, true));
  assert.deepEqual(first.headers, { accept: "text/html" });
  assert.equal(first.aborted, undefined);
  assert.deepEqual([...allowedHosts], ["boards.greenhouse.io"]);
  const mutation = await invoke(request("POST", "https://boards.greenhouse.io/acme/candidates"));
  assert.equal(mutation.aborted, "blockedbyclient");
  assert.equal(mutation.headers, undefined);
  const offOrigin = await invoke(request("GET", "https://evil.example/collect"));
  assert.equal(offOrigin.aborted, "blockedbyclient");
  assert.deepEqual([...allowedHosts], ["boards.greenhouse.io"]);

  let closedSocket: { code: number; reason?: string } | undefined;
  if (!webSocketHandler) throw new Error("WebSocket route was not registered");
  webSocketHandler({ close: (code = 0, reason) => { closedSocket = { code, reason }; } });
  assert.equal(closedSocket?.code, 1008);
  assert.equal(counters.blockedRequests, 2);
  assert.equal(counters.blockedWebSockets, 1);
});

test("ATS smoke JSON contains no supplied URL, query token or page values", async () => {
  assert.ok(process.env.PLAYWRIGHT_BROWSERS_PATH?.endsWith(".playwright-browsers"));
  const suppliedUrl = "https://jobs.lever.co/acme/role";
  let contextOptions: Record<string, unknown> | undefined;
  let navigatedTo: string | undefined;
  const page = {
    on: () => {},
    goto: async (url: string) => { navigatedTo = url; return { status: () => 200 }; },
    waitForTimeout: async () => {},
    evaluate: async () => ({ captcha: false, login: false, applyLinkVisible: true, applicationFormVisible: true }),
  };
  const context = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    route: async () => {},
    routeWebSocket: async () => {},
    newPage: async () => page,
    close: async () => {},
  };
  let browserClosed = false;
  const browserType = {
    launch: async (options: { headless: boolean; timeout: number }) => {
      assert.equal(options.headless, true);
      return {
        newContext: async (options: Record<string, unknown>) => { contextOptions = options; return context; },
        close: async () => { browserClosed = true; },
      };
    },
  };
  const report = await runAtsLiveSmoke([suppliedUrl], {
    timeoutMs: 2000,
    browserType,
    proxyFactory: () => ({ listen: async () => "http://127.0.0.1:43211", close: async () => {} }),
  });
  assert.ok(navigatedTo);
  assert.ok(contextOptions);
  assert.equal(navigatedTo, suppliedUrl);
  assert.equal(contextOptions.serviceWorkers, "block");
  assert.equal(contextOptions.acceptDownloads, false);
  assert.equal(Object.hasOwn(contextOptions, "storageState"), false);
  assert.equal(report.results[0].status, "accessible");
  assert.equal(report.results[0].applyLinkVisible, true);
  assert.equal(report.results[0].applicationFormVisible, true);
  const json = JSON.stringify(report);
  assert.equal(json.includes(suppliedUrl), false);
  assert.equal(json.includes("private-token"), false);
  assert.equal(json.includes("applicationFormVisible"), true);
  assert.equal(browserClosed, true);

  const privateUrl = "https://jobs.lever.co/acme/role?token=private-token";
  let privateProxyStarted = false;
  const rejected = await runAtsLiveSmoke([privateUrl], {
    browserType: { launch: async () => { throw new Error("must_not_launch"); } },
    proxyFactory: () => {
      privateProxyStarted = true;
      throw new Error("must_not_start");
    },
  });
  assert.equal(rejected.results[0].status, "rejected");
  assert.equal(rejected.results[0].issue, "query_not_allowed");
  assert.equal(privateProxyStarted, false);
  assert.equal(JSON.stringify(rejected).includes("private-token"), false);
});
