import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JobOffer, OfferSearchCriteria, OfferSearchService } from "../src/shared/career.ts";
import { CareerError, careerUrl } from "./career-store.ts";

type Offer = Omit<JobOffer, "id" | "discoveredAt" | "updatedAt">;
type Json = Record<string, unknown>;
type CachedJob = { offer: Offer; searchText: string; location: string; contract: string; publishedAt: number };
type CacheFile = { version: 1; lastAttemptAt: number; fetchedAt: number; jobs: CachedJob[] };

const API_URL = "https://remotive.com/api/remote-jobs";
const SOURCE_URL = "https://remotive.com/remote-jobs/api";
const MIN_REFRESH_MS = 24 * 60 * 60_000;
const STALE_LIMIT_MS = 7 * 24 * 60 * 60_000;
const MAX_BODY_BYTES = 8_000_000;
const MAX_ROWS = 5_000;
const MAX_RESULTS = 200;
const MAX_AGE_MS = 90 * 24 * 60 * 60_000;

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
    .replace(/&#(\d+);/g, (_match, digits: string) => {
      const code = Number(digits);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([\da-f]+);/gi, (_match, digits: string) => {
      const code = Number.parseInt(digits, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/\s+/g, " ").trim().slice(0, max)
  : "";
const normalize = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-FR");

function safeJobUrl(value: unknown): string {
  try {
    const url = new URL(careerUrl(String(value)));
    if (url.protocol !== "https:" || !["remotive.com", "www.remotive.com"].includes(url.hostname.toLowerCase())
      || url.username || url.password || !url.pathname.startsWith("/remote-jobs/")) return "";
    url.hostname = "remotive.com";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

function locationAllowsFrance(value: string): boolean {
  const location = normalize(value);
  if (!location) return false;
  return /(^|[^a-z])(?:france|french|europe|european union|emea|eu|eea|worldwide|anywhere|global|all countries)(?=$|[^a-z])/.test(location);
}

function matchesContract(wanted: string, available: string): boolean {
  const query = normalize(wanted.trim()), value = normalize(available);
  if (!query) return true;
  if (/(^|\b)(cdi|permanent|full.?time|temps plein)(\b|$)/.test(query)) return /permanent|full.?time|cdi|temps plein/.test(value);
  if (/(^|\b)(cdd|fixed.?term|temporary|temporaire)(\b|$)/.test(query)) return /fixed.?term|temporary|contract|cdd|temporaire/.test(value);
  if (/(^|\b)(stage|intern|internship|alternance|apprenticeship)(\b|$)/.test(query)) return /intern|stage|alternance|apprenticeship/.test(value);
  if (/(^|\b)(freelance|independent|contract)(\b|$)/.test(query)) return /freelance|independent|contract/.test(value);
  if (/(^|\b)(part.?time|temps partiel)(\b|$)/.test(query)) return /part.?time|temps partiel/.test(value);
  return value.includes(query);
}

function cachedJob(value: unknown): CachedJob | null {
  const row = obj(value);
  const offer = obj(row.offer) as Partial<Offer>;
  const url = safeJobUrl(offer.url);
  const title = clean(offer.title, 500);
  const company = clean(offer.company, 500);
  if (!url || !title || !company || typeof row.searchText !== "string" || typeof row.location !== "string"
    || typeof row.contract !== "string" || !Number.isFinite(row.publishedAt)) return null;
  return {
    offer: { url, title, company, location: clean(offer.location, 500), description: clean(offer.description, 20_000), sourceUrl: url },
    searchText: clean(row.searchText, 25_000),
    location: clean(row.location, 500),
    contract: clean(row.contract, 200),
    publishedAt: Number(row.publishedAt),
  };
}

function parseCache(value: unknown): CacheFile | null {
  const row = obj(value);
  if (row.version !== 1 || !Number.isFinite(row.lastAttemptAt) || !Number.isFinite(row.fetchedAt)
    || !Array.isArray(row.jobs) || row.jobs.length > MAX_ROWS) return null;
  const jobs = row.jobs.map(cachedJob);
  if (jobs.some(job => !job)) return null;
  return { version: 1, lastAttemptAt: Number(row.lastAttemptAt), fetchedAt: Number(row.fetchedAt), jobs: jobs as CachedJob[] };
}

/** Remotive's public feed is delayed by 24 hours and advises at most four requests daily.
 * The complete feed is fetched at most once per 24 hours and cached in the app data folder,
 * so keyword searches stay local and do not disclose profile terms to the source. */
export class RemotiveDiscovery implements OfferSearchService {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cachePath: string;
  private pending?: Promise<{ cache: CacheFile; stale: boolean }>;
  private cache?: CacheFile;

  constructor(options: { cachePath: string; request?: typeof fetch; timeoutMs?: number; now?: () => number }) {
    this.cachePath = options.cachePath;
    this.request = options.request || fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.now = options.now ?? Date.now;
  }

  private async saveCache(cache: CacheFile): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    const tempPath = `${this.cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(cache), { encoding: "utf8", flag: "wx" });
      await rename(tempPath, this.cachePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async loadCache(): Promise<CacheFile | null> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.cachePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > 12_000_000) throw new Error("cache too large");
      const parsed = parseCache(JSON.parse(raw));
      if (!parsed) throw new Error("cache invalid");
      this.cache = parsed;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new CareerError(503, "remotive_cache_unavailable", "Le cache Remotive est illisible. La source est désactivée pour éviter un appel API non maîtrisé.");
    }
  }

  private async readOffers(): Promise<{ cache: CacheFile; stale: boolean }> {
    if (this.pending) return this.pending;
    const pending = this.refreshIfDue();
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = undefined; }
  }

  private async refreshIfDue(): Promise<{ cache: CacheFile; stale: boolean }> {
    const previous = await this.loadCache();
    const now = this.now();
    if (previous && previous.fetchedAt > 0 && now - previous.fetchedAt < MIN_REFRESH_MS) {
      return { cache: previous, stale: false };
    }
    if (previous && now - previous.lastAttemptAt < MIN_REFRESH_MS) {
      if (previous.fetchedAt > 0 && now - previous.fetchedAt <= STALE_LIMIT_MS) return { cache: previous, stale: true };
      throw new CareerError(503, "remotive_refresh_limited", "Remotive limite ses appels. Réessayez après la fenêtre de 24 heures.");
    }

    const attempt: CacheFile = previous
      ? { ...previous, lastAttemptAt: now }
      : { version: 1, lastAttemptAt: now, fetchedAt: 0, jobs: [] };
    try { await this.saveCache(attempt); this.cache = attempt; }
    catch { throw new CareerError(503, "remotive_cache_unavailable", "Impossible d’enregistrer le cache Remotive. Aucun appel à la source n’a été effectué."); }

    try {
      const jobs = await this.fetchJobs();
      const refreshed: CacheFile = { version: 1, lastAttemptAt: now, fetchedAt: now, jobs };
      await this.saveCache(refreshed);
      this.cache = refreshed;
      return { cache: refreshed, stale: false };
    } catch (error) {
      if (previous && previous.fetchedAt > 0 && now - previous.fetchedAt <= STALE_LIMIT_MS) {
        return { cache: attempt, stale: true };
      }
      throw error;
    }
  }

  private async fetchJobs(): Promise<CachedJob[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.request(API_URL, { headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok) throw new CareerError(502, "remotive_unavailable", `Source Remotive indisponible (HTTP ${response.status}).`);
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_BODY_BYTES) throw new CareerError(502, "remotive_response_too_large", "Réponse Remotive trop volumineuse.");
      const reader = response.body?.getReader();
      if (!reader) throw new CareerError(502, "remotive_invalid_response", "Réponse Remotive invalide.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new CareerError(502, "remotive_response_too_large", "Réponse Remotive trop volumineuse.");
        }
        chunks.push(part.value);
      }
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8")); }
      catch { throw new CareerError(502, "remotive_invalid_response", "Réponse Remotive invalide."); }
      const rows = obj(payload).jobs;
      if (!Array.isArray(rows) || rows.length > MAX_ROWS || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
        throw new CareerError(502, "remotive_invalid_response", "Réponse Remotive invalide (liste d’offres absente ou trop volumineuse).");
      }
      const now = this.now();
      const seen = new Set<string>();
      const offers: CachedJob[] = [];
      for (const raw of rows) {
        const row = obj(raw);
        const url = safeJobUrl(row.url);
        const title = clean(row.title, 500);
        const company = clean(row.company_name, 500);
        const location = clean(row.candidate_required_location, 500);
        const publishedAt = typeof row.publication_date === "string" ? Date.parse(row.publication_date) : Number.NaN;
        if (!url || !title || !company || !locationAllowsFrance(location) || !Number.isFinite(publishedAt)
          || publishedAt > now + 24 * 60 * 60_000 || now - publishedAt > MAX_AGE_MS || seen.has(url)) continue;
        seen.add(url);
        const contract = clean(row.job_type, 200).replace(/_/g, " ");
        const description = clean(row.description, 20_000);
        const salary = clean(row.salary, 300);
        const searchText = normalize([title, company, location, contract, clean(row.category, 300), description, salary].join(" "));
        offers.push({ offer: { url, title, company, location, description, sourceUrl: url }, searchText, location: normalize(location), contract: normalize(contract), publishedAt });
      }
      return offers;
    } catch (error) {
      if (error instanceof CareerError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new CareerError(504, "remotive_timeout", "La recherche Remotive a dépassé le délai autorisé.");
      throw new CareerError(502, "remotive_unavailable", "Remotive est momentanément inaccessible.");
    } finally { clearTimeout(timer); }
  }

  async search(criteria: OfferSearchCriteria): Promise<{ offers: Offer[]; note: string }> {
    const keywords = clean(criteria.keywords, 300);
    if (!keywords) throw new CareerError(400, "validation", "Saisissez au moins un métier ou mot-clé.");
    if (criteria.department?.trim()) throw new CareerError(400, "unsupported_filter", "Remotive ne filtre pas par département. Effacez ce filtre.");
    if (criteria.commune?.trim()) throw new CareerError(400, "unsupported_filter", "Remotive ne précise pas les villes d’éligibilité. Effacez le filtre ville.");
    const wanted = keywords.split(/[,;\n]+/).map(normalize).filter(Boolean).map(phrase => phrase.split(/\s+/).filter(Boolean));
    const commune = normalize(clean(criteria.commune, 100));
    const { cache, stale } = await this.readOffers();
    const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(criteria.limit ?? 50)));
    const offers: Offer[] = [];
    for (const job of cache.jobs) {
      if (!wanted.some(words => words.every(word => job.searchText.includes(word)))) continue;
      if (commune && !job.location.includes(commune)) continue;
      if (!matchesContract(criteria.contractType || "", job.contract)) continue;
      offers.push(job.offer);
      if (offers.length >= limit) break;
    }
    const note = offers.length
      ? `${offers.length} offre(s) Remotive filtrée(s) localement parmi les postes distants ouverts à la France, à l’Europe ou partout. Remotive retarde les annonces de 24 h ; le flux est mis en cache localement et actualisé au maximum une fois par jour. Fiche et attribution : ${SOURCE_URL}.${stale ? " Le dernier cache disponible est servi après un échec de mise à jour." : ""}`
      : `Aucune offre Remotive correspondante parmi les annonces distantes ouvertes à la France. La source est retardée de 24 h et actualisée au maximum une fois par jour. Fiche et attribution : ${SOURCE_URL}.${stale ? " Le dernier cache disponible est servi après un échec de mise à jour." : ""}`;
    return { offers, note };
  }
}
