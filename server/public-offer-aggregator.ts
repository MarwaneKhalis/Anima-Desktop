import type { JobOffer, OfferSearchCriteria, OfferSearchService } from "../src/shared/career.ts";
import { careerUrl, CareerError } from "./career-store.ts";

type Offer = Omit<JobOffer, "id" | "discoveredAt" | "updatedAt">;

export interface PublicOfferSource {
  name: string;
  service?: OfferSearchService;
  supportsCommune?: boolean;
}

type SearchResult =
  | { source: PublicOfferSource; offers: Offer[]; note: string }
  | { source: PublicOfferSource; error: true; note: string };

function canonicalUrl(value: unknown, allowedTestOrigins: ReadonlySet<string>): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(careerUrl(value, [...allowedTestOrigins]));
    if ((url.protocol !== "https:" && !allowedTestOrigins.has(url.origin)) || url.username || url.password) return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return "";
  }
}

function publicOffer(value: unknown, allowedTestOrigins: ReadonlySet<string>): Offer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const offer = value as Partial<Offer>;
  if (typeof offer.title !== "string" || !offer.title.trim()
    || typeof offer.company !== "string" || !offer.company.trim()) return null;
  const url = canonicalUrl(offer.url, allowedTestOrigins);
  if (!url) return null;
  const sourceUrl = offer.sourceUrl ? canonicalUrl(offer.sourceUrl, allowedTestOrigins) : "";
  if (offer.sourceUrl && !sourceUrl) return null;
  return {
    url,
    title: offer.title.trim().slice(0, 500),
    company: offer.company.trim().slice(0, 500),
    location: typeof offer.location === "string" ? offer.location.trim().slice(0, 500) : "",
    description: typeof offer.description === "string" ? offer.description.slice(0, 20_000) : "",
    sourceUrl,
  };
}

/** Searches configured public feeds together, keeps source failures isolated,
 * and deduplicates only when application or original listing URLs match. */
export class PublicOfferAggregator implements OfferSearchService {
  private readonly sources: PublicOfferSource[];
  private readonly allowedTestOrigins: ReadonlySet<string>;

  constructor(sources: PublicOfferSource[], allowedTestOrigins: string[] = []) {
    this.sources = sources.filter(source => source.service);
    this.allowedTestOrigins = new Set(allowedTestOrigins);
  }

  async search(criteria: OfferSearchCriteria): Promise<{ offers: Offer[]; note: string }> {
    if (typeof criteria.keywords !== "string" || !criteria.keywords.trim()) {
      throw new CareerError(400, "validation", "Saisissez au moins un métier ou mot-clé.");
    }
    const limit = Math.max(1, Math.min(200, Math.floor(criteria.limit ?? 50)));
    if (!this.sources.length) throw new CareerError(503, "source_unavailable", "Aucune source publique n’est disponible.");

    const results: SearchResult[] = await Promise.all(this.sources.map(async source => {
      try {
        const sourceCriteria = { ...criteria, limit: 200 };
        const ignoredFilters: string[] = [];
        if (source.supportsCommune === false && sourceCriteria.commune?.trim()) {
          delete sourceCriteria.commune;
          ignoredFilters.push("filtre ville non appliqué.");
        }
        const result = await source.service!.search(sourceCriteria);
        if (!Array.isArray(result.offers) || result.offers.length > 200) throw new Error("invalid response");
        const offers = result.offers.map(offer => publicOffer(offer, this.allowedTestOrigins)).filter((offer): offer is Offer => offer !== null);
        const note = typeof result.note === "string" ? result.note.trim().slice(0, 450) : "";
        return { source, offers, note: [note, ...ignoredFilters].filter(Boolean).join(" ").slice(0, 500) };
      } catch (error) {
        return {
          source,
          error: true as const,
          note: error instanceof CareerError && error.code === "unsupported_filter" ? "filtre non pris en charge." : "source indisponible.",
        };
      }
    }));

    const succeeded = results.filter((result): result is Extract<SearchResult, { offers: Offer[] }> => !("error" in result));
    if (!succeeded.length) throw new CareerError(502, "all_sources_unavailable", "Les sources publiques sont momentanément indisponibles.");

    const offers: Offer[] = [];
    const seenUrls = new Set<string>();
    const cursors = succeeded.map(() => 0);
    let remaining = true;
    while (offers.length < limit && remaining) {
      remaining = false;
      for (let i = 0; i < succeeded.length && offers.length < limit; i++) {
        const result = succeeded[i];
        while (cursors[i] < result.offers.length) {
          remaining = true;
          const offer = result.offers[cursors[i]++];
          const urls = [canonicalUrl(offer.url, this.allowedTestOrigins), canonicalUrl(offer.sourceUrl, this.allowedTestOrigins)].filter(Boolean);
          if (urls.some(url => seenUrls.has(url))) continue;
          urls.forEach(url => seenUrls.add(url));
          offers.push(offer);
          break;
        }
      }
    }

    const notes = results.map(result => "error" in result
      ? `${result.source.name} : ${result.note}`
      : `${result.source.name} : ${result.note || `${result.offers.length} offre(s) reçue(s).`}`);
    notes.push(`${offers.length} offre(s) distincte(s) retenue(s).`);
    return { offers, note: notes.join(" ").slice(0, 1000) };
  }
}
