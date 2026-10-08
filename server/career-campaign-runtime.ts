import type { Application, RunResult } from "../src/shared/career.ts";
import type { CareerStore } from "./career-store.ts";
import type { CareerRunner } from "./career-runner.ts";
import { CareerCampaignEngine, CareerCampaignStore } from "./career-campaign.ts";

function asRunResult(application: Application): RunResult {
  const state: RunResult["state"] = ["ready", "needs_input", "blocked", "submitted", "uncertain", "failed"].includes(application.state)
    ? application.state as RunResult["state"]
    : "failed";
  return {
    state,
    message: application.lastError || (state === "submitted" ? "Candidature envoyée avec confirmation." : "Le parcours n’a pas terminé l’envoi."),
    missingFields: application.missingFields,
    receipt: application.receipt,
  };
}

/** Connect the durable campaign scheduler to the one-at-a-time desktop browser runner. */
export function createCareerCampaignRuntime(career: CareerStore, runner: CareerRunner) {
  const campaigns = new CareerCampaignStore(career.db);
  const engine = new CareerCampaignEngine(campaigns, {
    createApplication: (jobId, resumeId) => career.createApplication({ jobId, resumeId }),
    getApplication: (id) => career.getApplication(id),
    run: async (applicationId, signal, credentialId) => {
      const application = await runner.runAndWait(applicationId, "submit", credentialId || undefined, signal);
      return asRunResult(application);
    },
  }, { concurrency: 1 });
  return { campaigns, engine };
}
