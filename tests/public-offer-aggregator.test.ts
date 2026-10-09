import assert from "node:assert/strict";
import test from "node:test";
import type { OfferSearchCriteria, OfferSearchService } from "../src/shared/career.ts";
import { PublicOfferAggregator } from "../server/public-offer-aggregator.ts";
import { CareerError } from "../server/career-store.ts";

function offer(url: string, title = "Software engineer", sourceUrl = url) {
  return { url, title, company: "Example", location: "France", description: "Role details", sourceUrl };
}

function service(offers: ReturnType<typeof offer>[], calls: OfferSearchCriteria[], note = "ok"): OfferSearchService {
  return { search: async criteria => { calls.push(criteria); return { offers, note }; } };
}

test("searches public feeds together, round-robins results, and deduplicates canonical links", async () => {
  const arbeitnowCalls: OfferSearchCriteria[] = [];
  const jobicyCalls: OfferSearchCriteria[] = [];
  const failedCalls: OfferSearchCriteria[] = [];
  const sharedListing = "https://jobs.example/role/shared";
  const aggregator = new PublicOfferAggregator([
    { name: "Arbeitnow", service: service([
      offer("https://jobs.example/role/a?utm_source=feed#apply"),
      offer(sharedListing, "Duplicate title", sharedListing),
      offer("https://jobs.example/role/c"),
    ], arbeitnowCalls, "3 annonces") },
    { name: "Jobicy", service: service([
      offer("https://jobs.example/role/b"),
      offer("https://apply.example/shared", "Duplicate title", `${sharedListing}?utm_campaign=feed`),
      offer("https://jobs.example/role/d"),
    ], jobicyCalls, "3 annonces") },
    { name: "Remote OK", service: { search: async criteria => { failedCalls.push(criteria); throw new Error("network detail must not leak"); } } },
    { name: "Not configured" },
  ]);

  const result = await aggregator.search({ keywords: "Engineer", commune: "Paris", limit: 3 });
  assert.deepEqual(result.offers.map(item => item.url), [
    "https://jobs.example/role/a",
    "https://jobs.example/role/b",
    sharedListing,
  ]);
  assert.equal(arbeitnowCalls[0].limit, 200);
  assert.equal(jobicyCalls[0].keywords, "Engineer");
  assert.equal(failedCalls.length, 1);
  assert.match(result.note, /Arbeitnow : 3 annonces/);
  assert.match(result.note, /Remote OK : source indisponible/);
  assert.doesNotMatch(result.note, /network detail/);
  assert.match(result.note, /3 offre\(s\) distincte\(s\) retenue\(s\)/);
});

test("caps the final result count and permits only explicitly allowed HTTP fixture origins", async () => {
  const origin = "http://127.0.0.1:43127";
  const local = [offer(`${origin}/role/1`), offer(`${origin}/role/2`), offer(`${origin}/role/3`)];
  const aggregator = new PublicOfferAggregator([
    { name: "Fixture", service: service(local, []) },
  ], [origin]);

  const result = await aggregator.search({ keywords: "Engineer", limit: 2 });
  assert.deepEqual(result.offers.map(item => item.url), [`${origin}/role/1`, `${origin}/role/2`]);
});

test("rejects a search when every public source fails", async () => {
  const aggregator = new PublicOfferAggregator([
    { name: "Arbeitnow", service: { search: async () => { throw new Error("unavailable"); } } },
    { name: "Jobicy", service: { search: async () => { throw new Error("unavailable"); } } },
  ]);

  await assert.rejects(aggregator.search({ keywords: "Engineer" }), {
    code: "all_sources_unavailable",
    status: 502,
  });
});

test("drops offers with malformed or non-public links", async () => {
  const aggregator = new PublicOfferAggregator([
    { name: "Feed", service: service([
      offer("http://employer.example/job"),
      offer("https://127.0.0.1/private-job"),
      offer("https://[::1]/private-job"),
      offer("https://user:pass@employer.example/job"),
      offer("https://employer.example/job"),
    ], []) },
  ]);

  const result = await aggregator.search({ keywords: "Engineer" });
  assert.deepEqual(result.offers.map(item => item.url), ["https://employer.example/job"]);
});

test("distinguishes unsupported source filters from outages without leaking upstream error text", async () => {
  const aggregator = new PublicOfferAggregator([
    { name: "Himalayas", service: { search: async () => { throw new CareerError(400, "unsupported_filter", "Himalayas ne filtre que par pays."); } } },
    { name: "Arbeitnow", service: { search: async () => { throw new Error("secret network detail"); } } },
    { name: "Jobicy", service: service([], []) },
  ]);
  const result = await aggregator.search({ keywords: "Engineer" });
  assert.match(result.note, /Himalayas : filtre non pris en charge/);
  assert.match(result.note, /Arbeitnow : source indisponible/);
  assert.doesNotMatch(result.note, /secret network detail|Himalayas ne filtre/);
});

test("omits the city filter for sources that do not support it and explains the limitation", async () => {
  const calls: OfferSearchCriteria[] = [];
  const aggregator = new PublicOfferAggregator([
    { name: "Himalayas", supportsCommune: false, service: service([offer("https://jobs.example/remote")], calls) },
  ]);

  const result = await aggregator.search({ keywords: "Engineer", commune: "Paris" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].commune, undefined);
  assert.match(result.note, /Himalayas : .*filtre ville non appliqué/);
  assert.equal(result.offers.length, 1);
});
