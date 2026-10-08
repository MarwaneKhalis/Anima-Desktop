import { useEffect, useRef, useState } from "react";
import { apiFetch, downloadResponse } from "./api.ts";
import AiAssistant from "./AiAssistant.tsx";
import Legacy, { type Tab as LegacyTab } from "./App.tsx";
import type {
  Application,
  AnswerValue,
  CareerProfile,
  CareerSnapshot,
  JobOffer,
  RunMode,
} from "../src/shared/career.ts";

type Tab =
  "home" | "jobs" | "applications" | "profile" | "vault" | "prospecting";
const navigation: [Tab, string, string][] = [
  ["home", "◈", "Tableau de bord"],
  ["jobs", "⌕", "Offres"],
  ["applications", "▤", "Candidatures"],
  ["profile", "◉", "Profil & CV"],
  ["vault", "◇", "Comptes carrière"],
  ["prospecting", "↗", "Prospection"],
];
const states: Record<string, string> = {
  draft: "À préparer",
  running: "En cours",
  ready: "Prête",
  needs_input: "Réponse requise",
  blocked: "Action requise",
  submitting: "Envoi en cours",
  submitted: "Envoyée",
  uncertain: "Envoi à vérifier",
  failed: "À reprendre",
};
const outcomes: Record<string, string> = {
  active: "En attente",
  interview: "Entretien",
  offer: "Offre reçue",
  rejected: "Refus",
  withdrawn: "Retirée",
};
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
type CampaignSummary = {
  id: string;
  resumeId: string;
  credentialId: string | null;
  maxSubmissions: number;
  state: "queued" | "running" | "paused" | "stopped" | "completed" | "limit_reached";
  counts: { total: number; pending: number; running: number; submitted: number; needsInput: number; uncertain: number; failed: number; skipped: number };
  createdAt: string;
};
type CampaignItemSummary = { id: string; applicationId: string; jobId: string; state: string; error: string };
type CampaignDetail = { campaign: CampaignSummary; items: CampaignItemSummary[]; resumeDeferred?: boolean };
const campaignItemStates: Record<string, string> = {
  pending: "En attente", running: "En cours", submitted: "Envoyée", needs_input: "Réponse requise",
  uncertain: "Envoi à vérifier", failed: "Échec avant envoi", skipped: "Passée",
};
const campaignStates: Record<CampaignSummary["state"], string> = {
  queued: "En attente",
  running: "En cours",
  paused: "En pause",
  stopped: "Arrêtée",
  completed: "Terminée",
  limit_reached: "Plafond atteint",
};

