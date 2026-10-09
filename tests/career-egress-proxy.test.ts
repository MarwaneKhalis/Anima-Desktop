import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP, type AddressInfo } from "node:net";
import tls from "node:tls";
import { after, test } from "node:test";
import { CHROMIUM_EGRESS_FLAGS, PinnedBrowserProxy } from "../server/career-egress-proxy.ts";
import {
  browserProxyTestCaPem, browserProxyTestPfx, browserProxyTestPfxPassphrase,
} from "./fixtures/browser-proxy-test-certificate.ts";

type HttpResult = { status: number; headers: import("node:http").IncomingHttpHeaders; body: string };
const servers: Server[] = [];
const proxies: PinnedBrowserProxy[] = [];
after(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return address.port;
}

async function startProxy(options: ConstructorParameters<typeof PinnedBrowserProxy>[0] = {}): Promise<string> {
  const proxy = new PinnedBrowserProxy(options);
  proxies.push(proxy);
  return proxy.listen();
}

function connectStatus(proxyUrl: string, authority: string): Promise<number> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    const request = httpRequest({ hostname: proxy.hostname, port: Number(proxy.port), method: "CONNECT", path: authority });
    request.once("connect", (response, socket) => { socket.destroy(); finish(response.statusCode || 0); });
    request.once("response", response => { response.resume(); finish(response.statusCode || 0); });
    request.once("error", reject);
    request.end();
  });
}

function getThroughProxy(proxyUrl: string, targetUrl: string): Promise<HttpResult> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: proxy.hostname, port: Number(proxy.port), method: "GET", path: target.href,
      headers: { host: target.host },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}

function websocketThroughProxy(proxyUrl: string, targetUrl: string): Promise<void> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: proxy.hostname, port: Number(proxy.port), method: "GET", path: target.href,
      headers: {
        host: target.host, connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    request.once("upgrade", (_response, socket) => { socket.destroy(); resolve(); });
    request.once("response", response => { response.resume(); resolve(); });
    request.once("error", error => {
      // The fixture intentionally closes its socket after recording the handshake.
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
      else reject(error);
    });
    request.end();
  });
}

function tlsRequestThroughProxy(proxyUrl: string, authority: string, servername: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: proxy.hostname, port: Number(proxy.port), method: "CONNECT", path: authority });
    request.once("error", reject);
    request.once("connect", (response, socket) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error("CONNECT status " + response.statusCode)); return; }
      const secure = tls.connect({
        socket, servername, ca: browserProxyTestCaPem, rejectUnauthorized: true,
      });
      const chunks: Buffer[] = [];
      secure.on("data", chunk => chunks.push(Buffer.from(chunk)));
      secure.once("error", reject);
      secure.once("secureConnect", () => secure.write(
        "GET /verified HTTP/1.1\r\nHost: careers.example.test\r\nConnection: close\r\n\r\n",
      ));
      secure.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.end();
  });
}

test("the browser proxy rejects private and mixed DNS answers before dialing", async () => {
  for (const answers of [
    [{ address: "127.0.0.1", family: 4 as const }],
    [{ address: "93.184.216.34", family: 4 as const }, { address: "127.0.0.1", family: 4 as const }],
    [{ address: "::ffff:127.0.0.1", family: 6 as const }],
  ]) {
    let dials = 0;
    const proxyUrl = await startProxy({
      resolveAddresses: async () => answers,
      dial: async () => { dials++; throw new Error("must not dial a private answer"); },
    });
    assert.equal(await connectStatus(proxyUrl, "apply.example.org:443"), 403);
    assert.equal(dials, 0);
  }
});

