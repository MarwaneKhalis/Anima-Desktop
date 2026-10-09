import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Application, ApplicationState, JobOffer, RunResult } from "../src/shared/career.ts";
import { CareerCampaignEngine, CareerCampaignStore } from "../server/career-campaign.ts";

const job = (n: number): JobOffer => ({ id: `job-${n}`, url: `https://example.test/${n}`, title: `Role ${n}`, company: "Fixture Corp", location: "Paris", description: "Fixture", sourceUrl: "", discoveredAt: "", updatedAt: "" });
const app = (id: string, state: ApplicationState = "draft"): Application => ({ id, jobId: id.slice(4), resumeId: "resume-fixture", prospectId: null, state, outcome: "active", answers: {}, missingFields: [], notes: "", nextActionAt: "", lastError: "", receipt: null, createdAt: "", updatedAt: "", submittedAt: null });
const submitted: RunResult = { state: "submitted", missingFields: [], message: "fixture receipt", receipt: { url: "https://example.test/thanks", text: "Received", reference: "FIXTURE", observedAt: new Date().toISOString() } };
class FixturePort {
  apps = new Map<string, Application>();
  calls = new Map<string, number>();
  credentialIds: (string | null | undefined)[] = [];
  handler: (id: string, signal: AbortSignal) => Promise<RunResult> = async () => submitted;
  createApplication(jobId: string, _resumeId: string) { const id = `app-${jobId}`; const existing = this.apps.get(id); if (existing) return existing; const created = app(id); this.apps.set(id, created); return created; }
  getApplication(id: string) { const value = this.apps.get(id); if (!value) throw new Error("fixture app missing"); return value; }
  async run(id: string, signal: AbortSignal, credentialId?: string | null) { this.credentialIds.push(credentialId); this.calls.set(id, (this.calls.get(id) ?? 0) + 1); const result = await this.handler(id, signal); if (result.state === "submitted") this.apps.set(id, { ...this.getApplication(id), state: "submitted" }); else if (result.state === "uncertain") this.apps.set(id, { ...this.getApplication(id), state: "uncertain" }); else if (result.state === "needs_input" || result.state === "blocked") this.apps.set(id, { ...this.getApplication(id), state: result.state }); return result; }
}
function persistent() {
  const dir = mkdtempSync(join(tmpdir(), "anima-campaign-")), path = join(dir, "campaign.sqlite");
  const open = () => { const db = new DatabaseSync(path); db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL"); return { db, store: new CareerCampaignStore(db) }; };
  return { open, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
const create = (store: CareerCampaignStore, port: FixturePort, count = 3, cap = 10) => {
  const offers = Array.from({ length: count }, (_, i) => job(i + 1));
  const campaign = new CareerCampaignEngine(store, port).createFromOffers(offers, "resume-fixture", cap, `fixture-${count}-${cap}`);
  return campaign;
};

test("crash/restart with an uncertain submission pauses the batch and never sends later offers", async () => {
  const disk = persistent(), port = new FixturePort(); let first = disk.open();
  const campaign = create(first.store, port, 2);
  first.store.requestStart(campaign.id);
  first.store.activateRequested(campaign.id);
  const claimed = first.store.claimNext(campaign.id, 1)!;
  port.apps.set(claimed.applicationId, { ...port.getApplication(claimed.applicationId), state: "submitting" });
  first.db.close();
  first = disk.open();
  const engine = new CareerCampaignEngine(first.store, port);
  await engine.recoverAfterRestart();
  assert.equal(first.store.get(campaign.id).state, "paused");
  assert.equal(first.store.listItems(campaign.id)[0].state, "uncertain");
  assert.equal(port.calls.size, 0);
  assert.equal(port.calls.get(claimed.applicationId), undefined);
  assert.equal(first.store.listItems(campaign.id)[1].state, "pending");
  assert.equal(first.store.listItems(campaign.id).filter(x => x.state === "submitted").length, 0);
  first.db.close(); disk.dispose();
});

test("one item requiring input and one thrown error do not stop the following applications", async () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  port.handler = async id => { if (id === "app-job-1") return { state: "needs_input", missingFields: [], message: "MFA fixture", receipt: null }; if (id === "app-job-2") throw new Error("fixture timeout"); return submitted; };
  const campaign = create(store, port);
  await new CareerCampaignEngine(store, port).start(campaign.id);
  assert.deepEqual(store.listItems(campaign.id).map(x => x.state), ["needs_input", "failed", "submitted"]);
  db.close(); disk.dispose();
});

test("offers and application creation are idempotent when a crash separates persistence steps", () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  const campaign = store.create("resume-fixture", 5), engine = new CareerCampaignEngine(store, port);
  assert.equal(engine.addOffers(campaign.id, [job(1), job(2)]), 2);
  assert.equal(engine.addOffers(campaign.id, [job(1), job(2)]), 0);
  assert.equal(port.apps.size, 2); assert.equal(store.listItems(campaign.id).length, 2);
  db.close(); disk.dispose();
});

test("retry with the same idempotency key completes one partially built batch", () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  const engine = new CareerCampaignEngine(store, port), offers = [job(1), job(2), job(3)];
  const createApplication = port.createApplication.bind(port); let crash = true;
  port.createApplication = (jobId, resumeId) => { if (jobId === "job-2" && crash) { crash = false; throw new Error("simulated crash"); } return createApplication(jobId, resumeId); };
  assert.throws(() => engine.createFromOffers(offers, "resume-fixture", 5, "stable-batch-key"), /simulated crash/);
  const partial = store.get(store.create("resume-fixture", 5, "stable-batch-key").id);
  assert.equal(partial.state, "building"); assert.equal(store.listItems(partial.id).length, 1);
  assert.throws(() => engine.createFromOffers([job(1)], "resume-fixture", 5, "stable-batch-key"), /liste d’offres différente/);
  assert.throws(() => engine.createFromOffers([...offers, job(4)], "resume-fixture", 5, "stable-batch-key"), /liste d’offres différente/);
  const completed = engine.createFromOffers(offers, "resume-fixture", 5, "stable-batch-key");
  assert.equal(completed.id, partial.id); assert.equal(completed.state, "queued");
  assert.equal(store.listItems(completed.id).length, 3); assert.equal(port.apps.size, 3);
  assert.equal(engine.createFromOffers(offers, "resume-fixture", 5, "stable-batch-key").id, completed.id);
  assert.throws(() => engine.createFromOffers([job(4)], "resume-fixture", 5, "stable-batch-key"), /liste d’offres différente/);
  assert.throws(() => engine.createFromOffers([job(1), job(2)], "resume-fixture", 5, "stable-batch-key"), /liste d’offres différente/);
  assert.throws(() => store.create("another-resume", 5, "stable-batch-key"), /CV, un compte ou un plafond/);
  db.close(); disk.dispose();
});

