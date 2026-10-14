import { useEffect, useRef, useState } from "react";
import { apiFetch, downloadResponse } from "./api.ts";
import AiAssistant from "./AiAssistant.tsx";
import { useDialogKeyboardSupport } from "./useDialogKeyboardSupport.ts";
import ProspectingWorkspace, { type Tab as LegacyTab } from "./ProspectingWorkspace.tsx";
import type {
  Application,
  AnswerValue,
  CareerProfile,
  CareerEmployerResponse,
  CareerSavedSearch,
  CareerSearchSource,
  CareerSnapshot,
  JobOffer,
  RunMode,
} from "../src/shared/career.ts";
import type { Prospect } from "../src/shared/types.ts";
import { profileFitScore, rankJobsForProfile, sortJobOffers, type JobListSort } from "../src/shared/career-ranking.ts";
import { dueFollowups, dueProspectFollowups, prioritizeAttention, summarizeDailyActions } from "../src/shared/career-dashboard.ts";
import {
  APPLICATION_STATE_LABELS as states,
  APPLICATION_STATE_META,
  CAMPAIGN_ITEM_STATE_LABELS as campaignItemStates,
  CAMPAIGN_ITEM_STATE_META,
  CAMPAIGN_STATE_LABELS as campaignStates,
  CAMPAIGN_STATE_META,
  EMPLOYER_OUTCOME_LABELS as outcomes,
  EMPLOYER_OUTCOME_META,
  EMPLOYER_RESPONSE_CHANNEL_LABELS as employerResponseChannels,
  EMPLOYER_RESPONSE_TYPE_LABELS as employerResponseTypes,
  type CampaignItemState,
  type CampaignState,
} from "../src/shared/career-labels.ts";

