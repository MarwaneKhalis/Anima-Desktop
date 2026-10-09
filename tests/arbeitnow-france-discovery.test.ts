import test from "node:test";
import assert from "node:assert/strict";
import { ArbeitnowFranceDiscovery } from "../server/arbeitnow-france-discovery.ts";

const row = (overrides: Record<string, unknown> = {}) => ({
  slug: "ingenieur-logiciel-paris",
  company_name: "Entreprise",
  title: "Ingénieure logiciel",
  description: "<p>Développement produit</p><script>ne pas indexer</script>",
  remote: false,
  url: "https://jobs.lever.co/entreprise/role?utm_source=feed",
  tags: ["Engineering"],
  job_types: ["fulltime permanent"],
  location: "Paris, Île-de-France, France",
  created_at: 1,
  ...overrides,
});
const response = (data: unknown[]) => Response.json({ data, links: { next: null }, meta: { per_page: 100 } });

test("Arbeitnow France search reads public pages, filters locally and caches results", async () => {
  const calls: string[] = [];
  const filler = Array.from({ length: 100 }, (_, index) => row({ slug: `other-${index}`, title: `Autre métier ${index}`, url: `https://jobs.example.test/${index}` }));
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    return response(url.searchParams.get("page") === "1" ? filler : [row(), row()]);
  };
  const service = new ArbeitnowFranceDiscovery(request);
  const result = await service.search({ keywords: "ingenieure logiciel, data scientist", commune: "Paris", contractType: "CDI", limit: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, ["/api/job-board-api?page=1", "/api/job-board-api?page=2"]);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].url, "https://jobs.lever.co/entreprise/role");
  assert.equal(result.offers[0].sourceUrl, "https://www.arbeitnow.fr");
  assert.equal(result.offers[0].description.includes("ne pas indexer"), false);
  assert.match(result.note, /Arbeitnow/);
  await service.search({ keywords: "ingenieure logiciel", commune: "Paris", contractType: "CDI", limit: 1 });
  assert.equal(calls.length, 2, "cached pages should serve a repeated query");
});

test("Arbeitnow filters reject unsupported departments and validate response shape", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return response([row()]); };
  const service = new ArbeitnowFranceDiscovery(request);
  await assert.rejects(() => service.search({ keywords: "developer", department: "75" }), /filtre par ville/i);
  assert.equal((await service.search({ keywords: "ingenieure logiciel", contractType: "CDD" })).offers.length, 0);
  assert.equal(calls, 1);
  const invalid = new ArbeitnowFranceDiscovery(async () => Response.json({ unexpected: [] }));
  await assert.rejects(() => invalid.search({ keywords: "developer" }), /Réponse Arbeitnow invalide/i);
});

test("Arbeitnow search timeout is bounded and reported clearly", async () => {
  const request: typeof fetch = async (_input, init) => await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); }, { once: true });
  });
  await assert.rejects(() => new ArbeitnowFranceDiscovery(request, 5).search({ keywords: "engineer" }), /dépassé le délai/i);
});