test("campaign preserves discovery rank and binds retries to the same order", () => {
  const db = new DatabaseSync(":memory:"), store = new CareerCampaignStore(db), port = new FixturePort();
  const engine = new CareerCampaignEngine(store, port), ranked = [job(3), job(1), job(2)];
  const campaign = engine.createFromOffers(ranked, "resume-fixture", 1, "ranked-offers");
  assert.deepEqual(store.listItems(campaign.id).map(item => item.jobId), ["job-3", "job-1", "job-2"]);
  assert.throws(() => engine.createFromOffers([job(1), job(3), job(2)], "resume-fixture", 1, "ranked-offers"), /liste d’offres différente/);
  store.requestStart(campaign.id); store.activateRequested(campaign.id);
  assert.equal(store.claimNext(campaign.id, 1)?.jobId, "job-3");
  db.close();
});

test("an acknowledged start persisted while queued is recovered and resumed after restart", async () => {
  const disk = persistent(), port = new FixturePort(); let first = disk.open();
  const campaign = create(first.store, port, 2);
  first.store.requestStart(campaign.id); // crash in the gap before activation/first queue claim
  assert.equal(first.store.get(campaign.id).state, "queued");
  first.db.close(); first = disk.open();
  await new CareerCampaignEngine(first.store, port).recoverAfterRestart();
  assert.equal(first.store.get(campaign.id).state, "completed");
  assert.equal(first.store.listItems(campaign.id).filter(x => x.state === "submitted").length, 2);
  first.db.close(); disk.dispose();
});

test("a manually paused campaign reconciles interrupted items but stays paused", async () => {
  const disk = persistent(), port = new FixturePort(); let first = disk.open();
  const campaign = create(first.store, port, 2);
  first.store.requestStart(campaign.id); first.store.activateRequested(campaign.id);
  const one = first.store.claimNext(campaign.id, 2)!, two = first.store.claimNext(campaign.id, 2)!;
  port.apps.set(one.applicationId, { ...port.getApplication(one.applicationId), state: "submitting" });
  port.apps.set(two.applicationId, { ...port.getApplication(two.applicationId), state: "running" });
  first.store.setState(campaign.id, "paused");
  first.db.close(); first = disk.open();
  const engine = new CareerCampaignEngine(first.store, port);
  await engine.recoverAfterRestart();
  assert.equal(first.store.get(campaign.id).state, "paused");
  assert.deepEqual(first.store.listItems(campaign.id).map(item => item.state), ["uncertain", "pending"]);
  assert.equal(port.calls.size, 0);
  first.db.close(); disk.dispose();
});

