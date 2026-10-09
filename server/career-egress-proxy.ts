import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { isPublicAIAddress } from "./career-ai.ts";
import type { Duplex } from "node:stream";

export type BrowserProxyAddress = { address: string; family: 4 | 6 };
export type BrowserProxyResolver = (hostname: string) => Promise<BrowserProxyAddress[]>;
export type BrowserProxyDialer = (address: BrowserProxyAddress, port: number, signal?: AbortSignal) => Promise<Socket>;

export const CHROMIUM_EGRESS_FLAGS = [
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
] as const;

export interface PinnedBrowserProxyOptions {
  /** Exact local origins enabled only by automated test fixtures. */
  testOrigins?: string[];
  /** Dependency seams for deterministic tests; never sourced from UI/user data. */
  resolveAddresses?: BrowserProxyResolver;
  dial?: BrowserProxyDialer;
  dnsTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export function resolveBrowserAddresses(hostname: string): Promise<BrowserProxyAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return Promise.resolve([{ address: hostname, family }]);
  return lookup(hostname, { all: true, verbatim: true }).then(rows => rows.map(row => ({
    address: row.address, family: row.family as 4 | 6,
  })));
}

function isLoopback(address: BrowserProxyAddress): boolean {
  if (isIP(address.address) !== address.family) return false;
  if (address.family === 4) return Number(address.address.split(".")[0]) === 127;
  const normalized = address.address.toLowerCase().split("%", 1)[0];
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return Boolean(mapped && Number(mapped[1].split(".")[0]) === 127);
}

function validTestOrigins(origins: string[] = []): Set<string> {
  const result = new Set<string>();
  for (const value of origins) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== value) {
      throw new Error("Origine de test invalide.");
    }
    result.add(url.origin);
  }
  return result;
}