type Tab = "home" | "jobs" | "applications" | "network" | "profile" | "settings" | "help";
function jobSourceLabel(job: JobOffer): string {
  try {
    const host = new URL(job.sourceUrl || job.url).hostname.toLowerCase();
    if (host === "remoteok.com" || host === "www.remoteok.com") return "Remote OK";
    if (host === "himalayas.app") return "Himalayas";
    if (host === "remotive.com" || host === "www.remotive.com") return "Remotive";
    return new URL(job.url).hostname;
  } catch { return "Source de l’offre"; }
}
const navigation: [Tab, string, string][] = [
  ["home", "◈", "Aujourd’hui"],
  ["jobs", "⌕", "Offres"],
  ["applications", "▤", "Candidatures"],
  ["network", "↗", "Réseau"],
  ["profile", "◉", "Profil & CV"],
];
function parseEmployerResponse(detail: string): CareerEmployerResponse | null {
  try {
    const value = JSON.parse(detail) as Partial<CareerEmployerResponse>;
    if (value.version !== 1 || !value.receivedAt || !value.note || !value.type || !value.channel) return null;
    if (!Object.hasOwn(employerResponseTypes, value.type) || !Object.hasOwn(employerResponseChannels, value.channel)) return null;
    return value as CareerEmployerResponse;
  } catch { return null; }
}
function localDateInputValue(): string {
  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  return today.toISOString().slice(0, 10);
}
const normalizeOfferSearch = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
const split = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const date = (s: string) =>
  s
    ? new Date(s).toLocaleString("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
const labelJob = (snapshot: CareerSnapshot, a: Application) =>
  snapshot.jobs.find((j) => j.id === a.jobId);
const active = (a: Application) => ["running", "submitting"].includes(a.state);
type FranceTravailStatus = { configured: boolean; scope?: string; updatedAt?: string };
type SavedSearchDraft = {
  keywords: string;
  commune: string;
  contractType: string;
  limit: number;
  intervalHours: CareerSavedSearch["intervalHours"];
};
type CampaignSummary = {
  id: string;
  resumeId: string;
  credentialId: string | null;
  maxSubmissions: number;
  state: CampaignState;
  counts: { total: number; pending: number; running: number; submitted: number; needsInput: number; uncertain: number; failed: number; skipped: number };
  createdAt: string;
};
type CampaignItemSummary = { id: string; applicationId: string; jobId: string; state: CampaignItemState; error: string };
type CampaignDetail = { campaign: CampaignSummary; items: CampaignItemSummary[]; resumeDeferred?: boolean };

export default function CareerWorkspace() {
  const [tab, setTab] = useState<Tab>("home"),
    [legacyTab, setLegacyTab] = useState<LegacyTab>("prospects");
  const [settingsSection, setSettingsSection] = useState<"connections" | "data" | "preferences" | "about">("connections");
  const [applicationsSection, setApplicationsSection] = useState<"all" | "attention" | "followups" | "campaigns">("all");
  const [applicationQuery, setApplicationQuery] = useState("");
  const [applicationStateFilter, setApplicationStateFilter] = useState<"all" | Application["state"]>("all");
  const [applicationOutcomeFilter, setApplicationOutcomeFilter] = useState<"all" | Application["outcome"]>("all");
  const [applicationSort, setApplicationSort] = useState<"updated" | "action">(() => localStorage.getItem("anima-desktop-application-sort") === "action" ? "action" : "updated");
  const [campaignPage, setCampaignPage] = useState(0), [campaignTotal, setCampaignTotal] = useState(0);
  const [campaignsActiveOnly, setCampaignsActiveOnly] = useState(false);
  const [activeCampaigns, setActiveCampaigns] = useState<CampaignSummary[]>([]), [activeCampaignTotal, setActiveCampaignTotal] = useState(0);
  const [focusedCampaignId, setFocusedCampaignId] = useState<string | null>(null);
  const [networkSection, setNetworkSection] = useState<"contacts" | "searches" | "messages" | "history">("contacts");
  const [jobsSection, setJobsSection] = useState<"search" | "saved" | "searches">("search");
  const [editingSavedSearchId, setEditingSavedSearchId] = useState<string | null>(null);
  const [savedSearchDraft, setSavedSearchDraft] = useState<SavedSearchDraft | null>(null);
  const [demo, setDemo] = useState(
    () => localStorage.getItem("anima-demo") === "1",
  );
  const [data, setData] = useState<CareerSnapshot | null>(null),
    [profile, setProfile] = useState<CareerProfile | null>(null);
  const [profileDraftStatus, setProfileDraftStatus] = useState<"profileSaved" | "draftSaved" | "pending" | "saving" | "error">("profileSaved");
  const profileSnapshotRef = useRef("");
  const profileLatestRef = useRef<CareerProfile | null>(null);
  const profileDraftQueueRef = useRef<Promise<void>>(Promise.resolve());
  const profileDraftTimerRef = useRef<number | null>(null);
  const profileSaveInProgressRef = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const backgroundRefreshInFlight = useRef(false);
  const [campaignError, setCampaignError] = useState("");
  const [focusResultsAfterSearch, setFocusResultsAfterSearch] = useState(false);
  const offerSearchAdvancedRef = useRef<HTMLDetailsElement | null>(null);
  const offerSearchKeywordRef = useRef<HTMLInputElement | null>(null);
  const focusOfferSearchAfterNavigationRef = useRef(false);
  const resumeUploadRef = useRef<HTMLInputElement | null>(null);
  const focusResumeUploadAfterNavigationRef = useRef(false);
  const addJobDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const [query, setQuery] = useState(""),
    [source, setSource] = useState("");
  const [jobSort, setJobSort] = useState<JobListSort>(() => {
    const saved = localStorage.getItem("anima-desktop-offer-sort");
    return ["relevance", "newest", "title", "company"].includes(saved || "") ? saved as JobListSort : "relevance";
  });
  const [jobSourceFilter, setJobSourceFilter] = useState("");
  const [jobApplicationFilter, setJobApplicationFilter] = useState<"all" | "applied" | "unapplied">("all");
  const [jobDiscoveredAfter, setJobDiscoveredAfter] = useState("");
  const [jobDiscoveredBefore, setJobDiscoveredBefore] = useState("");
  const [compactJobs, setCompactJobs] = useState(() => localStorage.getItem("anima-desktop-compact-jobs") !== "0");
  const [franceTravail, setFranceTravail] = useState<FranceTravailStatus>({ configured: false }),
    [searchSource, setSearchSource] = useState<"all" | "arbeitnow" | "france-travail" | "jobicy" | "remoteok" | "himalayas" | "remotive">("all"),
    [franceCredentials, setFranceCredentials] = useState({ clientId: "", clientSecret: "", scope: "" }),
    [searchCriteria, setSearchCriteria] = useState({ keywords: "", department: "", commune: "", contractType: "", limit: 50 }),
    [searchIntervalHours, setSearchIntervalHours] = useState<6 | 12 | 24 | 168>(24),
    [maxSubmissions, setMaxSubmissions] = useState(10),
    [campaigns, setCampaigns] = useState<CampaignSummary[]>([]),
    [campaignDetails, setCampaignDetails] = useState<Record<string, CampaignDetail>>({}),
    [jobDraft, setJobDraft] = useState({
      url: "",
      title: "",
      company: "",
      location: "",
      description: "",
    });
  const [resumeId, setResumeId] = useState(""),
    [credentialId, setCredentialId] = useState(""),
    [detail, setDetail] = useState<string | null>(null);
  const [fileResumeChoices, setFileResumeChoices] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]),
    [batch, setBatch] = useState(false);
  const [campaignPlan, setCampaignPlan] = useState<{ jobIds: string[]; note: string } | null>(null),
    [campaignMode, setCampaignMode] = useState<"prepare" | "submit">("prepare");
  const campaignDialogRef = useRef<HTMLElement | null>(null);
  const campaignReturnFocusRef = useRef<HTMLElement | null>(null);
  const applicationDialogRef = useRef<HTMLElement | null>(null);
  const applicationReturnFocusRef = useRef<HTMLElement | null>(null);
  function openApplicationDetail(applicationId: string) {
    const active = document.activeElement;
    applicationReturnFocusRef.current = active instanceof HTMLElement ? active : null;
    setDetail(applicationId);
  }
  function rememberCampaignTrigger(element?: HTMLElement | null) {
    const active = document.activeElement;
    campaignReturnFocusRef.current = element ?? (active instanceof HTMLElement ? active : null);
  }
  profileLatestRef.current = profile;
  useDialogKeyboardSupport(!!campaignPlan && !!data, campaignDialogRef, () => setCampaignPlan(null), campaignReturnFocusRef);
  const [passphrase, setPassphrase] = useState(""),
    [account, setAccount] = useState({
      origin: "",
      label: "",
      username: "",
      password: "",
    });
  const [answerKey, setAnswerKey] = useState(""),
    [answerValue, setAnswerValue] = useState(""),
    [answerBoolean, setAnswerBoolean] = useState(false),
    [answerQuery, setAnswerQuery] = useState(""),
    [editingAnswerKey, setEditingAnswerKey] = useState<string | null>(null);
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [focusProspectId, setFocusProspectId] = useState<string | null>(null);
  const [focusProspectVersion, setFocusProspectVersion] = useState(0);
  const modeRef = useRef(demo);
  modeRef.current = demo;
  const campaignListViewRef = useRef({ activeOnly: false, page: 0 });
  campaignListViewRef.current = { activeOnly: campaignsActiveOnly, page: campaignPage };
  async function api<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await apiFetch(`/api/career${path}${path.includes("?") ? "&" : "?"}demo=${demo ? 1 : 0}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Anima-Request": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Action impossible.");
    return value;
  }
  async function load(resetProfile = false) {
    const currentMode = demo;
    const value = await api<CareerSnapshot>("/bootstrap");
    if (currentMode !== modeRef.current) return;
    setRefreshError("");
    setData(value);
    if (resetProfile) {
      const restoredProfile = structuredClone(value.profileDraft ?? value.profile);
      setProfile(restoredProfile);
      profileSnapshotRef.current = JSON.stringify(restoredProfile);
      setProfileDraftStatus(value.profileDraft ? "draftSaved" : "profileSaved");
    }
    setResumeId((id) =>
      value.resumes.some((r) => r.id === id) ? id : value.resumes[0]?.id || "",
    );
    setCredentialId((id) => value.credentials.some((credential) => credential.id === id) ? id : "");
    await Promise.all([refreshCampaigns(), refreshActiveCampaigns()]);
  }
  async function refreshActiveCampaigns() {
    try {
      const value = await api<{ campaigns: CampaignSummary[]; total?: number }>("/campaigns?active=1&limit=10&offset=0");
      setActiveCampaigns(value.campaigns || []);
      setActiveCampaignTotal(value.total ?? value.campaigns?.length ?? 0);
      setCampaignError("");
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : String(error));
    }
  }
  async function refreshCampaigns(activeOnly = campaignListViewRef.current.activeOnly, page = campaignListViewRef.current.page) {
    try {
      const value = await api<{ campaigns: CampaignSummary[]; total?: number }>(`/campaigns?${activeOnly ? "active=1&" : ""}limit=10&offset=${page * 10}`);
      setCampaigns(value.campaigns || []);
      setCampaignTotal(value.total ?? value.campaigns?.length ?? 0);
      setCampaignError("");
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : String(error));
    }
  }
  async function toggleCampaignDetails(campaignId: string) {
    if (campaignDetails[campaignId]) {
      setCampaignDetails((current) => { const next = { ...current }; delete next[campaignId]; return next; });
      return;
    }
    try {
      const detail = await api<CampaignDetail>(`/campaigns/${campaignId}`);
      setCampaignDetails((current) => ({ ...current, [campaignId]: detail }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function openCampaign(campaignId: string) {
    setFocusedCampaignId(campaignId);
    setCampaignPage(0);
    setCampaignsActiveOnly(true);
    setApplicationsSection("campaigns");
    setTab("applications");
    try {
      const detail = await api<CampaignDetail>(`/campaigns/${campaignId}`);
      setCampaignDetails((current) => ({ ...current, [campaignId]: detail }));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  async function refreshFranceTravail() {
    try {
      setFranceTravail(await api<FranceTravailStatus>("/sources/france-travail"));
    } catch {
      setFranceTravail({ configured: false });
    }
  }
  useEffect(() => {
    if (tab !== "jobs" || !focusOfferSearchAfterNavigationRef.current) return;
    focusOfferSearchAfterNavigationRef.current = false;
    offerSearchKeywordRef.current?.focus();
  }, [tab]);
  useEffect(() => {
    if (tab !== "profile" || !focusResumeUploadAfterNavigationRef.current) return;
    focusResumeUploadAfterNavigationRef.current = false;
    resumeUploadRef.current?.focus();
  }, [tab]);
  useEffect(() => {
    localStorage.setItem("anima-desktop-application-sort", applicationSort);
  }, [applicationSort]);
  useEffect(() => {
    localStorage.setItem("anima-desktop-offer-sort", jobSort);
  }, [jobSort]);
  useEffect(() => {
    localStorage.setItem("anima-desktop-compact-jobs", compactJobs ? "1" : "0");
  }, [compactJobs]);
  useEffect(() => {
    setData(null);
    setProfile(null);
    setRefreshError("");
    profileSnapshotRef.current = "";
    setDetail(null);
    setSelected([]);
    setError("");
    load(true)
      .then(() => recoverPendingCampaign())
      .catch((e) => setRefreshError(e instanceof Error ? e.message : String(e)));
    refreshFranceTravail();
  }, [demo]);
  useEffect(() => {
    if (!profile || profileSaveInProgressRef.current) return;
    const serialized = JSON.stringify(profile);
    if (serialized === profileSnapshotRef.current) return;
    setProfileDraftStatus("pending");
    profileDraftTimerRef.current = window.setTimeout(() => {
      setProfileDraftStatus("saving");
      profileDraftQueueRef.current = profileDraftQueueRef.current.catch(() => {}).then(async () => {
        await api("/profile/draft", "PUT", profile);
        if (JSON.stringify(profileLatestRef.current) === serialized) {
          profileSnapshotRef.current = serialized;
          setProfileDraftStatus("draftSaved");
        }
      }).catch(() => {
        if (JSON.stringify(profileLatestRef.current) === serialized) setProfileDraftStatus("error");
      });
    }, 700);
    return () => {
      if (profileDraftTimerRef.current !== null) window.clearTimeout(profileDraftTimerRef.current);
      profileDraftTimerRef.current = null;
    };
  }, [profile, demo]);
  useEffect(() => {
    if (!profile || JSON.stringify(profile) === profileSnapshotRef.current) return;
    const warnAboutUnsavedDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnAboutUnsavedDraft);
    return () => window.removeEventListener("beforeunload", warnAboutUnsavedDraft);
  }, [profile, profileDraftStatus]);
  useEffect(() => {
    if (!profile) return;
    setSearchCriteria((current) => ({
      ...current,
      keywords: current.keywords || profile.preferences.titles.join(", "),
      commune: current.commune || profile.city || profile.preferences.locations[0] || "",
    }));
  }, [profile]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (backgroundRefreshInFlight.current) return;
      backgroundRefreshInFlight.current = true;
      void load().catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        setRefreshError(message);
      }).finally(() => {
        backgroundRefreshInFlight.current = false;
      });
    }, 2500);
    return () => clearInterval(timer);
  }, [demo]);
  useEffect(() => {
    if (data && applicationsSection === "campaigns") void refreshCampaigns();
  }, [campaignPage, applicationsSection, campaignsActiveOnly]);
  useEffect(() => {
    if (!focusResultsAfterSearch || !data) return;
    if (offerSearchAdvancedRef.current) offerSearchAdvancedRef.current.open = false;
    document.getElementById("job-results")?.scrollIntoView({ behavior: "auto", block: "start" });
    setFocusResultsAfterSearch(false);
  }, [data, focusResultsAfterSearch]);
  async function action(fn: () => Promise<unknown>, message = "Enregistré.") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await fn();
      await load();
      setNotice(typeof result === "string" ? result : message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function run(id: string, mode: RunMode) {
    await api(`/applications/${id}/run`, "POST", {
      mode,
      ...(credentialId ? { credentialId } : {}),
    });
  }
  async function resume(id: string, fileFieldKey?: string, selectedResumeId?: string) {
    await api(`/applications/${id}/resume`, "POST", {
      ...(credentialId ? { credentialId } : {}),
      ...(fileFieldKey ? { fileFieldKey } : {}),
      ...(selectedResumeId ? { resumeId: selectedResumeId } : {}),
    });
  }
  async function runBatch(selection = selected) {
    setBatch(true);
    setError("");
    try {
      const latest = await api<CareerSnapshot>("/bootstrap");
      const ids = selection.filter((id) =>
        latest.applications.some(
          (a) =>
            a.id === id &&
            !["submitted", "uncertain", "running", "submitting"].includes(
              a.state,
            ),
        ),
      );
      setSelected(ids);
      const jobIds = [...new Set(ids.map((id) => latest.applications.find((a) => a.id === id)?.jobId).filter((id): id is string => !!id))];
      if (!jobIds.length) throw new Error("Aucune candidature disponible dans la sélection.");
      setCampaignMode("prepare");
      setCampaignPlan({ jobIds, note: "Sélection de candidatures" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatch(false);
      await load();
    }
  }
  async function createCampaign(jobIds: string[], start = true) {
    // Preserve the caller's ranking so the submission cap applies to that order.
    const normalizedJobIds = [...new Set(jobIds)];
    const payload = { jobIds: normalizedJobIds, resumeId, maxSubmissions, ...(credentialId ? { credentialId } : {}) };
    const storageKey = "anima-pending-campaign";
    let pending: { key: string; payload: typeof payload } | undefined;
    try { pending = JSON.parse(localStorage.getItem(storageKey) || "null") || undefined; } catch { pending = undefined; }
    const sameRequest = pending && JSON.stringify(pending.payload) === JSON.stringify(payload);
    const request = sameRequest ? pending! : { key: crypto.randomUUID(), payload };
    localStorage.setItem(storageKey, JSON.stringify({ ...request, start }));
    const created = await api<{ campaign: { id: string } }>("/campaigns", "POST", {
      ...payload,
      idempotencyKey: request.key,
    });
    if (start) await api(`/campaigns/${created.campaign.id}/start`, "POST", {});
    localStorage.removeItem(storageKey);
    return created.campaign.id;
  }
  async function confirmCampaignPlan(mode: "prepare" | "submit" = campaignMode) {
    if (!campaignPlan) throw new Error("Aucune campagne à préparer.");
    if (!resumeId || !data?.resumes.some((resume) => resume.id === resumeId)) throw new Error("Choisissez un CV valide dans le récapitulatif.");
    const count = campaignPlan.jobIds.length;
    const singleApplication = campaignPlan.note === "Candidature sélectionnée" && count === 1
      ? data.applications.find((application) => application.jobId === campaignPlan.jobIds[0])
      : undefined;
    for (const jobId of campaignPlan.jobIds) {
      const existing = data.applications.find((application) => application.jobId === jobId);
      if (existing && existing.resumeId !== resumeId && !["submitted", "uncertain", "running", "submitting"].includes(existing.state)) {
        await api(`/applications/${existing.id}`, "PATCH", { resumeId });
      }
    }
    if (singleApplication) await run(singleApplication.id, mode);
    else await createCampaign(campaignPlan.jobIds, mode === "submit");
    setCampaignPlan(null);
    setSelected([]);
    setApplicationsSection(singleApplication ? "all" : "campaigns");
    setCampaignPage(0);
    setTab("applications");
    if (singleApplication) return mode === "submit" ? "Envoi individuel lancé. Le résultat reste visible dans cette candidature." : "Candidature préparée. Aucun envoi n’a été déclenché.";
    return mode === "submit"
      ? `Campagne lancée sur ${count} offre(s), plafond ${maxSubmissions}. Les envois incertains ne seront jamais relancés automatiquement.`
      : `Campagne préparée sur ${count} offre(s). Aucun envoi n’a été déclenché.`;
  }
  async function recoverPendingCampaign() {
    if (demo) return;
    try {
      const pending = JSON.parse(localStorage.getItem("anima-pending-campaign") || "null");
      if (!pending?.key || !Array.isArray(pending?.payload?.jobIds) || !pending.payload.jobIds.length) return;
      const created = await api<{ campaign: { id: string } }>("/campaigns", "POST", {
        ...pending.payload,
        idempotencyKey: pending.key,
      });
      if (pending.start !== false) await api(`/campaigns/${created.campaign.id}/start`, "POST", {});
      localStorage.removeItem("anima-pending-campaign");
      await refreshCampaigns();
      if (pending.start !== false) setNotice("La campagne interrompue a repris automatiquement.");
    } catch {
      // Keep the request key so a later retry can safely resume without duplicating applications.
    }
  }
  async function searchOffers(apply = false) {
    if (!profile) throw new Error("Le profil n’est pas encore chargé.");
    if (apply && !resumeId) throw new Error("Ajoutez un CV dans Profil & CV avant de lancer une campagne.");
    const keywords = searchCriteria.keywords.trim() || profile.preferences.titles.join(", ");
    if (!keywords) throw new Error("Renseignez des métiers recherchés dans Profil & CV, ou saisissez un mot-clé.");
    const searchPath = searchSource === "all"
      ? "/sources/all-public/search"
      : searchSource === "arbeitnow"
      ? "/sources/arbeitnow/search"
      : searchSource === "jobicy"
        ? "/sources/jobicy/search"
        : searchSource === "remoteok"
        ? "/sources/remoteok/search"
        : searchSource === "himalayas"
          ? "/sources/himalayas/search"
          : searchSource === "remotive"
            ? "/sources/remotive/search"
          : "/sources/france-travail/search";
    const found = await api<{ jobs: JobOffer[]; note: string }>(
      searchPath,
      "POST",
      {
        keywords,
        ...(searchSource === "france-travail" && searchCriteria.department.trim() ? { department: searchCriteria.department.trim() } : {}),
        ...(!["himalayas", "remotive"].includes(searchSource) && searchCriteria.commune.trim() ? { commune: searchCriteria.commune.trim() } : {}),
        ...(searchCriteria.contractType.trim() ? { contractType: searchCriteria.contractType.trim() } : {}),
        limit: searchCriteria.limit,
      },
    );
    if (!found.jobs.length) return found.note || "Aucune offre ne correspond à ces critères.";
    if (!apply) {
      await load();
      setFocusResultsAfterSearch(true);
      return `${found.jobs.length} offre(s) récupérée(s). ${found.note}`;
    }
    const ranked = rankJobsForProfile(found.jobs, data?.profile || profile);
    const eligible = ranked.filter((job) => !data?.applications.some((application) => application.jobId === job.id && ["submitted", "uncertain", "running", "submitting"].includes(application.state)));
    if (!eligible.length) return "Les offres trouvées ont déjà une candidature envoyée, incertaine ou en cours. Aucune nouvelle campagne n’a été créée.";
    setCampaignMode("prepare");
    setCampaignPlan({ jobIds: eligible.map((job) => job.id), note: found.note });
    setNotice(`${eligible.length} offre(s) prêtes à examiner. Vérifiez le récapitulatif avant toute candidature.`);
    return "Récapitulatif de campagne prêt.";
  }
  async function saveRecurringSearch() {
    if (searchSource === "france-travail") throw new Error("La collecte récurrente est limitée aux flux publics sans compte.");
    const source = searchSource as CareerSearchSource;
    const criteria = { keywords: searchCriteria.keywords.trim() || profile?.preferences.titles.join(", ") || "", ...(searchCriteria.commune.trim() && !["himalayas", "remotive"].includes(source) ? { commune: searchCriteria.commune.trim() } : {}), ...(searchCriteria.contractType.trim() ? { contractType: searchCriteria.contractType.trim() } : {}), limit: Math.min(200, searchCriteria.limit) };
    await api<CareerSavedSearch>("/saved-searches", "POST", { source, criteria, intervalHours: searchIntervalHours, enabled: true });
    return "Recherche enregistrée. La collecte se fera automatiquement tant qu’Anima Desktop est ouvert.";
  }
  async function updateRecurringSearch(search: CareerSavedSearch, changes: Partial<Pick<CareerSavedSearch, "source" | "criteria" | "intervalHours" | "enabled">>) {
    return api<CareerSavedSearch>(`/saved-searches/${search.id}`, "PATCH", {
      source: changes.source ?? search.source,
      criteria: changes.criteria ?? search.criteria,
      intervalHours: changes.intervalHours ?? search.intervalHours,
      enabled: changes.enabled ?? search.enabled,
    });
  }
  function beginSavedSearchEdit(search: CareerSavedSearch) {
    setEditingSavedSearchId(search.id);
    setSavedSearchDraft({
      keywords: search.criteria.keywords,
      commune: search.criteria.commune || "",
      contractType: search.criteria.contractType || "",
      limit: search.criteria.limit || 50,
      intervalHours: search.intervalHours,
    });
  }
  async function saveFranceTravailCredentials() {
    const saved = await api<FranceTravailStatus>("/sources/france-travail", "POST", franceCredentials);
    setFranceTravail(saved);
    setFranceCredentials({ clientId: "", clientSecret: "", scope: "" });
    return "Accès France Travail enregistré dans le coffre chiffré.";
  }
  async function upload(file: File) {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await api("/resumes", "POST", {
      name: file.name.replace(/\.[^.]+$/, ""),
      filename: file.name,
      mime: file.name.toLowerCase().endsWith(".pdf")
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      base64,
    });
  }
  const field = (key: keyof CareerProfile, name: string, type = "text") =>
    profile && (
      <label>
        {name}
        <input
          type={type}
          value={String(profile[key])}
          onChange={(e) => setProfile({ ...profile, [key]: e.target.value })}
        />
      </label>
    );
  const current = data?.applications.find((a) => a.id === detail),
    currentJob = current && data ? labelJob(data, current) : undefined;
  useDialogKeyboardSupport(
    !!current && !!data,
    applicationDialogRef,
    () => setDetail(null),
    applicationReturnFocusRef,
  );
  const linkedApplications = data
    ? data.applications.flatMap((application) => {
        const job = data.jobs.find((item) => item.id === application.jobId);
        return application.prospectId && job
          ? [{ prospectId: application.prospectId, title: job.title, company: job.company }]
          : [];
      })
    : [];
  const runnable =
    data?.applications.filter(
      (a) =>
        !["submitted", "uncertain", "running", "submitting"].includes(a.state),
    ) || [];
  const attention = data ? prioritizeAttention(data.applications) : [];
  const dueFollowupList = data ? dueFollowups(data.applications) : [];
  const dueProspectList = dueProspectFollowups(prospects);
  const dueActions = [
    ...dueFollowupList.map((application) => ({ kind: "application" as const, date: application.nextActionAt, application })),
    ...dueProspectList.map((prospect) => ({ kind: "prospect" as const, date: prospect.nextActionAt, prospect })),
  ].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || (a.kind === b.kind ? 0 : a.kind === "application" ? -1 : 1));
  const sortedActiveCampaigns = activeCampaigns.slice().sort((a, b) =>
    (a.state === "running" ? 0 : a.state === "queued" ? 1 : 2) -
    (b.state === "running" ? 0 : b.state === "queued" ? 1 : 2) || a.createdAt.localeCompare(b.createdAt),
  );
  const todayActions = summarizeDailyActions(sortedActiveCampaigns, attention, dueActions, activeCampaignTotal);
  const pinnedCampaign = focusedCampaignId && campaignDetails[focusedCampaignId] && !campaigns.some((campaign) => campaign.id === focusedCampaignId)
    ? [campaignDetails[focusedCampaignId].campaign]
    : [];
  const campaignPageItems = [...pinnedCampaign, ...campaigns];
  const sectionApplications = applicationsSection === "attention" ? attention : applicationsSection === "followups" ? dueFollowupList : data?.applications || [];
  const normalizedApplicationQuery = normalizeOfferSearch(applicationQuery.trim());
  const visibleApplications = sectionApplications
    .filter((application) => applicationStateFilter === "all" || application.state === applicationStateFilter)
    .filter((application) => applicationOutcomeFilter === "all" || application.outcome === applicationOutcomeFilter)
    .filter((application) => {
      if (!normalizedApplicationQuery || !data) return true;
      const job = labelJob(data, application);
      return normalizeOfferSearch([job?.title, job?.company, job?.location, states[application.state], outcomes[application.outcome], application.nextActionAt && date(application.nextActionAt)].filter(Boolean).join(" ")).includes(normalizedApplicationQuery);
    }).slice().sort((left, right) => applicationSort === "action"
      ? (left.nextActionAt || "9999").localeCompare(right.nextActionAt || "9999") || right.updatedAt.localeCompare(left.updatedAt)
      : right.updatedAt.localeCompare(left.updatedAt));
  const visibleRunnable = visibleApplications.filter((application) => runnable.some((item) => item.id === application.id));
  const visibleSelected = selected.filter((id) => visibleRunnable.some((application) => application.id === id));
  const completion = data
    ? [
        !!data.profile.firstName && !!data.profile.lastName,
        !!data.profile.email,
        !!data.profile.phone,
        !!data.resumes.length,
      ].filter(Boolean).length
    : 0;
  const initials = data
    ? `${data.profile.firstName[0] || "A"}${data.profile.lastName[0] || "C"}`
    : "AC";
  const profileTools = (
    <div className="cw-tools">
      <label>
        CV pour les candidatures
        <select value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
          <option value="">Choisir un CV</option>
          {data?.resumes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Compte carrière préféré
        <select
          value={credentialId}
          onChange={(e) => setCredentialId(e.target.value)}
        >
          <option value="">Choix automatique si un seul compte existe pour le site</option>
          {data?.credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label || c.origin} · {c.username}
            </option>
          ))}
        </select>
      </label>
      <small>La campagne garde ce choix. Pour les autres sites, elle utilise un compte uniquement s’il n’y en a qu’un pour cette origine.</small>
    </div>
  );
  const franceConnectionPanel = data && (
    <section className="cw-panel">
      <div className="cw-section-head"><div><span className="cw-eyebrow">SOURCE À ACCÈS RESTREINT</span><h2>France Travail</h2></div><span className={`cw-source-status ${franceTravail.configured ? "is-ready" : ""}`}>{franceTravail.configured ? "Accès configuré" : "Accès non configuré"}</span></div>
      <p>L’API Offres d’emploi est à accès restreint et sa diffusion publique est actuellement suspendue. Demandez d’abord un accès auprès de <a href="https://francetravail.io/contact" target="_blank" rel="noreferrer">France Travail</a>, puis saisissez les identifiants et le périmètre qui vous seront attribués. Les identifiants ne sont pas testés avant la première recherche.</p>
      {franceTravail.configured && franceTravail.scope && <p className="cw-configured-note">Périmètre enregistré : {franceTravail.scope}</p>}
      <form className="cw-grid" onSubmit={(event) => { event.preventDefault(); action(saveFranceTravailCredentials, "Configuration enregistrée."); }}>
        <label>Client ID<input autoComplete="off" disabled={!data.vault.unlocked} value={franceCredentials.clientId} onChange={(event) => setFranceCredentials({ ...franceCredentials, clientId: event.target.value })} required /></label>
        <label>Client secret<input type="password" autoComplete="new-password" disabled={!data.vault.unlocked} value={franceCredentials.clientSecret} onChange={(event) => setFranceCredentials({ ...franceCredentials, clientSecret: event.target.value })} required /></label>
        <label>Scope / périmètre API<input autoComplete="off" disabled={!data.vault.unlocked} value={franceCredentials.scope} onChange={(event) => setFranceCredentials({ ...franceCredentials, scope: event.target.value })} required /></label>
        <button className="cw-primary" disabled={busy || demo || !data.vault.unlocked}>Enregistrer dans le coffre</button>
      </form>
      {franceTravail.configured && <button disabled={busy || demo || !data.vault.unlocked} onClick={() => action(async () => { await api("/sources/france-travail", "DELETE", {}); setFranceTravail({ configured: false }); return "Accès France Travail supprimé."; })}>Supprimer les identifiants</button>}
    </section>
  );
  const campaignPanel = campaignError ? <div className="cw-alert" role="alert">Impossible d’actualiser les campagnes : {campaignError} <button onClick={() => { void refreshCampaigns(); void refreshActiveCampaigns(); }}>Réessayer</button></div> : campaignPageItems.length ? (
    <section className="cw-panel cw-campaigns">
      <div className="cw-section-head">
        <div><span className="cw-eyebrow">TRAITEMENT AUTOMATIQUE</span><h2>{campaignsActiveOnly ? "Campagnes actives" : "Campagnes de candidature"}</h2></div>
        <span className="cw-pill">{campaignTotal} campagne(s)</span>
      </div>
      <div className="cw-campaign-list">
        {campaignPageItems.map((campaign) => (
          <article className="cw-campaign-row" data-campaign-id={campaign.id} key={campaign.id}>
            <div className="cw-campaign-main">
              <strong title={CAMPAIGN_STATE_META[campaign.state].description}>{campaignStates[campaign.state]}</strong>
              <small>{date(campaign.createdAt)} · {campaign.counts?.submitted || 0} envoyée(s) · {campaign.counts?.running || 0} en cours · {campaign.counts?.needsInput || 0} à compléter · {campaign.counts?.uncertain || 0} à vérifier · plafond {campaign.maxSubmissions}</small>
              <small>Compte : {campaign.credentialId ? data?.credentials.find((credential) => credential.id === campaign.credentialId)?.label || "sélectionné, à vérifier" : "détection automatique (un seul compte par site)"}</small>
            </div>
            <div className="cw-campaign-actions">
              <button onClick={() => void toggleCampaignDetails(campaign.id)}>{campaignDetails[campaign.id] ? "Masquer" : "Détails"}</button>
              {(campaign.state === "queued" || campaign.state === "paused") && !campaign.counts?.uncertain && <button className="cw-primary" disabled={busy || demo} onClick={() => action(() => api(`/campaigns/${campaign.id}/start`, "POST", {}), "Campagne reprise.")}>Reprendre</button>}
              {campaign.state === "paused" && !!campaign.counts?.uncertain && <small>Résolvez d’abord l’envoi incertain avant de reprendre.</small>}
              {campaign.state === "running" && <button disabled={busy || demo} onClick={() => action(() => api(`/campaigns/${campaign.id}/pause`, "POST", {}), "Campagne mise en pause.")}>Pause</button>}
              {campaign.state !== "stopped" && campaign.state !== "completed" && campaign.state !== "limit_reached" && <button disabled={busy || demo} onClick={() => action(() => api(`/campaigns/${campaign.id}/stop`, "POST", {}), "Campagne arrêtée.")}>Arrêter</button>}
            </div>
            {campaignDetails[campaign.id] && <div className="cw-campaign-items">
              {campaignDetails[campaign.id].items.map((item) => {
                const job = data?.jobs.find((entry) => entry.id === item.jobId);
                return <div className="cw-campaign-item" key={item.id}>
                <span><strong>{job ? `${job.title} · ${job.company}` : "Offre"}</strong><small title={CAMPAIGN_ITEM_STATE_META[item.state]?.description}>{campaignItemStates[item.state] || item.state}</small>{item.error && <small>{item.error}</small>}</span>
                <div>
                  <button onClick={() => { setTab("applications"); setApplicationsSection("all"); openApplicationDetail(item.applicationId); }}>Voir la candidature</button>
                  {["pending", "needs_input", "failed"].includes(item.state) && <button disabled={busy || demo} onClick={() => void action(async () => {
                    const updated = await api<CampaignDetail>(`/campaigns/${campaign.id}/items/${item.id}/skip`, "POST", { reason: "Passée depuis le suivi de campagne." });
                    setCampaignDetails((current) => ({ ...current, [campaign.id]: updated }));
                    return updated.resumeDeferred ? "Offre passée. La campagne reste en pause ; le navigateur est occupé. Reprenez-la quand il sera disponible." : updated.campaign.state === "completed" ? "Offre passée. La campagne est terminée." : "Offre passée ; la campagne continue si des offres restent en attente.";
                  })}>Passer cette offre</button>}
                </div>
              </div>;})}
            </div>}
          </article>
        ))}
      </div>
      {campaignTotal > 10 && <nav className="cw-pagination" aria-label="Pages des campagnes">
        <button disabled={campaignPage === 0} onClick={() => setCampaignPage((page) => Math.max(0, page - 1))}>Précédent</button>
        <span>Page {campaignPage + 1} sur {Math.ceil(campaignTotal / 10)}</span>
        <button disabled={(campaignPage + 1) * 10 >= campaignTotal} onClick={() => setCampaignPage((page) => page + 1)}>Suivant</button>
      </nav>}
      <small>Les réponses requises que le profil ne contient pas sont mises en attente pendant que les autres offres continuent. Un CAPTCHA, une MFA ou un site non pris en charge met la campagne en pause. Une candidature dont l’envoi est incertain n’est jamais relancée automatiquement.</small>
    </section>
  ) : <div className="cw-empty">Aucune campagne pour le moment. Les campagnes créées depuis vos sélections apparaîtront ici.</div>;
  const jobSources = [...new Set((data?.jobs || []).map(jobSourceLabel))].sort((a, b) => a.localeCompare(b, "fr"));
  const normalizedJobQuery = normalizeOfferSearch(query.trim());
  const appliedJobIds = new Set((data?.applications || []).map((application) => application.jobId));
  function navigateToOffers() {
    setJobsSection("search");
    focusOfferSearchAfterNavigationRef.current = true;
    setTab("jobs");
  }
  function navigateToResumeUpload() {
    focusResumeUploadAfterNavigationRef.current = true;
    setTab("profile");
  }
  const discoveredDay = (job: JobOffer) => {
    const timestamp = job.discoveredAt ? new Date(job.discoveredAt) : null;
    if (!timestamp || Number.isNaN(timestamp.getTime())) return "";
    timestamp.setMinutes(timestamp.getMinutes() - timestamp.getTimezoneOffset());
    return timestamp.toISOString().slice(0, 10);
  };
  const hasJobFilters = !!(query.trim() || jobSourceFilter || jobApplicationFilter !== "all" || jobDiscoveredAfter || jobDiscoveredBefore);
  const resetJobFilters = () => {
    setQuery("");
    setJobSourceFilter("");
    setJobApplicationFilter("all");
    setJobDiscoveredAfter("");
    setJobDiscoveredBefore("");
  };
  const rankedJobs = data ? sortJobOffers(rankJobsForProfile(data.jobs, data.profile), jobSort) : [];
  const jobsForDisplay = rankedJobs
    .filter((job) => !jobSourceFilter || jobSourceLabel(job) === jobSourceFilter)
    .filter((job) => jobApplicationFilter === "all" || (jobApplicationFilter === "applied" ? appliedJobIds.has(job.id) : !appliedJobIds.has(job.id)))
    .filter((job) => !jobDiscoveredAfter || (discoveredDay(job) && discoveredDay(job) >= jobDiscoveredAfter))
    .filter((job) => !jobDiscoveredBefore || (discoveredDay(job) && discoveredDay(job) <= jobDiscoveredBefore))
    .filter((job) => !normalizedJobQuery || normalizeOfferSearch(`${job.title} ${job.company} ${job.location} ${job.description}`).includes(normalizedJobQuery));
  const normalizedAnswerQuery = normalizeOfferSearch(answerQuery.trim());
  const duplicateAnswerKey = !!answerKey.trim()
    && !!profile
    && Object.hasOwn(profile.answers, answerKey.trim())
    && answerKey.trim() !== editingAnswerKey;
  const identityTone = tab === "home" ? "xenogears"
    : tab === "jobs" ? "weltall-ii"
      : tab === "applications" ? "weltall-id"
        : "weltall";
  return (
    <div className="cw-shell" data-identity={identityTone}>
      <a className="cw-skip-link" href="#career-content">Passer au contenu</a>
      <aside className="cw-sidebar">
        <a
          className="cw-brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab("home");
          }}
        >
          <span className="cw-logo" aria-hidden="true">
            <span className="cw-logo-core">A</span><i className="cw-logo-orbit" />
          </span>
          <strong>
            Anima<span> Desktop</span>
          </strong>
        </a>
        <p className="cw-caption">Offres · candidatures · réseau</p>
        <div className="cw-nav-label">ESPACE CARRIÈRE</div>
        <nav aria-label="Navigation principale">
          {navigation.map(([key, icon, name]) => (
            <button
              key={key}
              className={tab === key ? "current" : ""}
              aria-current={tab === key ? "page" : undefined}
              onClick={() => {
                setTab(key);
                setError("");
                setNotice("");
              }}
            >
              <span aria-hidden="true">{icon}</span>
              {name}
              {key === "applications" && !!attention.length && (
                <b>{attention.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="cw-bottom">
          <nav className="cw-secondary-nav" aria-label="Navigation secondaire">
            <button
              className={tab === "settings" ? "current" : ""}
              aria-current={tab === "settings" ? "page" : undefined}
              onClick={() => {
                setSettingsSection("connections");
                setTab("settings");
              }}
            >
              <span aria-hidden="true">◇</span> Paramètres
            </button>
            <button
              className={tab === "help" ? "current" : ""}
              aria-current={tab === "help" ? "page" : undefined}
              onClick={() => setTab("help")}
            >
              <span aria-hidden="true">?</span> Aide
            </button>
          </nav>
          <div className="cw-private">
            <span>●</span>
            <div>
              <strong>Local & personnel</strong>
              <small>CV et comptes sur cet ordinateur</small>
            </div>
          </div>
          <button
            disabled={busy || batch || !!data?.applications.some(active) || campaigns.some((campaign) => campaign.state === "running")}
            onClick={() => {
              localStorage.setItem("anima-demo", demo ? "0" : "1");
              setDemo(!demo);
              setCredentialId("");
              setPassphrase("");
            }}
          >
            {" "}
            {demo ? "● Démo · quitter" : "○ Explorer la démo"} <span>→</span>
          </button>
          <div className="cw-user">
            <span>{initials}</span>
            <div>
              <strong>{data?.profile.firstName || "Votre espace"}</strong>
              <small>{data?.profile.headline || "Prêt pour la suite"}</small>
            </div>
          </div>
        </div>
      </aside>
      <main id="career-content" className="cw-main" tabIndex={-1}>
        <header className="cw-top">
          <div>
            Mon espace <span>/</span>{" "}
            {navigation.find((n) => n[0] === tab)?.[2] ||
              (tab === "settings"
                ? settingsSection === "connections" ? "Paramètres · Connexions"
                  : settingsSection === "data" ? "Paramètres · Données & sauvegardes"
                    : settingsSection === "preferences" ? "Paramètres · Préférences" : "Paramètres · À propos"
                : "Aide")}
          </div>
          <div>
            <span className="cw-local">
              ●{" "}
              {data?.applications.some(active)
                ? "Automatisation en cours"
                : "Données locales"}
            </span>
            <span className="cw-avatar">{initials}</span>
          </div>
        </header>
        <div className="cw-content">
          {demo && (
            <div className="cw-banner">
              Données fictives · découvrez le parcours. Connexions et envois
              externes désactivés.
            </div>
          )}
          {refreshError && (
            <div className="cw-alert" role="status">
              Connexion locale interrompue : {refreshError}
              <button disabled={busy} onClick={() => {
                void load(!data)
                  .then(() => data ? undefined : recoverPendingCampaign())
                  .catch((e) => setRefreshError(e instanceof Error ? e.message : String(e)));
              }}>Réessayer</button>
            </div>
          )}
          {error && (
            <div className="cw-alert" role="alert">
              {error}
              <button aria-label="Fermer l’erreur" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="cw-notice" role="status">
              {notice}
            </div>
          )}
          {!data ? (
            <div className="cw-empty">
              {error
                ? "Anima Desktop ne répond pas. Vérifiez que l’application est démarrée."
                : "Ouverture de votre espace…"}
            </div>
          ) : (
            <>
              {tab === "settings" && (
                <div className="cw-subnav" aria-label="Sections des paramètres">
                  {([
                    ["connections", "Connexions"],
                    ["data", "Données & sauvegardes"],
                    ["preferences", "Préférences"],
                    ["about", "À propos"],
                  ] as const).map(([section, label]) => (
                    <button
                      key={section}
                      className={settingsSection === section ? "current" : ""}
                      onClick={() => setSettingsSection(section)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {tab === "network" && (
                <div className="cw-subnav" aria-label="Sections du réseau">
                  {([
                    ["contacts", "Contacts", "prospects"],
                    ["searches", "Recherches LinkedIn", "recherches"],
                    ["messages", "Messages", "file"],
                    ["history", "Historique", "activite"],
                  ] as [typeof networkSection, string, LegacyTab][]).map(([section, label, view]) => (
                    <button
                      key={section}
                      className={networkSection === section ? "current" : ""}
                      onClick={() => { setNetworkSection(section); setLegacyTab(view); }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {tab === "network" && (networkSection === "contacts" || networkSection === "messages") && (
                <div className="cw-subnav cw-subnav-nested" aria-label={networkSection === "contacts" ? "Vue des contacts" : "Sections des messages"}>
                  {(networkSection === "contacts" ? [["prospects", "Liste"], ["pipeline", "Colonnes"]] : [["file", "À envoyer manuellement"], ["modeles", "Modèles"]]).map(([key, label]) => (
                    <button key={key} className={legacyTab === key ? "current" : ""} onClick={() => setLegacyTab(key as LegacyTab)}>{label}</button>
                  ))}
                </div>
              )}
              {tab === "jobs" && (
                <div className="cw-subnav" aria-label="Sections des offres">
                  {([ ["search", "Rechercher"], ["saved", "Enregistrées"], ["searches", "Recherches enregistrées"] ] as const).map(([section, label]) => (
                    <button key={section} className={jobsSection === section ? "current" : ""} onClick={() => setJobsSection(section)}>{label}</button>
                  ))}
                </div>
              )}
              {tab === "home" && (
                <>
                  <div className="cw-heading">
                    <div>
                      <span className="cw-eyebrow">
                        UN PEU MOINS DE FRICTION. PLUS D’OPPORTUNITÉS.
                      </span>
                      <h1>
                        {data.profile.firstName
                          ? `Bonjour ${data.profile.firstName}.`
                          : "Place à votre prochaine opportunité."}
                      </h1>
                      <p>
                        Vos offres, vos candidatures et votre réseau. Au même
                        endroit.
                      </p>
                    </div>
                    <button
                      className="cw-primary"
                      onClick={navigateToOffers}
                    >
                      Trouver des offres <span>↗</span>
                    </button>
                  </div>
                  <div className="cw-metrics">
                    {[
                      ["Offres enregistrées", data.metrics.savedJobs, "⌕"],
                      ["Candidatures envoyées", data.metrics.submitted, "↗"],
                      ["Entretiens", data.metrics.interviews, "◷"],
                      ["À débloquer", data.metrics.needsAttention, "◇"],
                    ].map(([name, value, icon]) => (
                      <div className="cw-metric" key={String(name)}>
                        <span>
                          {name}
                          <i>{icon}</i>
                        </span>
                        <strong>{value}</strong>
                        <small>
                          {name === "À débloquer"
                            ? "Une réponse permet de reprendre"
                            : "Calculé depuis votre suivi"}
                        </small>
                      </div>
                    ))}
                  </div>
                  <div className="cw-dashboard">
                    <section className="cw-panel">
                      <div className="cw-section-head">
                        <h2>Du premier lien au premier entretien</h2>
                        <span className="cw-pill">Votre parcours</span>
                      </div>
                      <div className="cw-flow">
                        {[
                          [
                            "01",
                            "Vos ressources",
                            "Profil, CV et réponses",
                            "Vous",
                          ],
                          [
                            "02",
                            "Vos opportunités",
                            "Import & dédoublonnage",
                            "Auto",
                          ],
                          [
                            "03",
                            "Votre candidature",
                            "Connexion, formulaire, CV, envoi",
                            "Auto",
                          ],
                          [
                            "04",
                            "La suite",
                            "Reçu, historique et suivi",
                            "Mixte",
                          ],
                        ].map(([num, title, desc, tag]) => (
                          <div key={num}>
                            <span className="cw-step">{num}</span>
                            <h3>{title}</h3>
                            <p>{desc}</p>
                            <small className={tag === "Auto" ? "cw-auto" : ""}>
                              {tag}
                            </small>
                          </div>
                        ))}
                      </div>
                      <p className="cw-muted">
                        Une information manquante, une vérification de sécurité
                        ou un envoi incertain ouvre une action à traiter.
                      </p>
                    </section>
                    <section className="cw-panel cw-setup">
                      <span className="cw-eyebrow">PRÊT À POSTULER</span>
                      <h2>Votre profil, votre avantage.</h2>
                      <p>
                        Renseignez une fois. Réutilisez à chaque candidature.
                      </p>
                      <div className="cw-progress">
                        <i style={{ width: `${completion * 25}%` }} />
                      </div>
                      <div className="cw-section-head">
                        <small>{completion}/4 ressources essentielles</small>
                        <strong>{completion * 25}%</strong>
                      </div>
                      <button onClick={() => setTab("profile")}>
                        Compléter mon profil →
                      </button>
                    </section>
                  </div>
                  <div className="cw-dashboard">
                    <section className="cw-panel">
                      <div className="cw-section-head">
                        <h2>Candidatures récentes</h2>
                        <button
                          className="cw-link"
                          onClick={() => {
                            setApplicationsSection("all");
                            setTab("applications");
                          }}
                        >
                          Tout voir →
                        </button>
                      </div>
                      {data.applications.slice(0, 5).map((a) => (
                        <button
                          key={a.id}
                          className="cw-row"
                          onClick={() => {
                            openApplicationDetail(a.id);
                            setTab("applications");
                          }}
                        >
                          <span className="cw-company">
                            {labelJob(data, a)
                              ?.company.slice(0, 2)
                              .toUpperCase() || "↗"}
                          </span>
                          <span>
                            <strong>{labelJob(data, a)?.title}</strong>
                            <small>
                              {labelJob(data, a)?.company} ·{" "}
                              {labelJob(data, a)?.location}
                            </small>
                          </span>
                          <span className={`cw-status ${a.state}`} title={APPLICATION_STATE_META[a.state].description}>
                            {states[a.state]}
                          </span>
                        </button>
                      ))}
                      {!data.applications.length && (
                        <div className="cw-empty">
                          Votre première candidature commence avec une offre.
                          <button onClick={navigateToOffers}>
                            Ajouter une offre →
                          </button>
                        </div>
                      )}
                    </section>
                    <section className="cw-panel">
                      <div className="cw-section-head">
                        <h2>À ne pas laisser passer</h2>
                        <span className="cw-pill">{todayActions.totalCount}</span>
                      </div>
                      <p className="cw-muted">{todayActions.campaignCount} campagne(s) active(s) · {todayActions.attentionCount} candidature(s) à traiter · {todayActions.followupCount} relance(s) échue(s)</p>
                      {sortedActiveCampaigns.map((campaign) => (
                        <button
                          className="cw-row"
                          key={campaign.id}
                          onClick={() => void openCampaign(campaign.id)}
                        >
                          <span>
                            <strong title={CAMPAIGN_STATE_META[campaign.state].description}>Campagne · {campaignStates[campaign.state]}</strong>
                            <small>{campaign.counts.submitted}/{campaign.counts.total} envoyée(s) · {campaign.counts.running} en cours · {campaign.counts.needsInput} à compléter · {campaign.counts.uncertain} à vérifier</small>
                          </span>
                          <span>↗</span>
                        </button>
                      ))}
                      {todayActions.hiddenCampaignCount > 0 && (
                        <button className="cw-row cw-link" onClick={() => { setFocusedCampaignId(null); setCampaignsActiveOnly(true); setCampaignPage(0); setApplicationsSection("campaigns"); setTab("applications"); void refreshCampaigns(true, 0); }}>
                          Voir les {activeCampaignTotal} campagnes actives →
                        </button>
                      )}
                      {todayActions.visibleAttention.map((a) => (
                        <button
                          className="cw-row"
                          key={a.id}
                          onClick={() => {
                            openApplicationDetail(a.id);
                            setApplicationsSection("attention");
                            setTab("applications");
                          }}
                        >
                          <span>
                            <strong>{labelJob(data, a)?.title}</strong>
                            <small>{a.lastError || states[a.state]}</small>
                          </span>
                          <span>→</span>
                        </button>
                      ))}
                      {todayActions.hiddenAttentionCount > 0 && (
                        <button className="cw-row cw-link" onClick={() => { setApplicationsSection("attention"); setTab("applications"); }}>
                          Voir les {todayActions.attentionCount} candidatures à traiter →
                        </button>
                      )}
                      {dueActions.map((action) => action.kind === "application" ? (
                        <button
                          className="cw-row"
                          key={`application-${action.application.id}`}
                          onClick={() => {
                            openApplicationDetail(action.application.id);
                            setApplicationsSection("followups");
                            setTab("applications");
                          }}
                        >
                          <span>
                            <strong>Relance candidature · {labelJob(data, action.application)?.company}</strong>
                            <small>{date(action.date)}</small>
                          </span>
                          <span>◷</span>
                        </button>
                      ) : (
                        <button
                          className="cw-row"
                          key={`prospect-${action.prospect.id}`}
                          onClick={() => {
                            setNetworkSection("contacts");
                            setLegacyTab("prospects");
                            setFocusProspectId(action.prospect.id);
                            setFocusProspectVersion((version) => version + 1);
                            setTab("network");
                          }}
                        >
                          <span>
                            <strong>Relance contact · {action.prospect.firstName} {action.prospect.lastName}</strong>
                            <small>{action.prospect.nextAction} · {date(action.date)}</small>
                          </span>
                          <span>↗</span>
                        </button>
                      ))}
                      {!activeCampaignTotal && !attention.length && !dueActions.length && (
                        <p className="cw-muted">
                          Aucune campagne active, aucun blocage ni rappel échu. Les prochaines actions apparaîtront ici quand elles seront à traiter.
                        </p>
                      )}
                      <div className="cw-network">
                        <span>↗</span>
                        <strong>Le réseau ouvre aussi des portes.</strong>
                        <p>
                          {prospects.length} prospect(s) dans votre espace
                          LinkedIn.
                        </p>
                        <button onClick={() => { setNetworkSection("contacts"); setLegacyTab("prospects"); setTab("network"); }}>
                          Ouvrir les contacts →
                        </button>
                      </div>
                    </section>
                  </div>
                </>
              )}
              {tab === "jobs" && (
                <>
                  <div className="cw-heading">
                    <div>
                      <span className="cw-eyebrow">
                        DÉCOUVRIR & CENTRALISER
                      </span>
                      <h1>{jobsSection === "searches" ? "Recherches enregistrées" : jobsSection === "saved" ? "Offres enregistrées" : "Trouver une offre"}</h1>
                      <p>{jobsSection === "searches" ? "Gérez vos collectes récurrentes." : jobsSection === "saved" ? "Toutes les offres enregistrées sur cet appareil." : "Saisissez un métier, puis parcourez les résultats."}</p>
                    </div>
                    <span className="cw-pill">{data.jobs.length} offres</span>
                  </div>
                  <section className="cw-panel" hidden={jobsSection === "saved"}>
                    <div hidden={jobsSection !== "search"}>
                    <div className="cw-source-title">
                      <div>
                        <span className="cw-eyebrow">RECHERCHE AUTOMATIQUE</span>
                        <h2>{searchSource === "all" ? "Offres publiques France" : searchSource === "arbeitnow" ? "Offres Arbeitnow France" : searchSource === "jobicy" ? "Offres télétravaillables Jobicy" : searchSource === "remoteok" ? "Offres remote Remote OK" : searchSource === "himalayas" ? "Offres remote Himalayas" : searchSource === "remotive" ? "Offres remote Remotive" : "Offres France Travail"}</h2>
                        <p>Résultats publics attribués à leur source et dédupliqués.</p>
                      </div>
                      <span className={`cw-source-status ${searchSource !== "france-travail" || franceTravail.configured ? "is-ready" : ""}`}>
                        {searchSource === "france-travail" ? franceTravail.configured ? "Identifiants enregistrés" : "Accès France Travail requis" : "Source publique disponible"}
                      </span>
                    </div>
                    {searchSource === "france-travail" && !data.vault.unlocked && (
                      <div className="cw-help">
                        <strong>{data.vault.initialized ? "Coffre verrouillé." : "Coffre non initialisé."}</strong> {data.vault.initialized ? "Déverrouillez-le" : "Initialisez-le"} pour enregistrer les identifiants API et permettre la recherche.
                        <button onClick={() => { setSettingsSection("connections"); setTab("settings"); }}>Ouvrir le coffre</button>
                      </div>
                    )}
                    <form
                      className="cw-search-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void action(() => searchOffers(), "Recherche terminée.").then(() => {
                          window.requestAnimationFrame(() => document.getElementById("job-results")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                        });
                      }}
                    >
                      <details ref={offerSearchAdvancedRef} className="cw-details cw-search-advanced">
                        <summary>Source, lieu et filtres avancés</summary>
                      <label>
                        Source d’offres
                        <select value={searchSource} onChange={(e) => {
                          const source = e.target.value as "all" | "arbeitnow" | "france-travail" | "jobicy" | "remoteok" | "himalayas" | "remotive";
                          setSearchSource(source);
                          if (source === "himalayas" && searchCriteria.limit > 20) setSearchCriteria({ ...searchCriteria, limit: 20 });
                          else if ((source === "all" || source === "jobicy" || source === "remoteok" || source === "remotive") && searchCriteria.limit > 200) setSearchCriteria({ ...searchCriteria, limit: 200 });
                        }}>
                          <option value="all">Toutes les sources publiques · recommandé</option>
                          <option value="arbeitnow">Arbeitnow France · public, sans clé API</option>
                          <option value="jobicy">Jobicy · France, Europe/EMEA ou partout</option>
                          <option value="remoteok">Remote OK · remote ouvert à la France</option>
                          <option value="himalayas">Himalayas · remote France ou partout</option>
                          <option value="remotive">Remotive · remote France, Europe ou partout</option>
                          <option value="france-travail">France Travail · accès restreint</option>
                        </select>
                      </label>
                      <div className="cw-search-fields">
                        {searchSource === "france-travail" && (
                          <label>
                            Département (facultatif)
                            <input
                              inputMode="text"
                              maxLength={3}
                              value={searchCriteria.department}
                              onChange={(e) => setSearchCriteria({ ...searchCriteria, department: e.target.value.replace(/[^0-9a-z]/gi, "").toUpperCase().slice(0, 3) })}
                              placeholder="75 ou 2A"
                            />
                          </label>
                        )}
                        {!(["himalayas", "remotive"].includes(searchSource)) && <label>
                          Ville ou commune (facultatif)
                          <input
                            maxLength={100}
                            value={searchCriteria.commune}
                            onChange={(e) => setSearchCriteria({ ...searchCriteria, commune: e.target.value })}
                            placeholder="Paris ou code INSEE"
                          />
                        </label>}
                        <label>
                          {searchSource === "france-travail" ? "Contrat (code API, facultatif)" : "Contrat (filtre texte, facultatif)"}
                          <input
                            value={searchCriteria.contractType}
                            onChange={(e) => setSearchCriteria({ ...searchCriteria, contractType: e.target.value.toUpperCase().slice(0, 40) })}
                            placeholder="CDI"
                          />
                        </label>
                        <label>
                          Nombre d’offres à examiner
                          <select value={searchCriteria.limit} onChange={(e) => setSearchCriteria({ ...searchCriteria, limit: Number(e.target.value) })}>
                            {(searchSource === "himalayas" ? [10, 20] : searchSource === "all" || searchSource === "jobicy" || searchSource === "remoteok" || searchSource === "remotive" ? [25, 50, 100, 150, 200] : [25, 50, 100, 150, 200, 300, 450]).map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </label>
                      </div>
                      </details>
                      <label className="cw-search-keywords">
                        Métier(s) ou mot(s)-clé(s)
                        <input
                          ref={offerSearchKeywordRef}
                          type="text"
                          required
                          value={searchCriteria.keywords || profile?.preferences.titles.join(", ") || ""}
                          onChange={(e) => setSearchCriteria({ ...searchCriteria, keywords: e.target.value })}
                          placeholder={profile?.preferences.titles.join(", ") || "Ex. développeur TypeScript"}
                        />
                      </label>
                      <div className="cw-search-actions">
                        <button className="cw-primary" disabled={busy || demo || (searchSource === "france-travail" && (!franceTravail.configured || !data.vault.unlocked))}>
                          Rechercher les offres ↗
                        </button>
                        <details className="cw-details cw-search-actions-secondary">
                          <summary>Collecte programmée et candidature</summary>
                          <label className="cw-cap">Plafond par défaut
                            <select value={maxSubmissions} onChange={(e) => setMaxSubmissions(Number(e.target.value))}>
                              {[1, 3, 5, 10, 20, 50].map((n) => <option key={n} value={n}>{n} candidature{n > 1 ? "s" : ""}</option>)}
                            </select>
                          </label>
                        <button type="button" className="cw-primary cw-apply-button" disabled={busy || demo || (searchSource === "france-travail" && (!franceTravail.configured || !data.vault.unlocked)) || !resumeId} onClick={(event) => { rememberCampaignTrigger(event.currentTarget); void action(() => searchOffers(true), "Récapitulatif de campagne prêt."); }}>Rechercher et préparer un lancement</button>
                          {searchSource !== "france-travail" && <label className="cw-cap">Fréquence de collecte
                            <select value={searchIntervalHours} onChange={(e) => setSearchIntervalHours(Number(e.target.value) as 6 | 12 | 24 | 168)}>
                              <option value={6}>Toutes les 6 heures</option><option value={12}>Toutes les 12 heures</option><option value={24}>Chaque jour</option><option value={168}>Chaque semaine</option>
                            </select>
                          </label>}
                          {searchSource !== "france-travail" && <button type="button" disabled={busy || demo} onClick={() => action(saveRecurringSearch, "Recherche enregistrée.")}>Enregistrer cette recherche</button>}
                        </details>
                      </div>
                      <details className="cw-details cw-source-limits">
                        <summary>Sources et limites de collecte</summary>
                        <small className="cw-automation-note">
                          {searchSource === "all"
                            ? <>La recherche interroge simultanément les flux publics <a href="https://www.arbeitnow.fr" target="_blank" rel="noreferrer">Arbeitnow</a>, <a href="https://jobicy.com" target="_blank" rel="noreferrer">Jobicy</a>, <a href="https://remoteok.com/api" target="_blank" rel="noreferrer">Remote OK</a>, <a href="https://himalayas.app/api" target="_blank" rel="noreferrer">Himalayas</a> et <a href="https://remotive.com/remote-jobs/api" target="_blank" rel="noreferrer">Remotive</a>. Remotive retarde ses annonces de 24 h et son flux est actualisé au plus une fois par jour. Le filtre ville s’applique à Arbeitnow, Jobicy et Remote OK; Himalayas et Remotive ne fournissent qu’une zone d’éligibilité par pays ou région. Chaque fiche conserve son lien source; les offres identiques sont regroupées. France Travail reste sélectionnable séparément avec ses accès API.</>
                            : searchSource === "arbeitnow"
                            ? <>Les offres viennent de l’<a href="https://www.arbeitnow.fr" target="_blank" rel="noreferrer">API publique Arbeitnow France</a>. La couverture dépend des annonces indexées.</>
                            : searchSource === "jobicy"
                              ? <>Les offres viennent de l’<a href="https://jobicy.com" target="_blank" rel="noreferrer">API publique Jobicy</a>, limitée aux annonces télétravaillables des 7 derniers jours ; les zones hors France, Europe/EMEA et partout sont filtrées. La recherche est actualisée au plus une fois par heure et le lien Jobicy reste la source canonique.</>
                              : searchSource === "remoteok"
                                ? <>Les offres viennent du <a href="https://remoteok.com/api" target="_blank" rel="noreferrer">flux JSON public Remote OK</a>. Le lien d’origine Remote OK reste affiché sur chaque fiche; les annonces de plus de 60 jours et les zones non explicitement compatibles avec la France sont écartées.</>
                                : searchSource === "himalayas"
                                  ? <>Les offres viennent de l’<a href="https://himalayas.app/api" target="_blank" rel="noreferrer">API publique Himalayas</a>. Cette source ne filtre pas par ville; les annonces limitées à un autre pays sont écartées. Le lien Himalayas reste attribué et les données sont mises à jour quotidiennement.</>
                                : searchSource === "remotive"
                                  ? <>Les offres viennent du <a href="https://remotive.com/remote-jobs/api" target="_blank" rel="noreferrer">flux public Remotive</a>, retardé de 24 h et mis en cache localement au plus une fois par jour. Cette source ne précise pas la ville; seules les annonces ouvertes à la France, à l’Europe/EMEA ou partout sont conservées.</>
                            : <>La recherche interroge l’API France Travail après activation de vos accès. La source est à accès restreint et n’est pas disponible publiquement actuellement.</>} Des adaptateurs ciblent Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters, Teamtailor et Workday. Les scénarios automatisés sont vérifiés sur des pages de test, sans garantie de compatibilité complète avec les portails réels. Les autres sites peuvent demander une reprise manuelle. Un CAPTCHA, une MFA ou un formulaire ambigu met la campagne en pause.
                        </small>
                      </details>
                      {demo && <small>Quittez le mode démo pour utiliser les services externes.</small>}
                      {!resumeId && (
                        <div className="cw-section-head">
                          <small role="status">Ajoutez d’abord un CV dans l’onglet Profil &amp; CV pour activer les candidatures.</small>
                          <button type="button" onClick={navigateToResumeUpload}>Ajouter un CV →</button>
                        </div>
                      )}
                    </form>
                    </div>
                    <section className="cw-panel" aria-label="Recherches récurrentes" hidden={jobsSection !== "searches"}>
                      <div className="cw-section-head"><h3>Recherches enregistrées</h3><span className="cw-pill">{data.savedSearches.length}</span></div>
                      {data.savedSearches.length ? data.savedSearches.map((search) => <div key={search.id}>
                        <div className="cw-section-head">
                          <div><strong>{search.criteria.keywords}</strong><small>{search.source} · {search.intervalHours < 24 ? `toutes les ${search.intervalHours} h` : search.intervalHours === 24 ? "quotidienne" : "hebdomadaire"} · {search.lastResultCount} offre(s) au dernier passage</small>{search.lastRunAt && <small>Dernière collecte : {date(search.lastRunAt)}</small>}{search.lastError && <small className="cw-callout" role="alert">Échec de la dernière collecte : {search.lastError}</small>}{search.enabled && search.nextRunAt && <small>Prochaine collecte : {date(search.nextRunAt)}</small>}</div>
                          <div>
                            {search.enabled && <button disabled={busy || demo} onClick={() => action(async () => { const result = await api<CareerSavedSearch>(`/saved-searches/${search.id}/run`, "POST", {}); return result.lastError ? `Collecte à reprendre : ${result.lastError}` : `Collecte terminée : ${result.lastResultCount} offre(s) trouvée(s).`; }, "Collecte terminée.")}>{search.lastError ? "Réessayer la collecte" : "Collecter maintenant"}</button>}
                             {!search.enabled && search.lastError && <button disabled={busy || demo} onClick={() => action(async () => { await updateRecurringSearch(search, { enabled: true }); const result = await api<CareerSavedSearch>(`/saved-searches/${search.id}/run`, "POST", {}); return result.lastError ? `Collecte à reprendre : ${result.lastError}` : `Collecte terminée : ${result.lastResultCount} offre(s) trouvée(s).`; })}>Réactiver et réessayer</button>}
                            <button disabled={busy || demo} onClick={() => beginSavedSearchEdit(search)} aria-expanded={editingSavedSearchId === search.id}>Modifier</button>
                            <button disabled={busy || demo} onClick={() => action(() => updateRecurringSearch(search, { enabled: !search.enabled }), search.enabled ? "Collecte mise en pause." : "Collecte réactivée.")}>{search.enabled ? "Suspendre" : "Réactiver"}</button>
                            <button disabled={busy || demo} onClick={() => action(async () => { await api(`/saved-searches/${search.id}`, "DELETE", {}); return "Recherche supprimée."; })}>Supprimer</button>
                          </div>
                        </div>
                        {editingSavedSearchId === search.id && savedSearchDraft && <form className="cw-panel cw-saved-search-editor" aria-label={`Modifier la recherche ${search.criteria.keywords}`} onSubmit={(event) => {
                          event.preventDefault();
                          const draft = savedSearchDraft;
                          void action(async () => {
                            await updateRecurringSearch(search, {
                              criteria: {
                                keywords: draft.keywords.trim(),
                                ...(draft.commune.trim() && !["himalayas", "remotive"].includes(search.source) ? { commune: draft.commune.trim() } : {}),
                                ...(draft.contractType.trim() ? { contractType: draft.contractType.trim() } : {}),
                                limit: draft.limit,
                              },
                              intervalHours: draft.intervalHours,
                            });
                            setEditingSavedSearchId(null);
                            setSavedSearchDraft(null);
                            return "Recherche mise à jour.";
                          }, "Recherche mise à jour.");
                        }}>
                          <label>Mots-clés<input required maxLength={300} value={savedSearchDraft.keywords} onChange={(event) => setSavedSearchDraft({ ...savedSearchDraft, keywords: event.target.value })} /></label>
                          {!(["himalayas", "remotive"].includes(search.source)) && <label>Ville ou commune<input maxLength={100} value={savedSearchDraft.commune} onChange={(event) => setSavedSearchDraft({ ...savedSearchDraft, commune: event.target.value })} /></label>}
                          <label>Type de contrat<input maxLength={40} value={savedSearchDraft.contractType} onChange={(event) => setSavedSearchDraft({ ...savedSearchDraft, contractType: event.target.value })} placeholder="Facultatif" /></label>
                          <label>Nombre d’offres<select value={savedSearchDraft.limit} onChange={(event) => setSavedSearchDraft({ ...savedSearchDraft, limit: Number(event.target.value) })}>{(search.source === "himalayas" ? [10, 20] : [25, 50, 100, 150, 200]).map((limit) => <option key={limit} value={limit}>{limit}</option>)}</select></label>
                          <label>Fréquence<select value={savedSearchDraft.intervalHours} onChange={(event) => setSavedSearchDraft({ ...savedSearchDraft, intervalHours: Number(event.target.value) as CareerSavedSearch["intervalHours"] })}><option value={6}>Toutes les 6 heures</option><option value={12}>Toutes les 12 heures</option><option value={24}>Chaque jour</option><option value={168}>Chaque semaine</option></select></label>
                          <small>Modifier les critères ou la fréquence relance le délai de collecte. La recherche conserve son état actif ou en pause.</small>
                          <div><button type="submit" disabled={busy || demo}>Enregistrer les changements</button><button type="button" onClick={() => { setEditingSavedSearchId(null); setSavedSearchDraft(null); }}>Annuler</button></div>
                        </form>}
                      </div>) : <p>Aucune recherche récurrente. Enregistrez les critères ci-dessus pour collecter les offres automatiquement pendant qu’Anima Desktop est ouvert.</p>}
                      <small>La collecte lit uniquement les flux publics et enregistre les offres localement. Elle ne prépare ni n’envoie de candidature. Les recherches France Travail à accès restreint ne sont pas planifiées.</small>
                    </section>
                    {jobsSection === "search" && searchSource === "france-travail" && <div className="cw-help"><strong>France Travail demande un accès configuré.</strong> Gérez les identifiants API dans Paramètres &gt; Connexions. <button onClick={() => { setSettingsSection("connections"); setTab("settings"); }}>Ouvrir les connexions</button></div>}
                    <details className="cw-details" hidden={jobsSection !== "search"}>
                      <summary>Importer depuis une URL (optionnel)</summary>
                      <p>Utile pour ajouter un tableau carrière précis Greenhouse ou Lever. La recherche France Travail ci-dessus ne demande pas de lien.</p>
                      <form className="cw-inline" onSubmit={(e) => { e.preventDefault(); action(async () => { const result = await api<{ note: string }>("/discover", "POST", { url: source }); return result.note; }, "Import terminé."); }}>
                        <label>
                          URL du tableau ou de l’offre
                          <input type="url" required value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://jobs.lever.co/entreprise" />
                        </label>
                        <button disabled={busy}>Importer</button>
                      </form>
                    </details>
                    <details ref={addJobDetailsRef} className="cw-details" hidden={jobsSection !== "search"}>
                      <summary>Ajouter une offre avec son lien</summary>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          action(async () => {
                            await api("/jobs", "POST", jobDraft);
                            setJobDraft({
                              url: "",
                              title: "",
                              company: "",
                              location: "",
                              description: "",
                            });
                          }, "Offre enregistrée.");
                        }}
                      >
                        <div className="cw-grid">
                          {[
                            ["url", "URL de l’offre"],
                            ["title", "Intitulé"],
                            ["company", "Entreprise"],
                            ["location", "Lieu"],
                          ].map(([key, name]) => (
                            <label key={key}>
                              {name}
                              <input
                                type={key === "url" ? "url" : "text"}
                                required={key === "url" || key === "title"}
                                value={jobDraft[key as keyof typeof jobDraft]}
                                onChange={(e) =>
                                  setJobDraft({
                                    ...jobDraft,
                                    [key]: e.target.value,
                                  })
                                }
                              />
                            </label>
                          ))}
                        </div>
                        <label>
                          Description
                          <textarea
                            value={jobDraft.description}
                            onChange={(e) =>
                              setJobDraft({
                                ...jobDraft,
                                description: e.target.value,
                              })
                            }
                          />
                        </label>
                        <button disabled={busy} className="cw-primary">
                          Enregistrer l’offre
                        </button>
                      </form>
                    </details>
                  </section>
                  <div hidden={jobsSection === "searches"}>
                  <div className="cw-section-head">
                    <h2 id="job-results">{jobsSection === "saved" ? "Offres enregistrées" : "Résultats de recherche"}</h2>
                  </div>
                  <div className="cw-job-toolbar" role="group" aria-label="Filtres et affichage des offres">
                    <label className="cw-job-query">Rechercher
                      <input
                        className="cw-search"
                        aria-label="Rechercher une offre"
                        placeholder="Métier, entreprise, lieu, compétence…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <label>Source
                      <select aria-label="Filtrer par source" value={jobSourceFilter} onChange={(e) => setJobSourceFilter(e.target.value)}>
                        <option value="">Toutes les sources</option>
                        {jobSources.map((item) => <option key={item} value={item}>{item}</option>)}
                      </select>
                    </label>
                    <label>Candidature
                      <select aria-label="Filtrer par candidature" value={jobApplicationFilter} onChange={(e) => setJobApplicationFilter(e.target.value as "all" | "applied" | "unapplied")}>
                        <option value="all">Toutes</option>
                        <option value="applied">Déjà suivies</option>
                        <option value="unapplied">Non suivies</option>
                      </select>
                    </label>
                    <label>Repérée depuis
                      <input type="date" aria-label="Repérée depuis" value={jobDiscoveredAfter} onChange={(e) => setJobDiscoveredAfter(e.target.value)} />
                    </label>
                    <label>Repérée jusqu’au
                      <input type="date" aria-label="Repérée jusqu’au" value={jobDiscoveredBefore} onChange={(e) => setJobDiscoveredBefore(e.target.value)} />
                    </label>
                    <label>Trier
                      <select aria-label="Trier les offres" value={jobSort} onChange={(e) => setJobSort(e.target.value as JobListSort)}>
                        <option value="relevance">Pertinence du profil</option>
                        <option value="newest">Plus récentes</option>
                        <option value="title">Intitulé A à Z</option>
                        <option value="company">Entreprise A à Z</option>
                      </select>
                    </label>
                    {hasJobFilters && <button type="button" className="cw-job-clear" onClick={resetJobFilters}>Effacer les filtres</button>}
                    <button type="button" className="cw-job-density" aria-pressed={compactJobs} onClick={() => setCompactJobs((value) => !value)}>
                      {compactJobs ? "Vue confortable" : "Vue compacte"}
                    </button>
                    <span className="cw-muted cw-job-count" role="status" aria-live="polite">{jobsForDisplay.length} offre(s) affichée(s) sur {data.jobs.length}</span>
                  </div>
                  {jobsForDisplay.length ? (
                    <div className={`cw-jobs ${compactJobs ? "is-compact" : ""}`}>
                    {jobsForDisplay.map((j) => (
                        <article className="cw-panel cw-job" key={j.id}>
                          <div className="cw-section-head">
                            <span className="cw-company">
                              {j.company.slice(0, 2).toUpperCase() || "↗"}
                            </span>
                            <span className="cw-pill">
                              {jobSourceLabel(j)}
                            </span>
                            {profileFitScore(j, data.profile) !== null && (
                              <span className="cw-pill" aria-label="Correspondance indicative de mots-clés" title="Indice local basé sur le profil (métiers, compétences, expérience, lieu et préférences). Ne tient pas compte de la requête de recherche et ne prédit pas une embauche.">
                                {profileFitScore(j, data.profile)}% mots-clés
                              </span>
                            )}
                          </div>
                          <h2>{j.title}</h2>
                          <p>
                            {j.company} <span>·</span>{" "}
                            {j.location || "Lieu non précisé"}
                          </p>
                          <small className="cw-muted">Repérée par Anima le {j.discoveredAt ? new Date(j.discoveredAt).toLocaleDateString("fr-FR", { dateStyle: "medium" }) : "—"}</small>
                          <div className="cw-job-description">
                            {j.description ||
                              "Consultez la source pour le détail de cette offre."}
                          </div>
                          <div className="cw-section-head">
                            <a href={j.url} target="_blank" rel="noreferrer">
                              Voir l’offre{["Remote OK", "Remotive"].includes(jobSourceLabel(j)) ? ` sur ${jobSourceLabel(j)}` : ""} ↗
                            </a>
                            {j.sourceUrl && j.sourceUrl !== j.url && (
                              <a href={j.sourceUrl} target="_blank" rel="noreferrer">Source {jobSourceLabel(j)} ↗</a>
                            )}
                            {data.applications.some((a) => a.jobId === j.id) ? (
                              <button
                                onClick={() => {
                                  openApplicationDetail(
                                     data.applications.find(
                                       (a) => a.jobId === j.id,
                                     )!.id,
                                   );
                                  setTab("applications");
                                }}
                              >
                                Suivre →
                              </button>
                            ) : (
                              <button
                                className="cw-primary"
                                disabled={busy || !resumeId}
                                onClick={() =>
                                  action(async () => {
                                    const a = await api<Application>(
                                      "/applications",
                                      "POST",
                                      { jobId: j.id, resumeId },
                                    );
                                    openApplicationDetail(a.id);
                                    setTab("applications");
                                  }, "Candidature créée. Vous pouvez lancer son envoi automatique.")
                                }
                              >
                                Créer une candidature
                              </button>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : !data.jobs.length ? (
                    <div className="cw-empty">
                      <p role="status">Importez des offres ou ajoutez votre premier lien pour commencer.</p>
                      <button type="button" onClick={() => {
                        const details = addJobDetailsRef.current;
                        if (!details) return;
                        details.open = true;
                        details.scrollIntoView({ block: "center", behavior: "smooth" });
                        details.querySelector("input")?.focus({ preventScroll: true });
                      }}>Ajouter une offre</button>
                    </div>
                  ) : hasJobFilters ? (
                    <div className="cw-empty" role="status" aria-live="polite">
                      Aucune offre ne correspond à ces filtres.
                      <button type="button" onClick={resetJobFilters}>Afficher toutes les offres</button>
                    </div>
                  ) : (
                    <div className="cw-empty">Aucune offre à afficher.</div>
                  )}
                  </div>
                </>
              )}
              {tab === "applications" && (
                <>
                  <div className="cw-heading">
                    <div>
                      <span className="cw-eyebrow">CANDIDATER & AVANCER</span>
                      <h1>{applicationsSection === "campaigns" ? "Campagnes de candidature" : applicationsSection === "attention" ? "À traiter" : applicationsSection === "followups" ? "Relances à traiter" : "Vos candidatures"}</h1>
                      <p>
                        Un seul lancement pour la connexion, le formulaire, le
                        CV et l’envoi.
                      </p>
                    </div>
                    <button onClick={() => { setJobsSection("search"); setTab("jobs"); }}>
                      + Nouvelle candidature
                    </button>
                  </div>
                  <div className="cw-subnav" aria-label="Vues des candidatures">
                    {([ ["all", "Toutes"], ["attention", "À traiter"], ["followups", `Relances (${dueFollowupList.length})`], ["campaigns", "Campagnes"] ] as const).map(([section, label]) => (
                      <button key={section} className={applicationsSection === section ? "current" : ""} onClick={() => { setApplicationsSection(section); if (section === "campaigns") { setFocusedCampaignId(null); setCampaignsActiveOnly(false); setCampaignPage(0); void refreshCampaigns(false, 0); } }}>{label}</button>
                    ))}
                  </div>
                  {applicationsSection === "campaigns" ? campaignPanel : (
                    <>
                  {profileTools}
                  {applicationsSection !== "followups" && <div className="cw-panel cw-batch">
                    <label>
                      <input
                        type="checkbox"
                        checked={
                          !!visibleRunnable.length &&
                          visibleRunnable.every((a) => selected.includes(a.id))
                        }
                        onChange={(e) =>
                          setSelected(
                            e.target.checked ? [...new Set([...selected, ...visibleRunnable.map((a) => a.id)])] : selected.filter((id) => !visibleRunnable.some((a) => a.id === id)),
                          )
                        }
                      />
                      Sélectionner les candidatures disponibles
                    </label>
                    <button
                      className="cw-primary"
                      disabled={busy || batch || demo || !visibleSelected.length}
                      onClick={(event) => { rememberCampaignTrigger(event.currentTarget); void runBatch(visibleSelected); }}
                    >
                      Lancer une campagne · {visibleSelected.length} offre(s) · plafond {maxSubmissions} ↗
                    </button>
                    {campaigns.filter((campaign) => campaign.state === "running").map((campaign) => (
                      <button key={campaign.id} disabled={busy || demo} onClick={() => action(() => api(`/campaigns/${campaign.id}/stop`, "POST", {}), "Campagne arrêtée.")}>Arrêter la campagne</button>
                    ))}
                  </div>}
                  <div className="cw-application-toolbar" role="group" aria-label="Filtres et tri des candidatures">
                    <label>Rechercher une candidature<input type="search" aria-label="Rechercher une candidature" placeholder="Poste, entreprise, état, retour…" value={applicationQuery} onChange={(event) => setApplicationQuery(event.target.value)} /></label>
                    <label>État<select aria-label="Filtrer par état de candidature" value={applicationStateFilter} onChange={(event) => setApplicationStateFilter(event.target.value as typeof applicationStateFilter)}><option value="all">Tous les états</option>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label>Retour employeur<select aria-label="Filtrer par retour employeur" value={applicationOutcomeFilter} onChange={(event) => setApplicationOutcomeFilter(event.target.value as typeof applicationOutcomeFilter)}><option value="all">Tous les retours</option>{Object.entries(outcomes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label>Trier<select aria-label="Trier les candidatures" value={applicationSort} onChange={(event) => setApplicationSort(event.target.value as typeof applicationSort)}><option value="updated">Modifiées récemment</option><option value="action">Prochaine action</option></select></label>
                    {(applicationQuery || applicationStateFilter !== "all" || applicationOutcomeFilter !== "all") && <button type="button" className="cw-application-clear" onClick={() => { setApplicationQuery(""); setApplicationStateFilter("all"); setApplicationOutcomeFilter("all"); }}>Effacer les filtres</button>}
                    <span className="cw-muted cw-application-count" role="status" aria-live="polite">{visibleApplications.length} candidature(s) affichée(s) sur {sectionApplications.length}</span>
                  </div>
                  <div className="cw-applications">
                    {visibleApplications.map((a) => (
                      <article key={a.id} className="cw-panel cw-application">
                        <div className="cw-section-head">
                          <label className="cw-check">
                            <input
                              aria-label={`Sélectionner ${labelJob(data, a)?.title}`}
                              type="checkbox"
                              disabled={
                                !runnable.some((r) => r.id === a.id) || batch
                              }
                              checked={selected.includes(a.id)}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? [...selected, a.id]
                                    : selected.filter((id) => id !== a.id),
                                )
                              }
                            />
                            <span className="cw-company">
                              {labelJob(data, a)
                                ?.company.slice(0, 2)
                                .toUpperCase() || "↗"}
                            </span>
                            <span>
                              <strong>{labelJob(data, a)?.title}</strong>
                              <small>
                                {labelJob(data, a)?.company} ·{" "}
                                {labelJob(data, a)?.location}
                              </small>
                            </span>
                          </label>
                          <span className={`cw-status ${a.state}`} title={APPLICATION_STATE_META[a.state].description}>
                            {states[a.state]}
                          </span>
                        </div>
                        <div className="cw-section-head">
                          <small>
                            {
                              data.resumes.find((r) => r.id === a.resumeId)
                                ?.name
                            }{" "}
                            · <span title={EMPLOYER_OUTCOME_META[a.outcome].description}>Résultat employeur : {outcomes[a.outcome]}</span>
                          </small>
                          {a.prospectId && prospects.find((p) => p.id === a.prospectId) && (
                            <small className="cw-application-contact">
                              Contact : {prospects.find((p) => p.id === a.prospectId)?.firstName} {prospects.find((p) => p.id === a.prospectId)?.lastName}
                            </small>
                          )}
                          <button onClick={() => openApplicationDetail(a.id)}>
                            Ouvrir le suivi →
                          </button>
                        </div>
                        {a.lastError && (
                          <p className="cw-muted">{a.lastError}</p>
                        )}
                      </article>
                    ))}
                  </div>
                  {!visibleApplications.length && (
                    <div className="cw-empty">
                      <p role="status">{applicationQuery || applicationStateFilter !== "all" || applicationOutcomeFilter !== "all" ? "Aucune candidature ne correspond à ces filtres." : applicationsSection === "attention" ? "Aucune candidature ne demande d’action pour le moment." : applicationsSection === "followups" ? "Aucune relance n’est échue pour le moment." : "Choisissez une offre et un CV. Le moteur s’occupe du parcours pris en charge."}</p>
                      {!applicationQuery && applicationStateFilter === "all" && applicationOutcomeFilter === "all" && applicationsSection === "all" && (
                        <button type="button" className="cw-primary" onClick={navigateToOffers}>Voir les offres →</button>
                      )}
                    </div>
                  )}
                    </>
                  )}
                </>
              )}
              {tab === "profile" && profile && (
                <>
                  <div className="cw-heading">
                    <div>
                      <span className="cw-eyebrow">RENSEIGNER UNE FOIS</span>
                      <h1>Votre profil. Vos possibilités.</h1>
                      <p>
                        Le moteur utilise vos informations et vos réponses
                        explicites.
                      </p>
                    </div>
                    <button
                      className="cw-primary"
                      disabled={busy}
                      onClick={() =>
                        action(
                          async () => {
                            profileSaveInProgressRef.current = true;
                            if (profileDraftTimerRef.current !== null) window.clearTimeout(profileDraftTimerRef.current);
                            profileDraftTimerRef.current = null;
                            await profileDraftQueueRef.current.catch(() => {});
                            try {
                              const saved = await api<CareerProfile>("/profile", "PUT", profile);
                              profileSnapshotRef.current = JSON.stringify(saved);
                              setProfile(saved);
                              setProfileDraftStatus("profileSaved");
                              return saved;
                            } finally {
                              profileSaveInProgressRef.current = false;
                            }
                          },
                          "Profil enregistré.",
                        )
                      }
                    >
                      Enregistrer le profil
                    </button>
                    <span className="cw-muted" role="status" aria-live="polite">
                      {profileDraftStatus === "profileSaved" ? "Profil enregistré" :
                        profileDraftStatus === "draftSaved" ? "Brouillon sauvegardé automatiquement" :
                          profileDraftStatus === "pending" ? "Enregistrement du brouillon…" :
                            profileDraftStatus === "saving" ? "Sauvegarde en cours…" :
                              "Brouillon non sauvegardé — vérifiez la connexion locale"}
                    </span>
                  </div>
                  <div className="cw-dashboard">
                    <section className="cw-panel">
                      <h2>Informations personnelles</h2>
                      <div className="cw-grid">
                        {field("firstName", "Prénom")}
                        {field("lastName", "Nom")}
                        {field("email", "Email", "email")}
                        {field("phone", "Téléphone", "tel")}
                        {field("city", "Ville")}
                        {field("country", "Pays")}
                        {field("address", "Adresse")}
                        {field("postalCode", "Code postal")}
                        {field("linkedinUrl", "URL LinkedIn", "url")}
                        {field("websiteUrl", "Site personnel", "url")}
                      </div>
                    </section>
                    <section className="cw-panel">
                      <h2>Votre bibliothèque de CV</h2>
                      <p className="cw-muted">
                        PDF ou DOCX, 10 Mo maximum. Le fichier choisi est
                        transmis au formulaire.
                      </p>
                      <label className="cw-upload">
                        + Ajouter un CV
                        <input
                          ref={resumeUploadRef}                          aria-label="Ajouter un CV"
                          type="file"
                          accept=".pdf,.docx"
                          disabled={busy}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) action(() => upload(file), "CV ajouté.");
                            e.target.value = "";
                          }}
                        />
                      </label>
                      {data.resumes.map((r) => (
                        <div className="cw-resume" key={r.id}>
                          <span>▤</span>
                          <div>
                            <strong>{r.name}</strong>
                            <small>
                              {r.filename} · {(r.size / 1024).toFixed(0)} Ko
                            </small>
                          </div>
                          <a
                            href="#download"
                            aria-label={`Télécharger ${r.name}`}
                            onClick={async (event) => {
                              event.preventDefault();
                              try {
                                const response = await apiFetch(
                                  `/api/career/resumes/${r.id}/download?demo=${demo ? 1 : 0}`,
                                );
                                if (!response.ok) throw new Error("Téléchargement impossible.");
                                await downloadResponse(response, r.filename);
                              } catch (e) {
                                setError(e instanceof Error ? e.message : String(e));
                              }
                            }}
                          >
                            ↓
                          </a>
                          <button
                            aria-label={`Supprimer ${r.name}`}
                            disabled={busy}
                            onClick={() =>
                              action(
                                () => api(`/resumes/${r.id}`, "DELETE"),
                                "CV supprimé.",
                              )
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </section>
                  </div>
                  <section className="cw-panel">
                    <h2>Parcours & recherche</h2>
                    <div className="cw-grid">
                      {field("headline", "Titre professionnel")}
                      <label>
                        Compétences
                        <input
                          value={profile.skills.join(", ")}
                          onChange={(e) =>
                            setProfile({
                              ...profile,
                              skills: split(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Langues
                        <input
                          value={profile.languages.join(", ")}
                          onChange={(e) =>
                            setProfile({
                              ...profile,
                              languages: split(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Postes recherchés
                        <input
                          value={profile.preferences.titles.join(", ")}
                          onChange={(e) =>
                            setProfile({
                              ...profile,
                              preferences: {
                                ...profile.preferences,
                                titles: split(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        Lieux recherchés
                        <input
                          value={profile.preferences.locations.join(", ")}
                          onChange={(e) =>
                            setProfile({
                              ...profile,
                              preferences: {
                                ...profile.preferences,
                                locations: split(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        Type de contrat
                        <input
                          value={profile.preferences.contract}
                          onChange={(e) =>
                            setProfile({
                              ...profile,
                              preferences: {
                                ...profile.preferences,
                                contract: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    </div>
                    <label className="cw-checkbox">
                      <input
                        type="checkbox"
                        checked={profile.preferences.remote}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            preferences: {
                              ...profile.preferences,
                              remote: e.target.checked,
                            },
                          })
                        }
                      />
                      Télétravail recherché
                    </label>
                    <label>
                      Présentation
                      <textarea
                        value={profile.summary}
                        onChange={(e) =>
                          setProfile({ ...profile, summary: e.target.value })
                        }
                      />
                    </label>
                    <h3>Expériences</h3>
                    {profile.experiences.map((experience, i) => (
                      <div className="cw-repeat" key={i}>
                        <div className="cw-grid">
                          {(
                            [
                              "company",
                              "title",
                              "start",
                              "end",
                              "description",
                            ] as const
                          ).map((key, index) => (
                            <label key={key}>
                              {
                                [
                                  "Entreprise",
                                  "Poste",
                                  "Début",
                                  "Fin",
                                  "Description",
                                ][index]
                              }
                              <input
                                value={experience[key]}
                                onChange={(e) =>
                                  setProfile({
                                    ...profile,
                                    experiences: profile.experiences.map(
                                      (item, n) =>
                                        n === i
                                          ? { ...item, [key]: e.target.value }
                                          : item,
                                    ),
                                  })
                                }
                              />
                            </label>
                          ))}
                        </div>
                        <button
                          onClick={() =>
                            setProfile({
                              ...profile,
                              experiences: profile.experiences.filter(
                                (_, n) => n !== i,
                              ),
                            })
                          }
                        >
                          Retirer
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() =>
                        setProfile({
                          ...profile,
                          experiences: [
                            ...profile.experiences,
                            {
                              company: "",
                              title: "",
                              start: "",
                              end: "",
                              description: "",
                            },
                          ],
                        })
                      }
                    >
                      + Ajouter une expérience
                    </button>
                    <h3>Formation</h3>
                    {profile.education.map((education, i) => (
                      <div className="cw-repeat" key={i}>
                        <div className="cw-grid">
                          {(["school", "degree", "start", "end"] as const).map(
                            (key, index) => (
                              <label key={key}>
                                {
                                  ["Établissement", "Diplôme", "Début", "Fin"][
                                    index
                                  ]
                                }
                                <input
                                  value={education[key]}
                                  onChange={(e) =>
                                    setProfile({
                                      ...profile,
                                      education: profile.education.map(
                                        (item, n) =>
                                          n === i
                                            ? { ...item, [key]: e.target.value }
                                            : item,
                                      ),
                                    })
                                  }
                                />
                              </label>
                            ),
                          )}
                        </div>
                        <button
                          onClick={() =>
                            setProfile({
                              ...profile,
                              education: profile.education.filter(
                                (_, n) => n !== i,
                              ),
                            })
                          }
                        >
                          Retirer
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() =>
                        setProfile({
                          ...profile,
                          education: [
                            ...profile.education,
                            { school: "", degree: "", start: "", end: "" },
                          ],
                        })
                      }
                    >
                      + Ajouter une formation
                    </button>
                  </section>
                  <section className="cw-panel">
                    <h2>Réponses réutilisables</h2>
                    <p className="cw-muted">
                      Utilisez le libellé ou la clé de la question. Une réponse
                      oui/non est enregistrée comme un booléen.
                    </p>
                    <label className="cw-answer-search">
                      Filtrer les réponses
                      <input
                        className="cw-search"
                        aria-label="Filtrer les réponses"
                        placeholder="Question ou mot-clé…"
                        value={answerQuery}
                        onChange={(e) => setAnswerQuery(e.target.value)}
                      />
                    </label>
                    {Object.entries(profile.answers)
                      .filter(([key]) => !normalizedAnswerQuery || normalizeOfferSearch(key).includes(normalizedAnswerQuery))
                      .sort(([left], [right]) => left.localeCompare(right, "fr"))
                      .map(([key, value]) => (
                      <div className="cw-row" key={key}>
                        <span>
                          <strong>{key}</strong>
                          <small>
                            {typeof value === "boolean"
                              ? value
                                ? "Oui"
                                : "Non"
                              : value}
                          </small>
                        </span>
                        <div className="cw-inline">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingAnswerKey(key);
                              setAnswerKey(key);
                              setAnswerBoolean(typeof value === "boolean");
                              setAnswerValue(typeof value === "boolean" ? String(value) : value);
                            }}
                          >
                            Modifier
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const answers = { ...profile.answers };
                              delete answers[key];
                              setProfile({ ...profile, answers });
                              if (editingAnswerKey === key) {
                                setEditingAnswerKey(null);
                                setAnswerKey("");
                                setAnswerValue("");
                                setAnswerBoolean(false);
                              }
                            }}
                          >
                            Retirer
                          </button>
                        </div>
                      </div>
                    ))}
                    {Object.keys(profile.answers).length > 0
                      && !Object.keys(profile.answers).some((key) => !normalizedAnswerQuery || normalizeOfferSearch(key).includes(normalizedAnswerQuery))
                      && <p className="cw-muted">Aucune réponse ne correspond à cette recherche.</p>}
                    <div className="cw-inline">
                      <label>
                        Question
                        <input
                          value={answerKey}
                          onChange={(e) => setAnswerKey(e.target.value)}
                        />
                      </label>
                      <label>
                        Réponse
                        {answerBoolean ? (
                          <select
                            aria-label="Réponse"
                            value={answerValue}
                            onChange={(e) => setAnswerValue(e.target.value)}
                          >
                            <option value="">Choisir</option>
                            <option value="true">Oui</option>
                            <option value="false">Non</option>
                          </select>
                        ) : (
                          <input
                            aria-label="Réponse"
                            value={answerValue}
                            onChange={(e) => setAnswerValue(e.target.value)}
                          />
                        )}
                      </label>
                      <label className="cw-checkbox">
                        <input
                          type="checkbox"
                          checked={answerBoolean}
                          onChange={(e) => {
                            setAnswerBoolean(e.target.checked);
                            setAnswerValue("");
                          }}
                        />
                        Oui / non
                      </label>
                      {duplicateAnswerKey && <small className="cw-alert" role="alert">Une réponse existe déjà pour cette question.</small>}
                      <button
                        type="button"
                        disabled={!answerKey.trim() || !answerValue || duplicateAnswerKey}
                        onClick={() => {
                          setProfile((current) => {
                            if (!current) return current;
                            const answers = { ...current.answers };
                            if (editingAnswerKey) delete answers[editingAnswerKey];
                            answers[answerKey.trim()] = answerBoolean
                              ? answerValue === "true"
                              : answerValue;
                            return { ...current, answers };
                          });
                          setAnswerKey("");
                          setAnswerValue("");
                          setAnswerBoolean(false);
                          setEditingAnswerKey(null);
                        }}
                      >
                        {editingAnswerKey ? "Enregistrer les modifications" : "Ajouter la réponse"}
                      </button>
                      {editingAnswerKey && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingAnswerKey(null);
                            setAnswerKey("");
                            setAnswerValue("");
                            setAnswerBoolean(false);
                          }}
                        >
                          Annuler
                        </button>
                      )}
                    </div>
                  </section>
                </>
              )}
              {tab === "settings" && settingsSection === "connections" && (
                <>
                  <div className="cw-heading">
                    <div>
                      <span className="cw-eyebrow">
                        CONNEXIONS RÉUTILISABLES
                      </span>
                      <h1>Les comptes, sans la répétition.</h1>
                      <p>
                        Les mots de passe sont chiffrés. Déverrouillez le coffre
                        pour les connexions automatiques.
                      </p>
                    </div>
                    <span className="cw-pill">
                      {data.vault.unlocked ? "● Déverrouillé" : "◇ Verrouillé"}
                    </span>
                  </div>
                  <section className="cw-panel">
                    <h2>
                      {!data.vault.initialized
                        ? "Créer votre coffre"
                        : "Votre coffre"}
                    </h2>
                    {!data.vault.unlocked ? (
                      <form
                        className="cw-inline"
                        onSubmit={(e) => {
                          e.preventDefault();
                          action(async () => {
                            await api(
                              data.vault.initialized
                                ? "/vault/unlock"
                                : "/vault/initialize",
                              "POST",
                              { passphrase },
                            );
                            setPassphrase("");
                          }, "Coffre déverrouillé.");
                        }}
                      >
                        <label>
                          Phrase secrète du coffre
                          <input
                            type="password"
                            autoComplete="off"
                            minLength={12}
                            required
                            value={passphrase}
                            disabled={demo}
                            onChange={(e) => setPassphrase(e.target.value)}
                            placeholder="12 caractères minimum"
                          />
                        </label>
                        <button className="cw-primary" disabled={busy || demo}>
                          {data.vault.initialized
                            ? "Déverrouiller"
                            : "Créer le coffre"}
                        </button>
                      </form>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() =>
                          action(
                            () => api("/vault/lock", "POST", {}),
                            "Coffre verrouillé et automatisation arrêtée.",
                          )
                        }
                      >
                        Verrouiller le coffre
                      </button>
                    )}
                    <p className="cw-muted">
                      Gardez cette phrase : elle est nécessaire pour retrouver
                      vos mots de passe.
                    </p>
                  </section>
                  <section className="cw-panel">
                    <h2>Ajouter un compte carrière</h2>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        action(async () => {
                          await api("/credentials", "POST", account);
                          setAccount({ ...account, password: "" });
                        }, "Compte enregistré.");
                      }}
                    >
                      <div className="cw-grid">
                        {(
                          ["origin", "label", "username", "password"] as const
                        ).map((key, i) => (
                          <label key={key}>
                            {
                              [
                                "Origine du site (https://…)",
                                "Nom du compte",
                                "Identifiant",
                                "Mot de passe",
                              ][i]
                            }
                            <input
                              required
                              type={
                                key === "password"
                                  ? "password"
                                  : key === "origin"
                                    ? "url"
                                    : "text"
                              }
                              autoComplete="off"
                              disabled={!data.vault.unlocked || demo}
                              value={account[key]}
                              onChange={(e) =>
                                setAccount({
                                  ...account,
                                  [key]: e.target.value,
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <button
                        className="cw-primary"
                        disabled={busy || !data.vault.unlocked || demo}
                      >
                        Enregistrer le compte
                      </button>
                    </form>
                  </section>
                  <section className="cw-panel">
                    <h2>Vos comptes</h2>
                    {data.credentials.map((c) => (
                      <div className="cw-row" key={c.id}>
                        <span>
                          <strong>{c.label || c.origin}</strong>
                          <small>
                            {c.origin} · {c.username}
                          </small>
                        </span>
                        <button
                          disabled={busy || demo}
                          onClick={() =>
                            action(
                              () => api(`/credentials/${c.id}`, "DELETE"),
                              "Compte supprimé.",
                            )
                          }
                        >
                          Supprimer
                        </button>
                      </div>
                    ))}
                    {!data.credentials.length && (
                      <p className="cw-muted">
                        Ajoutez les comptes existants des sites sur lesquels
                        vous postulez.
                      </p>
                    )}
                  </section>
                  {franceConnectionPanel}
                  <AiAssistant
                    view="connection"
                    request={(path, method, body) => api<unknown>(path, method, body)}
                  />
                </>
              )}
              {tab === "settings" && settingsSection === "data" && (
                <div className="cw-heading"><div><span className="cw-eyebrow">DONNÉES LOCALES</span><h1>Données & sauvegardes</h1><p>Exportez, restaurez ou protégez vos données locales.</p></div></div>
              )}
              {tab === "settings" && settingsSection === "preferences" && (
                <>
                  <div className="cw-heading">
                    <div><span className="cw-eyebrow">VOTRE ESPACE</span><h1>Préférences</h1><p>Ces valeurs servent de choix par défaut pour les prochaines campagnes.</p></div>
                  </div>
                  <section className="cw-panel">
                    <h2>Plafond par défaut des campagnes</h2>
                    <label>Nombre maximal de candidatures
                      <input type="number" min="1" max="100" value={maxSubmissions} onChange={(event) => setMaxSubmissions(Number(event.target.value))} />
                    </label>
                    <p className="cw-muted">Chaque campagne affiche et conserve son propre plafond au moment de sa création.</p>
                  </section>
                </>
              )}
              {tab === "settings" && settingsSection === "about" && (
                <div className="cw-heading">
                  <div><span className="cw-eyebrow">À PROPOS</span><h1>Anima Desktop</h1><p>Un espace local pour organiser vos offres, candidatures, profil et réseau.</p></div>
                </div>
              )}
              <div
                className="cw-legacy-host"
                hidden={!(tab === "network" || tab === "help" || (tab === "settings" && ["connections", "data", "preferences"].includes(settingsSection)))}
              >
                <ProspectingWorkspace
                  embedded
                  initialTab={tab === "network" ? legacyTab : tab === "help" ? "erreurs" : "parametres"}
                  settingsSection={tab === "settings" ? settingsSection : undefined}
                  demoMode={demo}
                  focusProspectId={focusProspectId}
                  focusProspectVersion={focusProspectVersion}
                  onProspectsChange={setProspects}
                  associatedApplications={linkedApplications}
                  onFeedback={(kind, message) => {
                    setError(kind === "error" ? message : "");
                    setNotice(kind === "notice" ? message : "");
                  }}
                />
              </div>
            </>
          )}
        </div>
      </main>
      {current && data && (
        <div className="cw-overlay" onClick={() => setDetail(null)}>
          <aside
            ref={applicationDialogRef}
            className="cw-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="application-drawer-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cw-section-head">
              <span className={`cw-status ${current.state}`} title={APPLICATION_STATE_META[current.state].description}>
                {states[current.state]}
              </span>
              <button
                aria-label="Fermer la candidature"
                onClick={() => setDetail(null)}
              >
                ×
              </button>
            </div>
            <h2 id="application-drawer-title">{currentJob?.title || "Candidature"}</h2>
            <p>
              {currentJob?.company} · {currentJob?.location}
            </p>
            <a href={currentJob?.url} target="_blank" rel="noreferrer">
              Voir l’offre ↗
            </a>
            <div className="cw-section-head cw-run-actions">
              <button
                disabled={
                  busy ||
                  demo ||
                  batch ||
                  !runnable.some((a) => a.id === current.id)
                }
                onClick={(event) => { rememberCampaignTrigger(event.currentTarget); setCampaignMode("prepare"); setCampaignPlan({ jobIds: [current.jobId], note: "Candidature sélectionnée" }); }}
              >
                Préparer avec vérification…
              </button>
              <button
                className="cw-primary"
                disabled={
                  busy ||
                  demo ||
                  batch ||
                  !runnable.some((a) => a.id === current.id)
                }
                onClick={(event) => { rememberCampaignTrigger(event.currentTarget); setCampaignMode("prepare"); setCampaignPlan({ jobIds: [current.jobId], note: "Candidature sélectionnée" }); }}
              >
                Préparer le lancement…
              </button>
            </div>
            {window.anima && !demo && currentJob && (
              <AiAssistant
                request={(path, method, body) => api<unknown>(path, method, body)}
                selectedApplication={{
                  id: current.id,
                  title: currentJob.title,
                  company: currentJob.company,
                }}
              />
            )}
            {current.lastError && (
              <p className="cw-callout">{current.lastError}</p>
            )}
            {["needs_input", "blocked"].includes(current.state) && (
              <div className="cw-callout">
                <strong>Parcours en pause</strong>
                <p>Répondez aux questions ci-dessous ou terminez la vérification dans la fenêtre du navigateur, puis reprenez la session.</p>
                <button
                  className="cw-primary"
                  disabled={busy || demo || batch}
                  onClick={() => action(() => resume(current.id), "Reprise lancée dans la session ouverte.")}
                >
                  Reprendre la session ouverte
                </button>
              </div>
            )}
            {current.receipt && (
              <div className="cw-receipt">
                <strong>✓ Candidature reçue</strong>
                <p>{current.receipt.text}</p>
                <small>
                  {current.receipt.reference} ·{" "}
                  {date(current.receipt.observedAt)}
                </small>
                <a href={current.receipt.url} target="_blank" rel="noreferrer">
                  Page de confirmation ↗
                </a>
              </div>
            )}
            {!!current.missingFields.length && (
              <section>
                <h3>Une réponse et ça repart.</h3>
                {current.missingFields.map((m) => m.type === "file" ? (
                  <div key={m.key} className="cw-file-resolution">
                    <label>
                      {m.label}
                      <select
                        value={fileResumeChoices[`${current.id}:${m.key}`] || current.resumeId}
                        onChange={(e) => setFileResumeChoices((choices) => ({ ...choices, [`${current.id}:${m.key}`]: e.target.value }))}
                      >
                        {data.resumes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </label>
                    <button
                      disabled={busy || demo || batch || !data.resumes.length}
                      onClick={() => action(() => resume(current.id, m.key, fileResumeChoices[`${current.id}:${m.key}`] || current.resumeId), "Fichier joint, reprise lancée.")}
                    >
                      Joindre ce fichier et reprendre
                    </button>
                  </div>
                ) : (
                  <label key={m.key}>
                    {m.label}
                    {m.type === "boolean" ? (
                      <select
                        value={
                          current.answers[m.key] === undefined
                            ? ""
                            : String(current.answers[m.key])
                        }
                        onChange={(e) => {
                          if (e.target.value)
                            action(
                              () =>
                                api(`/applications/${current.id}`, "PATCH", {
                                  answers: {
                                    ...current.answers,
                                    [m.key]: e.target.value === "true",
                                  },
                                }),
                              "Réponse enregistrée.",
                            );
                        }}
                      >
                        <option value="">Choisir votre réponse</option>
                        <option value="true">Oui</option>
                        <option value="false">Non</option>
                      </select>
                    ) : m.type === "select" ? (
                      <select
                        value={String(current.answers[m.key] || "")}
                        onChange={(e) =>
                          action(
                            () =>
                              api(`/applications/${current.id}`, "PATCH", {
                                answers: {
                                  ...current.answers,
                                  [m.key]: e.target.value,
                                },
                              }),
                            "Réponse enregistrée.",
                          )
                        }
                      >
                        <option value="">Choisir</option>
                        {m.options?.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        defaultValue={String(current.answers[m.key] || "")}
                        onBlur={(e) => {
                          if (e.target.value !== current.answers[m.key])
                            action(
                              () =>
                                api(`/applications/${current.id}`, "PATCH", {
                                  answers: {
                                    ...current.answers,
                                    [m.key]: e.target.value,
                                  },
                                }),
                              "Réponse enregistrée.",
                            );
                        }}
                      />
                    )}
                  </label>
                ))}
              </section>
            )}
            {current.state === "uncertain" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  action(
                    () =>
                      api(`/applications/${current.id}/resolve`, "POST", {
                        resolution: f.get("resolution"),
                        detail: f.get("detail"),
                      }),
                    "Vérification enregistrée.",
                  );
                }}
              >
                <h3>Vérifier avant tout nouvel envoi</h3>
                <label>
                  Résultat
                  <select name="resolution">
                    <option value="submitted">Candidature bien envoyée</option>
                    <option value="not_submitted">
                      Candidature non envoyée
                    </option>
                  </select>
                </label>
                <label>
                  Ce que vous avez vérifié
                  <textarea name="detail" required minLength={3} />
                </label>
                <button disabled={busy}>Enregistrer la vérification</button>
              </form>
            )}
            <section>
              <h3>Votre suivi</h3>
              <label>
                Résultat employeur
                <select
                  value={current.outcome}
                  disabled={busy}
                  onChange={(e) =>
                    action(
                      () =>
                        api(`/applications/${current.id}`, "PATCH", {
                          outcome: e.target.value,
                        }),
                      "Suivi mis à jour.",
                    )
                  }
                >
                  {Object.entries(outcomes).map(([key, name]) => (
                    <option value={key} key={key}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <small>Ce résultat est renseigné séparément du journal des retours reçus.</small>
              <label>
                CV
                <select
                  value={current.resumeId}
                  disabled={
                    busy || active(current) || current.state === "submitted"
                  }
                  onChange={(e) =>
                    action(
                      () =>
                        api(`/applications/${current.id}`, "PATCH", {
                          resumeId: e.target.value,
                        }),
                      "CV mis à jour.",
                    )
                  }
                >
                  {data.resumes.map((r) => (
                    <option value={r.id} key={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Prospect lié
                <select
                  value={current.prospectId || ""}
                  disabled={busy || ["running", "submitting", "submitted", "uncertain"].includes(current.state)}
                  onChange={(e) =>
                    action(
                      () =>
                        api(`/applications/${current.id}`, "PATCH", {
                          prospectId: e.target.value || null,
                        }),
                      "Prospect lié.",
                    )
                  }
                >
                  <option value="">Aucun prospect</option>
                  {prospects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.firstName} {p.lastName} · {p.company}
                    </option>
                  ))}
                </select>
              </label>
              {["running", "submitting", "submitted", "uncertain"].includes(current.state) && (
                <small className="cw-muted cw-association-lock-note">
                  Le lien avec le contact est figé pendant ou après l’envoi de la candidature.
                </small>
              )}
              {current.prospectId && (
                <button
                  type="button"
                  className="cw-contact-link"
                  onClick={() => {
                    setDetail(null);
                    setNetworkSection("contacts");
                    setLegacyTab("prospects");
                    setFocusProspectId(current.prospectId);
                    setFocusProspectVersion((version) => version + 1);
                    setTab("network");
                  }}
                >
                  Ouvrir le contact →
                </button>
              )}
              <label>
                Prochaine action / relance
                <input
                  type="datetime-local"
                  defaultValue={
                    current.nextActionAt
                      ? new Date(
                          new Date(current.nextActionAt).getTime() -
                            new Date(current.nextActionAt).getTimezoneOffset() *
                              60000,
                        )
                          .toISOString()
                          .slice(0, 16)
                      : ""
                  }
                  key={`${current.id}-date`}
                  onBlur={(e) =>
                    action(
                      () =>
                        api(`/applications/${current.id}`, "PATCH", {
                          nextActionAt: e.target.value
                            ? new Date(e.target.value).toISOString()
                            : "",
                        }),
                      "Relance enregistrée.",
                    )
                  }
                />
              </label>
              <label>
                Notes de suivi
                <textarea
                  key={`${current.id}-notes`}
                  defaultValue={current.notes}
                  placeholder="Date et canal du retour, résumé, prochaine étape…"
                  onBlur={(e) => {
                    if (e.target.value !== current.notes)
                      action(
                        () =>
                          api(`/applications/${current.id}`, "PATCH", {
                            notes: e.target.value,
                          }),
                        "Notes enregistrées.",
                      );
                  }}
                />
              </label>
              <form
                className="cw-employer-response-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const fields = new FormData(form);
                  void action(async () => {
                    const result = await api(`/applications/${current.id}/employer-responses`, "POST", {
                      receivedAt: fields.get("receivedAt"),
                      channel: fields.get("channel"),
                      type: fields.get("type"),
                      note: fields.get("note"),
                    });
                    form.reset();
                    return result;
                  }, "Retour employeur consigné dans l’historique.");
                }}
              >
                <h4>Consigner un retour reçu</h4>
                <div className="cw-grid">
                  <label>Date de réception<input type="date" name="receivedAt" defaultValue={localDateInputValue()} required /></label>
                  <label>Canal<select name="channel" defaultValue="email"><option value="email">E-mail</option><option value="phone">Téléphone</option><option value="portal">Portail carrière</option><option value="linkedin">LinkedIn</option><option value="other">Autre</option></select></label>
                  <label>Type de retour<select name="type" defaultValue="interview"><option value="interview">Entretien proposé</option><option value="offer">Offre reçue</option><option value="rejection">Refus reçu</option><option value="request">Demande ou question</option><option value="other">Autre retour</option></select></label>
                </div>
                <label>Résumé<textarea name="note" required maxLength={1000} placeholder="Ce que l’employeur a communiqué et la prochaine étape éventuelle…" /></label>
                <button type="submit" disabled={busy || demo}>Ajouter à l’historique</button>
                <small>Ce relevé est manuel : il ne lit ni n’envoie aucun e-mail et ne modifie pas le résultat employeur ci-dessus.</small>
              </form>
            </section>
            <section>
              <h3>Historique vérifiable</h3>
              <div className="cw-timeline">
                {data.events
                  .filter((event) => event.applicationId === current.id)
                  .map((event) => (
                    <div key={event.id}>
                      <span>●</span>
                      <div>
                        {(() => {
                          const response = event.kind === "employer_response" ? parseEmployerResponse(event.detail) : null;
                          if (!response) return <>
                            <strong>{event.detail || event.kind}</strong>
                            <small>{date(event.happenedAt)} · {event.source === "automation" ? "Automatisation" : "Vous"}</small>
                          </>;
                          return <>
                            <strong>Retour employeur · {employerResponseTypes[response.type]}</strong>
                            <p>{response.note}</p>
                            <small>Reçu le {new Date(`${response.receivedAt}T00:00:00`).toLocaleDateString("fr-FR")} via {employerResponseChannels[response.channel]} · Consigné le {date(event.happenedAt)}</small>
                          </>;
                        })()}
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          </aside>
        </div>
      )}
      {campaignPlan && data && <div className="cw-overlay cw-campaign-overlay" onClick={() => setCampaignPlan(null)}>
        <section ref={campaignDialogRef} className="cw-drawer cw-campaign-review" role="dialog" aria-modal="true" aria-labelledby="campaign-review-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
          <div className="cw-section-head"><div><span className="cw-eyebrow">AVANT DE CONTINUER</span><h2 id="campaign-review-title">Récapitulatif de campagne</h2></div><button data-dialog-initial-focus aria-label="Fermer le récapitulatif" onClick={() => setCampaignPlan(null)}>×</button></div>
          <p>{campaignPlan.jobIds.length} offre(s) · ordre de pertinence conservé. {campaignPlan.note}</p>
          <div className="cw-campaign-review-jobs" aria-label="Offres de la campagne">
            {campaignPlan.jobIds.map((jobId, index) => {
              const job = data.jobs.find((entry) => entry.id === jobId);
              const existing = data.applications.find((entry) => entry.jobId === jobId);
              return <article key={jobId}><span>{index + 1}</span><div><strong>{job?.title || "Offre introuvable"}</strong><small>{job?.company || ""} · {job?.location || "Lieu non précisé"}</small>{existing && <small>Candidature existante · CV : {data.resumes.find((resume) => resume.id === existing.resumeId)?.name || "introuvable"} · {states[existing.state] || existing.state}</small>}</div></article>;
            })}
          </div>
          <div className="cw-grid">
            <label>CV de la campagne<select value={resumeId} onChange={(event) => setResumeId(event.target.value)}>{data.resumes.map((resume) => <option key={resume.id} value={resume.id}>{resume.name}</option>)}</select></label>
            <label>Compte carrière<select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}><option value="">Détection automatique · un compte par site</option>{data.credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label} · {credential.origin}</option>)}</select></label>
            <label>Plafond d’envoi<select value={maxSubmissions} onChange={(event) => setMaxSubmissions(Number(event.target.value))}>{[1, 3, 5, 10, 20, 50].map((value) => <option key={value} value={value}>{value} candidature(s)</option>)}</select></label>
          </div>
          {campaignPlan.jobIds.some((jobId) => { const existing = data.applications.find((entry) => entry.jobId === jobId); return !!existing && existing.resumeId !== resumeId && !["submitted", "uncertain", "running", "submitting"].includes(existing.state); }) && <p className="cw-callout">À la confirmation, le CV choisi remplacera le CV des candidatures existantes qui peuvent encore être modifiées. Les candidatures envoyées ou à l’issue incertaine gardent leur CV actuel.</p>}
          <fieldset className="cw-campaign-mode"><legend>Action demandée</legend>
            <label><input type="radio" name="campaign-mode" value="prepare" checked={campaignMode === "prepare"} onChange={() => setCampaignMode("prepare")} /> Préparer sans envoyer <small>La campagne reste en attente. Aucun portail n’est ouvert.</small></label>
            <label><input type="radio" name="campaign-mode" value="submit" checked={campaignMode === "submit"} onChange={() => setCampaignMode("submit")} /> Envoyer les candidatures <small>Anima traite les offres dans l’ordre affiché et respecte le plafond. Les questions, CAPTCHA, MFA et envois incertains demandent votre intervention.</small></label>
          </fieldset>
          {campaignPlan.jobIds.some((jobId) => data.applications.some((entry) => entry.jobId === jobId && entry.missingFields.length)) && <p className="cw-callout">Au moins une candidature contient des réponses manquantes. La campagne pourra la mettre en attente et poursuivre les autres offres.</p>}
          <div className="cw-campaign-review-actions"><button onClick={() => setCampaignPlan(null)}>Annuler</button><button className="cw-primary" disabled={busy || demo || !resumeId} onClick={() => { const selectedMode = document.querySelector<HTMLInputElement>('input[name="campaign-mode"]:checked')?.value === "submit" ? "submit" : "prepare"; void action(() => confirmCampaignPlan(selectedMode), selectedMode === "submit" ? "Campagne lancée." : "Campagne préparée."); }}>{campaignMode === "submit" ? "Confirmer et envoyer" : campaignPlan.note === "Candidature sélectionnée" ? "Préparer sans envoyer" : "Créer la campagne sans envoi"}</button></div>
        </section>
      </div>}
    </div>
  );
}
