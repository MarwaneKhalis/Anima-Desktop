import type { JobOffer, OfferSearchCriteria, OfferSearchService } from "../src/shared/career.ts";
import { CareerError } from "./career-store.ts";

type Offer = Omit<JobOffer, "id" | "discoveredAt" | "updatedAt">;
type ApiJob = { offer: Offer; searchText: string; location: string; contract: string };
type CachedPage = { expiresAt: number; jobs: ApiJob[] };
type Json = Record<string, unknown>;
const API_URL = "https://www.arbeitnow.fr/api/job-board-api";
const ATTRIBUTION_URL = "https://www.arbeitnow.com";
const MAX_PAGES = 5;
const PAGE_TTL_MS = 10 * 60_000;
const MAX_BODY_BYTES = 5_000_000;
const clean = (value: unknown, max = 20_000): string => typeof value === "string"
  ? value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, " ").trim().slice(0, max)
  : "";
const obj = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(entry => typeof entry === "string" ? [clean(entry, 100)] : []) : [];
const normalize = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-FR");
function safeUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || url.username || url.password || url.hostname.length > 253) return "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
    url.hash = "";
    return url.href;
  } catch { return ""; }
}
function matchesContract(wanted: string, available: string): boolean {
  const query = normalize(wanted.trim());
  if (!query) return true;
  const values = normalize(available);
  if (/(^|\b)(cdi|permanent)(\b|$)/.test(query)) return /permanent|cdi/.test(values);
  if (/(^|\b)(cdd|fixed term|temporary)(\b|$)/.test(query)) return /fixed.?term|temporary|cdd/.test(values);
  if (/(^|\b)(stage|intern|internship)(\b|$)/.test(query)) return /intern|stage/.test(values);
  if (/(^|\b)(alternance|apprenticeship|apprentice)(\b|$)/.test(query)) return /apprentic|alternance/.test(values);
  return values.includes(query);
}

/** Public France job feed; requests are paged and cached to avoid repeated API traffic. */
export class ArbeitnowFranceDiscovery implements OfferSearchService {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<number, CachedPage>();
  constructor(request: typeof fetch = fetch, timeoutMs = 8000, now: () => number = Date.now) {
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  private mapJob(raw: unknown): ApiJob | null {
    const row = obj(raw);
    const url = safeUrl(row.url), title = clean(row.title, 500);
    if (!url || !title) return null;
    const company = clean(row.company_name, 500) || "Entreprise non précisée";
    const location = clean(row.location, 500);
    const tags = [...list(row.tags), ...list(row.job_types)];
    const description = clean(row.description, 20_000);
    return {
      offer: { url, title, company, location, description, sourceUrl: "https://www.arbeitnow.fr" },
      searchText: normalize([title, company, location, ...tags, description].join(" ")),
      location: normalize(location),
      contract: normalize(tags.join(" ")),
    };
  }

  private async page(page: number): Promise<ApiJob[]> {
    const cached = this.cache.get(page);
    if (cached && cached.expiresAt > this.now()) return cached.jobs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL(API_URL);
      url.searchParams.set("page", String(page));
      const response = await this.request(url, { headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok) throw new CareerError(502, "arbeitnow_unavailable", `Source Arbeitnow France indisponible (HTTP ${response.status}).`);
      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_BODY_BYTES) throw new CareerError(502, "arbeitnow_response_too_large", "Réponse Arbeitnow trop volumineuse.");
      const reader = response.body?.getReader();
      if (!reader) throw new CareerError(502, "arbeitnow_invalid_response", "Réponse Arbeitnow invalide.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new CareerError(502, "arbeitnow_response_too_large", "Réponse Arbeitnow trop volumineuse."); }
        chunks.push(part.value);
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8")); }
      catch { throw new CareerError(502, "arbeitnow_invalid_response", "Réponse Arbeitnow invalide."); }
      const rows = obj(value).data;
      if (!Array.isArray(rows) || rows.length > 100) throw new CareerError(502, "arbeitnow_invalid_response", "Réponse Arbeitnow invalide (liste d’offres absente ou trop volumineuse).");
      const jobs = rows.flatMap(row => { const mapped = this.mapJob(row); return mapped ? [mapped] : []; });
      this.cache.set(page, { expiresAt: this.now() + PAGE_TTL_MS, jobs });
      return jobs;
    } catch (error) {
      if (error instanceof CareerError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new CareerError(504, "arbeitnow_timeout", "La recherche Arbeitnow a dépassé le délai autorisé.");
      throw new CareerError(502, "arbeitnow_unavailable", "Arbeitnow France est momentanément inaccessible.");
    } finally { clearTimeout(timer); }
  }

  async search(criteria: OfferSearchCriteria): Promise<{ offers: Offer[]; note: string }> {
    const keywords = clean(criteria.keywords, 300);
    if (!keywords) throw new CareerError(400, "validation", "Saisissez au moins un métier ou mot-clé.");
    if (criteria.department?.trim()) throw new CareerError(400, "unsupported_filter", "La source publique filtre par ville, pas par département. Effacez le département ou choisissez France Travail.");
    const limit = Math.max(1, Math.min(450, Math.floor(criteria.limit ?? 50)));
    const phrases = keywords.split(/[,;\n]+/).map(normalize).filter(Boolean).map(phrase => phrase.split(/\s+/).filter(Boolean));
    const commune = normalize(clean(criteria.commune, 100));
    const offers: Offer[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    for (let page = 1; page <= MAX_PAGES && offers.length < limit; page++) {
      const jobs = await this.page(page);
      scanned += jobs.length;
      for (const job of jobs) {
        if (!phrases.some(words => words.every(word => job.searchText.includes(word)))) continue;
        if (commune && !job.location.includes(commune)) continue;
        if (!matchesContract(criteria.contractType || "", job.contract)) continue;
        const key = job.offer.url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        offers.push(job.offer);
        if (offers.length >= limit) break;
      }
      if (jobs.length < 100) break;
    }
    const note = offers.length
      ? `${offers.length} offre(s) Arbeitnow France trouvée(s), parmi ${scanned} annonces récentes examinées. Les résultats sont actualisés environ chaque heure. Source : ${ATTRIBUTION_URL}.`
      : `Aucune offre correspondante parmi ${scanned} annonces récentes examinées. La source publique est limitée aux pages consultées et ne couvre pas tout le marché français. Source : ${ATTRIBUTION_URL}.`;
    return { offers, note };
  }
}
