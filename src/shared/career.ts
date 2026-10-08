export type ApplicationState = 'draft' | 'running' | 'ready' | 'needs_input' | 'blocked' | 'submitting' | 'submitted' | 'uncertain' | 'failed';
export type Outcome = 'active' | 'interview' | 'offer' | 'rejected' | 'withdrawn';
export type RunMode = 'prepare' | 'submit';
export type AnswerValue = string | boolean;

export interface CareerProfile {
  firstName: string; lastName: string; email: string; phone: string;
  city: string; country: string; address: string; postalCode: string;
  headline: string; summary: string; linkedinUrl: string; websiteUrl: string;
  skills: string[]; languages: string[];
  experiences: { company: string; title: string; start: string; end: string; description: string }[];
  education: { school: string; degree: string; start: string; end: string }[];
  preferences: { titles: string[]; locations: string[]; remote: boolean; contract: string };
  answers: Record<string, AnswerValue>;
  updatedAt: string;
}
export interface Resume {
  id: string; name: string; filename: string; mime: string; size: number;
  sha256: string; createdAt: string;
}
export interface CredentialSummary {
  id: string; origin: string; label: string; username: string; updatedAt: string;
}
export interface VaultStatus { initialized: boolean; unlocked: boolean; }
export interface JobOffer {
  id: string; url: string; title: string; company: string; location: string;
  description: string; sourceUrl: string; discoveredAt: string; updatedAt: string;
}
export interface MissingField {
  key: string; label: string; required: boolean;
  type: 'text' | 'boolean' | 'select' | 'file' | 'unknown';
  options?: string[];
}
export interface Receipt {
  url: string; text: string; reference: string; observedAt: string;
}
export interface Application {
  id: string; jobId: string; resumeId: string; prospectId: string | null;
  state: ApplicationState; outcome: Outcome;
  answers: Record<string, AnswerValue>;
  missingFields: MissingField[]; notes: string; nextActionAt: string;
  lastError: string; receipt: Receipt | null;
  createdAt: string; updatedAt: string; submittedAt: string | null;
}
export interface CareerEvent {
  id: string; applicationId: string; kind: string; detail: string;
  source: 'automation' | 'user'; happenedAt: string;
}
export interface CareerMetrics {
  savedJobs: number; applications: number; submitted: number;
  needsAttention: number; interviews: number; offers: number; rejected: number;
}
export interface CareerSnapshot {
  profile: CareerProfile; resumes: Resume[]; credentials: CredentialSummary[];
  jobs: JobOffer[]; applications: Application[]; events: CareerEvent[];
  metrics: CareerMetrics; vault: VaultStatus;
}
export interface RunResult {
  state: 'ready' | 'needs_input' | 'blocked' | 'submitted' | 'uncertain' | 'failed';
  missingFields: MissingField[]; message: string; receipt: Receipt | null;
}
export interface DiscoveryResult { jobs: JobOffer[]; note: string; }
export interface OfferSearchCriteria {
  keywords: string;
  department?: string;
  commune?: string;
  contractType?: string;
  limit?: number;
}
export interface FranceTravailConfigSummary { configured: boolean; scope?: string; updatedAt?: string; }
export interface OfferSearchService {
  search(criteria: OfferSearchCriteria): Promise<{ offers: Omit<JobOffer, 'id' | 'discoveredAt' | 'updatedAt'>[]; note: string }>;
}
export interface CareerDiscovery {
  discover(url: string): Promise<{ offers: Omit<JobOffer, 'id' | 'discoveredAt' | 'updatedAt'>[]; note: string }>;
}
