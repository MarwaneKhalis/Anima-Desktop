import type { IncomingMessage, ServerResponse } from "node:http";
import type { Campaign, CampaignItem } from "./career-campaign.ts";
import { CampaignError, CareerCampaignEngine, CareerCampaignStore } from "./career-campaign.ts";
import { CareerError, CareerStore } from "./career-store.ts";

export interface CareerCampaignApiContext {
  careerStore: CareerStore;
  campaigns: CareerCampaignStore;
  engine: CareerCampaignEngine;
  demo: boolean;
  credentialExists?: (id: string) => boolean;
  closePausedRunnerFor?: (applicationId: string) => Promise<void>;
  ensureRunnerAvailable?: () => void;
  onBackgroundError?: (error: unknown, campaignId: string) => void;
}
const reply = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CareerError(400, "validation", "Objet JSON attendu.");
  return value as Record<string, unknown>;
};
const only = (value: Record<string, unknown>, keys: string[]) => { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new CareerError(400, "validation", `Champ interdit : ${key}.`); };
const string = (value: unknown, name: string, max = 200) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new CareerError(400, "validation", `${name} invalide.`);
  return value.trim();
};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new CareerError(400, "validation", "Contenu JSON attendu.");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 64_000) throw new CareerError(413, "too_large", "Requête trop volumineuse."); chunks.push(bytes); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch (error) { if (error instanceof CareerError) throw error; throw new CareerError(400, "validation", "JSON invalide."); }
}
function view(campaign: Campaign, items: CampaignItem[], context: CareerCampaignApiContext) {
  return { campaign: { ...campaign, counts: context.campaigns.counts(campaign.id) }, items };
}
function getDetail(id: string, context: CareerCampaignApiContext) {
  context.engine.reconcile(id);
  const campaign = context.campaigns.get(id);
  return view(campaign, context.campaigns.listItems(id), context);
}

/** Campaign endpoints kept separate so the owner can mount them in the existing career API. */
export async function handleCareerCampaignApi(req: IncomingMessage, res: ServerResponse, url: URL, context: CareerCampaignApiContext): Promise<boolean> {
  const prefix = "/api/career/campaigns";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  const method = req.method || "GET";
  const relative = url.pathname.slice(prefix.length);
  try {
    if (method !== "GET" && req.headers["x-anima-request"] !== "1") throw new CareerError(403, "csrf", "En-tête de requête requis.");
    if (method === "GET" && relative === "") {
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CareerError(400, "validation", "La limite doit être comprise entre 1 et 100.");
      const campaigns = context.campaigns.list(limit).map(campaign => {
        context.engine.reconcile(campaign.id);
        return { ...campaign, counts: context.campaigns.counts(campaign.id) };
      });
      reply(res, 200, { campaigns }); return true;
    }
    const match = relative.match(/^\/([^/]+)$/);
    if (method === "GET" && match) { reply(res, 200, getDetail(match[1], context)); return true; }
    if (method === "POST" && relative === "") {
      if (context.demo) throw new CareerError(403, "demo_disabled", "La création de campagnes est désactivée en démonstration.");
      const input = await body(req); only(input, ["jobIds", "resumeId", "maxSubmissions", "idempotencyKey", "credentialId"]);
      if (!Array.isArray(input.jobIds) || input.jobIds.length > 450 || input.jobIds.length === 0 || input.jobIds.some(id => typeof id !== "string")) throw new CareerError(400, "validation", "La campagne doit contenir de 1 à 450 identifiants d’offres.");
      const jobIds = [...new Set(input.jobIds.map(id => string(id, "Offre", 64)))];
      const resumeId = string(input.resumeId, "CV", 64);
      const maxSubmissions = input.maxSubmissions;
      if (!Number.isInteger(maxSubmissions) || Number(maxSubmissions) < 1 || Number(maxSubmissions) > 500) throw new CareerError(400, "validation", "Le plafond doit être compris entre 1 et 500 candidatures.");
      const idempotencyKey = string(input.idempotencyKey, "Clé d’idempotence", 200);
      const credentialId = input.credentialId === undefined || input.credentialId === "" ? null : string(input.credentialId, "Compte", 64);
      if (credentialId && !context.credentialExists?.(credentialId)) throw new CareerError(404, "credential_not_found", "Le compte de connexion sélectionné n’existe plus.");
      context.careerStore.getResume(resumeId);
      const offers = jobIds.map(jobId => context.careerStore.getJob(jobId));
      const campaign = context.engine.createFromOffers(offers, resumeId, Number(maxSubmissions), idempotencyKey, credentialId);
      reply(res, 201, getDetail(campaign.id, context)); return true;
    }
    const skip = relative.match(/^\/([^/]+)\/items\/([^/]+)\/skip$/);
    if (method === "POST" && skip) {
      const id = skip[1], itemId = skip[2];
      const input = await body(req); only(input, ["reason"]);
      const item = context.campaigns.getItem(id, itemId);
      if (item.state === "needs_input" || item.state === "failed") await context.closePausedRunnerFor?.(item.applicationId);
      const reason = input.reason === undefined ? "Passée par l’utilisateur." : string(input.reason, "Motif", 500);
      context.engine.skipItem(id, itemId, reason);
      const campaign = context.campaigns.get(id);
      let resumeDeferred = false;
      if (campaign.state === "paused" && campaign.startRequested && !context.engine.hasUncertain(id) && context.campaigns.listItems(id).some(entry => entry.state === "pending")) {
        try {
          context.ensureRunnerAvailable?.();
          void context.engine.start(id).catch(error => { try { context.onBackgroundError?.(error, id); } catch { /* logging must not alter campaign state */ } });
        } catch {
          // Keep remaining pending items untouched for an explicit Resume after the
          // shared browser becomes available.
          resumeDeferred = true;
        }
      }
      reply(res, 200, { ...getDetail(id, context), ...(resumeDeferred ? { resumeDeferred: true } : {}) }); return true;
    }
    const action = relative.match(/^\/([^/]+)\/(start|pause|stop)$/);
    if (method === "POST" && action) {
      const id = action[1], operation = action[2];
      const input = await body(req); only(input, []);
      if (operation === "start") {
        if (context.demo) throw new CareerError(403, "demo_disabled", "Les candidatures sont désactivées en démonstration.");
        // A user may have resolved an uncertain submission in the application drawer
        // since the last dashboard refresh; reconcile before deciding whether resume is safe.
        context.engine.reconcile(id);
        const campaign = context.campaigns.get(id);
        if (["stopped", "completed", "limit_reached"].includes(campaign.state)) { reply(res, 200, getDetail(id, context)); return true; }
        if (campaign.state === "building") throw new CampaignError(409, "campaign_conflict", "La préparation de la file n’est pas terminée.");
        if (context.engine.hasUncertain(id)) throw new CampaignError(409, "uncertain_pending", "Vérifiez d’abord la candidature au résultat incertain avant de reprendre la campagne.");
        if (campaign.state !== "running") context.ensureRunnerAvailable?.();
        void context.engine.start(id).catch(error => { try { context.onBackgroundError?.(error, id); } catch { /* logging must not alter campaign state */ } });
        reply(res, 202, getDetail(id, context)); return true;
      }
      const campaign = context.campaigns.get(id);
      if (operation === "pause") context.engine.pause(id);
      else await context.engine.stop(id);
      reply(res, 200, getDetail(id, context)); return true;
    }
    return false;
  } catch (error) {
    const e = error instanceof CareerError || error instanceof CampaignError ? error : new CareerError(500, "internal", "Erreur interne de campagne.");
    reply(res, e.status, { error: e.message, code: e.code }); return true;
  }
}