test("a manual pause clears automatic resume intent and stays paused after skip", async () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  const campaign = create(store, port, 2), engine = new CareerCampaignEngine(store, port);
  store.requestStart(campaign.id); store.activateRequested(campaign.id);
  engine.pause(campaign.id); // User pause, not a browser-blocked pause.
  assert.equal(store.get(campaign.id).startRequested, false);
  const item = store.listItems(campaign.id)[0];
  engine.skipItem(campaign.id, item.id, "Skip fixture");
  assert.equal(store.get(campaign.id).state, "paused");
  assert.equal(store.get(campaign.id).startRequested, false);
  assert.equal(port.calls.size, 0);
  await engine.start(campaign.id);
  assert.equal(store.get(campaign.id).state, "completed");
  assert.equal(port.calls.size, 1);
  db.close(); disk.dispose();
});

test("skipping the final eligible item settles a blocked campaign instead of leaving Resume stale", () => {
  const db = new DatabaseSync(":memory:"), store = new CareerCampaignStore(db), port = new FixturePort();
  const campaign = create(store, port, 1), engine = new CareerCampaignEngine(store, port);
  const item = store.listItems(campaign.id)[0];
  store.finish(item.id, "needs_input", "blocked fixture");
  store.requestStart(campaign.id); store.activateRequested(campaign.id); engine.pause(campaign.id, true);
  engine.skipItem(campaign.id, item.id, "Skip final offer");
  assert.equal(store.get(campaign.id).state, "completed");
  db.close();
});

test("uncertain result halts the batch until a human resolves it; not_submitted is never replayed", async () => {
  const db = new DatabaseSync(":memory:"), store = new CareerCampaignStore(db), port = new FixturePort();
  port.handler = async id => id === "app-job-1"
    ? { state: "uncertain", missingFields: [], message: "No receipt", receipt: null }
    : submitted;
  const campaign = create(store, port, 2, 5), engine = new CareerCampaignEngine(store, port);
  await engine.start(campaign.id);
  assert.equal(store.get(campaign.id).state, "paused");
  assert.deepEqual(store.listItems(campaign.id).map(item => item.state), ["uncertain", "pending"]);
  assert.equal(port.calls.size, 1);
  await assert.rejects(() => engine.start(campaign.id), /incertain/);

  port.apps.set("app-job-1", { ...port.getApplication("app-job-1"), state: "draft" }); // human resolved not_submitted
  engine.reconcile(campaign.id);
  assert.deepEqual(store.listItems(campaign.id).map(item => item.state), ["failed", "pending"]);
  assert.match(store.listItems(campaign.id)[0].error, /ne sera pas relancé automatiquement/);
  assert.equal(store.get(campaign.id).state, "paused");
  await engine.start(campaign.id);
  assert.equal(port.calls.get("app-job-1"), 1);
  assert.equal(port.calls.get("app-job-2"), 1);
  db.close();
});

test("exception after the durable submitting marker becomes uncertain and halts later offers", async () => {
  const db = new DatabaseSync(":memory:"), store = new CareerCampaignStore(db), port = new FixturePort();
  port.handler = async id => {
    port.apps.set(id, { ...port.getApplication(id), state: "uncertain" });
    throw new Error("connection lost after submit marker");
  };
  const campaign = create(store, port, 2, 5), engine = new CareerCampaignEngine(store, port);
  await engine.start(campaign.id);
  assert.equal(store.get(campaign.id).state, "paused");
  assert.deepEqual(store.listItems(campaign.id).map(item => item.state), ["uncertain", "pending"]);
  assert.equal(port.calls.size, 1);
  db.close();
});

