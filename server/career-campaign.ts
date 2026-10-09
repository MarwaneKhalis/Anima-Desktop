import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Application, ApplicationState, JobOffer, RunResult } from "../src/shared/career.ts";
import { ensureProtectedScope, LocalDataProtector, PROTECTED_SCOPES } from "./data-protection.ts";

/** A durable queue for a single user-approved search campaign. This module deliberately
 * knows nothing about Playwright or HTTP: the desktop host injects the career runner. */
export type CampaignState = "building" | "queued" | "running" | "paused" | "stopped" | "completed" | "limit_reached";
export type CampaignItemState = "pending" | "running" | "submitted" | "needs_input" | "uncertain" | "failed" | "skipped";
export interface Campaign { id: string; idempotencyKey: string; resumeId: string; credentialId: string | null; maxSubmissions: number; state: CampaignState; startRequested: boolean; createdAt: string; updatedAt: string; }
export interface CampaignItem { id: string; campaignId: string; applicationId: string; jobId: string; state: CampaignItemState; error: string; createdAt: string; updatedAt: string; }
export interface CampaignCounts { total: number; pending: number; running: number; submitted: number; needsInput: number; uncertain: number; failed: number; skipped: number; }
export interface CampaignApplicationPort {
  /** Must be idempotent per job (CareerStore.createApplication already is). */
  createApplication(jobId: string, resumeId: string): Application;
  getApplication(id: string): Application;
  /** Execute one compatible career-site workflow. Never retries after a submitting marker. */
  run(applicationId: string, signal: AbortSignal, credentialId?: string | null): Promise<RunResult>;
}

const stamp = () => new Date().toISOString();
type Row = Record<string, unknown>;
export class CampaignError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "CampaignError"; this.status = status; this.code = code; }
}

