import assert from "node:assert/strict";
import test from "node:test";
import { HimalayasDiscovery } from "../server/himalayas-discovery.ts";

const job = (overrides: Record<string, unknown> = {}) => ({
  title: "Senior Product Manager",
  companyName: "Example",
  employmentType: "Full Time",
  locationRestrictions: [{ alpha2: "FR", name: "France", slug: "france" }],
  description: "<p>Build the product &amp; grow the team.</p><script>alert('x')</script>",
  pubDate: 1_800_000_000,
  expiryDate: 1_900_000_000,
  applicationLink: "https://himalayas.app/companies/example/jobs/senior-product-manager?utm_source=api#apply",
  guid: "job-1",
  ...overrides,
});
const response = (jobs: unknown[]) => Response.json({ jobs, totalCount: jobs.length, page: 1 });

test("Himalayas searches France, keeps only eligible live jobs and preserves source attribution", async () => {
  const calls: URL[] = [];
  const source = new HimalayasDiscovery(async input => {
    calls.push(new URL(String(input)));
    return response([
      job(),
      job({ applicationLink: "https://himalayas.app/companies/example/jobs/worldwide", locationRestrictions: [] }),
      job({ applicationLink: "https://himalayas.app/companies/example/jobs/outside-france", locationRestrictions: [{ alpha2: "US", name: "United States" }] }),
      job({ applicationLink: "https://himalayas.app/companies/example/jobs/expired", expiryDate: 1_600_000_000 }),
      job({ applicationLink: "https://employer.example/jobs/unsafe" }),
      job({ applicationLink: "javascript:alert(1)" }),
      job({ title: "" }),
      job({ companyName: "" }),
    ]);
  }, 8000, () => 1_800_000_000_000);

  const result = await source.search({ keywords: "Product manager", limit: 10 });
  assert.deepEqual(calls[0].origin, "https://himalayas.app");
  assert.equal(calls[0].pathname, "/jobs/api/search");
  assert.equal(calls[0].searchParams.get("q"), "Product manager");
  assert.equal(calls[0].searchParams.get("country"), "FR");
  assert.equal(calls[0].searchParams.get("sort"), "recent");
  assert.equal(calls[0].searchParams.get("page"), "1");
  assert.deepEqual(result.offers.map(offer => offer.url), [
    "https://himalayas.app/companies/example/jobs/senior-product-manager",
    "https://himalayas.app/companies/example/jobs/worldwide",
  ]);
  assert.equal(result.offers[0].sourceUrl, result.offers[0].url);
  assert.equal(result.offers[0].description, "Build the product & grow the team.");
  assert.match(result.note, /quotidiennement/);
});

test("Himalayas maps known contract filters and refuses unsupported geographic filters before network", async () => {
  const calls: URL[] = [];
  const source = new HimalayasDiscovery(async input => {
    calls.push(new URL(String(input)));
    return response([job()]);
  });
  await source.search({ keywords: "Product manager", contractType: "CDI" });
  assert.equal(calls[0].searchParams.get("employment_type"), "Full Time");
  await assert.rejects(source.search({ keywords: "Product manager", commune: "Paris" }), { code: "unsupported_filter" });
  await assert.rejects(source.search({ keywords: "Product manager", department: "75" }), { code: "unsupported_filter" });
  await assert.rejects(source.search({ keywords: "Product manager", contractType: "Mission courte" }), { code: "unsupported_filter" });
  assert.equal(calls.length, 1);
});

test("Himalayas coalesces concurrent requests and honors its daily cache window", async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  const source = new HimalayasDiscovery(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return response([job()]);
  }, 8000, () => now);
  const [a, b] = await Promise.all([
    source.search({ keywords: "Product manager" }),
    source.search({ keywords: "Product manager" }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a.offers, b.offers);
  now += 24 * 60 * 60_000 + 1;
  await source.search({ keywords: "Product manager" });
  assert.equal(calls, 2);
});

test("Himalayas evicts old search queries instead of growing its cache without bound", async () => {
  let calls = 0;
  const source = new HimalayasDiscovery(async () => {
    calls++;
    return response([job()]);
  });
  for (let index = 0; index < 41; index++) {
    await source.search({ keywords: `Product manager ${index}` });
  }
  assert.equal(calls, 41);
  await source.search({ keywords: "Product manager 0" });
  assert.equal(calls, 42, "the oldest query was evicted at the cache limit");
});

test("Himalayas rejects malformed, oversized and timed-out responses without caching", async () => {
  let calls = 0;
  const malformed = new HimalayasDiscovery(async () => { calls++; return Response.json({ jobs: "not an array" }); });
  await assert.rejects(malformed.search({ keywords: "Product manager" }), { code: "himalayas_invalid_response" });
  await assert.rejects(malformed.search({ keywords: "Product manager" }), { code: "himalayas_invalid_response" });
  assert.equal(calls, 2);

  const oversized = new HimalayasDiscovery(async () => new Response(new Uint8Array(8_000_001), { headers: { "content-type": "application/json" } }));
  await assert.rejects(oversized.search({ keywords: "Product manager" }), { code: "himalayas_response_too_large" });

  const timeout = new HimalayasDiscovery(async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }), 1);
  await assert.rejects(timeout.search({ keywords: "Product manager" }), { code: "himalayas_timeout" });
});

