import type { JobOffer, OfferSearchCriteria, OfferSearchService } from "../src/shared/career.ts";
import { CareerError, careerUrl } from "./career-store.ts";

type Offer = Omit<JobOffer, "id" | "discoveredAt" | "updatedAt">;
type Json = Record<string, unknown>;
type CacheEntry = { expiresAt: number; offers: Offer[] };

const API_URL = "https://himalayas.app/jobs/api/search";
const SOURCE_URL = "https://himalayas.app";
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_BODY_BYTES = 8_000_000;
const MAX_ROWS = 200;
const MAX_RESULTS = 20;
const MAX_CACHE_ENTRIES = 40;

const obj = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const clean = (value: unknown, max = 20_000): string => typeof value === "string"
  ? value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?\s*>|<\/(p|div|li|h[1-6])\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim().slice(0, max)
  : "";
const normalize = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-FR");

function jobUrl(value: unknown): string {
  try {
    const url = new URL(careerUrl(String(value)));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "himalayas.app" || url.username || url.password
      || !/^\/companies\/[a-z0-9-]+\/jobs\/[a-z0-9][a-z0-9-]*\/?$/i.test(url.pathname)) return "";
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

function milliseconds(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (Number.isFinite(number) && number > 0) return number < 100_000_000_000 ? number * 1000 : number;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function openToFrance(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  return value.some(item => {
    if (typeof item === "string") return /^(?:fr|france)$/i.test(item.trim());
    const row = obj(item);
    return [row.alpha2, row.name, row.slug].some(part => typeof part === "string" && /^(?:fr|france)$/i.test(part.trim()));
  });
}

function employmentType(value: string): string {
  const normalized = normalize(value);
  if (!normalized) return "";
  if (/\b(cdi|permanent|full.?time|temps plein)\b/.test(normalized)) return "Full Time";
  if (/\b(part.?time|temps partiel)\b/.test(normalized)) return "Part Time";
  if (/\b(cdd|fixed.?term|temporary|temporaire)\b/.test(normalized)) return "Temporary";
  if (/\b(stage|intern|internship|alternance|apprenticeship|apprenti)\b/.test(normalized)) return "Intern";
  if (/\b(freelance|independent|contractor|contract)\b/.test(normalized)) return "Contractor";
  throw new CareerError(400, "unsupported_filter", "Himalayas ne reconnaît pas ce type de contrat. Effacez le filtre.");
}

/** Public, attribution-required remote-job search. Results are cached for the API's daily refresh window. */
export class HimalayasDiscovery implements OfferSearchService {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<Offer[]>>();

  constructor(request: typeof fetch = fetch, timeoutMs = 8000, now: () => number = Date.now) {
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  private async fetchOffers(keywords: string, type: string): Promise<Offer[]> {
    const url = new URL(API_URL);
    url.searchParams.set("q", keywords);
    url.searchParams.set("country", "FR");
    url.searchParams.set("sort", "recent");
    url.searchParams.set("page", "1");
    if (type) url.searchParams.set("employment_type", type);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.request(url, { headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok) throw new CareerError(502, "himalayas_unavailable", `Source Himalayas indisponible (HTTP ${response.status}).`);
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_BODY_BYTES) throw new CareerError(502, "himalayas_response_too_large", "Réponse Himalayas trop volumineuse.");
      const reader = response.body?.getReader();
      if (!reader) throw new CareerError(502, "himalayas_invalid_response", "Réponse Himalayas invalide.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new CareerError(502, "himalayas_response_too_large", "Réponse Himalayas trop volumineuse.");
        }
        chunks.push(part.value);
      }
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8")); }
      catch { throw new CareerError(502, "himalayas_invalid_response", "Réponse Himalayas invalide."); }
      const jobs = obj(payload).jobs;
      if (!Array.isArray(jobs) || jobs.length > MAX_ROWS || jobs.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
        throw new CareerError(502, "himalayas_invalid_response", "Réponse Himalayas invalide (liste d’offres absente ou trop volumineuse).");
      }
      const now = this.now();
      const seen = new Set<string>();
      const offers: Offer[] = [];
      for (const raw of jobs) {
        const row = obj(raw);
        const url = jobUrl(row.applicationLink);
        const title = clean(row.title, 500);
        const company = clean(row.companyName, 500);
        if (!url || !title || !company || !openToFrance(row.locationRestrictions)) continue;
        const expiresAt = milliseconds(row.expiryDate);
        if (expiresAt !== null && expiresAt <= now) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        const restrictions = Array.isArray(row.locationRestrictions)
          ? row.locationRestrictions.map(item => clean(typeof item === "string" ? item : obj(item).name || obj(item).alpha2, 80)).filter(Boolean).join(", ")
          : "";
        offers.push({
          url,
          title,
          company,
          location: restrictions || "Télétravail (France ou partout)",
          description: clean(row.description || row.excerpt, 20_000),
          sourceUrl: url,
        });
      }
      return offers;
    } catch (error) {
      if (error instanceof CareerError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new CareerError(504, "himalayas_timeout", "La recherche Himalayas a dépassé le délai autorisé.");
      throw new CareerError(502, "himalayas_unavailable", "Himalayas est momentanément inaccessible.");
    } finally { clearTimeout(timer); }
  }

  async search(criteria: OfferSearchCriteria): Promise<{ offers: Offer[]; note: string }> {
    const keywords = clean(criteria.keywords, 300);
    if (!keywords) throw new CareerError(400, "validation", "Saisissez au moins un métier ou mot-clé.");
    if (criteria.department?.trim() || criteria.commune?.trim()) {
      throw new CareerError(400, "unsupported_filter", "Himalayas ne filtre que par pays. Effacez le département ou la ville.");
    }
    const type = employmentType(criteria.contractType || "");
    const key = JSON.stringify([normalize(keywords), type]);
    let entry = this.cache.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      entry = undefined;
    } else if (entry) {
      // Keep frequently reused queries warm while bounding this in-memory cache.
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    if (!entry || entry.expiresAt <= this.now()) {
      let pending = this.pending.get(key);
      if (!pending) {
        pending = this.fetchOffers(keywords, type);
        this.pending.set(key, pending);
      }
      try {
        const offers = await pending;
        entry = { offers, expiresAt: this.now() + CACHE_TTL_MS };
        this.cache.set(key, entry);
        while (this.cache.size > MAX_CACHE_ENTRIES) {
          const oldestKey = this.cache.keys().next().value;
          if (oldestKey === undefined) break;
          this.cache.delete(oldestKey);
        }
      } finally {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      }
    }
    const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(criteria.limit ?? 50)));
    // The API applies contract filters before returning the page; only cap the returned page locally.
    const limited = entry.offers.slice(0, limit);
    const note = limited.length
      ? `${limited.length} offre(s) Himalayas correspondant à la France ou au monde entier. La recherche utilise une page de 20 résultats ; le flux est actualisé quotidiennement et chaque fiche renvoie à son annonce d’origine sur Himalayas.`
      : `Aucune offre Himalayas correspondante pour la France. La source couvre les emplois à distance et est actualisée quotidiennement. Source : ${SOURCE_URL}.`;
    return { offers: limited, note };
  }
}