test("manual submitted resolution reconciles an uncertain campaign item and counts it toward the cap", () => {
  const db = new DatabaseSync(":memory:"), store = new CareerCampaignStore(db), port = new FixturePort();
  const campaign = create(store, port, 2, 1), engine = new CareerCampaignEngine(store, port);
  const [uncertainItem, pendingItem] = store.listItems(campaign.id);
  port.apps.set(uncertainItem.applicationId, { ...port.getApplication(uncertainItem.applicationId), state: "uncertain" });
  store.finish(uncertainItem.id, "uncertain", "check receipt");
  store.setState(campaign.id, "paused");
  port.apps.set(uncertainItem.applicationId, { ...port.getApplication(uncertainItem.applicationId), state: "submitted" }); // human confirmed submitted
  engine.reconcile(campaign.id);
  assert.equal(store.listItems(campaign.id)[0].state, "submitted");
  assert.equal(store.counts(campaign.id).submitted, 1);
  assert.equal(store.listItems(campaign.id)[1].state, "pending");
  assert.equal(store.get(campaign.id).state, "limit_reached");
  db.close();
});

test("restart request while a paused pump still has a worker is not lost", async () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  const releases: ((value: RunResult) => void)[] = [];
  port.handler = () => new Promise(resolve => releases.push(resolve));
  const campaign = create(store, port, 2), engine = new CareerCampaignEngine(store, port);
  const original = engine.start(campaign.id);
  while (releases.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
  engine.pause(campaign.id);
  const resumed = engine.start(campaign.id);
  assert.equal(store.get(campaign.id).state, "running");
  releases[0](submitted);
  while (releases.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  releases[1](submitted);
  await Promise.all([original, resumed]);
  assert.equal(store.get(campaign.id).state, "completed");
  assert.equal(store.listItems(campaign.id).filter(x => x.state === "submitted").length, 2);
  db.close(); disk.dispose();
});

test("ready without a submission cannot be re-queued into an endless loop", async () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  let calls = 0;
  port.handler = async () => { calls++; return { state: "ready", missingFields: [], message: "Fill completed, send not attempted", receipt: null }; };
  const campaign = create(store, port, 1);
  await new CareerCampaignEngine(store, port).start(campaign.id);
  assert.equal(calls, 1); assert.equal(store.listItems(campaign.id)[0].state, "failed");
  db.close(); disk.dispose();
});

test("pause finishes only active work and explicit stop never restarts", async () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  let release!: (value: RunResult) => void;
  port.handler = () => new Promise(resolve => { release = resolve; });
  const campaign = create(store, port, 2), engine = new CareerCampaignEngine(store, port);
  const running = engine.start(campaign.id);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  engine.pause(campaign.id); release(submitted); await running;
  assert.equal(store.get(campaign.id).state, "paused"); assert.equal(store.listItems(campaign.id)[1].state, "pending");
  const resume = engine.start(campaign.id); while (store.listItems(campaign.id)[1].state !== "running") await new Promise(resolve => setTimeout(resolve, 1));
  const stopping = engine.stop(campaign.id); release(submitted); await stopping; await resume;
  assert.equal(store.get(campaign.id).state, "stopped");
  await engine.start(campaign.id); // terminal start retries are idempotent no-ops
  assert.equal(port.calls.size, 2);
  assert.throws(() => engine.addOffers(campaign.id, [job(9)]), /refusé/);
  db.close(); disk.dispose();
});

test("submission ceiling is enforced and concurrent workers never exceed configured limit", async () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  let active = 0, peak = 0;
  port.handler = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 4)); active--; return submitted; };
  const campaign = create(store, port, 5, 2);
  await new CareerCampaignEngine(store, port, { concurrency: 2 }).start(campaign.id);
  assert.equal(peak, 2); assert.equal(store.get(campaign.id).state, "limit_reached");
  assert.equal(store.listItems(campaign.id).filter(x => x.state === "submitted").length, 2);
  assert.equal(store.listItems(campaign.id).filter(x => x.state === "pending").length, 3);
  db.close(); disk.dispose();
});

test("concurrency limit is global across campaigns", async () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  let active = 0, peak = 0;
  port.handler = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return submitted; };
  const engine = new CareerCampaignEngine(store, port, { concurrency: 2 });
  const first = engine.createFromOffers([job(1), job(2), job(3)], "resume-fixture", 5, "global-one");
  const second = engine.createFromOffers([job(11), job(12), job(13)], "resume-fixture", 5, "global-two");
  await Promise.all([engine.start(first.id), engine.start(second.id)]);
  assert.equal(peak, 2);
  assert.equal(store.listItems(first.id).filter(x => x.state === "submitted").length, 3);
  assert.equal(store.listItems(second.id).filter(x => x.state === "submitted").length, 3);
  db.close(); disk.dispose();
});

