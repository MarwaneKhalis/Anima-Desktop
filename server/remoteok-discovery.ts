import type { JobOffer, OfferSearchCriteria, OfferSearchService } from "../src/shared/career.ts";
import { CareerError } from "./career-store.ts";

type Offer = Omit<JobOffer, "id" | "discoveredAt" | "updatedAt">;
type Json = Record<string, unknown>;
type CachedResponse = { expiresAt: number; raw: string };

const API_URL = "https://remoteok.com/api";
const SOURCE_URL = "https://remoteok.com";
const CACHE_TTL_MS = 60 * 60_000;
const MAX_BODY_BYTES = 8_000_000;
const MAX_ROWS = 2_000;
const MAX_RESULTS = 200;
const MAX_AGE_MS = 60 * 24 * 60 * 60_000;

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
const cleanList = (value: unknown, max = 1000): string => Array.isArray(value)
  ? value.flatMap(item => typeof item === "string" ? [clean(item, 200)] : []).join(" ").slice(0, max)
  : clean(value, max);
const normalize = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-FR");

function safeRemoteOkUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || url.username || url.password || !["remoteok.com", "www.remoteok.com"].includes(url.hostname.toLowerCase()) || !/^\/remote-jobs\/[^/]+/i.test(url.pathname)) return "";
    url.hostname = "remoteok.com";
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

/** Remote OK's remote-only feed is filtered to listings that explicitly include France or a broad eligible region. */
function isOpenToFrance(location: string): boolean {
  const normalized = normalize(location);
  return /(^|[^a-z])(?:france|europe|emea|european union|eea|eu|worldwide|anywhere|global)(?=$|[^a-z])/.test(normalized);
}

function createdAt(row: Json): number {
  const date = typeof row.date === "string" ? Date.parse(row.date) : Number.NaN;
  if (Number.isFinite(date)) return date;
  const epoch = Number(row.epoch);
  return Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Number.NaN;
}

/** Reads Remote OK's public JSON feed once per hour and keeps its original listing URL for attribution. */
export class RemoteOkDiscovery implements OfferSearchService {
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
      const response = await this.request(API_URL, { headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok) throw new CareerError(502, "remoteok_unavailable", `Source Remote OK indisponible (HTTP ${response.status}).`);
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_BODY_BYTES) throw new CareerError(502, "remoteok_response_too_large", "Réponse Remote OK trop volumineuse.");
      const reader = response.body?.getReader();
      if (!reader) throw new CareerError(502, "remoteok_invalid_response", "Réponse Remote OK invalide.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new CareerError(502, "remoteok_response_too_large", "Réponse Remote OK trop volumineuse.");
        }
        chunks.push(part.value);
      }
      const raw = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
      let payload: unknown;
      try { payload = JSON.parse(raw); }
      catch { throw new CareerError(502, "remoteok_invalid_response", "Réponse Remote OK invalide."); }
      if (!Array.isArray(payload) || payload.length > MAX_ROWS + 1 || payload.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
        throw new CareerError(502, "remoteok_invalid_response", "Réponse Remote OK invalide (flux d’offres absent ou trop volumineux).");
      }
      this.cached = { expiresAt: this.now() + CACHE_TTL_MS, raw };
      return raw;
    } catch (error) {
      if (error instanceof CareerError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new CareerError(504, "remoteok_timeout", "La recherche Remote OK a dépassé le délai autorisé.");
      throw new CareerError(502, "remoteok_unavailable", "Remote OK est momentanément inaccessible.");
    } finally { clearTimeout(timer); }
  }

  private mapJob(raw: unknown): { offer: Offer; searchText: string; location: string; contract: string; createdAt: number } | null {
    const row = obj(raw);
    const url = safeRemoteOkUrl(row.url);
    const title = clean(row.position, 500);
    if (!url || !title || row.closed === true || row.verified === false) return null;
    const company = clean(row.company, 500) || "Entreprise non précisée";
    const location = clean(row.location, 500);
    const contract = cleanList(row.tags, 1000);
    const description = clean(row.description, 20_000);
    const searchText = normalize([title, company, location, contract, description].join(" "));
    return { offer: { url, title, company, location, description, sourceUrl: url }, searchText, location: normalize(location), contract: normalize(contract), createdAt: createdAt(row) };
  }

  async search(criteria: OfferSearchCriteria): Promise<{ offers: Offer[]; note: string }> {
    const keywords = clean(criteria.keywords, 300);
    if (!keywords) throw new CareerError(400, "validation", "Saisissez au moins un métier ou mot-clé.");
    if (criteria.department?.trim()) throw new CareerError(400, "unsupported_filter", "Remote OK ne filtre pas par département. Effacez ce filtre.");
    const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(criteria.limit ?? 50)));
    const payload = JSON.parse(await this.rawResponse()) as unknown[];
    const phrases = keywords.split(/[,;\n]+/).map(normalize).filter(Boolean).map(phrase => phrase.split(/\s+/).filter(Boolean));
    const commune = normalize(clean(criteria.commune, 100));
    const now = this.now();
    const offers: Offer[] = [];
    const seen = new Set<string>();
    for (const raw of payload) {
      const job = this.mapJob(raw);
      if (!job || !Number.isFinite(job.createdAt) || job.createdAt > now + 24 * 60 * 60_000 || now - job.createdAt > MAX_AGE_MS) continue;
      if (!isOpenToFrance(job.location) || !phrases.some(words => words.every(word => job.searchText.includes(word)))) continue;
      if (commune && !job.location.includes(commune)) continue;
      if (!matchesContract(criteria.contractType || "", job.contract)) continue;
      const key = job.offer.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      offers.push(job.offer);
      if (offers.length >= limit) break;
    }
    const note = offers.length
      ? `${offers.length} offre(s) Remote OK trouvée(s) parmi les annonces récentes explicitement ouvertes à la France, à l’Europe/EMEA ou partout. Les filtres sont appliqués localement et chaque fiche conserve son lien Remote OK. Flux actualisé au plus une fois par heure.`
      : `Aucune offre Remote OK correspondante parmi les annonces récentes ouvertes à la France, à l’Europe/EMEA ou partout. La couverture remote ne représente pas tout le marché français. Source : ${SOURCE_URL}.`;
    return { offers, note };
  }
}

