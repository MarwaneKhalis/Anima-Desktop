import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RemotiveDiscovery } from "../server/remotive-discovery.ts";

const now = Date.parse("2026-10-09T12:00:00Z");
const job = (overrides: Record<string, unknown> = {}) => ({
  id: 1001,
  url: "https://remotive.com/remote-jobs/product/lead-developer-1001?utm_source=api#apply",
  title: "Lead Developer",
  company_name: "Example",
  category: "Software Development",
  job_type: "full_time",
  publication_date: "2026-10-08T10:00:00Z",
  candidate_required_location: "France",
  salary: "$70,000 - $90,000",
  description: "<p>Build reliable software &amp; coach the team.</p><script>secret()</script>",
  ...overrides,
});
const response = (jobs: unknown[]) => Response.json({ "job-count": jobs.length, jobs });
async function tempCache() {
  const dir = await mkdtemp(join(tmpdir(), "anima-remotive-"));
  return { dir, path: join(dir, "remotive-cache.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("Remotive filters local jobs to France-eligible roles, keeps attribution and sanitizes descriptions", async t => {
  const cache = await tempCache(); t.after(cache.cleanup);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const source = new RemotiveDiscovery({ cachePath: cache.path, now: () => now, request: async (input, init) => {
    calls.push({ url: String(input), init });
    return response([
      job(),
      job({ id: 2, url: "https://remotive.com/remote-jobs/dev/lead-developer-2", candidate_required_location: "Worldwide" }),
      job({ id: 3, url: "https://remotive.com/remote-jobs/dev/lead-developer-3", candidate_required_location: "United States" }),
      job({ id: 4, url: "https://remotive.com/remote-jobs/dev/lead-developer-4", publication_date: "2026-05-01T00:00:00Z" }),
      job({ id: 5, url: "https://remotive.com.evil.example/remote-jobs/dev/fake" }),
      job({ id: 6, url: "https://remotive.com/remote-jobs/dev/lead-developer-6", job_type: "contract" }),
    ]);
  } });

  const result = await source.search({ keywords: "lead developer", contractType: "CDI", limit: 10 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://remotive.com/api/remote-jobs", "keywords and profile filters stay local");
  assert.equal((calls[0].init?.headers as Record<string, string>).Accept, "application/json");
  assert.equal(calls[0].init?.redirect, "error");
  assert.deepEqual(result.offers.map(offer => offer.url), [
    "https://remotive.com/remote-jobs/product/lead-developer-1001",
    "https://remotive.com/remote-jobs/dev/lead-developer-2",
  ]);
  assert.equal(result.offers[0].sourceUrl, result.offers[0].url);
  assert.equal(result.offers[0].description, "Build reliable software & coach the team.");
  assert.match(result.note, /attribution/i);
  assert.match(result.note, /24 h/);
  await assert.rejects(() => source.search({ keywords: "lead developer", commune: "Paris" }), { code: "unsupported_filter" });
  assert.equal(calls.length, 1, "unsupported city filtering does not query the source again");
});

test("Remotive cache survives restart, coalesces concurrent searches and refreshes no more than daily", async t => {
  const cache = await tempCache(); t.after(cache.cleanup);
  let clock = now, calls = 0;
  const request: typeof fetch = async () => { calls++; return response([job()]); };
  const first = new RemotiveDiscovery({ cachePath: cache.path, request, now: () => clock });
  const [a, b] = await Promise.all([
    first.search({ keywords: "lead developer" }),
    first.search({ keywords: "software development" }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.offers.length, 1);
  assert.equal(b.offers.length, 1);

  const afterRestart = new RemotiveDiscovery({ cachePath: cache.path, request, now: () => clock });
  await afterRestart.search({ keywords: "lead developer" });
  assert.equal(calls, 1, "the persisted cache prevents a request after restart");
  clock += 24 * 60 * 60_000 - 1;
  await afterRestart.search({ keywords: "lead developer" });
  assert.equal(calls, 1);
  clock += 2;
  await afterRestart.search({ keywords: "lead developer" });
  assert.equal(calls, 2);
});

test("Remotive rate-limits failed refreshes and serves a bounded stale cache", async t => {
  const cache = await tempCache(); t.after(cache.cleanup);
  let clock = now, calls = 0;
  const initial = new RemotiveDiscovery({ cachePath: cache.path, now: () => clock, request: async () => { calls++; return response([job()]); } });
  await initial.search({ keywords: "lead developer" });
  clock += 24 * 60 * 60_000 + 1;
  const unavailable = new RemotiveDiscovery({ cachePath: cache.path, now: () => clock, request: async () => { calls++; throw new Error("offline"); } });
  const stale = await unavailable.search({ keywords: "lead developer" });
  assert.equal(stale.offers.length, 1);
  assert.match(stale.note, /dernier cache disponible/i);
  await unavailable.search({ keywords: "lead developer" });
  assert.equal(calls, 2, "a failed refresh attempt is also recorded to respect the API limit");

  clock += 8 * 24 * 60 * 60_000;
  const tooOld = new RemotiveDiscovery({ cachePath: cache.path, now: () => clock, request: async () => { calls++; throw new Error("offline"); } });
  await assert.rejects(() => tooOld.search({ keywords: "lead developer" }), /momentanément inaccessible/i);
  assert.equal(calls, 3);
});

test("Remotive malformed, oversized, timed out and corrupt cache responses fail safely", async t => {
  const cache1 = await tempCache(); t.after(cache1.cleanup);
  const malformed = new RemotiveDiscovery({ cachePath: cache1.path, now: () => now, request: async () => Response.json({ jobs: "bad" }) });
  await assert.rejects(() => malformed.search({ keywords: "lead developer" }), /Réponse Remotive invalide/i);
  await assert.rejects(() => malformed.search({ keywords: "lead developer" }), /fenêtre de 24 heures/i);

  const cache2 = await tempCache(); t.after(cache2.cleanup);
  const oversized = new RemotiveDiscovery({ cachePath: cache2.path, now: () => now, request: async () => new Response("x".repeat(8_000_001)) });
  await assert.rejects(() => oversized.search({ keywords: "lead developer" }), /trop volumineuse/i);

  const cache3 = await tempCache(); t.after(cache3.cleanup);
  const timeout = new RemotiveDiscovery({ cachePath: cache3.path, now: () => now, timeoutMs: 5, request: async (_input, init) => await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }) });
  await assert.rejects(() => timeout.search({ keywords: "lead developer" }), /dépassé le délai/i);

  const cache4 = await tempCache(); t.after(cache4.cleanup);
  await writeFile(cache4.path, "not json", "utf8");
  let calls = 0;
  const corrupt = new RemotiveDiscovery({ cachePath: cache4.path, request: async () => { calls++; return response([job()]); } });
  await assert.rejects(() => corrupt.search({ keywords: "lead developer" }), /cache Remotive est illisible/i);
  assert.equal(calls, 0, "a corrupt cache does not trigger an uncontrolled API request");
  assert.match(await readFile(cache4.path, "utf8"), /not json/);
});