test("pauseAll persists pause for every active campaign and waitAll drains workers", async () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  let release!: (value: RunResult) => void;
  port.handler = () => new Promise(resolve => { release = resolve; });
  const engine = new CareerCampaignEngine(store, port, { concurrency: 1 });
  const first = engine.createFromOffers([job(1)], "resume-fixture", 1, "shutdown-one");
  const second = engine.createFromOffers([job(2)], "resume-fixture", 1, "shutdown-two");
  void engine.start(first.id); void engine.start(second.id);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  engine.pauseAll();
  assert.equal(store.get(first.id).state, "paused"); assert.equal(store.get(second.id).state, "paused");
  let drained = false; const wait = engine.waitAll().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(drained, false);
  release(submitted); await wait;
  assert.equal(drained, true); assert.equal(store.listItems(second.id)[0].state, "pending");
  db.close(); disk.dispose();
});

test("configuration rejects invalid concurrency and submission ceilings", () => {
  const disk = persistent(), { db, store } = disk.open(), port = new FixturePort();
  assert.throws(() => new CareerCampaignEngine(store, port, { concurrency: 5 }));
  assert.throws(() => store.create("resume", 0)); assert.throws(() => store.create("resume", 501));
  db.close(); disk.dispose();
});

test("campaign schema migration adds durable idempotency and start-intent columns", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE career_campaigns(id TEXT PRIMARY KEY,resume_id TEXT NOT NULL,max_submissions INTEGER NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE career_campaign_items(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES career_campaigns(id) ON DELETE CASCADE,application_id TEXT NOT NULL,job_id TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(campaign_id,job_id),UNIQUE(campaign_id,application_id));
    INSERT INTO career_campaigns VALUES ('legacy','resume-fixture',4,'queued','2026-10-01','2026-10-01');`);
  const store = new CareerCampaignStore(db);
  assert.equal(store.get("legacy").idempotencyKey, "");
  assert.equal(store.get("legacy").startRequested, false);
  assert.equal(store.get("legacy").credentialId, null);
  assert.equal(store.create("resume-fixture", 2, "new-uuid-key").state, "building");
  db.close();
});

test("expected job set migration preserves legacy queue and only permits an exact retry", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE career_campaigns(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,resume_id TEXT NOT NULL,credential_id TEXT NOT NULL DEFAULT '',max_submissions INTEGER NOT NULL,state TEXT NOT NULL,start_requested INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE career_campaign_items(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES career_campaigns(id) ON DELETE CASCADE,application_id TEXT NOT NULL,job_id TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(campaign_id,job_id),UNIQUE(campaign_id,application_id));
    INSERT INTO career_campaigns VALUES ('legacy-building','legacy-key','resume-fixture','',4,'building',0,'2026-10-01','2026-10-01');
    INSERT INTO career_campaign_items VALUES ('legacy-item','legacy-building','app-job-1','job-1','pending','','2026-10-01','2026-10-01');`);
  const store = new CareerCampaignStore(db), engine = new CareerCampaignEngine(store, new FixturePort());
  assert.deepEqual(store.expectedJobIds("legacy-building"), ["job-1"]);
  assert.equal(store.listItems("legacy-building").length, 1);
  assert.throws(() => engine.createFromOffers([job(1), job(2)], "resume-fixture", 4, "legacy-key"), /liste d’offres différente|file existante ne permet pas/);
  assert.equal(engine.createFromOffers([job(1)], "resume-fixture", 4, "legacy-key").state, "queued");
  assert.equal(store.listItems("legacy-building").length, 1);
  db.close();
});

test("campaign sends its persisted account choice to each runner invocation", async () => {
  const db = new DatabaseSync(":memory:"), store = new CareerCampaignStore(db), port = new FixturePort();
  const campaign = new CareerCampaignEngine(store, port).createFromOffers([job(1)], "resume-fixture", 1, "selected-account", "credential-fixture");
  await new CareerCampaignEngine(store, port).start(campaign.id);
  assert.deepEqual(port.credentialIds, ["credential-fixture"]);
  db.close();
});

test("list ordering, hard limit and durable per-state counts", () => {
  const db = new DatabaseSync(":memory:"), store = new CareerCampaignStore(db), port = new FixturePort();
  for (let i = 0; i < 101; i++) store.create("resume-fixture", 1, `list-key-${i}`);
  assert.equal(store.list().length, 50);
  assert.equal(store.list(100).length, 100);
  assert.throws(() => store.list(101), /1–100/);
  const campaign = new CareerCampaignEngine(store, port).createFromOffers([job(1), job(2)], "resume-fixture", 5, "count-key");
  const counts = store.counts(campaign.id);
  assert.equal(counts.total, 2); assert.equal(counts.pending, 2); assert.equal(counts.submitted, 0);
  db.close();
});