/** SQLite repository; all claims and reservations happen under BEGIN IMMEDIATE. */
export class CareerCampaignStore {
  private readonly db: DatabaseSync;
  private readonly protectedData: LocalDataProtector;
  constructor(db: DatabaseSync, dataProtectionKey?: Buffer) {
    this.db = db;
    this.protectedData = new LocalDataProtector(dataProtectionKey);
    db.exec(`
      CREATE TABLE IF NOT EXISTS career_campaigns (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, resume_id TEXT NOT NULL, credential_id TEXT NOT NULL DEFAULT '', expected_job_ids TEXT, max_submissions INTEGER NOT NULL,
        state TEXT NOT NULL, start_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS career_campaign_items (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES career_campaigns(id) ON DELETE CASCADE,
        application_id TEXT NOT NULL, job_id TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(campaign_id, job_id), UNIQUE(campaign_id, application_id)
      );
      CREATE INDEX IF NOT EXISTS career_campaign_items_order ON career_campaign_items(campaign_id,state,created_at);
    `);
    const columns = new Set((db.prepare("PRAGMA table_info(career_campaigns)").all() as Row[]).map(row => String(row.name)));
    if (!columns.has("idempotency_key")) db.exec("ALTER TABLE career_campaigns ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT ''");
    if (!columns.has("start_requested")) db.exec("ALTER TABLE career_campaigns ADD COLUMN start_requested INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("credential_id")) db.exec("ALTER TABLE career_campaigns ADD COLUMN credential_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("expected_job_ids")) db.exec("ALTER TABLE career_campaigns ADD COLUMN expected_job_ids TEXT");
    // Old rows cannot prove what the original request contained. Bind legacy rows to
    // their persisted items, so only an exact retry can proceed after migration.
    const legacy = db.prepare("SELECT id FROM career_campaigns WHERE expected_job_ids IS NULL").all() as Row[];
    const bindLegacy = db.prepare("UPDATE career_campaigns SET expected_job_ids=? WHERE id=? AND expected_job_ids IS NULL");
    const knownItems = db.prepare("SELECT job_id FROM career_campaign_items WHERE campaign_id=? ORDER BY created_at,id");
    for (const row of legacy) {
      const ids = (knownItems.all(String(row.id)) as Row[]).map(item => String(item.job_id));
      bindLegacy.run(JSON.stringify(ids), String(row.id));
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS career_campaigns_idempotency ON career_campaigns(idempotency_key) WHERE idempotency_key<>''");
    const campaignScope = PROTECTED_SCOPES.find((scope) => scope.name === "campaign");
    if (!campaignScope) throw new Error("Schéma de protection des campagnes absent.");
    ensureProtectedScope(db, campaignScope, dataProtectionKey);
  }
  private tx<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  private campaign(row: Row): Campaign { return { id: String(row.id), idempotencyKey: String(row.idempotency_key ?? ""), resumeId: String(row.resume_id), credentialId: String(row.credential_id ?? "") || null, maxSubmissions: Number(row.max_submissions), state: String(row.state) as CampaignState, startRequested: Number(row.start_requested) === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
  private item(row: Row): CampaignItem { const itemId=String(row.id); return { id: itemId, campaignId: String(row.campaign_id), applicationId: String(row.application_id), jobId: String(row.job_id), state: String(row.state) as CampaignItemState, error: this.protectedData.readText("career_campaign_items",itemId,"error",row.error), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
  create(resumeId: string, maxSubmissions: number, idempotencyKey: string = randomUUID(), credentialId?: string | null, expectedJobIds?: readonly string[]): Campaign {
    if (!resumeId || !idempotencyKey.trim() || idempotencyKey.length > 200 || !Number.isInteger(maxSubmissions) || maxSubmissions < 1 || maxSubmissions > 500) throw new CampaignError(400, "validation", "Paramètres de campagne invalides (clé requise, plafond de 1 à 500 candidatures).");
    const existing = this.db.prepare("SELECT * FROM career_campaigns WHERE idempotency_key=?").get(idempotencyKey) as Row | undefined;
    if (existing) {
      const campaign = this.campaign(existing);
      if (campaign.resumeId !== resumeId || campaign.maxSubmissions !== maxSubmissions || campaign.credentialId !== (credentialId || null)) throw new CampaignError(409, "idempotency_conflict", "La clé d’idempotence existe avec un CV, un compte ou un plafond différent.");
      return campaign;
    }
    const id = randomUUID(), at = stamp();
    const expected = expectedJobIds === undefined ? null : JSON.stringify([...new Set(expectedJobIds)]);
    this.db.prepare("INSERT INTO career_campaigns(id,idempotency_key,resume_id,credential_id,expected_job_ids,max_submissions,state,start_requested,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, idempotencyKey, resumeId, credentialId || "", expected, maxSubmissions, "building", 0, at, at);
    return this.get(id);
  }
  expectedJobIds(id: string): string[] | null {
    const row = this.db.prepare("SELECT expected_job_ids FROM career_campaigns WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new CampaignError(404, "not_found", "Campagne introuvable.");
    try { return row.expected_job_ids === null || row.expected_job_ids === undefined ? null : JSON.parse(String(row.expected_job_ids)) as string[]; }
    catch { throw new CampaignError(500, "campaign_corrupt", "La liste d’offres de la campagne est illisible."); }
  }
  bindExpectedJobIds(id: string, ids: readonly string[]): void {
    const campaign = this.get(id);
    const current = this.expectedJobIds(id);
    const normalized = [...new Set(ids)];
    const existing = this.listItems(id).map(item => item.jobId);
    if (current !== null) {
      if (JSON.stringify(current) !== JSON.stringify(normalized)) throw new CampaignError(409, "idempotency_conflict", "La clé d’idempotence existe avec une liste d’offres différente.");
      if (JSON.stringify(normalized.slice(0, existing.length)) !== JSON.stringify(existing) || (campaign.state !== "building" && JSON.stringify(existing) !== JSON.stringify(normalized))) {
        throw new CampaignError(409, "campaign_queue_conflict", "La file persistée ne correspond pas au lot attendu.");
      }
      return;
    }
    if (JSON.stringify(existing) !== JSON.stringify(normalized)) throw new CampaignError(409, "idempotency_legacy_conflict", "La file existante ne permet pas de vérifier ce retry. Créez une nouvelle campagne plutôt que de modifier son lot.");
    this.db.prepare("UPDATE career_campaigns SET expected_job_ids=? WHERE id=? AND expected_job_ids IS NULL").run(JSON.stringify(normalized), id);
  }
  enqueue(campaignId: string, application: Application): CampaignItem {
    const campaign = this.get(campaignId);
    if (campaign.state !== "building") throw new CampaignError(409, "campaign_conflict", "La file n’est pas en phase de préparation.");
    const previous = this.db.prepare("SELECT created_at FROM career_campaign_items WHERE campaign_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(campaignId) as Row | undefined;
    const previousTime = previous ? Date.parse(String(previous.created_at)) : 0;
    const at = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
    const itemId=randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO career_campaign_items VALUES (?,?,?,?,?,?,?,?)").run(itemId, campaignId, application.id, application.jobId, "pending", this.protectedData.writeText("career_campaign_items",itemId,"error",""), at, at);
    const row = this.db.prepare("SELECT * FROM career_campaign_items WHERE campaign_id=? AND job_id=?").get(campaignId, application.jobId) as Row;
    return this.item(row);
  }
  seal(id: string): Campaign { return this.tx(() => { const c = this.get(id); if (c.state === "building") return this.setState(id, "queued"); return c; }); }
  requestStart(id: string): Campaign {
    return this.tx(() => {
      const c = this.get(id);
      if (c.state === "building") throw new CampaignError(409, "campaign_conflict", "La préparation de la file n’est pas terminée.");
      if (["stopped", "completed", "limit_reached"].includes(c.state)) throw new CampaignError(409, "campaign_conflict", "Cette campagne est terminée.");
      this.db.prepare("UPDATE career_campaigns SET start_requested=1,updated_at=? WHERE id=?").run(stamp(), id);
      return this.get(id);
    });
  }
  beginAddOffers(id: string): Campaign {
    return this.tx(() => {
      const c = this.get(id);
      if (c.state !== "queued" || c.startRequested) throw new CampaignError(409, "campaign_conflict", "Ajout d’offres impossible après le démarrage ou la mise en pause.");
      return this.setState(id, "building");
    });
  }
  get(id: string): Campaign { const row = this.db.prepare("SELECT * FROM career_campaigns WHERE id=?").get(id) as Row | undefined; if (!row) throw new CampaignError(404, "not_found", "Campagne introuvable."); return this.campaign(row); }
  list(limit = 50): Campaign[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("La liste des campagnes est limitée à 1–100 éléments.");
    return (this.db.prepare("SELECT * FROM career_campaigns ORDER BY updated_at DESC,created_at DESC LIMIT ?").all(limit) as Row[]).map(r => this.campaign(r));
  }
  counts(id: string): CampaignCounts {
    this.get(id);
    const rows = this.db.prepare("SELECT state,COUNT(*) AS n FROM career_campaign_items WHERE campaign_id=? GROUP BY state").all(id) as Row[];
    const counts: CampaignCounts = { total: 0, pending: 0, running: 0, submitted: 0, needsInput: 0, uncertain: 0, failed: 0, skipped: 0 };
    for (const row of rows) { const state = String(row.state); const n = Number(row.n); counts.total += n; const key = state === "needs_input" ? "needsInput" : state as keyof Omit<CampaignCounts, "total">; if (key in counts) counts[key] = n; }
    return counts;
  }
  listRecoverable(): Campaign[] { return (this.db.prepare("SELECT c.* FROM career_campaigns c WHERE c.state='running' OR (c.state='queued' AND c.start_requested=1) OR (c.state='paused' AND EXISTS (SELECT 1 FROM career_campaign_items i WHERE i.campaign_id=c.id AND i.state='running')) ORDER BY c.created_at,c.id").all() as Row[]).map(r => this.campaign(r)); }
  pauseRunning(): void { this.db.prepare("UPDATE career_campaigns SET state='paused',updated_at=? WHERE state='running'").run(stamp()); }
  listItems(id: string): CampaignItem[] { return (this.db.prepare("SELECT * FROM career_campaign_items WHERE campaign_id=? ORDER BY created_at,id").all(id) as Row[]).map(r => this.item(r)); }
  getItem(id: string, itemId: string): CampaignItem {
    const row = this.db.prepare("SELECT * FROM career_campaign_items WHERE campaign_id=? AND id=?").get(id, itemId) as Row | undefined;
    if (!row) throw new CampaignError(404, "item_not_found", "Offre introuvable dans cette campagne.");
    return this.item(row);
  }
  markSkipped(campaignId: string, itemId: string, reason: string): CampaignItem {
    return this.tx(() => {
      const result = this.db.prepare("UPDATE career_campaign_items SET state='skipped',error=?,updated_at=? WHERE campaign_id=? AND id=? AND state IN ('pending','needs_input','failed')").run(this.protectedData.writeText("career_campaign_items",itemId,"error",reason.slice(0, 1000)), stamp(), campaignId, itemId);
      if (result.changes !== 1) {
        this.getItem(campaignId, itemId);
        throw new CampaignError(409, "item_not_skippable", "Cette offre a démarré ou ne peut plus être passée.");
      }
      return this.getItem(campaignId, itemId);
    });
  }
  pause(id: string, preserveStartRequest: boolean): Campaign {
    return this.tx(() => {
      const c = this.get(id);
      if (c.state === "paused" && !preserveStartRequest && c.startRequested) {
        this.db.prepare("UPDATE career_campaigns SET start_requested=0,updated_at=? WHERE id=?").run(stamp(), id);
        return this.get(id);
      }
      if (c.state !== "running") return c;
      this.db.prepare("UPDATE career_campaigns SET state='paused',start_requested=?,updated_at=? WHERE id=?")
        .run(preserveStartRequest && c.startRequested ? 1 : 0, stamp(), id);
      return this.get(id);
    });
  }
  setExpectedTerminalState(id: string): Campaign {
    return this.tx(() => {
      const c = this.get(id), counts = this.counts(id);
      if (["building", "stopped", "completed", "limit_reached"].includes(c.state) || counts.running || counts.uncertain || counts.needsInput) return c;
      if (counts.pending) {
        const reserved = counts.submitted + counts.running + counts.uncertain;
        return reserved >= c.maxSubmissions ? this.setState(id, "limit_reached") : c;
      }
      return this.setState(id, "completed");
    });
  }
  reopenLimitForHumanResume(id: string): Campaign {
    return this.tx(() => {
      const campaign = this.get(id), counts = this.counts(id);
      if (campaign.state === "limit_reached" && counts.pending && counts.submitted + counts.running < campaign.maxSubmissions) {
        this.db.prepare("UPDATE career_campaigns SET state='paused',start_requested=0,updated_at=? WHERE id=?")
          .run(stamp(), id);
      }
      return this.get(id);
    });
  }
  setState(id: string, state: CampaignState): Campaign { this.db.prepare("UPDATE career_campaigns SET state=?,updated_at=? WHERE id=?").run(state, stamp(), id); return this.get(id); }
  activateRequested(id: string): Campaign {
    return this.tx(() => { const c = this.get(id); if (!c.startRequested || !["queued", "paused", "running"].includes(c.state)) throw new Error("Cette campagne ne peut pas démarrer."); return this.setState(id, "running"); });
  }
  /** Atomically reserves one submission slot as well as one worker slot. Uncertain items
   * permanently consume a slot until a human resolves them outside the campaign engine. */
  claimNext(id: string, concurrency: number): CampaignItem | null {
    return this.tx(() => {
      const c = this.get(id);
      if (c.state !== "running" || !c.startRequested) return null;
      const active = Number((this.db.prepare("SELECT COUNT(*) n FROM career_campaign_items WHERE campaign_id=? AND state='running'").get(id) as Row).n);
      const reserved = Number((this.db.prepare("SELECT COUNT(*) n FROM career_campaign_items WHERE campaign_id=? AND state IN ('running','submitted','uncertain')").get(id) as Row).n);
      if (active >= concurrency || reserved >= c.maxSubmissions) return null;
      const row = this.db.prepare("SELECT * FROM career_campaign_items WHERE campaign_id=? AND state='pending' ORDER BY created_at,id LIMIT 1").get(id) as Row | undefined;
      if (!row) return null;
      const at = stamp();
      this.db.prepare("UPDATE career_campaign_items SET state='running',error=?,updated_at=? WHERE id=? AND state='pending'").run(this.protectedData.writeText("career_campaign_items",String(row.id),"error",""), at, String(row.id));
      return this.item(this.db.prepare("SELECT * FROM career_campaign_items WHERE id=?").get(String(row.id)) as Row);
    });
  }
  finish(itemId: string, state: CampaignItemState, error = ""): CampaignItem {
    if (!(["submitted", "needs_input", "uncertain", "failed", "pending", "skipped"] as CampaignItemState[]).includes(state)) throw new Error("Transition d’élément invalide.");
    this.db.prepare("UPDATE career_campaign_items SET state=?,error=?,updated_at=? WHERE id=?").run(state, this.protectedData.writeText("career_campaign_items",itemId,"error",error.slice(0, 1000)), stamp(), itemId);
    const row = this.db.prepare("SELECT * FROM career_campaign_items WHERE id=?").get(itemId) as Row | undefined;
    if (!row) throw new Error("Élément de campagne introuvable.");
    return this.item(row);
  }
  recover(id: string, applicationState: (applicationId: string) => ApplicationState): void {
    this.tx(() => {
      for (const item of this.listItems(id).filter(x => x.state === "running")) {
        const state = applicationState(item.applicationId);
        // A submitting marker is a one-way safety boundary. Never replay it automatically.
        const next: CampaignItemState = state === "submitted" ? "submitted" : state === "submitting" || state === "uncertain" ? "uncertain" : state === "needs_input" || state === "blocked" ? "needs_input" : "pending";
        this.finish(item.id, next, next === "uncertain" ? "Résultat d’envoi à vérifier ; aucune nouvelle tentative automatique." : "Récupéré après interruption.");
      }
      const c = this.get(id);
      if (c.state === "running" || (c.state === "queued" && c.startRequested)) this.setState(id, "paused");
    });
  }
  hasPending(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM career_campaign_items WHERE campaign_id=? AND state='pending' LIMIT 1").get(id)); }
  activeCount(id: string): number { return Number((this.db.prepare("SELECT COUNT(*) n FROM career_campaign_items WHERE campaign_id=? AND state='running'").get(id) as Row).n); }
}

export interface CampaignOptions { concurrency?: number; onItem?: (item: CampaignItem, application: Application) => void; }
/** Durable scheduler. A UI may disappear at any time; only this host-side loop owns work. */
export class CareerCampaignEngine {
  private loops = new Map<string, Promise<void>>();
  private aborters = new Map<string, Set<AbortController>>();
  private activeWorkers = 0;
  private workerWaiters = new Set<() => void>();
  private readonly concurrency: number;
  private readonly store: CareerCampaignStore;
  private readonly applications: CampaignApplicationPort;
  constructor(store: CareerCampaignStore, applications: CampaignApplicationPort, options: CampaignOptions = {}) {
    this.store = store;
    this.applications = applications;
    this.concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4) throw new Error("Concurrence de campagne limitée à 1–4 parcours.");
    this.onItem = options.onItem;
  }
  private readonly onItem?: CampaignOptions["onItem"];
  /** A stable caller-supplied key makes a retry resume the same building batch. */
  createFromOffers(offers: readonly JobOffer[], resumeId: string, maxSubmissions: number, idempotencyKey: string, credentialId?: string | null): Campaign {
    const normalized = [...new Map(offers.map(offer => [offer.id, offer])).values()];
    if (!normalized.length) throw new CampaignError(400, "validation", "La campagne doit contenir au moins une offre.");
    const expectedIds = normalized.map(offer => offer.id);
    const campaign = this.store.create(resumeId, maxSubmissions, idempotencyKey, credentialId, expectedIds);
    this.store.bindExpectedJobIds(campaign.id, expectedIds);
    if (campaign.state !== "building") return campaign;
    for (const offer of normalized) {
      const application = this.applications.createApplication(offer.id, resumeId);
      this.store.enqueue(campaign.id, application);
    }
    return this.store.seal(campaign.id);
  }
  /** Add more discoveries to an existing campaign without duplicating application rows. */
  addOffers(campaignId: string, offers: readonly JobOffer[]): number {
    let c = this.store.get(campaignId);
    if (c.state === "queued") c = this.store.beginAddOffers(campaignId);
    else if (c.state !== "building") throw new Error("Ajout d’offres refusé après démarrage ou sur une campagne terminale.");
    let added = 0;
    for (const offer of offers) {
      const app = this.applications.createApplication(offer.id, c.resumeId);
      const before = this.store.listItems(campaignId).some(x => x.jobId === offer.id);
      this.store.enqueue(campaignId, app);
      if (!before) added++;
    }
    this.store.seal(campaignId);
    return added;
  }
  async start(id: string): Promise<void> {
    const state = this.store.get(id).state;
    if (["stopped", "completed", "limit_reached"].includes(state)) return;
    if (state === "building") throw new Error("La préparation de la campagne n’est pas terminée.");
    if (this.store.listItems(id).some(item => item.state === "uncertain")) throw new CampaignError(409, "uncertain_pending", "Vérifiez d’abord la candidature au résultat incertain avant de reprendre la campagne.");
    const existing = this.loops.get(id);
    if (existing) {
      if (state !== "paused") return existing;
      this.store.requestStart(id);
      this.store.activateRequested(id);
      this.wakeWorkers();
      // If the old pump had already left its loop, its finally handler removes the map
      // entry before this continuation runs; start a fresh pump for the durable intent.
      return existing.then(async () => { if (this.store.get(id).state === "running") await this.start(id); });
    }
    this.store.requestStart(id);
    this.store.activateRequested(id);
    this.wakeWorkers();
    const loop = this.pump(id).finally(() => this.loops.delete(id));
    this.loops.set(id, loop); return loop;
  }
  /** Reconcile items resolved through the ordinary application drawer between campaign runs. */
  reconcile(id: string): void {
    let resolvedNotSubmitted = false;
    for (const item of this.store.listItems(id)) {
      if (!["needs_input", "failed", "uncertain"].includes(item.state)) continue;
      const application = this.applications.getApplication(item.applicationId);
      if (application.state === "submitted") this.store.finish(item.id, "submitted");
      else if (application.state === "uncertain" || application.state === "submitting") this.store.finish(item.id, "uncertain", "Résultat d’envoi incertain ; vérification humaine requise.");
      else if (item.state === "uncertain" && application.state === "draft") {
        this.store.finish(item.id, "failed", "Vérification manuelle : candidature non envoyée. Cet élément ne sera pas relancé automatiquement.");
        resolvedNotSubmitted = true;
      }
      else if (item.state === "needs_input" && ["draft", "ready"].includes(application.state)) this.store.finish(item.id, "pending");
      else if (item.state === "needs_input" && application.state === "failed") this.store.finish(item.id, "failed", application.lastError || "Le parcours a échoué avant l’envoi.");
    }
    if (resolvedNotSubmitted) this.store.reopenLimitForHumanResume(id);
    this.store.setExpectedTerminalState(id);
  }
  skipItem(campaignId: string, itemId: string, reason: string): CampaignItem {
    const item = this.store.getItem(campaignId, itemId);
    if (!new Set<CampaignItemState>(["pending", "needs_input", "failed"]).has(item.state)) throw new CampaignError(409, "item_not_skippable", "Seule une offre en attente ou bloquée avant envoi peut être passée.");
    const application = this.applications.getApplication(item.applicationId);
    if (["running", "submitting", "submitted", "uncertain"].includes(application.state)) throw new CampaignError(409, "item_not_skippable", "Une offre en cours d’envoi ou envoyée ne peut pas être passée.");
    const skipped = this.store.markSkipped(campaignId, itemId, reason);
    this.store.setExpectedTerminalState(campaignId);
    return skipped;
  }
  pause(id: string, preserveStartRequest = false): void { const c = this.store.pause(id, preserveStartRequest); if (c.state === "paused") this.wakeWorkers(); }
  hasUncertain(id: string): boolean { return this.store.listItems(id).some(item => item.state === "uncertain"); }
  async stop(id: string): Promise<void> {
    const c = this.store.get(id);
    if (["stopped", "completed", "limit_reached"].includes(c.state)) return;
    this.store.setState(id, "stopped");
    this.wakeWorkers();
    for (const controller of this.aborters.get(id) ?? []) controller.abort();
    await this.loops.get(id);
    // Queued work is retained for audit but cannot restart after an explicit stop.
    if (c.state !== "stopped") this.store.setState(id, "stopped");
  }
  async wait(id: string): Promise<void> { await this.loops.get(id); }
  pauseAll(): void {
    this.store.pauseRunning();
    this.wakeWorkers();
  }
  async waitAll(): Promise<void> { await Promise.all([...this.loops.values()]); }
  private notify(campaignId: string, itemId: string, application: Application): void {
    if (!this.onItem) return;
    try { const item = this.store.listItems(campaignId).find(x => x.id === itemId); if (item) this.onItem(item, application); }
    catch { /* observers must never change durable queue outcomes */ }
  }
  /** Call once after CareerStore.recoverInterruptedRuns() during desktop startup.
   * Recovery and execution happen in the host process, independently of React. */
  async recoverAfterRestart(): Promise<void> {
    const interrupted = this.store.listRecoverable();
    const autoResume = interrupted.filter(campaign => campaign.state === "running" || (campaign.state === "queued" && campaign.startRequested));
    for (const campaign of interrupted) this.store.recover(campaign.id, id => this.applications.getApplication(id).state);
    await Promise.all(autoResume.filter(campaign => !this.hasUncertain(campaign.id)).map(campaign => this.start(campaign.id)));
  }
  private async pump(id: string): Promise<void> {
    const active = new Set<Promise<void>>(); this.aborters.set(id, new Set());
    try {
      while (this.store.get(id).state === "running") {
        while (this.store.get(id).state === "running" && active.size < this.concurrency && this.activeWorkers < this.concurrency) {
          const item = this.store.claimNext(id, this.concurrency);
          if (!item) break;
          const controller = new AbortController(); this.aborters.get(id)!.add(controller);
          this.activeWorkers++;
          const task = this.runItem(id, item, controller).finally(() => { active.delete(task); this.aborters.get(id)?.delete(controller); this.activeWorkers--; this.wakeWorkers(); });
          active.add(task);
        }
        if (active.size) { await Promise.race(active); continue; }
        if (this.store.get(id).state === "running" && this.store.hasPending(id) && this.activeWorkers >= this.concurrency) {
          await new Promise<void>(resolve => this.workerWaiters.add(resolve));
          continue;
        }
        const campaign = this.store.get(id);
        if (!this.store.hasPending(id)) this.store.setState(id, "completed");
        else if (this.store.listItems(id).some(x => x.state === "pending") && this.store.listItems(id).filter(x => ["submitted", "uncertain", "running"].includes(x.state)).length >= campaign.maxSubmissions) this.store.setState(id, "limit_reached");
        else this.store.setState(id, "completed");
        break;
      }
      await Promise.allSettled(active);
    } finally { this.aborters.delete(id); }
  }
  private wakeWorkers(): void { const waiters = [...this.workerWaiters]; this.workerWaiters.clear(); for (const wake of waiters) wake(); }
  private async runItem(campaignId: string, item: CampaignItem, controller: AbortController): Promise<void> {
    try {
      const before = this.applications.getApplication(item.applicationId);
      if (before.state === "submitted") { this.store.finish(item.id, "submitted"); this.notify(campaignId, item.id, before); return; }
      if (["submitting", "uncertain"].includes(before.state)) { this.store.finish(item.id, "uncertain", "Résultat d’envoi incertain ; vérification humaine requise."); this.haltForUncertain(campaignId, controller); return; }
      if (["needs_input", "blocked"].includes(before.state)) { this.store.finish(item.id, "needs_input", "Intervention requise ; les autres offres continuent."); return; }
      const result = await this.applications.run(item.applicationId, controller.signal, this.store.get(campaignId).credentialId);
      const state: CampaignItemState = result.state === "submitted" ? "submitted" : result.state === "uncertain" ? "uncertain" : result.state === "needs_input" || result.state === "blocked" ? "needs_input" : "failed";
      const message = result.state === "ready" ? "Parcours terminé sans soumission ; vérification manuelle requise." : result.message;
      this.store.finish(item.id, state, message);
      if (result.state === "blocked") this.pause(campaignId, true);
      if (result.state === "uncertain") this.haltForUncertain(campaignId, controller);
      this.notify(campaignId, item.id, this.applications.getApplication(item.applicationId));
    } catch (error) {
      // Per-item isolation: an exception never prevents later queue entries from running.
      let state: CampaignItemState = "failed", message = error instanceof Error ? error.message : "Erreur d’exécution.";
      try {
        const actual = this.applications.getApplication(item.applicationId);
        if (actual.state === "submitting" || actual.state === "uncertain") { state = "uncertain"; message = "Résultat d’envoi incertain ; aucune relance automatique."; this.haltForUncertain(campaignId, controller); }
        else if (actual.state === "submitted") state = "submitted";
        else if (actual.state === "needs_input" || actual.state === "blocked") { state = "needs_input"; if (actual.state === "blocked") this.pause(campaignId, true); }
      } catch { /* keep the original failure */ }
      this.store.finish(item.id, state, message);
    }
  }
  private haltForUncertain(campaignId: string, current: AbortController): void {
    this.pause(campaignId, true);
    for (const controller of this.aborters.get(campaignId) ?? []) if (controller !== current) controller.abort();
  }
}
