import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { isProtectedText } from "../server/data-protection.ts";
import { CareerStore } from "../server/career-store.ts";
import { CareerSearchScheduler } from "../server/career-search-scheduler.ts";
import type { JobOffer, OfferSearchService } from "../src/shared/career.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const store = new CareerStore(db, { dataProtectionKey: randomBytes(32) });
  return { db, store };
}
const offer: Omit<JobOffer, "id" | "discoveredAt" | "updatedAt"> = {
  url: "https://example.org/jobs/role-1", title: "Développeuse TypeScript", company: "Example", location: "Paris", description: "Public fixture", sourceUrl: "https://example.org/jobs",
};

test("saved recurring searches encrypt criteria, retain scheduling state and accept supported intervals only", () => {
  const { db, store } = fixture();
  const saved = store.saveSavedSearch({ source: "arbeitnow", criteria: { keywords: "TypeScript", commune: "Paris", limit: 20 }, intervalHours: 12 });
  assert.equal(saved.enabled, true);
  assert.equal(Date.parse(saved.nextRunAt) <= Date.now(), true, "first collection is due immediately");
  assert.deepEqual(store.getSavedSearch(saved.id).criteria, { keywords: "TypeScript", commune: "Paris", limit: 20 });
  assert.ok(isProtectedText(db.prepare("SELECT criteria FROM career_saved_searches WHERE id=?").get(saved.id)?.criteria));
  const paused = store.saveSavedSearch({ source: saved.source, criteria: saved.criteria, intervalHours: saved.intervalHours, enabled: false }, saved.id);
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, "");
  const resumed = store.saveSavedSearch({ source: paused.source, criteria: paused.criteria, intervalHours: 168, enabled: true }, paused.id);
  assert.equal(resumed.intervalHours, 168);
  assert.equal(Date.parse(resumed.nextRunAt) <= Date.now(), true, "reactivation or cadence change schedules a fresh collection");
  assert.throws(() => store.saveSavedSearch({ source: "france-travail", criteria: { keywords: "Test" }, intervalHours: 12 }), /Source de recherche/);
  assert.throws(() => store.saveSavedSearch({ source: "all", criteria: { keywords: "Test" }, intervalHours: 2 }), /fréquence/);
  db.close();
});

test("due search collection saves offers locally and will not replay until the next cadence", async () => {
  const { db, store } = fixture();
  const search = store.saveSavedSearch({ source: "arbeitnow", criteria: { keywords: "TypeScript" }, intervalHours: 6 });
  const scheduledAt = new Date(Date.now() + 1000).toISOString();
  db.prepare("UPDATE career_saved_searches SET next_run_at=? WHERE id=?").run(new Date(Date.parse(scheduledAt) - 1000).toISOString(), search.id);
  let calls = 0;
  const service: OfferSearchService = { search: async criteria => { calls++; assert.equal(criteria.keywords, "TypeScript"); return { offers: [offer], note: "fixture" }; } };
  const scheduler = new CareerSearchScheduler(() => store, { arbeitnow: service });
  assert.equal(await scheduler.runDue(scheduledAt), 1);
  assert.equal(calls, 1);
  assert.equal(store.listJobs().length, 1);
  const completed = store.getSavedSearch(search.id);
  assert.equal(completed.lastResultCount, 1);
  assert.equal(completed.lastRunAt, scheduledAt);
  assert.equal(completed.lastError, "");
  assert.equal(await scheduler.runDue(scheduledAt), 0);
  assert.equal(calls, 1);
  db.close();
});

test("feed failures are sanitized and a disabled search cannot be collected on demand", async () => {
  const { db, store } = fixture();
  const search = store.saveSavedSearch({ source: "remotive", criteria: { keywords: "Engineer" }, intervalHours: 24 });
  const service: OfferSearchService = { search: async () => { throw new Error("private URL token=secret"); } };
  const scheduler = new CareerSearchScheduler(() => store, { remotive: service });
  const result = await scheduler.runNow(search.id);
  assert.equal(result.lastResultCount, 0);
  assert.doesNotMatch(result.lastError, /secret|token|URL/);
  store.saveSavedSearch({ source: result.source, criteria: result.criteria, intervalHours: result.intervalHours, enabled: false }, result.id);
  await assert.rejects(() => scheduler.runNow(result.id), /désactivée/);
  db.close();
});

test("partial public-feed failures remain visible without storing upstream note text", async () => {
  const { db, store } = fixture();
  const search = store.saveSavedSearch({ source: "all", criteria: { keywords: "Designer" }, intervalHours: 12 });
  const service: OfferSearchService = { search: async () => ({ offers: [offer], note: "Remote OK : source indisponible. Raw token=must-not-leak" }) };
  const scheduler = new CareerSearchScheduler(() => store, { all: service });
  const result = await scheduler.runNow(search.id);
  assert.equal(result.lastResultCount, 1);
  assert.match(result.lastError, /Collecte partielle.*Remote OK/);
  assert.doesNotMatch(result.lastError, /token|must-not-leak|Raw/);
  db.close();
});

test("stopping the scheduler blocks new manual runs and drains the active collection", async () => {
  const { db, store } = fixture();
  const search = store.saveSavedSearch({ source: "arbeitnow", criteria: { keywords: "Engineer" }, intervalHours: 6 });
  let finish!: (value: { offers: []; note: string }) => void;
  const service: OfferSearchService = { search: () => new Promise(resolve => { finish = resolve; }) };
  const scheduler = new CareerSearchScheduler(() => store, { arbeitnow: service });
  const run = scheduler.runNow(search.id);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const stopping = scheduler.stop();
  assert.equal(scheduler.isStopped(), true);
  await assert.rejects(() => scheduler.runNow(search.id), /maintenance/);
  assert.equal(await scheduler.runDue(), 0);
  finish({ offers: [], note: "" });
  await stopping;
  await run;
  scheduler.start(60_000);
  assert.equal(scheduler.isStopped(), false);
  await scheduler.stop();
  db.close();
});
