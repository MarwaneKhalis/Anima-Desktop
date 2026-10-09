import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { CareerCampaignEngine, CareerCampaignStore } from "../server/career-campaign.ts";
import { CareerStore } from "../server/career-store.ts";
import { handleCareerCampaignApi, type CareerCampaignApiContext } from "../server/career-campaign-api.ts";
import type { Application, JobOffer, RunResult } from "../src/shared/career.ts";

const result: RunResult = { state: "submitted", message: "fixture receipt", missingFields: [], receipt: { url: "https://jobs.example.test/thanks", text: "Received", reference: "TEST-42", observedAt: new Date().toISOString() } };
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
const input = { resumeId: "", jobIds: [] as string[], maxSubmissions: 10, idempotencyKey: "stable-test-key" };
class FixturePort {
  runCount = 0;
  release: ((value: RunResult) => void) | null = null;
  private readonly store: CareerStore;
  private readonly deferred: boolean;
  constructor(store: CareerStore, deferred = false) { this.store = store; this.deferred = deferred; }
  createApplication(jobId: string, resumeId: string): Application { return this.store.createApplication({ jobId, resumeId }); }
  getApplication(id: string): Application { return this.store.getApplication(id); }
  async run(id: string, _signal: AbortSignal): Promise<RunResult> {
    this.runCount++;
    this.store.claimRun(id); this.store.markSubmitting(id);
    const value = this.deferred ? await new Promise<RunResult>(resolve => { this.release = resolve; }) : result;
    this.store.finishRun(id, value);
    return value;
  }
}
async function setup(demo = false, deferred = false) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE prospects(id TEXT PRIMARY KEY);");
  const careerStore = new CareerStore(db);
  const resume = careerStore.saveResume({ name: "Fixture CV", filename: "fixture.pdf", mime: "application/pdf", bytes: pdf });
  const job: JobOffer = careerStore.saveJob({ url: "https://jobs.example.test/apply/1", title: "Engineer", company: "Fixture", location: "Paris", description: "Test only" });
  const campaigns = new CareerCampaignStore(db), port = new FixturePort(careerStore, deferred);
  const engine = new CareerCampaignEngine(campaigns, port, { concurrency: 1 });
  const closedPausedApplications: string[] = [];
  const context: CareerCampaignApiContext = { careerStore, campaigns, engine, demo, credentialExists: (id) => ["credential-fixture", "other-fixture"].includes(id), closePausedRunnerFor: async (applicationId) => { closedPausedApplications.push(applicationId); } };
  const server = createServer(async (req, res) => {
    const handled = await handleCareerCampaignApi(req, res, new URL(req.url || "/", "http://127.0.0.1"), context);
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => { engine.pauseAll(); await engine.waitAll(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); };
  const call = (path: string, method = "GET", bodyValue?: unknown, csrf = true) => fetch(`${base}${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "Content-Type": "application/json", ...(csrf ? { "X-Anima-Request": "1" } : {}) } : {}) },
    ...(method !== "GET" ? { body: JSON.stringify(bodyValue ?? {}) } : {}),
  });
  return { db, careerStore, campaigns, port, engine, resume, job, context, closedPausedApplications, close, call };
}

test("HTTP create/list/detail validate CSRF, idempotency, bounds and counts", async t => {
  const app = await setup(); t.after(app.close);
  assert.equal((await app.call("/api/career/campaigns", "POST", input, false)).status, 403);
  const payload = { resumeId: app.resume.id, jobIds: [app.job.id], maxSubmissions: 2, idempotencyKey: "api-key-one" };
  const created = await app.call("/api/career/campaigns", "POST", payload);
  assert.equal(created.status, 201);
  const detail = await created.json() as { campaign: { id: string; state: string; counts: { total: number; pending: number } }; items: unknown[] };
  assert.equal(detail.campaign.state, "queued"); assert.deepEqual(detail.campaign.counts, { total: 1, pending: 1, running: 0, submitted: 0, needsInput: 0, uncertain: 0, failed: 0, skipped: 0 });
  assert.equal(detail.items.length, 1);
  const repeated = await app.call("/api/career/campaigns", "POST", payload);
  assert.equal((await repeated.json() as typeof detail).campaign.id, detail.campaign.id);
  assert.equal(app.campaigns.listItems(detail.campaign.id).length, 1);
  const list = await app.call("/api/career/campaigns?limit=10");
  assert.equal(list.status, 200); assert.equal(((await list.json()) as { campaigns: unknown[] }).campaigns.length, 1);
  assert.equal((await app.call(`/api/career/campaigns/${detail.campaign.id}`)).status, 200);
  assert.equal((await app.call("/api/career/campaigns?limit=101")).status, 400);
  assert.equal((await app.call("/api/career/campaigns/no-such-campaign")).status, 404);
  assert.equal((await app.call("/api/career/campaigns", "POST", { ...payload, maxSubmissions: 0 })).status, 400);
  assert.equal((await app.call("/api/career/campaigns", "POST", { ...payload, jobIds: ["00000000-0000-4000-8000-000000000000"] })).status, 404);
  assert.equal((await app.call("/api/career/campaigns", "POST", { ...payload, jobIds: Array.from({ length: 451 }, (_, index) => `unknown-${index}`) })).status, 400);
});

test("campaign persists selected career account and includes it in idempotency", async t => {
  const app = await setup(); t.after(app.close);
  const payload = { resumeId: app.resume.id, jobIds: [app.job.id], maxSubmissions: 2, idempotencyKey: "account-key", credentialId: "credential-fixture" };
  const created = await app.call("/api/career/campaigns", "POST", payload);
  assert.equal(created.status, 201);
  const detail = await created.json() as { campaign: { credentialId: string | null } };
  assert.equal(detail.campaign.credentialId, "credential-fixture");
  assert.equal((await app.call("/api/career/campaigns", "POST", { ...payload, credentialId: "not-saved" })).status, 404);
  assert.equal((await app.call("/api/career/campaigns", "POST", { ...payload, credentialId: "other-fixture" })).status, 409);
  assert.equal((await app.call("/api/career/campaigns", "POST", { ...payload, credentialId: "" })).status, 409);
});

test("campaign detail reconciles a human-confirmed uncertain submission and updates the cap", async t => {
  const app = await setup(); t.after(app.close);
  const job2 = app.careerStore.saveJob({ url: "https://jobs.example.test/apply/2", title: "Engineer 2", company: "Fixture", location: "Paris" });
  const campaign = app.engine.createFromOffers([app.job, job2], app.resume.id, 1, "manual-resolution");
  const [item] = app.campaigns.listItems(campaign.id);
  app.careerStore.claimRun(item.applicationId);
  app.careerStore.markSubmitting(item.applicationId);
  app.careerStore.finishRun(item.applicationId, { state: "uncertain", message: "Connection lost", missingFields: [], receipt: null });
  app.campaigns.finish(item.id, "uncertain", "Check application");
  app.campaigns.setState(campaign.id, "paused");
  app.careerStore.resolveUncertain(item.applicationId, { resolution: "submitted", detail: "Confirmation email received" });
  const response = await app.call(`/api/career/campaigns/${campaign.id}`);
  const detail = await response.json() as { campaign: { state: string; counts: { submitted: number; pending: number } }; items: { id: string; state: string }[] };
  assert.equal(detail.items.find(value => value.id === item.id)?.state, "submitted");
  assert.equal(detail.campaign.counts.submitted, 1);
  assert.equal(detail.campaign.counts.pending, 1);
  assert.equal(detail.campaign.state, "limit_reached");
  assert.equal(app.port.runCount, 0);
});

test("start reconciles a human-resolved uncertain item before checking whether it can resume", async t => {
  const app = await setup(); t.after(app.close);
  const job2 = app.careerStore.saveJob({ url: "https://jobs.example.test/apply/2", title: "Engineer 2", company: "Fixture", location: "Paris" });
  const campaign = app.engine.createFromOffers([app.job, job2], app.resume.id, 2, "resume-after-resolution");
  const [item] = app.campaigns.listItems(campaign.id);
  app.careerStore.claimRun(item.applicationId);
  app.careerStore.markSubmitting(item.applicationId);
  app.careerStore.finishRun(item.applicationId, { state: "uncertain", message: "Connection lost", missingFields: [], receipt: null });
  app.campaigns.finish(item.id, "uncertain", "Check application");
  app.campaigns.requestStart(campaign.id); app.campaigns.activateRequested(campaign.id); app.engine.pause(campaign.id, true);
  app.careerStore.resolveUncertain(item.applicationId, { resolution: "not_submitted", detail: "Verified no confirmation" });

  const resumed = await app.call(`/api/career/campaigns/${campaign.id}/start`, "POST");
  assert.equal(resumed.status, 202);
  await app.engine.wait(campaign.id);
  assert.equal(app.campaigns.listItems(campaign.id)[0].state, "failed");
  assert.equal(app.campaigns.listItems(campaign.id)[1].state, "submitted");
  assert.equal(app.port.runCount, 1, "Only the pending second offer can be submitted after resolution.");
});

test("campaign can skip a blocked application and closes its held browser session first", async t => {
  const app = await setup(); t.after(app.close);
  const campaign = app.engine.createFromOffers([app.job], app.resume.id, 1, "skip-key");
  const item = app.campaigns.listItems(campaign.id)[0];
  app.careerStore.claimRun(item.applicationId);
  app.careerStore.finishRun(item.applicationId, { state: "blocked", message: "CAPTCHA", missingFields: [], receipt: null });
  app.campaigns.finish(item.id, "needs_input", "CAPTCHA");
  app.campaigns.requestStart(campaign.id);
  app.campaigns.activateRequested(campaign.id);
  app.campaigns.setState(campaign.id, "paused");
  const skipped = await app.call(`/api/career/campaigns/${campaign.id}/items/${item.id}/skip`, "POST", { reason: "Site non compatible." });
  assert.equal(skipped.status, 200);
  const detail = await skipped.json() as { campaign: { state: string }; items: { state: string; error: string }[] };
  assert.equal(detail.items[0].state, "skipped");
  assert.equal(detail.items[0].error, "Site non compatible.");
  assert.equal(detail.campaign.state, "completed");
  assert.deepEqual(app.closedPausedApplications, [item.applicationId]);
  assert.equal((await app.call(`/api/career/campaigns/${campaign.id}/items/${item.id}/skip`, "POST", {})).status, 409);
});

test("skip does not restart a manually paused campaign or consume pending work while browser is busy", async t => {
  const app = await setup(); t.after(app.close);
  const job2 = app.careerStore.saveJob({ url: "https://jobs.example.test/apply/2", title: "Engineer 2", company: "Fixture", location: "Paris" });
  const campaign = app.engine.createFromOffers([app.job, job2], app.resume.id, 2, "manual-pause-skip");
  app.campaigns.requestStart(campaign.id); app.campaigns.activateRequested(campaign.id);
  app.engine.pause(campaign.id); // manual pause clears restart intent
  const item = app.campaigns.listItems(campaign.id)[0];
  const skipped = await app.call(`/api/career/campaigns/${campaign.id}/items/${item.id}/skip`, "POST", {});
  assert.equal(skipped.status, 200);
  assert.equal(app.campaigns.get(campaign.id).state, "paused");
  assert.equal(app.campaigns.counts(campaign.id).pending, 1);
  assert.equal(app.port.runCount, 0);

  const job3 = app.careerStore.saveJob({ url: "https://jobs.example.test/apply/3", title: "Engineer 3", company: "Fixture", location: "Paris" });
  const campaign2 = app.engine.createFromOffers([app.job, job3], app.resume.id, 2, "blocked-skip-busy");
  const [blockedItem, pendingItem] = app.campaigns.listItems(campaign2.id);
  app.careerStore.claimRun(blockedItem.applicationId);
  app.careerStore.finishRun(blockedItem.applicationId, { state: "blocked", message: "CAPTCHA", missingFields: [], receipt: null });
  app.campaigns.finish(blockedItem.id, "needs_input", "CAPTCHA");
  app.campaigns.requestStart(campaign2.id); app.campaigns.activateRequested(campaign2.id); app.engine.pause(campaign2.id, true);
  app.context.ensureRunnerAvailable = () => { throw new Error("browser busy fixture"); };
  const deferred = await app.call(`/api/career/campaigns/${campaign2.id}/items/${blockedItem.id}/skip`, "POST", {});
  assert.equal(deferred.status, 200);
  const payload = await deferred.json() as { resumeDeferred: boolean; campaign: { state: string }; items: { id: string; state: string }[] };
  assert.equal(payload.resumeDeferred, true);
  assert.equal(payload.campaign.state, "paused");
  assert.equal(payload.items.find(entry => entry.id === pendingItem.id)?.state, "pending");
  assert.equal(app.port.runCount, 0);
});

test("start reports context conflicts and is an idempotent no-op for terminal campaigns", async t => {
  const app = await setup(); t.after(app.close);
  assert.equal((await app.call("/api/career/campaigns/missing/start", "POST")).status, 404);
  const building = app.campaigns.create(app.resume.id, 1, "building-api-key");
  assert.equal((await app.call(`/api/career/campaigns/${building.id}/start`, "POST")).status, 409);
  const complete = app.campaigns.create(app.resume.id, 1, "completed-api-key");
  app.campaigns.seal(complete.id); app.campaigns.setState(complete.id, "completed");
  const response = await app.call(`/api/career/campaigns/${complete.id}/start`, "POST");
  assert.equal(response.status, 200); assert.equal(app.campaigns.get(complete.id).state, "completed");
  assert.equal(app.port.runCount, 0);
});

test("demo mode refuses campaign creation and start, but permits safe pause/stop", async t => {
  const app = await setup(true); t.after(app.close);
  const payload = { resumeId: app.resume.id, jobIds: [app.job.id], maxSubmissions: 1, idempotencyKey: "demo-key" };
  assert.equal((await app.call("/api/career/campaigns", "POST", payload)).status, 403);
  const campaign = app.campaigns.create(app.resume.id, 1, "preseeded-demo");
  app.campaigns.enqueue(campaign.id, app.careerStore.createApplication({ jobId: app.job.id, resumeId: app.resume.id }));
  app.campaigns.seal(campaign.id);
  assert.equal((await app.call(`/api/career/campaigns/${campaign.id}/start`, "POST")).status, 403);
  assert.equal(app.port.runCount, 0);
  assert.equal((await app.call(`/api/career/campaigns/${campaign.id}/pause`, "POST")).status, 200);
  assert.equal((await app.call(`/api/career/campaigns/${campaign.id}/stop`, "POST")).status, 200);
});

test("start returns 202 without waiting; pause and stop controls are safe, stop awaits worker", async t => {
  const app = await setup(false, true); t.after(app.close);
  const created = await app.call("/api/career/campaigns", "POST", { resumeId: app.resume.id, jobIds: [app.job.id], maxSubmissions: 1, idempotencyKey: "run-key" });
  const detail = await created.json() as { campaign: { id: string } };
  const started = await app.call(`/api/career/campaigns/${detail.campaign.id}/start`, "POST");
  assert.equal(started.status, 202); assert.equal(app.port.runCount, 1);
  assert.equal((await app.call(`/api/career/campaigns/${detail.campaign.id}/pause`, "POST")).status, 200);
  // Resume is idempotent even while the previous pump is draining a paused worker.
  assert.equal((await app.call(`/api/career/campaigns/${detail.campaign.id}/start`, "POST")).status, 202);
  const stopping = app.call(`/api/career/campaigns/${detail.campaign.id}/stop`, "POST");
  let settled = false; void stopping.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false);
  app.port.release?.(result);
  assert.equal((await stopping).status, 200);
  assert.equal(app.campaigns.get(detail.campaign.id).state, "stopped");
  assert.equal((await app.call(`/api/career/campaigns/${detail.campaign.id}/start`, "POST")).status, 200);
  assert.equal(app.port.runCount, 1);
});
