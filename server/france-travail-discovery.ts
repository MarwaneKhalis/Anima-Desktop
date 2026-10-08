import type { JobOffer, OfferSearchCriteria, OfferSearchService } from "../src/shared/career.ts";
import { CareerError } from "./career-store.ts";
import type { Vault } from "./vault.ts";

type Offer = Omit<JobOffer, "id" | "discoveredAt" | "updatedAt">;
type Json = Record<string, unknown>;
const TOKEN_URL = "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=/partenaire";
const SEARCH_URL = "https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search";
const GEO_URL = "https://geo.api.gouv.fr/communes";
const DEPARTMENT_CODE = /^(?:\d{2,3}|2[AB])$/i;
const INSEE_COMMUNE_CODE = /^(?:\d{5}|2[AB]\d{3})$/i;
const PAGE_SIZE = 150;
const MAX_PAGES = 3;
const clean = (value: unknown, max = 20000): string => typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const obj = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const nested = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => obj(current)[key], value);
const safeUrl = (value: unknown): string => { try { const url = new URL(String(value)); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; } catch { return ""; } };

export class FranceTravailDiscovery implements OfferSearchService {
  private readonly vault: Vault;
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  constructor(vault: Vault, request: typeof fetch = fetch, timeoutMs = 12000) { this.vault = vault; this.request = request; this.timeoutMs = timeoutMs; }

