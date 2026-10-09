import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { FranceTravailDiscovery } from "../server/france-travail-discovery.ts";
import { CareerError, CareerStore } from "../server/career-store.ts";
import { Vault } from "../server/vault.ts";
import { handleCareerApi } from "../server/career-api.ts";

const criteria = { keywords: "développeur", department: "75", contractType: "CDI", limit: 300 };
function configuredVault() {
  const db = new DatabaseSync(":memory:");
  const vault = new Vault(db);
  vault.initialize("a long test passphrase");
  vault.saveFranceTravailConfig({ clientId: "client-id-sensitive", clientSecret: "client-secret-sensitive", scope: "scope-offres" });
  return { db, vault };
}
const offer = (id: string, title = "Développeur") => ({
  id, intitule: title, description: "Node.js", entreprise: { nom: "Entreprise" },
  lieuTravail: { libelle: "Paris" }, origineOffre: { urlOrigine: `https://candidat.francetravail.fr/offres/recherche/detail/${id}` },
});

test("France Travail config is encrypted in vault and summaries never disclose credentials", () => {
  const { db, vault } = configuredVault();
  const raw = Buffer.from((db.prepare("SELECT ciphertext FROM career_france_travail").get() as { ciphertext: Uint8Array }).ciphertext);
  assert.equal(raw.includes(Buffer.from("client-secret-sensitive")), false);
  assert.deepEqual(vault.franceTravailConfigSummary(), { configured: true, scope: "scope-offres", updatedAt: vault.getFranceTravailConfig().updatedAt });
  vault.lock();
  assert.deepEqual(vault.franceTravailConfigSummary().configured, true);
  assert.throws(() => vault.getFranceTravailConfig(), CareerError);
  vault.unlock("a long test passphrase");
  assert.equal(vault.getFranceTravailConfig().clientSecret, "client-secret-sensitive");
  vault.deleteFranceTravailConfig();
  assert.deepEqual(vault.franceTravailConfigSummary(), { configured: false });
  db.close();
});

test("search requests token, applies filters, paginates and deduplicates results", async () => {
  const { db, vault } = configuredVault();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("access_token")) {
      assert.equal(init.method, "POST");
      const body = String(init.body);
      assert.match(body, /grant_type=client_credentials/);
      assert.match(body, /client_secret=client-secret-sensitive/);
      assert.match(body, /scope=scope-offres/);
      return Response.json({ access_token: "test-bearer", expires_in: 3600 });
    }
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-bearer");
    const urlObject = new URL(url);
    if (urlObject.searchParams.get("range") === "0-149") return Response.json({ resultats: Array.from({ length: 150 }, (_, index) => offer(String(100 + index))) });
    assert.equal(urlObject.searchParams.get("range"), "150-299");
    return Response.json({ resultats: [offer("124", "Doublon"), offer("300")] });
  };
  const result = await new FranceTravailDiscovery(vault, request).search(criteria);
  assert.equal(result.offers.length, 151);
  assert.equal(result.offers.at(-1)?.url.endsWith("/300"), true);
  assert.match(result.note, /151 offre/);
  assert.equal(calls.length, 3);
  const searchUrl = new URL(calls[1].url);
  assert.equal(searchUrl.searchParams.get("motsCles"), "développeur");
  assert.equal(searchUrl.searchParams.get("departement"), "75");
  assert.equal(searchUrl.searchParams.get("typeContrat"), "CDI");
  db.close();
});

test("invalid geography is rejected before any network request", async () => {
  const { db, vault } = configuredVault();
  let requests = 0;
  const request: typeof fetch = async () => { requests++; return Response.json({}); };
  await assert.rejects(() => new FranceTravailDiscovery(vault, request).search({ keywords: "job", department: "PARIS" }), /département/i);
  await assert.rejects(() => new FranceTravailDiscovery(vault, request).search({ keywords: "job", commune: "7501" }), /commune/i);
  await assert.rejects(() => new FranceTravailDiscovery(vault, request).search({ keywords: " " }), /mot-clé/i);
  assert.equal(requests, 0);
  db.close();
});

test("commune names resolve through geo.api.gouv.fr; an INSEE code goes straight to job search", async () => {
  const { db, vault } = configuredVault();
  const calls: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.startsWith("https://geo.api.gouv.fr/communes")) return Response.json([{ code: "75056", nom: "Paris", codeDepartement: "75" }]);
    if (url.includes("access_token")) return Response.json({ access_token: "test-bearer" });
    return Response.json({ resultats: [offer("paris-1")] });
  };
  await new FranceTravailDiscovery(vault, request).search({ keywords: "développeur", commune: "Paris", department: "75" });
  assert.equal(new URL(calls.find((url) => url.includes("/offres/search"))!).searchParams.get("commune"), "75056");
  assert.match(calls.find((url) => url.startsWith("https://geo.api.gouv.fr"))!, /nom=Paris/);
  calls.length = 0;
  await new FranceTravailDiscovery(vault, request).search({ keywords: "développeur", commune: "75056" });
  assert.equal(calls.some((url) => url.startsWith("https://geo.api.gouv.fr")), false);
  assert.equal(new URL(calls.find((url) => url.includes("/offres/search"))!).searchParams.get("commune"), "75056");
  db.close();
});