test("closing the proxy aborts an in-flight upstream dial", async () => {
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const dialStarted = new Promise<void>(resolve => { started = resolve; });
  const proxy = new PinnedBrowserProxy({
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    dial: async (_address, _port, abortSignal) => {
      signal = abortSignal;
      started();
      return new Promise((_resolve, reject) => abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  });
  proxies.push(proxy);
  const proxyUrl = await proxy.listen();
  const endpoint = new URL(proxyUrl);
  const request = httpRequest({ hostname: endpoint.hostname, port: Number(endpoint.port), method: "CONNECT", path: "apply.example.org:443" });
  request.on("error", () => {});
  request.end();
  await dialStarted;
  await proxy.close();
  assert.equal(signal?.aborted, true, "proxy shutdown aborts the pending pinned socket dial");
  request.destroy();
});

test("malformed and non-standard CONNECT targets fail before DNS", async () => {
  let resolutions = 0;
  let dials = 0;
  const proxyUrl = await startProxy({
    resolveAddresses: async () => { resolutions++; return [{ address: "93.184.216.34", family: 4 }]; },
    dial: async () => { dials++; throw new Error("must not dial"); },
  });
  assert.equal(await connectStatus(proxyUrl, "apply.example.org:444"), 403);
  assert.equal(resolutions, 0);
  assert.equal(dials, 0);
  assert.equal(await connectStatus(proxyUrl, "apply.example.org"), 403);
  assert.equal(resolutions, 0);
});

test("TLS stays end-to-end through a loopback CONNECT tunnel and checks the original hostname", async () => {
  const httpsServer = createHttpsServer({
    pfx: Buffer.from(browserProxyTestPfx, "base64"),
    passphrase: browserProxyTestPfxPassphrase,
  }, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", connection: "close" });
    response.end("pinned TLS response");
  });
  const port = await listen(httpsServer);
  const origin = "https://careers.example.test:" + port;
  const proxyUrl = await startProxy({
    testOrigins: [origin],
    resolveAddresses: async hostname => {
      assert.equal(hostname, "careers.example.test");
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  const response = await tlsRequestThroughProxy(proxyUrl, "careers.example.test:" + port, "careers.example.test");
  assert.match(response, /200 OK/);
  assert.match(response, /pinned TLS response/);
  await assert.rejects(
    tlsRequestThroughProxy(proxyUrl, "careers.example.test:" + port, "other.example.test"),
    /ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match certificate/i,
  );
});

test("HTTP navigation, assets, redirects, and WebSocket upgrades use the pinned test-origin egress path", async () => {
  let wsAttempts = 0;
  let atsUrl = "";
  const ats = createServer((request, response) => {
    if (request.url === "/application") { response.writeHead(200); response.end("ATS application"); return; }
    response.writeHead(404); response.end();
  });
  ats.on("upgrade", (_request, socket) => { wsAttempts++; socket.destroy(); });
  const atsPort = await listen(ats);
  atsUrl = "http://127.0.0.1:" + atsPort;
  const job = createServer((request, response) => {
    if (request.url === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end("<link rel=stylesheet href=/assets/app.css><h1>Job page</h1>"); return; }
    if (request.url === "/assets/app.css") { response.writeHead(200, { "content-type": "text/css" }); response.end("body{color:#123}"); return; }
    if (request.url === "/l/123") { response.writeHead(302, { location: atsUrl + "/application" }); response.end(); return; }
    response.writeHead(404); response.end();
  });
  const jobPort = await listen(job);
  const jobUrl = "http://127.0.0.1:" + jobPort;
  const resolveAddresses = async (hostname: string) => {
    assert.equal(isIP(hostname), 4);
    return [{ address: hostname, family: 4 as const }];
  };
  const proxyUrl = await startProxy({ testOrigins: [jobUrl, atsUrl], resolveAddresses });

  const page = await getThroughProxy(proxyUrl, jobUrl + "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /Job page/);
  const asset = await getThroughProxy(proxyUrl, jobUrl + "/assets/app.css");
  assert.equal(asset.status, 200);
  assert.match(asset.body, /color:#123/);
  const redirect = await getThroughProxy(proxyUrl, jobUrl + "/l/123");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, atsUrl + "/application");
  const destination = await getThroughProxy(proxyUrl, atsUrl + "/application");
  assert.equal(destination.status, 200);
  assert.match(destination.body, /ATS application/);

  await websocketThroughProxy(proxyUrl, atsUrl.replace(/^http:/, "ws:") + "/collect-ws");
  assert.equal(wsAttempts, 1);
});

test("Chromium egress flags disable browser DNS, QUIC, and non-proxied WebRTC UDP", () => {
  assert.deepEqual(CHROMIUM_EGRESS_FLAGS, [
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ]);
});
