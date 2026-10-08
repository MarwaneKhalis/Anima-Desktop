Warning: truncated output (original token count: 25687)
Total output lines: 2233

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
      // Keep the request key so a later retry can safely resume without duplicating applications.…19687 tokens truncated…astError}</p>
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

