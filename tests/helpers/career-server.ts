import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCareerFixtures } from "../fixtures/careers.ts";

export interface CareerTestServer {
  baseUrl: string;
  fixture: Awaited<ReturnType<typeof startCareerFixtures>>;
  dataDir: string;
  close(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
  json(
    path: string,
    body?: unknown,
    method?: string,
  ): Promise<{ response: Response; value: any }>;
}

async function reservePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a local port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForServer(
  url: string,
  child: ChildProcess,
  getOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + 25_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Career API exited before startup:\n${getOutput()}`);
    try {
      const response = await fetch(`${url}/api/career/bootstrap`, {
        headers: { "X-Anima-Request": "1" },
      });
      if (response.ok) return;
      lastError = new Error(`Bootstrap returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `Career API did not start (${String(lastError)}):\n${getOutput()}`,
  );
}

export async function startCareerTestServer(options: { mockFranceTravailSearch?: boolean; mockArbeitnowSearch?: boolean; mockJobicySearch?: boolean; mockRemoteOkSearch?: boolean } = {}): Promise<CareerTestServer> {
  const fixture = await startCareerFixtures();
  const port = await reservePort();
  const dataDir = await mkdtemp(join(tmpdir(), "anima-career-api-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "server/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ANIMA_DATA_DIR: dataDir,
        PORT: String(port),
        ANIMA_TEST_MODE: "1",
        CAREER_TEST_ORIGINS: JSON.stringify([new URL(fixture.baseUrl).origin, new URL(fixture.atsUrl).origin]),
        CAREER_TEST_FRANCE_TRAVAIL_URL: options.mockFranceTravailSearch ? `${fixture.baseUrl}/simple` : "",
        CAREER_TEST_ARBEITNOW_URL: options.mockArbeitnowSearch ? `${fixture.baseUrl}/simple?source=arbeitnow` : "",
        CAREER_TEST_JOBICY_URL: options.mockJobicySearch ? `${fixture.baseUrl}/simple?source=jobicy` : "",
        CAREER_TEST_REMOTEOK_URL: options.mockRemoteOkSearch ? `${fixture.baseUrl}/remoteok-job` : "",
        CAREER_HEADLESS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    await waitForServer(baseUrl, child, () => output);
  } catch (error) {
    child.kill();
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("X-Anima-Request")) headers.set("X-Anima-Request", "1");
    return fetch(`${baseUrl}${path}`, { ...init, headers });
  };
  return {
    baseUrl,
    fixture,
    dataDir,
    async close() {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        setTimeout(() => resolve(), 3_000).unref();
      });
      await fixture.close();
      await rm(dataDir, { recursive: true, force: true });
    },
    request,
    async json(
      path,
      body = undefined,
      method = body === undefined ? "GET" : "POST",
    ) {
      const response = await request(path, {
        method,
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let value: any = null;
      try {
        value = await response.json();
      } catch {
        /* binary/empty response */
      }
      return { response, value };
    },
  };
}

export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for career state; last value: ${JSON.stringify(last)}`,
  );
}

