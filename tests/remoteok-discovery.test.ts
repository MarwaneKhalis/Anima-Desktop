import test from "node:test";
import assert from "node:assert/strict";
import { RemoteOkDiscovery } from "../server/remoteok-discovery.ts";

const now = Date.parse("2026-10-08T13:00:00Z");
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "9001",
  url: "https://www.remoteok.com/remote-jobs/remote-software-engineer-9001?utm_source=api#apply",
  date: "2026-10-08T12:00:00Z",
  epoch: Date.parse("2026-10-08T12:00:00Z") / 1000,
  company: "Société",
  position: "Ingénieure logiciel",
  location: "Lyon, France",
  tags: ["engineer", "full-time"],
  description: "<p>Livrer un logiciel &amp; coacher l’équipe.</p><script>private()</script>",
  verified: true,
  ...overrides,
});
const response = (jobs: unknown[]) => Response.json([{ last_updated: 1791388805, legal: "Credit Remote OK" }, ...jobs]);

test("Remote OK query filters local rows and preserves its canonical credit link", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const service = new RemoteOkDiscovery(async (input, init) => {
    calls.push({ url: String(input), init });
    return response([
      row(),
      row({ id: "9002", url: "https://remoteok.com/remote-jobs/remote-software-engineer-9001?utm_medium=api", location: "Paris, France" }),
      row({ id: "9003", url: "https://remoteok.com.evil.example/remote-jobs/fake" }),
      row({ id: "9004", url: "http://remoteok.com/remote-jobs/insecure" }),
      row({ id: "9005", url: "https://remoteok.com/other/path" }),
      row({ id: "9006", url: "https://remoteok.com/remote-jobs/contract", tags: ["contract"] }),
      row({ id: "9007", url: "https://remoteok.com/remote-jobs/other-city", location: "Paris, France" }),
    ]);
  }, 1000, () => now);

  const result = await service.search({ keywords: "INGÉNIEURE logiciel", commune: "lyon", contractType: "CDI", limit: 20 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://remoteok.com/api", "the search terms and profile are not sent to the feed");
  assert.equal((calls[0].init?.headers as Record<string, string>)?.Accept, "application/json");
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].url, "https://remoteok.com/remote-jobs/remote-software-engineer-9001");
  assert.equal(result.offers[0].sourceUrl, result.offers[0].url, "each result retains the original Remote OK listing link");
  assert.equal(result.offers[0].description, "Livrer un logiciel & coacher l’équipe.");
  assert.match(result.note, /Remote OK/);
  assert.match(result.note, /une fois par heure/);
});

test("Remote OK includes only explicit France or broad-region eligibility and recent open posts", async () => {
  const locations = ["France", "Europe", "Remote, EMEA", "Worldwide", "Anywhere", "Global", "EU", "EEA", "Germany", "United States", ""];
  const jobs = locations.map((location, index) => row({ id: String(index + 1), url: `https://remoteok.com/remote-jobs/role-${index + 1}`, location, position: "Software Engineer" }));
  jobs.push(
    row({ id: "old", url: "https://remoteok.com/remote-jobs/old", location: "France", date: "2026-07-01T00:00:00Z" }),
    row({ id: "future", url: "https://remoteok.com/remote-jobs/future", location: "France", date: "2026-10-10T00:00:00Z" }),
    row({ id: "unverified", url: "https://remoteok.com/remote-jobs/unverified", location: "France", verified: false }),
    row({ id: "closed", url: "https://remoteok.com/remote-jobs/closed", location: "France", closed: true }),
  );
  const service = new RemoteOkDiscovery(async () => response(jobs), 1000, () => now);
  const result = await service.search({ keywords: "software engineer", limit: 200 });
  assert.deepEqual(result.offers.map(offer => new URL(offer.url).pathname), [
    "/remote-jobs/role-1", "/remote-jobs/role-2", "/remote-jobs/role-3", "/remote-jobs/role-4",
    "/remote-jobs/role-5", "/remote-jobs/role-6", "/remote-jobs/role-7", "/remote-jobs/role-8",
  ]);
});

test("Remote OK raw feed cache coalesces concurrent searches and expires after an hour", async () => {
  let calls = 0, clock = now;
  const service = new RemoteOkDiscovery(async () => {
    calls++;
    return response([
      row({ url: "https://remoteok.com/remote-jobs/engineer", position: "Software Engineer", tags: ["engineer"] }),
      row({ url: "https://remoteok.com/remote-jobs/analyst", position: "Data Analyst", tags: ["analyst"] }),
    ]);
  }, 1000, () => clock);
  const [engineer, analyst] = await Promise.all([
    service.search({ keywords: "engineer" }),
    service.search({ keywords: "analyst" }),
  ]);
  assert.equal(engineer.offers.length, 1);
  assert.equal(analyst.offers.length, 1);
  assert.equal(calls, 1);
  clock += 60 * 60_000;
  await service.search({ keywords: "engineer" });
  assert.equal(calls, 2);
});

test("Remote OK contract, phrase, city, result cap and unsupported filters are applied before storage", async () => {
  let calls = 0;
  const service = new RemoteOkDiscovery(async () => {
    calls++;
    return response([
      row({ url: "https://remoteok.com/remote-jobs/paris", position: "Senior Software Engineer", location: "Paris, France", tags: ["full-time"] }),
      row({ url: "https://remoteok.com/remote-jobs/lyon", position: "Senior Software Engineer", location: "Lyon, France", tags: ["part-time"] }),
      row({ url: "https://remoteok.com/remote-jobs/analyst", position: "Data Analyst", location: "Paris, France", tags: ["part-time"] }),
    ]);
  }, 1000, () => now);
  const result = await service.search({ keywords: "software engineer, data analyst", commune: "paris", contractType: "temps partiel", limit: 1 });
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].url, "https://remoteok.com/remote-jobs/analyst");
  await assert.rejects(() => service.search({ keywords: "engineer", department: "75" }), /ne filtre pas par département/i);
  await assert.rejects(() => service.search({ keywords: " " }), /Saisissez au moins/);
  assert.equal(calls, 1, "invalid and unsupported searches do not call Remote OK");
});

test("Remote OK timeout and invalid or oversized responses are reported and not cached", async () => {
  const never: typeof fetch = async (_input, init) => await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("aborted"); error.name = "AbortError"; reject(error);
    }, { once: true });
  });
  await assert.rejects(() => new RemoteOkDiscovery(never, 5, () => now).search({ keywords: "engineer" }), /dépassé le délai/i);

  let invalidCalls = 0;
  const invalid = new RemoteOkDiscovery(async () => { invalidCalls++; return Response.json({ jobs: [] }); }, 1000, () => now);
  await assert.rejects(() => invalid.search({ keywords: "engineer" }), /Réponse Remote OK invalide/i);
  await assert.rejects(() => invalid.search({ keywords: "engineer" }), /Réponse Remote OK invalide/i);
  assert.equal(invalidCalls, 2, "invalid feed data is not cached");

  const oversized = new RemoteOkDiscovery(async () => new Response("x".repeat(8_000_001), { headers: { "content-type": "application/json" } }), 1000, () => now);
  await assert.rejects(() => oversized.search({ keywords: "engineer" }), /trop volumineuse/i);
});