function parseAuthority(authority: string): { hostname: string; port: number } | null {
  if (!authority || /[\s/@?#]/.test(authority)) return null;
  try {
    // HTTP is used here so an explicit :443 remains visible in URL.port.
    const url = new URL("http://" + authority);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port) return null;
    const port = Number(url.port);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { hostname, port };
  } catch {
    return null;
  }
}

function originFor(protocol: "http:" | "https:", hostname: string, port: number): string {
  const host = hostname.includes(":") ? "[" + hostname + "]" : hostname;
  return new URL(protocol + "//" + host + ":" + port).origin;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DNS resolution timed out.")), timeoutMs);
    timer.unref?.();
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function connectToAddress(address: BrowserProxyAddress, port: number, timeoutMs: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Destination connection aborted.")); return; }
    const socket = netConnect({ host: address.address, port, family: address.family });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => socket.destroy(new Error("Destination connection timed out.")), timeoutMs);
    timer.unref?.();
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => socket.destroy(new Error("Destination connection aborted."));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onError);
    socket.once("connect", () => {
      cleanup();
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

function copyRequestHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[] | undefined> {
  const result = { ...headers };
  delete result["proxy-authorization"];
  delete result["proxy-connection"];
  return result;
}

function reply(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = message + "\n";
  socket.end("HTTP/1.1 " + status + " " + (status === 403 ? "Forbidden" : "Bad Gateway")
    + "\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: "
    + Buffer.byteLength(body) + "\r\n\r\n" + body);
}

export class PinnedBrowserProxy {
  private readonly testOrigins: Set<string>;
  private readonly resolveAddresses: BrowserProxyResolver;
  private readonly dial: BrowserProxyDialer;
  private readonly dnsTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly sockets = new Set<Socket>();
  private readonly controller = new AbortController();
  private server: Server | undefined;
  private closed = false;
  private listeningUrl: string | undefined;

  constructor(options: PinnedBrowserProxyOptions = {}) {
    this.testOrigins = validTestOrigins(options.testOrigins);
    this.resolveAddresses = options.resolveAddresses ?? resolveBrowserAddresses;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 8_000;
    this.dnsTimeoutMs = options.dnsTimeoutMs ?? 5_000;
    this.dial = options.dial ?? ((address, port, signal) => connectToAddress(address, port, this.connectTimeoutMs, signal));
  }

  async listen(): Promise<string> {
    if (this.closed) throw new Error("Le proxy réseau est déjà fermé.");
    if (this.listeningUrl) return this.listeningUrl;
    const server = createServer((request, response) => { void this.handleHttp(request, response); });
    server.on("connection", socket => this.track(socket));
    server.on("connect", (request, socket, head) => { void this.handleConnect(request, socket, head); });
    server.on("upgrade", (request, socket, head) => { void this.handleUpgrade(request, socket, head); });
    server.on("clientError", (_error, socket) => reply(socket, 403, "Proxy request rejected."));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
      const onListening = () => { server.removeListener("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === "string") {
      await new Promise<void>(resolve => server.close(() => resolve()));
      throw new Error("Le proxy réseau n’a pas obtenu de port local.");
    }
    this.server = server;
    this.listeningUrl = "http://127.0.0.1:" + address.port;
    return this.listeningUrl;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    this.listeningUrl = undefined;
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private async destination(hostname: string, port: number, protocol: "http:" | "https:"): Promise<BrowserProxyAddress[]> {
    const origin = originFor(protocol, hostname, port);
    const testOrigin = this.testOrigins.has(origin);
    if (!testOrigin && (protocol !== "https:" || port !== 443 || isIP(hostname) !== 0 || !hostname.includes("."))) {
      throw new Error("Destination non autorisée.");
    }
    const addresses = await withTimeout(this.resolveAddresses(hostname), this.dnsTimeoutMs);
    if (!addresses.length || addresses.some(({ address, family }) => isIP(address) !== family)) {
      throw new Error("Résolution DNS invalide.");
    }
    if (testOrigin) {
      // Exact test fixtures may use loopback, but never a LAN or external address.
      if (addresses.some(address => !isLoopback(address))) throw new Error("Origine de test hors boucle locale.");
    } else if (addresses.some(({ address, family }) => !isPublicAIAddress(address, family))) {
      // Reject mixed answers as well as private-only answers.
      throw new Error("Destination réseau non publique.");
    }
    return addresses;
  }

  private async openPinned(hostname: string, port: number, protocol: "http:" | "https:"): Promise<Socket> {
    const addresses = await this.destination(hostname, port, protocol);
    let lastError: unknown;
    for (const address of addresses) {
      if (this.closed) throw new Error("Le proxy réseau est fermé.");
      try {
        const socket = await this.dial(address, port, this.controller.signal);
        if (this.closed) { socket.destroy(); throw new Error("Le proxy réseau est fermé."); }
        this.track(socket);
        return socket;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Aucune adresse épinglée joignable.");
  }

  private async handleConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (this.closed) { client.destroy(); return; }
    const target = parseAuthority(request.url || "");
    if (!target) return reply(client, 403, "Invalid CONNECT authority.");
    let upstream: Socket;
    try {
      upstream = await this.openPinned(target.hostname, target.port, "https:");
    } catch {
      return reply(client, 403, "HTTPS destination rejected.");
    }
    if (client.destroyed || this.closed) { upstream.destroy(); return; }
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    // TLS remains end-to-end between Chromium and the hiring site; the proxy never terminates TLS.
    client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: AnimaConnect\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed) { response.destroy(); return; }
    let target: URL;
    try { target = new URL(request.url || "/", "http://" + String(request.headers.host || "")); }
    catch { response.writeHead(403).end(); return; }
    if (target.protocol !== "http:" || !this.testOrigins.has(target.origin)) {
      response.writeHead(403, { "Connection": "close" }).end("Cleartext or non-test proxy request rejected.");
      return;
    }
    let address: BrowserProxyAddress;
    try {
      address = (await this.destination(target.hostname.replace(/^\[|\]$/g, ""), Number(target.port || 80), "http:"))[0];
    } catch {
      response.writeHead(403, { "Connection": "close" }).end("Test destination rejected.");
      return;
    }
    const upstream = httpRequest({
      hostname: address.address, family: address.family, port: Number(target.port || 80),
      method: request.method, path: target.pathname + target.search,
      headers: copyRequestHeaders(request.headers), agent: false,
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("socket", socket => this.track(socket));
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  }

  private async handleUpgrade(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (this.closed) { client.destroy(); return; }
    let target: URL;
    try {
      target = new URL(request.url || "/", "http://" + String(request.headers.host || ""));
      if (target.protocol === "ws:") target.protocol = "http:";
      else if (target.protocol === "wss:") target.protocol = "https:";
    } catch {
      return reply(client, 403, "Invalid WebSocket destination.");
    }
    const protocol = target.protocol === "https:" ? "https:" : target.protocol === "http:" ? "http:" : null;
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const port = Number(target.port || (protocol === "https:" ? 443 : 80));
    if (!protocol || !this.testOrigins.has(originFor(protocol, hostname, port))) {
      return reply(client, 403, "WebSocket proxy request rejected.");
    }
    let upstream: Socket;
    try { upstream = await this.openPinned(hostname, port, protocol); }
    catch { return reply(client, 403, "WebSocket destination rejected."); }
    if (client.destroyed || this.closed) { upstream.destroy(); return; }
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    const path = target.pathname + target.search;
    const lines = [request.method + " " + path + " HTTP/" + request.httpVersion];
    for (const [name, value] of Object.entries(request.headers)) {
      if (name === "proxy-authorization" || name === "proxy-connection") continue;
      if (Array.isArray(value)) for (const item of value) lines.push(name + ": " + item);
      else if (value !== undefined) lines.push(name + ": " + value);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  }
}
