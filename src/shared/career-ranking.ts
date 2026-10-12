import type { CareerProfile, JobOffer } from "./career.ts";

const stopWords = new Set(["and", "the", "for", "with", "dans", "des", "les", "une", "un", "de", "du", "en", "sur", "poste", "job"]);
const shortTechnologyTerms = new Set(["c", "c#", "c++", "r", "go", "f#"]);
const tokens = (value: string): string[] => [...new Set(value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z0-9+#.]+/g) || [])]
  .filter(token => (token.length > 2 || shortTechnologyTerms.has(token)) && !stopWords.has(token));

/** A transparent local keyword-overlap heuristic; it is not a prediction of hiring outcomes. */
export function profileFitScore(job: JobOffer, profile: CareerProfile): number | null {
  const titleTerms = tokens(profile.preferences.titles.join(" "));
  const skillTerms = tokens(profile.skills.join(" "));
  const experienceTerms = tokens(profile.experiences.map(item => item.title).join(" "));
  const locationTerms = tokens([...profile.preferences.locations, profile.city].join(" "));
  const contractTerms = tokens(profile.preferences.contract);
  if (!titleTerms.length && !skillTerms.length && !experienceTerms.length && !locationTerms.length && !contractTerms.length && !profile.preferences.remote) return null;

  const jobTitle = new Set(tokens(job.title));
  const jobText = new Set(tokens(`${job.title} ${job.description}`));
  const jobLocation = new Set(tokens(job.location));
  let possible = 0, earned = 0;
  const scoreTerms = (terms: string[], weight: number, matches: Set<string>) => {
    for (const term of terms) { possible += weight; if (matches.has(term)) earned += weight; }
  };
  scoreTerms(titleTerms, 3, jobTitle);
  scoreTerms(skillTerms, 1, jobText);
  scoreTerms(experienceTerms, 1, jobTitle);
  scoreTerms(locationTerms, 1, jobLocation);
  scoreTerms(contractTerms, 1, jobText);
  if (profile.preferences.remote) {
    possible += 2;
    if (/\b(remote|teletravail|hybride|work from home|anywhere)\b/i.test(`${job.title} ${job.location} ${job.description}`.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""))) earned += 2;
  }
  return possible ? Math.round(100 * earned / possible) : null;
}

/** Stable descending sort: equal heuristic scores retain the source's original order. */
export function rankJobsForProfile(jobs: readonly JobOffer[], profile: CareerProfile): JobOffer[] {
  return jobs.map((job, index) => ({ job, index, score: profileFitScore(job, profile) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.index - b.index)
    .map(item => item.job);
}
