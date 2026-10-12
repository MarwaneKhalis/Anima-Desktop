import type { CareerSavedSearch, CareerSearchSource, OfferSearchService } from "../src/shared/career.ts";
import type { CareerStore } from "./career-store.ts";

export type CareerSearchSources = Partial<Record<CareerSearchSource, OfferSearchService>>;

/** Recurring discovery is durable, serialized, and limited to public offer feeds. */
export class CareerSearchScheduler {
  private running = false;
  private readonly activeSearches = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private finishRun?: () => void;
  private stopped = false;
  private readonly getStore: () => CareerStore;
  private readonly sources: CareerSearchSources;
  constructor(getStore: () => CareerStore, sources: CareerSearchSources) { this.getStore = getStore; this.sources = sources; }
  isRunning(): boolean { return this.running; }
  isStopped(): boolean { return this.stopped; }
  isSearchRunning(id: string): boolean { return this.activeSearches.has(id); }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.runDue().catch(() => {}); }, intervalMs);
    this.timer.unref();
    void this.runDue().catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.running) await new Promise<void>(resolve => { this.finishRun = resolve; });
  }

  async runDue(at?: string): Promise<number> {
    if (this.stopped || this.running) return 0;
    this.running = true;
    let ran = 0;
    try {
      const store = this.getStore();
      for (const search of store.dueSavedSearches(at)) {
        if (this.stopped) break;
        try {
          if (!store.beginSavedSearchRun(search.id, at)) continue;
        } catch {
          // A search may have been deleted while an earlier feed was running.
          continue;
        }
        await this.execute(store, search, at);
        ran++;
      }
      return ran;
    } finally { this.running = false; this.finishRun?.(); this.finishRun = undefined; }
  }

  async runNow(searchId: string): Promise<CareerSavedSearch> {
    if (this.stopped) throw new Error("Collecte récurrente indisponible pendant la maintenance.");
    if (this.running) throw new Error("Une recherche récurrente est déjà en cours.");
    this.running = true;
    try {
      const store = this.getStore();
      const search = store.getSavedSearch(searchId);
      if (!store.beginSavedSearchRun(search.id, new Date().toISOString(), true))
        throw new Error("La recherche est désactivée.");
      await this.execute(store, search);
      return store.getSavedSearch(searchId);
    } finally { this.running = false; this.finishRun?.(); this.finishRun = undefined; }
  }

  private async execute(store: CareerStore, search: CareerSavedSearch, at?: string): Promise<void> {
    this.activeSearches.add(search.id);
    try {
      const service = this.sources[search.source];
      if (!service) throw new Error("Source indisponible.");
      const result = await service.search(search.criteria);
      if (!Array.isArray(result.offers) || result.offers.length > 200) throw new Error("Résultat invalide.");
      for (const offer of result.offers) store.saveJob(offer);
      const unavailable = [...new Set([...String(result.note || "").matchAll(/([^.;]+?)\s*:\s*source indisponible\./gi)]
        .map(match => match[1].trim())
        .filter(source => ["Arbeitnow", "Jobicy", "Remote OK", "Himalayas", "Remotive"].includes(source)))];
      const warning = unavailable.length ? `Collecte partielle : sources indisponibles (${unavailable.join(", ")}).` : "";
      store.finishSavedSearchRun(search.id, { ...(at ? { at } : {}), count: result.offers.length, error: warning });
    } catch {
      store.finishSavedSearchRun(search.id, { ...(at ? { at } : {}), count: 0, error: "Source momentanément indisponible; nouvelle tentative au prochain passage." });
    } finally { this.activeSearches.delete(search.id); }
  }
}