export default function CareerWorkspace() {
  const [tab, setTab] = useState<Tab>("home"),
    [legacyTab, setLegacyTab] = useState<LegacyTab>("recherches");
  const [demo, setDemo] = useState(
    () => localStorage.getItem("anima-demo") === "1",
  );
  const [data, setData] = useState<CareerSnapshot | null>(null),
    [profile, setProfile] = useState<CareerProfile | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""),
    [source, setSource] = useState(""),
    [franceTravail, setFranceTravail] = useState<FranceTravailStatus>({ configured: false }),
    [searchSource, setSearchSource] = useState<"arbeitnow" | "france-travail" | "jobicy">("arbeitnow"),
    [franceCredentials, setFranceCredentials] = useState({ clientId: "", clientSecret: "", scope: "" }),
    [searchCriteria, setSearchCriteria] = useState({ keywords: "", department: "", commune: "", contractType: "", limit: 50 }),
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
  const [passphrase, setPassphrase] = useState(""),
    [account, setAccount] = useState({
      origin: "",
      label: "",
      username: "",
      password: "",
    });
  const [answerKey, setAnswerKey] = useState(""),
    [answerValue, setAnswerValue] = useState(""),
    [answerBoolean, setAnswerBoolean] = useState(false);
  const [prospects, setProspects] = useState<
    { id: string; firstName: string; lastName: string; company: string }[]
  >([]);
  const modeRef = useRef(demo);
  modeRef.current = demo;
  async function api<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await apiFetch(`/api/career${path}?demo=${demo ? 1 : 0}`, {
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
    setData(value);
    if (resetProfile) setProfile(structuredClone(value.profile));
    setResumeId((id) =>
      value.resumes.some((r) => r.id === id) ? id : value.resumes[0]?.id || "",
    );
    setCredentialId((id) => value.credentials.some((credential) => credential.id === id) ? id : "");
    await refreshCampaigns();
  }
  async function refreshCampaigns() {
    try {
      const value = await api<{ campaigns: CampaignSummary[] }>("/campaigns");
      setCampaigns(value.campaigns || []);
    } catch {
      // Older builds do not expose durable campaigns; keep the rest of the workspace usable.
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
  async function refreshFranceTravail() {
    try {
      setFranceTravail(await api<FranceTravailStatus>("/sources/france-travail"));
    } catch {
      setFranceTravail({ configured: false });
    }
  }
  useEffect(() => {
    setData(null);
    setProfile(null);
    setDetail(null);
    setSelected([]);
    setError("");
    load(true)
      .then(() => recoverPendingCampaign())
      .catch((e) => setError(e.message));
    refreshFranceTravail();
    apiFetch(`/api/bootstrap?demo=${demo ? 1 : 0}`)
      .then((r) => r.json())
      .then((v) => setProspects(v.prospects || []))
      .catch(() => {});
  }, [demo]);
  useEffect(() => {
    if (!profile) return;
    setSearchCriteria((current) => ({
      ...current,
      keywords: current.keywords || profile.preferences.titles.join(", "),
      commune: current.commune || profile.city || profile.preferences.locations[0] || "",
    }));
  }, [profile]);
  useEffect(() => {
    const timer = setInterval(
      () => load().catch((e) => setError(e.message)),
      2500,
    );
    return () => clearInterval(timer);
  }, [demo]);
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
  async function runBatch() {
    setBatch(true);
    setError("");
    try {
      const latest = await api<CareerSnapshot>("/bootstrap");
      const ids = selected.filter((id) =>
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
      await createAndStartCampaign(jobIds);
      setSelected([]);
      setNotice(`Campagne durable lancée sur ${jobIds.length} offre(s), plafond ${maxSubmissions}.`);
      await refreshCampaigns();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatch(false);
      await load();
    }
  }
  async function createAndStartCampaign(jobIds: string[]) {
    // Keep discovery order: the first offers are the highest ranked, and the
    // campaign's submission cap must apply to that ranking.
    const normalizedJobIds = [...new Set(jobIds)];
    const payload = { jobIds: normalizedJobIds, resumeId, maxSubmissions, ...(credentialId ? { credentialId } : {}) };
    const storageKey = "anima-pending-campaign";
    let pending: { key: string; payload: typeof payload } | undefined;
    try { pending = JSON.parse(localStorage.getItem(storageKey) || "null") || undefined; } catch { pending = undefined; }
    const sameRequest = pending && JSON.stringify(pending.payload) === JSON.stringify(payload);
    const request = sameRequest ? pending! : { key: crypto.randomUUID(), payload };
    localStorage.setItem(storageKey, JSON.stringify(request));
    const created = await api<{ campaign: { id: string } }>("/campaigns", "POST", {
      ...payload,
      idempotencyKey: request.key,
    });
    await api(`/campaigns/${created.campaign.id}/start`, "POST", {});
    localStorage.removeItem(storageKey);
    return created.campaign.id;
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
      await api(`/campaigns/${created.campaign.id}/start`, "POST", {});
      localStorage.removeItem("anima-pending-campaign");
      await refreshCampaigns();
      setNotice("La campagne interrompue a repris automatiquement.");
    } catch {
      // Keep the request key so a later retry can safely resume without duplicating applications.
    }
  }
  async function searchOffers(apply = false) {
    if (!profile) throw new Error("Le profil n’est pas encore chargé.");
    if (apply && !resumeId) throw new Error("Ajoutez un CV dans Profil & CV avant de lancer une campagne.");
    const keywords = searchCriteria.keywords.trim() || profile.preferences.titles.join(", ");
    if (!keywords) throw new Error("Renseignez des métiers recherchés dans Profil & CV, ou saisissez un mot-clé.");
    const searchPath = searchSource === "arbeitnow"
      ? "/sources/arbeitnow/search"
      : searchSource === "jobicy"
        ? "/sources/jobicy/search"
        : "/sources/france-travail/search";
    const found = await api<{ jobs: JobOffer[]; note: string }>(
      searchPath,
      "POST",
      {
        keywords,
        ...(searchSource === "france-travail" && searchCriteria.department.trim() ? { department: searchCriteria.department.trim() } : {}),
        ...(searchCriteria.commune.trim() ? { commune: searchCriteria.commune.trim() } : {}),
        ...(searchCriteria.contractType.trim() ? { contractType: searchCriteria.contractType.trim() } : {}),
        limit: searchCriteria.limit,
      },
    );
    if (!found.jobs.length) return found.note || "Aucune offre ne correspond à ces critères.";
    if (!apply) return `${found.jobs.length} offre(s) récupérée(s). ${found.note}`;
    await createAndStartCampaign(found.jobs.map((job) => job.id));
    await refreshCampaigns();
    return `Campagne lancée sur ${found.jobs.length} offre(s), avec un plafond de ${maxSubmissions} envoi(s). ${found.note}`;
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
  const runnable =
    data?.applications.filter(
      (a) =>
        !["submitted", "uncertain", "running", "submitting"].includes(a.state),
    ) || [];
  const attention =
    data?.applications.filter((a) =>
      ["needs_input", "blocked", "uncertain", "failed"].includes(a.state),
    ) || [];
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
  return (
    <div className="cw-shell">
      <aside className="cw-sidebar">
        <a
          className="cw-brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab("home");
          }}
        >
          <span className="cw-logo">
            a<span>✳</span>
          </span>
          <strong>
            anima<span>connect</span>
          </strong>
        </a>
        <p className="cw-caption">Votre prochain chapitre.</p>
        <div className="cw-nav-label">ESPACE CARRIÈRE</div>
        <nav>
          {navigation.map(([key, icon, name]) => (
            <button
              key={key}
              className={tab === key ? "current" : ""}
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
      <main className="cw-main">
        <header className="cw-top">
          <div>
            Mon espace <span>/</span>{" "}
            {navigation.find((n) => n[0] === tab)?.[2]}
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
                ? "Anima Connect ne répond pas. Vérifiez que l’application est démarrée."
                : "Ouverture de votre espace…"}
            </div>
          ) : (
            <>
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
                      onClick={() => setTab("jobs")}
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
                          onClick={() => setTab("applications")}
                        >
                          Tout voir →
                        </button>
                      </div>
                      {data.applications.slice(0, 5).map((a) => (
                        <button
                          key={a.id}
                          className="cw-row"
                          onClick={() => {
                            setDetail(a.id);
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
                          <span className={`cw-status ${a.state}`}>
                            {states[a.state]}
                          </span>
                        </button>
                      ))}
                      {!data.applications.length && (
                        <div className="cw-empty">
                          Votre première candidature commence avec une offre.
                          <button onClick={() => setTab("jobs")}>
                            Ajouter une offre →
                          </button>
                        </div>
                      )}
                    </section>
                    <section className="cw-panel">
                      <div className="cw-section-head">
                        <h2>À ne pas laisser passer</h2>
                        <span className="cw-pill">{attention.length}</span>
                      </div>
                      {attention.slice(0, 3).map((a) => (
                        <button
                          className="cw-row"
                          key={a.id}
                          onClick={() => {
                            setDetail(a.id);
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
                      {data.applications
                        .filter((a) => a.nextActionAt && a.outcome === "active")
                        .slice(0, 3)
                        .map((a) => (
                          <button
                            className="cw-row"
                            key={a.id}
                            onClick={() => {
                              setDetail(a.id);
                              setTab("applications");
                            }}
                          >
                            <span>
                              <strong>
                                Relance · {labelJob(data, a)?.company}
                              </strong>
                              <small>{date(a.nextActionAt)}</small>
                            </span>
                            <span>◷</span>
                          </button>
                        ))}
                      {!attention.length && (
                        <p className="cw-muted">
                          Aucun blocage à traiter. Retrouvez ici les questions
                          manquantes et vos relances.
                        </p>
                      )}
                      <div className="cw-network">
                        <span>↗</span>
                        <strong>Le réseau ouvre aussi des portes.</strong>
                        <p>
                          {prospects.length} prospect(s) dans votre espace
                          LinkedIn.
                        </p>
                        <button onClick={() => setTab("prospecting")}>
                          Ouvrir la prospection →
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
                      <h1>Les bonnes opportunités.</h1>
                      <p>
                        Cherchez depuis vos critères, puis laissez une campagne
                        traiter les candidatures compatibles.
                      </p>
                    </div>
                    <span className="cw-pill">{data.jobs.length} offres</span>
                  </div>
                  <section className="cw-panel">
                    <div className="cw-source-title">
                      <div>
                        <span className="cw-eyebrow">RECHERCHE AUTOMATIQUE</span>
                        <h2>{searchSource === "arbeitnow" ? "Offres Arbeitnow France" : searchSource === "jobicy" ? "Offres télétravaillables pour la France" : "Offres France Travail"}</h2>
                        <p>
                          {searchSource === "arbeitnow"
                            ? "Recherche publique d’offres récentes en France, sans clé API ni URL à copier."
                            : searchSource === "jobicy"
                              ? "Offres à distance indiquant France, Europe/EMEA ou partout dans leur zone d’éligibilité. Source publique, sans clé API ni compte à créer."
                              : "La recherche part de vos mots-clés et critères. Cette source demande des identifiants API personnels conservés dans le coffre local chiffré."}
                        </p>
                      </div>
                      <span className={`cw-source-status ${searchSource !== "france-travail" || franceTravail.configured ? "is-ready" : ""}`}>
                        {searchSource === "france-travail" ? franceTravail.configured ? "Identifiants enregistrés" : "Accès France Travail requis" : "Source publique disponible"}
                      </span>
                    </div>
                    {searchSource === "france-travail" && !data.vault.unlocked && (
                      <div className="cw-help">
                        <strong>{data.vault.initialized ? "Coffre verrouillé." : "Coffre non initialisé."}</strong> {data.vault.initialized ? "Déverrouillez-le" : "Initialisez-le"} pour enregistrer les identifiants API et permettre la recherche.
                        <button onClick={() => setTab("vault")}>Ouvrir le coffre</button>
                      </div>
                    )}
                    <form
                      className="cw-search-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        action(() => searchOffers(), "Recherche terminée.");
                      }}
                    >
                      <label>
                        Source d’offres
                        <select value={searchSource} onChange={(e) => {
                          const source = e.target.value as "arbeitnow" | "france-travail" | "jobicy";
                          setSearchSource(source);
                          if (source === "jobicy" && searchCriteria.limit > 200) setSearchCriteria({ ...searchCriteria, limit: 200 });
                        }}>
                          <option value="arbeitnow">Arbeitnow France · public, sans clé API</option>
                          <option value="jobicy">Jobicy · France, Europe/EMEA ou partout</option>
                          <option value="france-travail">France Travail · accès restreint</option>
                        </select>
                      </label>
                      <label>
                        Métier(s) ou mot(s)-clé(s)
                        <input
                          type="text"
                          required
                          value={searchCriteria.keywords}
                          onChange={(e) => setSearchCriteria({ ...searchCriteria, keywords: e.target.value })}
                          placeholder={profile?.preferences.titles.join(", ") || "Ex. développeur TypeScript"}
                        />
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
                        <label>
                          Ville ou commune (facultatif)
                          <input
                            maxLength={100}
                            value={searchCriteria.commune}
                            onChange={(e) => setSearchCriteria({ ...searchCriteria, commune: e.target.value })}
                            placeholder="Paris ou code INSEE"
                          />
                        </label>
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
                            {(searchSource === "jobicy" ? [25, 50, 100, 150, 200] : [25, 50, 100, 150, 200, 300, 450]).map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </label>
                      </div>
                      <div className="cw-search-actions">
                        <button className="cw-primary" disabled={busy || demo || (searchSource === "france-travail" && (!franceTravail.configured || !data.vault.unlocked))}>
                          Rechercher les offres ↗
                        </button>
                        <label className="cw-cap">
                          Plafond d’envoi par campagne
                          <select value={maxSubmissions} onChange={(e) => setMaxSubmissions(Number(e.target.value))}>
                            {[1, 3, 5, 10, 20, 50].map((n) => <option key={n} value={n}>{n} candidature{n > 1 ? "s" : ""}</option>)}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="cw-primary cw-apply-button"
                          disabled={busy || demo || (searchSource === "france-travail" && (!franceTravail.configured || !data.vault.unlocked)) || !resumeId}
                          onClick={() => action(() => searchOffers(true), "Campagne lancée.")}
                        >
                          Trouver et candidater automatiquement
                        </button>
                      </div>
                      <small className="cw-automation-note">
                          {searchSource === "arbeitnow"
                            ? <>Les offres viennent de l’<a href="https://www.arbeitnow.fr" target="_blank" rel="noreferrer">API publique Arbeitnow France</a>. La couverture dépend des annonces indexées.</>
                            : searchSource === "jobicy"
                              ? <>Les offres viennent de l’<a href="https://jobicy.com" target="_blank" rel="noreferrer">API publique Jobicy</a>, limitée aux annonces télétravaillables des 7 derniers jours ; les zones hors France, Europe/EMEA et partout sont filtrées. La recherche est actualisée au plus une fois par heure et le lien Jobicy reste la source canonique.</>
                              : <>La recherche interroge l’API France Travail après activation de vos accès. La source est à accès restreint et n’est pas disponible publiquement actuellement.</>} L’envoi automatique est pris en charge sur Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters et Teamtailor ; les autres sites peuvent demander une reprise manuelle. Un CAPTCHA, une MFA ou un formulaire ambigu met la campagne en pause.
                      </small>
                      {demo && <small>Quittez le mode démo pour utiliser les services externes.</small>}
                      {!resumeId && <small>Ajoutez d’abord un CV dans l’onglet Profil & CV pour activer les candidatures.</small>}
                    </form>
                    {searchSource === "france-travail" && <details className="cw-details" open={!franceTravail.configured && !demo}>
                      <summary>{franceTravail.configured ? "Modifier la configuration France Travail" : "Configurer l’accès France Travail"}</summary>
                      <p>
                        L’API Offres d’emploi est à accès restreint et sa diffusion publique est actuellement suspendue. Demandez d’abord un accès auprès de{" "}
                        <a href="https://francetravail.io/contact" target="_blank" rel="noreferrer">France Travail</a>, puis saisissez les identifiants et le périmètre qui vous seront attribués. Les identifiants enregistrés ne sont pas testés avant la première recherche.
                      </p>
                      {franceTravail.configured && franceTravail.scope && (
                        <p className="cw-configured-note">Périmètre enregistré : {franceTravail.scope}</p>
                      )}
                      <form className="cw-grid" onSubmit={(e) => { e.preventDefault(); action(saveFranceTravailCredentials, "Configuration enregistrée."); }}>
                        <label>
                          Client ID
                          <input autoComplete="off" disabled={!data.vault.unlocked} value={franceCredentials.clientId} onChange={(e) => setFranceCredentials({ ...franceCredentials, clientId: e.target.value })} required />
                        </label>
                        <label>
                          Client secret
                          <input type="password" autoComplete="new-password" disabled={!data.vault.unlocked} value={franceCredentials.clientSecret} onChange={(e) => setFranceCredentials({ ...franceCredentials, clientSecret: e.target.value })} required />
                        </label>
                        <label>
                          Scope / périmètre API
                          <input autoComplete="off" disabled={!data.vault.unlocked} value={franceCredentials.scope} onChange={(e) => setFranceCredentials({ ...franceCredentials, scope: e.target.value })} required />
                        </label>
                        <button className="cw-primary" disabled={busy || demo || !data.vault.unlocked}>Enregistrer dans le coffre</button>
                      </form>
                      {franceTravail.configured && (
                        <button disabled={busy || demo || !data.vault.unlocked} onClick={() => action(async () => { await api("/sources/france-travail", "DELETE", {}); setFranceTravail({ configured: false }); return "Accès France Travail supprimé."; })}>Supprimer les identifiants</button>
                      )}
                    </details>}
                    <details className="cw-details">
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
                    <details className="cw-details">
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
                  {profileTools}
                  {!!campaigns.length && (
                    <section className="cw-panel cw-campaigns">
                      <div className="cw-section-head">
                        <div>
                          <span className="cw-eyebrow">TRAITEMENT AUTOMATIQUE</span>
                          <h2>Campagnes de candidature</h2>
                        </div>
                        <span className="cw-pill">{campaigns.length} campagne(s)</span>
                      </div>
                      <div className="cw-campaign-list">
                        {campaigns.slice(0, 5).map((campaign) => (
                          <article className="cw-campaign-row" key={campaign.id}>
                            <div className="cw-campaign-main">
                              <strong>{campaignStates[campaign.state]}</strong>
                              <small>
                                {campaign.counts?.submitted || 0} envoyée(s) · {campaign.counts?.running || 0} en cours · {campaign.counts?.needsInput || 0} à compléter · {campaign.counts?.uncertain || 0} à vérifier · plafond {campaign.maxSubmissions}
                              </small>
                              <small>
                                Compte : {campaign.credentialId
                                  ? data.credentials.find((credential) => credential.id === campaign.credentialId)?.label || "sélectionné, à vérifier"
                                  : "détection automatique (un seul compte par site)"}
                              </small>
                            </div>
                            <div className="cw-campaign-actions">
                              <button onClick={() => void toggleCampaignDetails(campaign.id)}>
                                {campaignDetails[campaign.id] ? "Masquer" : "Détails"}
                              </button>
                              {(campaign.state === "queued" || campaign.state === "paused") && !campaign.counts?.uncertain && (
                                <button className="cw-primary" disabled={busy || demo} onClick={() => action(() => api(`/campaigns/${campaign.id}/start`, "POST", {}), "Campagne reprise.")}>Reprendre</button>
                              )}
                              {campaign.state === "paused" && !!campaign.counts?.uncertain && <small>Résolvez d’abord l’envoi incertain avant de reprendre.</small>}
                              {campaign.state === "running" && (
                                <button disabled={busy || demo} onClick={() => action(() => api(`/campaigns/${campaign.id}/pause`, "POST", {}), "Campagne mise en pause.")}>Pause</button>
                              )}
                              {!["stopped", "completed", "limit_reached"].includes(campaign.state) && (
                                <button disabled={busy || demo} onClick={() => action(() => api(`/campaigns/${campaign.id}/stop`, "POST", {}), "Campagne arrêtée.")}>Arrêter</button>
                              )}
                            </div>
                            {campaignDetails[campaign.id] && (
                              <div className="cw-campaign-items">
                                {campaignDetails[campaign.id].items.map((item) => (
                                  <div className="cw-campaign-item" key={item.id}>
                                    <span>
                                      <strong>{campaignItemStates[item.state] || item.state}</strong>
                                      {item.error && <small>{item.error}</small>}
                                    </span>
                                    <div>
                                      <button onClick={() => { setTab("applications"); setDetail(item.applicationId); }}>
                                        Voir la candidature
                                      </button>
                                      {["pending", "needs_input", "failed"].includes(item.state) && (
                                        <button disabled={busy || demo} onClick={() => void action(async () => {
                                          const updated = await api<CampaignDetail>(`/campaigns/${campaign.id}/items/${item.id}/skip`, "POST", { reason: "Passée depuis le suivi de campagne." });
                                          setCampaignDetails((current) => ({ ...current, [campaign.id]: updated }));
                                          return updated.resumeDeferred
                                            ? "Offre passée. La campagne reste en pause ; le navigateur est occupé. Reprenez-la quand il sera disponible."
                                            : updated.campaign.state === "completed"
                                              ? "Offre passée. La campagne est terminée."
                                              : "Offre passée ; la campagne continue si des offres restent en attente.";
                                        })}>
                                          Passer cette offre
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    <small>Les réponses requises que le profil ne contient pas sont mises en attente pendant que les autres offres continuent. Un CAPTCHA, une MFA ou un site non pris en charge met la campagne en pause : ouvrez ses détails pour traiter ou passer l’offre. Une candidature dont l’envoi est incertain n’est jamais relancée automatiquement.</small>
                    </section>
                  )}
                  <div className="cw-section-head">
                    <h2>Votre sélection</h2>
                    <input
                      className="cw-search"
                      aria-label="Rechercher une offre"
                      placeholder="Poste, entreprise, lieu…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <div className="cw-jobs">
                    {data.jobs
                      .filter((j) =>
                        `${j.title} ${j.company} ${j.location}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((j) => (
                        <article className="cw-panel cw-job" key={j.id}>
                          <div className="cw-section-head">
                            <span className="cw-company">
                              {j.company.slice(0, 2).toUpperCase() || "↗"}
                            </span>
                            <span className="cw-pill">
                              {new URL(j.url).hostname}
                            </span>
                          </div>
                          <h2>{j.title}</h2>
                          <p>
                            {j.company} <span>·</span>{" "}
                            {j.location || "Lieu non précisé"}
                          </p>
                          <div className="cw-job-description">
                            {j.description ||
                              "Consultez la source pour le détail de cette offre."}
                          </div>
                          <div className="cw-section-head">
                            <a href={j.url} target="_blank" rel="noreferrer">
                              Voir l’offre ↗
                            </a>
                            {data.applications.some((a) => a.jobId === j.id) ? (
                              <button
                                onClick={() => {
                                  setDetail(
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
                                    setDetail(a.id);
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
                  {!data.jobs.length && (
                    <div className="cw-empty">
                      Importez des offres ou ajoutez votre premier lien pour
                      commencer.
                    </div>
                  )}
                </>
              )}
              {tab === "applications" && (
                <>
                  <div className="cw-heading">
                    <div>
                      <span className="cw-eyebrow">CANDIDATER & AVANCER</span>
                      <h1>Chaque candidature compte.</h1>
                      <p>
                        Un seul lancement pour la connexion, le formulaire, le
                        CV et l’envoi.
                      </p>
                    </div>
                    <button onClick={() => setTab("jobs")}>
                      + Nouvelle candidature
                    </button>
                  </div>
                  {profileTools}
                  <div className="cw-panel cw-batch">
                    <label>
                      <input
                        type="checkbox"
                        checked={
                          !!runnable.length &&
                          runnable.every((a) => selected.includes(a.id))
                        }
                        onChange={(e) =>
                          setSelected(
                            e.target.checked ? runnable.map((a) => a.id) : [],
                          )
                        }
                      />
                      Sélectionner les candidatures disponibles
                    </label>
                    <button
                      className="cw-primary"
                      disabled={busy || batch || demo || !selected.length}
                      onClick={runBatch}
                    >
                      Lancer une campagne · {selected.length} offre(s) · plafond {maxSubmissions} ↗
                    </button>
                    {campaigns.filter((campaign) => campaign.state === "running").map((campaign) => (
                      <button key={campaign.id} disabled={busy || demo} onClick={() => action(() => api(`/campaigns/${campaign.id}/stop`, "POST", {}), "Campagne arrêtée.")}>Arrêter la campagne</button>
                    ))}
                  </div>
                  <div className="cw-applications">
                    {data.applications.map((a) => (
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
                          <span className={`cw-status ${a.state}`}>
                            {states[a.state]}
                          </span>
                        </div>
                        <div className="cw-section-head">
                          <small>
                            {
                              data.resumes.find((r) => r.id === a.resumeId)
                                ?.name
                            }{" "}
                            · {outcomes[a.outcome]}
                          </small>
                          <button onClick={() => setDetail(a.id)}>
                            Ouvrir le suivi →
                          </button>
                        </div>
                        {a.lastError && (
                          <p className="cw-muted">{a.lastError}</p>
                        )}
                      </article>
                    ))}
                  </div>
                  {!data.applications.length && (
                    <div className="cw-empty">
                      Choisissez une offre et un CV. Le moteur s’occupe du
                      parcours pris en charge.
                    </div>
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
                          () => api("/profile", "PUT", profile),
                          "Profil enregistré.",
                        )
                      }
                    >
                      Enregistrer le profil
                    </button>
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
                          aria-label="Ajouter un CV"
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
                    {Object.entries(profile.answers).map(([key, value]) => (
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
                        <button
                          onClick={() => {
                            const answers = { ...profile.answers };
                            delete answers[key];
                            setProfile({ ...profile, answers });
                          }}
                        >
                          Retirer
                        </button>
                      </div>
                    ))}
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
                            value={answerValue}
                            onChange={(e) => setAnswerValue(e.target.value)}
                          >
                            <option value="">Choisir</option>
                            <option value="true">Oui</option>
                            <option value="false">Non</option>
                          </select>
                        ) : (
                          <input
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
                      <button
                        disabled={!answerKey.trim() || !answerValue}
                        onClick={() => {
                          setProfile({
                            ...profile,
                            answers: {
                              ...profile.answers,
                              [answerKey.trim()]: answerBoolean
                                ? answerValue === "true"
                                : answerValue,
                            },
                          });
                          setAnswerKey("");
                          setAnswerValue("");
                        }}
                      >
                        Ajouter la réponse
                      </button>
                    </div>
                  </section>
                </>
              )}
              {tab === "vault" && (
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
                </>
              )}
              {tab === "prospecting" && (
                <>
                  <div className="cw-heading">
                    <div>
                      <span className="cw-eyebrow">
                        LA PROSPECTION ANIMA CONNECT
                      </span>
                      <h1>Vos prochaines conversations.</h1>
                      <p>
                        Recherches LinkedIn, prospects, modèles et suivi réunis
                        avec vos candidatures.
                      </p>
                    </div>
                  </div>
                  <div className="cw-subnav">
                    {(
                      [
                        ["recherches", "Recherches"],
                        ["prospects", "Prospects"],
                        ["pipeline", "Pipeline"],
                        ["file", "File de contact"],
                        ["modeles", "Modèles"],
                        ["activite", "Activité"],
                        ["parametres", "Sauvegardes"],
                      ] as [LegacyTab, string][]
                    ).map(([key, name]) => (
                      <button
                        className={legacyTab === key ? "current" : ""}
                        key={key}
                        onClick={() => setLegacyTab(key)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <Legacy embedded initialTab={legacyTab} demoMode={demo} />
                </>
              )}
            </>
          )}
        </div>
      </main>
      {current && data && (
        <div className="cw-overlay" onClick={() => setDetail(null)}>
          <aside className="cw-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="cw-section-head">
              <span className={`cw-status ${current.state}`}>
                {states[current.state]}
              </span>
              <button
                aria-label="Fermer la candidature"
                onClick={() => setDetail(null)}
              >
                ×
              </button>
            </div>
            <h2>{currentJob?.title}</h2>
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
                onClick={() =>
                  action(
                    () => run(current.id, "prepare"),
                    "Préparation lancée. Aucun envoi dans ce mode.",
                  )
                }
              >
                Préparer sans envoyer
              </button>
              <button
                className="cw-primary"
                disabled={
                  busy ||
                  demo ||
                  batch ||
                  !runnable.some((a) => a.id === current.id)
                }
                onClick={() =>
                  action(
                    () => run(current.id, "submit"),
                    "Automatisation lancée. Le suivi se met à jour ici.",
                  )
                }
              >
                Postuler automatiquement
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
                Résultat
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
                  disabled={busy}
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
              <label>
                Prochaine action
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
                Notes
                <textarea
                  key={`${current.id}-notes`}
                  defaultValue={current.notes}
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
                        <strong>{event.detail || event.kind}</strong>
                        <small>
                          {date(event.happenedAt)} ·{" "}
                          {event.source === "automation"
                            ? "Automatisation"
                            : "Vous"}
                        </small>
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
