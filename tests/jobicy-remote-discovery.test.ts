import test from "node:test";
import assert from "node:assert/strict";
import { JobicyRemoteDiscovery } from "../server/jobicy-remote-discovery.ts";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 101,
  url: "https://www.jobicy.com/jobs/remote-software-engineer?utm_source=api#apply",
  jobTitle: "Ingénieure logiciel",
  companyName: "Entreprise",
  jobGeo: "France (Remote)",
  jobIndustry: ["Technology"],
  jobType: ["Full-Time"],
  jobLevel: "Mid level",
  jobExcerpt: "Résumé",
  jobDescription: "<p>Développement produit &amp; équipe</p><script>alert('x')</script>",
  ...overrides,
});
const response = (jobs: unknown[]) => Response.json({ success: true, jobs });

test("Jobicy uses the France remote feed, normalizes safe canonical offers, and filters locally", async () => {
  const calls: URL[] = [];
  const request: typeof fetch = async input => {
    calls.push(new URL(String(input)));
    return response([
      row(),
      row({ id: 102, url: "https://jobicy.com/jobs/remote-software-engineer?utm_campaign=other", jobTitle: "Ingénieure logiciel" }),
      row({ id: 103, url: "https://jobicy.com/jobs/data", jobTitle: "Data scientist", jobGeo: "France", jobType: "contract" }),
      row({ id: 104, url: "https://jobicy.com/jobs/paris", jobGeo: "Paris, France", jobType: "part_time" }),
      row({ id: 105, url: "https://jobs.other.test/unsafe", jobTitle: "Ingénieure logiciel" }),
    ]);
  };
  const service = new JobicyRemoteDiscovery(request);
  const result = await service.search({ keywords: "ingenieure logiciel", commune: "france", contractType: "CDI", limit: 20 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin + calls[0].pathname, "https://jobicy.com/api/v2/remote-jobs");
  assert.equal(calls[0].searchParams.get("geo"), "france");
  assert.equal(calls[0].searchParams.get("count"), "200");
  assert.equal(result.offers.length, 1, "duplicate URL, wrong contract and unsafe host are discarded");
  assert.equal(result.offers[0].url, "https://jobicy.com/jobs/remote-software-engineer");
  assert.equal(result.offers[0].sourceUrl, result.offers[0].url, "the canonical Jobicy listing is preserved as the source link");
  assert.equal(result.offers[0].description, "Développement produit & équipe");
  assert.match(result.note, /Jobicy/);
  assert.match(result.note, /une fois par heure/);
});

test("Jobicy caches the raw response for at least one hour across different local filters", async () => {
  let calls = 0, now = 10_000;
  const service = new JobicyRemoteDiscovery(async input => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("geo"), "france");
    return response([row(), row({ url: "https://jobicy.com/jobs/data", jobTitle: "Data analyst" })]);
  }, 1000, () => now);
  const [software, data] = await Promise.all([
    service.search({ keywords: "ingenieure" }),
    service.search({ keywords: "data analyst" }),
  ]);
  assert.equal(software.offers.length, 1);
  assert.equal(data.offers.length, 1);
  assert.equal(calls, 1);
  now += 60 * 60_000;
  await service.search({ keywords: "ingenieure" });
  assert.equal(calls, 2, "cache expires at the one-hour boundary");
});

test("Jobicy applies accent-insensitive city and contract matching and rejects unsupported department", async () => {
  let calls = 0;
  const service = new JobicyRemoteDiscovery(async () => {
    calls++;
    return response([
      row({ url: "https://jobicy.com/jobs/lyon", jobGeo: "Lyon, France", jobType: "full_time" }),
      row({ url: "https://jobicy.com/jobs/paris", jobGeo: "Paris, France", jobType: "full_time" }),
      row({ url: "https://jobicy.com/jobs/intern", jobGeo: "Lyon, France", jobType: "internship" }),
    ]);
  });
  const result = await service.search({ keywords: "INGENIEURE LOGICIEL", commune: "Lýon", contractType: "CDI" });
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].url, "https://jobicy.com/jobs/lyon");
  await assert.rejects(() => service.search({ keywords: "engineer", department: "69" }), /ne permet pas de filtrer par département/i);
  assert.equal(calls, 1, "unsupported filters are rejected before making another request");
});

test("Jobicy keeps only France, broad Europe/EMEA, and worldwide eligibility from its France feed", async () => {
  const service = new JobicyRemoteDiscovery(async () => response([
    row({ id: 201, url: "https://jobicy.com/jobs/france", jobGeo: "France" }),
    row({ id: 202, url: "https://jobicy.com/jobs/europe", jobGeo: "Europe, Ukraine" }),
    row({ id: 203, url: "https://jobicy.com/jobs/emea", jobGeo: "APAC, EMEA, LATAM, Canada, USA" }),
    row({ id: 204, url: "https://jobicy.com/jobs/anywhere", jobGeo: "Anywhere" }),
    row({ id: 205, url: "https://jobicy.com/jobs/usa", jobGeo: "USA, Canada" }),
    row({ id: 206, url: "https://jobicy.com/jobs/apac", jobGeo: "APAC" }),
    row({ id: 207, url: "https://jobicy.com/jobs/germany", jobGeo: "Germany, Austria" }),
    row({ id: 208, url: "https://jobicy.com/jobs/unknown", jobGeo: "" }),
  ]));
  const result = await service.search({ keywords: "ingenieure logiciel", limit: 20 });
  assert.deepEqual(result.offers.map(offer => offer.url), [
    "https://jobicy.com/jobs/france",
    "https://jobicy.com/jobs/europe",
    "https://jobicy.com/jobs/emea",
    "https://jobicy.com/jobs/anywhere",
  ]);
  assert.match(result.note, /France, Europe\/EMEA ou partout/);
});

test("Jobicy timeout is bounded and reported clearly", async () => {
  const request: typeof fetch = async (_input, init) => await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("aborted"); error.name = "AbortError"; reject(error);
    }, { once: true });
  });
  await assert.rejects(() => new JobicyRemoteDiscovery(request, 5).search({ keywords: "engineer" }), /dépassé le délai/i);
});

test("Jobicy rejects malformed and oversized response shapes without caching them", async () => {
  let calls = 0;
  const invalid = new JobicyRemoteDiscovery(async () => {
    calls++;
    return Response.json({ success: true, jobs: "not-an-array" });
  });
  await assert.rejects(() => invalid.search({ keywords: "engineer" }), /Réponse Jobicy invalide/i);
  await assert.rejects(() => invalid.search({ keywords: "engineer" }), /Réponse Jobicy invalide/i);
  assert.equal(calls, 2, "invalid responses are never cached");

  const oversized = new JobicyRemoteDiscovery(async () => new Response("x".repeat(5_000_001), {
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(() => oversized.search({ keywords: "engineer" }), /trop volumineuse/i);
});