test("Corsican departments and INSEE commune codes are accepted and geo ambiguity stays explicit", async () => {
  const { db, vault } = configuredVault();
  const calls: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.startsWith("https://geo.api.gouv.fr/communes")) {
      const search = new URL(url);
      if (search.searchParams.get("nom") === "Ajaccio") return Response.json([
        { code: "2A004", nom: "Ajaccio", codeDepartement: "2A" },
        { code: "2B004", nom: "Ajaccio", codeDepartement: "2B" },
      ]);
      return Response.json([{ code: "2B004", nom: "Ajaccio", codeDepartement: "2B" }]);
    }
    if (url.includes("access_token")) return Response.json({ access_token: "test-bearer" });
    return Response.json({ resultats: [offer("corsica-1")] });
  };
  const service = new FranceTravailDiscovery(vault, request);
  for (const department of ["2A", "2B"]) {
    calls.length = 0;
    await service.search({ keywords: "développeur", department, commune: "Ajaccio" });
    const geo = calls.find((url) => url.startsWith("https://geo.api.gouv.fr/communes"))!;
    const search = calls.find((url) => url.includes("/offres/search"))!;
    assert.equal(new URL(geo).searchParams.get("nom"), "Ajaccio");
    assert.equal(new URL(search).searchParams.get("departement"), department);
    assert.equal(new URL(search).searchParams.get("commune"), department === "2A" ? "2A004" : "2B004");
  }
  calls.length = 0;
  await service.search({ keywords: "développeur", department: "2A", commune: "2A004" });
  assert.equal(calls.some((url) => url.startsWith("https://geo.api.gouv.fr")), false);
  assert.equal(new URL(calls.find((url) => url.includes("/offres/search"))!).searchParams.get("commune"), "2A004");
  calls.length = 0;
  await assert.rejects(() => service.search({ keywords: "développeur", commune: "Ajaccio" }), /Plusieurs communes correspondent/);
  assert.equal(calls.some((url) => url.includes("access_token")), false);
  db.close();
});

test("career API route accepts Corsican department codes and rejects malformed ones", async (t) => {
  const db = new DatabaseSync(":memory:");
  const careerStore = new CareerStore(db);
  const vault = new Vault(db);
  const received: string[] = [];
  const server = createServer((req, res) => {
    void handleCareerApi(req, res, new URL(req.url || "/", "http://127.0.0.1"), {
      store: careerStore,
      vault,
      runner: { start() { throw new Error("unused"); }, isBusy: () => false, stop: async () => {} },
      discovery: {} as never,
      offerSearch: { search: async (criteria) => { received.push(criteria.department || ""); return { offers: [], note: "mock" }; } },
      demo: false,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const search = async (department: string) => fetch(`http://127.0.0.1:${address.port}/api/career/sources/france-travail/search`, {
    method: "POST", headers: { "content-type": "application/json", "x-anima-request": "1" }, body: JSON.stringify({ keywords: "développeur", department }),
  });
  for (const department of ["2A", "2B"]) assert.equal((await search(department)).status, 200);
  assert.deepEqual(received, ["2A", "2B"]);
  const invalid = await search("2C");
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { code: string }).code, "validation");
});

test("ambiguous city names are rejected without guessing", async () => {
  const { db, vault } = configuredVault(); let tokenCalls = 0;
  const request: typeof fetch = async (input) => {
    if (String(input).startsWith("https://geo.api.gouv.fr")) return Response.json([{ code: "75001", nom: "Saint-Denis", codeDepartement: "75" }, { code: "93200", nom: "Saint-Denis", codeDepartement: "93" }]);
    tokenCalls++; return Response.json({ access_token: "test-bearer" });
  };
  await assert.rejects(() => new FranceTravailDiscovery(vault, request).search({ keywords: "développeur", commune: "Saint-Denis" }), /Plusieurs communes correspondent/);
  assert.equal(tokenCalls, 0);
  db.close();
});

test("API errors and timeouts are sanitized and bounded", async () => {
  const { db, vault } = configuredVault();
  const denied: typeof fetch = async () => new Response("secret-secret-secret", { status: 401 });
  await assert.rejects(() => new FranceTravailDiscovery(vault, denied).search({ keywords: "job" }), /identifiants/);
  const slow: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
  await assert.rejects(() => new FranceTravailDiscovery(vault, slow, 5).search({ keywords: "job" }), /dépassé le délai/);
  db.close();
});