  private async json(url: string, init: RequestInit): Promise<Json> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.request(url, { ...init, redirect: "error", signal: controller.signal });
      if (!response.ok) throw response.status === 401 || response.status === 403
        ? new CareerError(403, "france_travail_access_denied", "Accès France Travail refusé. Vérifiez les identifiants, le périmètre et l’habilitation API.")
        : new CareerError(502, "france_travail_unavailable", `Service France Travail indisponible (HTTP ${response.status}).`);
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 5_000_000) throw new CareerError(502, "france_travail_response_too_large", "Réponse France Travail trop volumineuse.");
      const reader = response.body?.getReader();
      if (!reader) throw new CareerError(502, "france_travail_invalid_response", "Réponse France Travail invalide.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 5_000_000) { await reader.cancel(); throw new CareerError(502, "france_travail_response_too_large", "Réponse France Travail trop volumineuse."); }
        chunks.push(part.value);
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")); }
      catch { throw new CareerError(502, "france_travail_invalid_response", "Réponse France Travail invalide."); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Réponse France Travail invalide.");
      return value as Json;
    } catch (error) {
      if (error instanceof CareerError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new CareerError(504, "france_travail_timeout", "La recherche France Travail a dépassé le délai autorisé.");
      throw new CareerError(502, "france_travail_unavailable", "France Travail est momentanément inaccessible.");
    } finally { clearTimeout(timer); }
  }

  private async token(): Promise<string> {
    const config = this.vault.getFranceTravailConfig();
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret, scope: config.scope });
    const response = await this.json(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    const token = clean(response.access_token, 8000);
    if (!token) throw new CareerError(502, "france_travail_invalid_token", "France Travail n’a pas fourni de jeton d’accès.");
    return token;
  }

  private async resolveCommune(value: string, department?: string): Promise<string> {
    if (INSEE_COMMUNE_CODE.test(value)) return value.toUpperCase();
    if (value.length < 2 || value.length > 100 || /^\d+$/.test(value) || /(?:\d{5}|2[AB]\d{3})/i.test(value)) throw new CareerError(400, "validation", "La commune doit être un nom de ville ou un code INSEE à 5 caractères.");
    const url = new URL(GEO_URL);
    url.searchParams.set("nom", value);
    url.searchParams.set("fields", "code,nom,codeDepartement");
    url.searchParams.set("format", "json");
    url.searchParams.set("boost", "population");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 6000));
    try {
      const response = await this.request(url, { headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok) throw new CareerError(502, "commune_lookup_unavailable", "La recherche de commune est momentanément indisponible.");
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 1_000_000) throw new CareerError(502, "commune_lookup_invalid", "Réponse de recherche de commune trop volumineuse.");
      const reader = response.body?.getReader();
      if (!reader) throw new CareerError(502, "commune_lookup_invalid", "Réponse de recherche de commune invalide.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1_000_000) { await reader.cancel(); throw new CareerError(502, "commune_lookup_invalid", "Réponse de recherche de commune trop volumineuse."); }
        chunks.push(part.value);
      }
      let raw: unknown;
      try { raw = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")); }
      catch { throw new CareerError(502, "commune_lookup_invalid", "Réponse de recherche de commune invalide."); }
      if (!Array.isArray(raw) || raw.length > 500) throw new CareerError(502, "commune_lookup_invalid", "Réponse de recherche de commune invalide.");
      const candidates = raw.map(obj).filter((entry) => INSEE_COMMUNE_CODE.test(String(entry.code || "")) && clean(entry.nom, 200));
      const narrowed = department ? candidates.filter((entry) => String(entry.codeDepartement || "").toUpperCase() === department.toUpperCase()) : candidates;
      const byCode = new Map(narrowed.map((entry) => [String(entry.code), String(entry.nom)]));
      if (byCode.size === 0) throw new CareerError(404, "commune_not_found", "Aucune commune correspondante trouvée. Vérifiez le nom ou le département.");
      if (byCode.size > 1) {
        const choices = [...byCode.entries()].slice(0, 4).map(([code, name]) => `${name} (${code})`).join(", ");
        throw new CareerError(409, "commune_ambiguous", `Plusieurs communes correspondent à « ${value} »${department ? ` dans le département ${department}` : ""} : ${choices}. Précisez le département ou le code INSEE.`);
      }
      return [...byCode.keys()][0];
    } catch (error) {
      if (error instanceof CareerError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new CareerError(504, "commune_lookup_timeout", "La recherche de commune a dépassé le délai autorisé.");
      throw new CareerError(502, "commune_lookup_unavailable", "La recherche de commune est momentanément inaccessible.");
    } finally { clearTimeout(timer); }
  }

  async search(criteria: OfferSearchCriteria): Promise<{ offers: Offer[]; note: string }> {
    const keywords = clean(criteria.keywords, 300);
    if (!keywords) throw new CareerError(400, "validation", "Saisissez au moins un métier ou mot-clé.");
    const department = criteria.department?.trim();
    if (department && !DEPARTMENT_CODE.test(department)) throw new CareerError(400, "validation", "Le département doit être un code à 2 ou 3 chiffres, ou 2A/2B pour la Corse.");
    const communeInput = criteria.commune?.trim();
    const commune = communeInput ? await this.resolveCommune(communeInput, department) : undefined;
    const contractType = clean(criteria.contractType, 40);
    const limit = Math.max(1, Math.min(450, Math.floor(criteria.limit ?? 150)));
    const accessToken = await this.token();
    const offers: Offer[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < Math.min(MAX_PAGES, Math.ceil(limit / PAGE_SIZE)); page++) {
      const params = new URLSearchParams({ motsCles: keywords, range: `${page * PAGE_SIZE}-${page * PAGE_SIZE + PAGE_SIZE - 1}` });
      if (department) params.set("departement", department);
      if (commune) params.set("commune", commune);
      if (contractType) params.set("typeContrat", contractType);
      const data = await this.json(`${SEARCH_URL}?${params}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
      const results = data.resultats;
      if (!Array.isArray(results)) throw new CareerError(502, "france_travail_invalid_response", "Réponse France Travail invalide (liste d’offres absente).");
      for (const raw of results) {
        const item = obj(raw);
        const url = safeUrl(nested(item, "origineOffre", "urlOrigine"));
        const title = clean(item.intitule, 500);
        const company = clean(nested(item, "entreprise", "nom"), 500);
        if (!url || !title) continue;
        const key = String(item.id || url).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const place = obj(item.lieuTravail);
        const location = clean(place.libelle || [place.ville, place.codePostal].filter(Boolean).join(" "), 500);
        const description = clean(item.description, 20000);
        offers.push({ url, title, company: company || "Entreprise non précisée", location, description, sourceUrl: url });
        if (offers.length >= limit) break;
      }
      if (results.length < PAGE_SIZE || offers.length >= limit) break;
    }
    const note = offers.length
      ? `${offers.length} offre(s) France Travail trouvée(s). Jusqu’à ${limit} résultats consultés, doublons par identifiant regroupés. Les offres sans lien de candidature exploitable sont ignorées.`
      : "Aucune offre avec lien de candidature exploitable ne correspond aux critères dans les résultats consultés.";
    return { offers, note };
  }
}
