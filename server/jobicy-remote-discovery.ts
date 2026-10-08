import type { JobOffer, OfferSearchCriteria, OfferSearchService } from "../src/shared/career.ts";
import { CareerError } from "./career-store.ts";

type Offer = Omit<JobOffer, "id" | "discoveredAt" | "updatedAt">;
type Json = Record<string, unknown>;
type CachedResponse = { expiresAt: number; raw: string };

const API_URL = "https://jobicy.com/api/v2/remote-jobs";
const SOURCE_URL = "https://jobicy.com";
const CACHE_TTL_MS = 60 * 60_000;
const MAX_BODY_BYTES = 5_000_000;
const MAX_JOBS = 200;

const obj = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const clean = (value: unknown, max = 20_000): string => typeof value === "string"
  ? value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<br\s*\/?\s*>|<\/(p|div|li|h[1-6])\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, digits: string) => {
      const code = Number(digits);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/\s+/g, " ").trim().slice(0, max)
  : "";
const cleanList = (value: unknown, max = 1000): string => Array.isArray(value)
  ? value.flatMap(item => typeof item === "string" ? [clean(item, 200)] : []).join(" ").slice(0, max)
  : clean(value, max);
const normalize = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-FR");

function safeJobicyUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || url.username || url.password || !["jobicy.com", "www.jobicy.com"].includes(url.hostname.toLowerCase())) return "";
    url.hostname = "jobicy.com";
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

function matchesContract(wanted: string, available: string): boolean {
  const query = normalize(wanted.trim()), value = normalize(available);
  if (!query) return true;
  if (/(^|\b)(cdi|permanent|full.?time)(\b|$)/.test(query)) return /permanent|cdi|full.?time/.test(value);
  if (/(^|\b)(cdd|fixed.?term|temporary)(\b|$)/.test(query)) return /fixed.?term|temporary|contract|cdd/.test(value);
  if (/(^|\b)(stage|intern|internship)(\b|$)/.test(query)) return /intern|stage/.test(value);
  if (/(^|\b)(alternance|apprenticeship|apprentice)(\b|$)/.test(query)) return /apprentic|alternance/.test(value);
  if (/(^|\b)(freelance|independent)(\b|$)/.test(query)) return /freelance|independent/.test(value);
  if (/(^|\b)(part.?time|temps partiel)(\b|$)/.test(query)) return /part.?time|temps partiel/.test(value);
  return value.includes(query);
}

/** Public remote-job feed from Jobicy; the API response is cached for one hour. */
export class JobicyRemoteDiscovery implements OfferSearchService {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cached?: CachedResponse;
  private pending?: Promise<string>;

  constructor(request: typeof fetch = fetch, timeoutMs = 8000, now: () => number = Date.now) {
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  private async rawResponse(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.raw;
    if (this.pending) return this.pending;
    const pending = this.fetchRawResponse();
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = undefined; }
  }

  private async fetchRawResponse(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL(API_URL);
      url.searchParams.set("geo", "france");
      url.searchParams.set("count", String(MAX_JOBS));
      const response = await this.request(url, { headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok) throw new CareerError(502, "jobicy_unavailable", `Source Jobicy indisponible (HTTP ${response.status}).`);
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_BODY_BYTES) throw new CareerError(502, "jobicy_response_too_large", "Réponse Jobicy trop volumineuse.");
      const reader = response.body?.getReader();
      if (!reader) throw new CareerError(502, "jobicy_invalid_response", "Réponse Jobicy invalide.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new CareerError(502, "jobicy_response_too_large", "Réponse Jobicy trop volumineuse.");
        }
        chunks.push(part.value);
      }
      const raw = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
      let payload: unknown;
      try { payload = JSON.parse(raw); }
      catch { throw new CareerError(502, "jobicy_invalid_response", "Réponse Jobicy invalide."); }
      const jobs = obj(payload).jobs;
      if (!Array.isArray(jobs) || jobs.length > MAX_JOBS) {
        throw new CareerError(502, "jobicy_invalid_response", "Réponse Jobicy invalide (liste d’offres absente ou trop volumineuse).");
      }
      this.cached = { expiresAt: this.now() + CACHE_TTL_MS, raw };
      return raw;
    } catch (error) {
      if (error instanceof CareerError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new CareerError(504, "jobicy_timeout", "La recherche Jobicy a dépassé le délai autorisé.");
      throw new CareerError(502, "jobicy_unavailable", "Jobicy est momentanément inaccessible.");
    } finally { clearTimeout(timer); }
  }

  private mapJob(raw: unknown): { offer: Offer; searchText: string; location: string; contract: string } | null {
    const row = obj(raw);
    const url = safeJobicyUrl(row.url);
    const title = clean(row.jobTitle, 500);
    if (!url || !title) return null;
    const company = clean(row.companyName, 500) || "Entreprise non précisée";
    const location = clean(row.jobGeo, 500);
    const contract = cleanList(row.jobType, 300);
    const description = clean(row.jobDescription || row.jobExcerpt, 20_000);
    const searchText = normalize([
      title, company, location, contract, cleanList(row.jobIndustry, 1000), clean(row.jobLevel, 300), description,
    ].join(" "));
    return { offer: { url, title, company, location, description, sourceUrl: url }, searchText, location: normalize(location), contract: normalize(contract) };
  }

  async search(criteria: OfferSearchCriteria): Promise<{ offers: Offer[]; note: string }> {
    const keywords = clean(criteria.keywords, 300);
    if (!keywords) throw new CareerError(400, "validation", "Saisissez au moins un métier ou mot-clé.");
    if (criteria.department?.trim()) throw new CareerError(400, "unsupported_filter", "Jobicy ne permet pas de filtrer par département. Effacez ce filtre.");
    const limit = Math.max(1, Math.min(MAX_JOBS, Math.floor(criteria.limit ?? 50)));
    const payload = JSON.parse(await this.rawResponse()) as unknown;
    const rows = obj(payload).jobs as unknown[];
    const phrases = keywords.split(/[,;\n]+/).map(normalize).filter(Boolean).map(phrase => phrase.split(/\s+/).filter(Boolean));
    const commune = normalize(clean(criteria.commune, 100));
    const offers: Offer[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const job = this.mapJob(row);
      if (!job || !phrases.some(words => words.every(word => job.searchText.includes(word)))) continue;
      if (commune && !job.location.includes(commune)) continue;
      if (!matchesContract(criteria.contractType || "", job.contract)) continue;
      const key = job.offer.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      offers.push(job.offer);
      if (offers.length >= limit) break;
    }
    const note = offers.length
      ? `${offers.length} offre(s) Jobicy trouvée(s) parmi les postes distants correspondant à la zone France, ${offers.length === 1 ? "résultat" : "résultats"} filtré(s) localement. La source est actualisée au maximum une fois par heure. Source : ${SOURCE_URL}.`
      : `Aucune offre Jobicy correspondante parmi les postes distants de la zone France. Les filtres métier, ville et contrat sont appliqués localement ; la source ne couvre pas tout le marché français. Source : ${SOURCE_URL}.`;
    return { offers, note };
  }
}
