import { useEffect, useMemo, useState } from "react";
import { apiFetch, downloadResponse } from "./api.ts";
import {
  EMPTY_FILTERS,
  STATUSES,
  type ActivityEvent,
  type Message,
  type Prospect,
  type QueueItem,
  type SavedSearch,
  type SearchFilters,
  type Status,
  type Template,
} from "../src/shared/types.ts";

export type Tab =
  | "accueil"
  | "recherches"
  | "prospects"
  | "pipeline"
  | "file"
  | "modeles"
  | "activite"
  | "parametres"
  | "erreurs";
type Snapshot = {
  searches: SavedSearch[];
  prospects: Prospect[];
  templates: Template[];
  queue: QueueItem[];
  activity: ActivityEvent[];
  settings: {
    invitationLimit: number;
    invitationsToday: number;
    queuePaused: boolean;
  };
  metrics: {
    found: number;
    qualified: number;
    invited: number;
    accepted: number;
    replies: number;
    meetings: number;
  };
  demo: boolean;
};
type Candidate = {
  linkedinUrl: string;
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  location: string;
  school: string;
  visibleText?: string;
  selected?: boolean;
};

const initial: Snapshot = {
  searches: [],
  prospects: [],
  templates: [],
  queue: [],
  activity: [],
  settings: { invitationLimit: 10, invitationsToday: 0, queuePaused: false },
  metrics: {
    found: 0,
    qualified: 0,
    invited: 0,
    accepted: 0,
    replies: 0,
    meetings: 0,
  },
  demo: false,
};
const blankSearch = (): SavedSearch => ({
  id: "",
  name: "",
  filters: structuredClone(EMPTY_FILTERS),
  linkedinUrl: "",
  notes: "",
  createdAt: "",
  updatedAt: "",
});
const blankProspect = (): Prospect => ({
  id: "",
  linkedinUrl: "",
  firstName: "",
  lastName: "",
  title: "",
  company: "",
  location: "",
  school: "",
  status: "À examiner",
  tags: [],
  notes: "",
  nextAction: "",
  nextActionAt: "",
  createdAt: "",
  updatedAt: "",
});
const date = (s: string) =>
  s
    ? new Date(s).toLocaleDateString("fr-FR", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
const dateTime = (s: string) =>
  s
    ? new Date(s).toLocaleString("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
const fullName = (p: Pick<Prospect, "firstName" | "lastName">) =>
  `${p.firstName} ${p.lastName}`.trim() || "Sans nom";
const base64Utf8 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const statusClass = (s: string) =>
  s === "À ne pas contacter" || s === "Sans suite"
    ? "muted"
    : s.includes("envoyé") || s.includes("acceptée")
      ? "blue"
      : s.includes("Réponse") || s.includes("Converti")
        ? "green"
        : "amber";
const splitList = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const fmtList = (a: string[]) => a.join(", ");
const filterText = (f: SearchFilters) => ({
  titles: fmtList(f.titles),
  keywords: fmtList(f.keywords),
  locations: fmtList(f.locations),
  schools: fmtList(f.schools),
  companies: fmtList(f.companies),
  industries: fmtList(f.industries),
});

export default function App({ initialTab = "accueil", demoMode, embedded = false }: {initialTab?: Tab; demoMode?: boolean; embedded?: boolean} = {}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const [demo, setDemo] = useState(
    () => demoMode ?? localStorage.getItem("anima-demo") === "1",
  );
  useEffect(() => { if (demoMode !== undefined) setDemo(demoMode); }, [demoMode]);
  const [data, setData] = useState<Snapshot>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedSearch, setSelectedSearch] =
    useState<SavedSearch>(blankSearch);
  const [filterDrafts, setFilterDrafts] = useState(() =>
    filterText(EMPTY_FILTERS),
  );
  const [candidateList, setCandidateList] = useState<Candidate[] | null>(null);
  const [candidateNote, setCandidateNote] = useState("");
  const [detail, setDetail] = useState<Prospect | null>(null);
  const [edit, setEdit] = useState<Prospect | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [manualStatus, setManualStatus] = useState<Status>(
    "Invitation acceptée",
  );
  const [manualDetail, setManualDetail] = useState("");
  const [manualDate, setManualDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [confirmItem, setConfirmItem] = useState<QueueItem | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [sort, setSort] = useState("recent");
  const [templateEdit, setTemplateEdit] = useState<Template | null>(null);
  const [limit, setLimit] = useState(10);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");

  async function api<T = any>(
    path: string,
    init?: RequestInit,
    mode = demo,
  ): Promise<T> {
    const separator = path.includes("?") ? "&" : "?";
    const response = await apiFetch(
      `/api${path}${separator}demo=${mode ? "1" : "0"}`,
      init,
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(payload.error || `Erreur ${response.status}`);
    return payload as T;
  }
  const post = <T,>(path: string, value: unknown) =>
    api<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  const put = <T,>(path: string, value: unknown) =>
    api<T>(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  async function load(mode = demo) {
    const snapshot = await api<Snapshot>("/bootstrap", undefined, mode);
    setData(snapshot);
    setLimit(snapshot.settings.invitationLimit);
    return snapshot;
  }
  useEffect(() => {
    load(demo).catch((e) => setError(e.message));
  }, [demo]);
  async function run(fn: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      if (message) setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function openProspect(id: string) {
    try {
      const p = await api<Prospect>(`/prospects/${id}`);
      setDetail(p);
      setEdit(structuredClone(p));
      setTagDraft(p.tags.join(", "));
      setSelectedTemplate(data.templates[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function refreshDetail(id: string) {
    const p = await api<Prospect>(`/prospects/${id}`);
    setDetail(p);
    setEdit(structuredClone(p));
    setTagDraft(p.tags.join(", "));
  }
  function switchDemo(next: boolean) {
    localStorage.setItem("anima-demo", next ? "1" : "0");
    setDemo(next);
    setDetail(null);
    setCandidateList(null);
    setSelectedSearch(blankSearch());
    setFilterDrafts(filterText(EMPTY_FILTERS));
    setTab("accueil");
    setNotice(
      next
        ? "Mode démo : données fictives isolées."
        : "Retour à votre base personnelle.",
    );
  }
  const filtered = useMemo(() => {
    const sourceIds = searchFilter
      ? new Set(
          data.prospects
            .filter((p) => p.sources?.some((s) => s.searchId === searchFilter))
            .map((p) => p.id),
        )
      : null;
    // Sources are loaded on demand in the detail view; the list uses the source index returned by bootstrap.
    const value = data.prospects.filter((p) => {
      const hay = [
        p.firstName,
        p.lastName,
        p.title,
        p.company,
        p.location,
        p.school,
        p.notes,
        p.tags.join(" "),
      ]
        .join(" ")
        .toLocaleLowerCase("fr");
      return (
        (!query || hay.includes(query.toLocaleLowerCase("fr"))) &&
        (!statusFilter || p.status === statusFilter) &&
        (!searchFilter || sourceIds?.has(p.id)) &&
        (!tagFilter ||
          p.tags.some((t) =>
            t
              .toLocaleLowerCase("fr")
              .includes(tagFilter.toLocaleLowerCase("fr")),
          )) &&
        (!dateFilter || p.createdAt.slice(0, 10) >= dateFilter)
      );
    });
    return value.sort((a, b) =>
      sort === "name"
        ? fullName(a).localeCompare(fullName(b), "fr")
        : sort === "company"
          ? a.company.localeCompare(b.company, "fr")
          : b.createdAt.localeCompare(a.createdAt),
    );
  }, [
    data.prospects,
    query,
    statusFilter,
    searchFilter,
    tagFilter,
    dateFilter,
    sort,
  ]);
  const counts = data.metrics;
  const reminders = data.prospects
    .filter(
      (p) =>
        p.nextAction &&
        p.status !== "Sans suite" &&
        p.status !== "À ne pas contacter",
    )
    .sort((a, b) =>
      (a.nextActionAt || "9999").localeCompare(b.nextActionAt || "9999"),
    )
    .slice(0, 5);
  const pending = data.queue.filter((q) =>
    ["pending", "open", "uncertain"].includes(q.state),
  );
  const nav: { id: Tab; label: string; icon: string }[] = [
    { id: "accueil", label: "Vue d’ensemble", icon: "◫" },
    { id: "recherches", label: "Recherches", icon: "⌕" },
    { id: "prospects", label: "Prospects", icon: "♧" },
    { id: "pipeline", label: "Pipeline", icon: "▦" },
    { id: "file", label: "File d’actions", icon: "▷" },
    { id: "modeles", label: "Modèles", icon: "✎" },
    { id: "activite", label: "Activité", icon: "◷" },
    { id: "parametres", label: "Paramètres", icon: "⚙" },
    { id: "erreurs", label: "Aide & erreurs", icon: "?" },
  ];
  const title = nav.find((n) => n.id === tab)?.label || "";

  async function saveSearch() {
    await run(async () => {
      const payload = {
        ...selectedSearch,
        filters: {
          ...selectedSearch.filters,
          titles: splitList(filterDrafts.titles),
          keywords: splitList(filterDrafts.keywords),
          locations: splitList(filterDrafts.locations),
          schools: splitList(filterDrafts.schools),
          companies: splitList(filterDrafts.companies),
          industries: splitList(filterDrafts.industries),
        },
      };
      const saved = selectedSearch.id
        ? await put<SavedSearch>(`/searches/${selectedSearch.id}`, payload)
        : await post<SavedSearch>("/searches", payload);
      setSelectedSearch(saved);
      setFilterDrafts(filterText(saved.filters));
    }, "Recherche enregistrée.");
  }
  async function importCandidates() {
    const profiles =
      candidateList
        ?.filter((c) => c.selected)
        .map(({ selected, visibleText, ...c }) => c) || [];
    if (!profiles.length) {
      setError("Sélectionnez au moins un profil.");
      return;
    }
    await run(async () => {
      const result = await post<
        {
          prospect: Prospect;
          created: boolean;
          possibleDuplicates: Prospect[];
        }[]
      >("/prospects/import", {
        searchId: selectedSearch.id || undefined,
        prospects: profiles,
      });
      const created = result.filter((r) => r.created).length;
      const warnings = result.filter((r) => r.possibleDuplicates.length).length;
      setCandidateList(null);
      setTab("prospects");
      setNotice(
        `${created} nouvelle(s) fiche(s), ${result.length - created} déjà existante(s).${warnings ? ` ${warnings} doublon(s) possible(s) à vérifier.` : ""}`,
      );
    });
  }
  async function saveProspect() {
    if (!edit) return;
    await run(async () => {
      await put(`/prospects/${edit.id}`, {
        ...edit,
        tags: splitList(tagDraft),
      });
      await refreshDetail(edit.id);
    }, "Fiche mise à jour.");
  }
  async function addManual() {
    if (!detail) return;
    await run(async () => {
      await post(`/prospects/${detail.id}/events`, {
        kind: "manual",
        detail: manualDetail || `État confirmé : ${manualStatus}`,
        status: manualStatus,
        happenedAt: manualDate,
      });
      await refreshDetail(detail.id);
      setManualDetail("");
    }, "Événement ajouté à la chronologie.");
  }
  async function createDraft() {
    if (!detail || !selectedTemplate) return;
    await run(async () => {
      await post("/drafts", {
        prospectId: detail.id,
        templateId: selectedTemplate,
      });
      await refreshDetail(detail.id);
    }, "Brouillon créé : relisez-le avant de le placer dans la file.");
  }
  async function updateDraft(message: Message, content: string) {
    await run(async () => {
      await put(`/drafts/${message.id}`, { content });
      if (detail) await refreshDetail(detail.id);
    }, "Brouillon enregistré.");
  }
  async function queueDraft(message: Message) {
    if (!detail) return;
    await run(async () => {
      await post("/queue", { messageId: message.id });
      await refreshDetail(detail.id);
      setTab("file");
      setDetail(null);
    }, "Action ajoutée à la file. Aucune invitation ou message n’a été envoyé.");
  }
  async function download(path: string, filename: string) {
    await run(async () => {
      const response = await apiFetch(
        `/api${path}${path.includes("?") ? "&" : "?"}demo=${demo ? "1" : "0"}`,
      );
      if (!response.ok) throw new Error((await response.json()).error);
      await downloadResponse(response, filename);
    }, "Fichier téléchargé.");
  }
  async function createPortableBackup() {
    const passphrase = backupPassphrase;
    if (passphrase.length < 12) {
      setError("Utilisez une phrase de sauvegarde d’au moins 12 caractères.");
      return;
    }
    await run(async () => {
      const response = await apiFetch(`/api/backup?demo=${demo ? "1" : "0"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      await downloadResponse(response, `anima-connect-sauvegarde-${new Date().toISOString().slice(0, 10)}.anima-backup`);
      setBackupPassphrase("");
    }, "Sauvegarde chiffrée téléchargée.");
  }

  return (
    <div className={`shell ${embedded ? "cw-legacy" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            a<span>✦</span>
          </div>
          <div>
            <strong>
              anima<span>connect</span>
            </strong>
            <small>Votre espace de prospection</small>
          </div>
        </div>
        <div className="workspace-label">ESPACE DE TRAVAIL</div>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? "active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === "file" && pending.length > 0 && (
                <b className="nav-count">{pending.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className="online-dot" /> <strong>Local & privé</strong>
            <p>Vos données restent sur cet ordinateur.</p>
          </div>
          <button className="demo-switch" onClick={() => switchDemo(!demo)}>
            <span>{demo ? "● Mode démo actif" : "○ Activer le mode démo"}</span>
            <span>→</span>
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Espace personnel <span>/</span> {title}
          </div>
          <div className="top-actions">
            <span className="today">
              {new Date().toLocaleDateString("fr-FR", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </span>
            <span className="avatar">AC</span>
          </div>
        </header>
        <div className="content">
          {demo && (
            <div className="demo-banner">
              <strong>Mode démo</strong> — Les noms et profils sont fictifs. Les
              actions LinkedIn sont désactivées.{" "}
              <button onClick={() => switchDemo(false)}>
                Revenir à ma base
              </button>
            </div>
          )}
          {error && (
            <div role="alert" className="alert error">
              <span>!</span>
              <p>{error}</p>
              <button onClick={() => setError("")}>Fermer</button>
            </div>
          )}
          {notice && (
            <div role="status" className="alert success">
              <span>✓</span>
              <p>{notice}</p>
              <button onClick={() => setNotice("")}>Fermer</button>
            </div>
          )}
          {tab === "accueil" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">TABLEAU DE BORD</div>
                  <h1>
                    Bonjour, bienvenue sur Anima Connect{" "}
                    <span className="wave">✳</span>
                  </h1>
                  <p>
                    Une vue claire de vos recherches, contacts et prochaines
                    étapes.
                  </p>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setTab("recherches");
                    setSelectedSearch(blankSearch());
                    setFilterDrafts(filterText(EMPTY_FILTERS));
                  }}
                >
                  ＋ Nouvelle recherche
                </button>
              </div>
              <div className="metrics">
                {[
                  ["Profils trouvés", counts.found, "◉"],
                  ["Qualifiés", counts.qualified, "◇"],
                  ["Invitations envoyées", counts.invited, "↗"],
                  ["Acceptées", counts.accepted, "✓"],
                  ["Réponses", counts.replies, "↩"],
                  ["Rendez-vous", counts.meetings, "▣"],
                ].map(([label, value, icon]) => (
                  <div className="metric" key={label}>
                    <div className="metric-icon">{icon}</div>
                    <strong>{value}</strong>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              <div className="dashboard-grid">
                <section className="panel">
                  <div className="section-head">
                    <div>
                      <h2>Prochaines actions</h2>
                      <p>Les contacts à suivre en priorité</p>
                    </div>
                    <button
                      className="text-link"
                      onClick={() => setTab("prospects")}
                    >
                      Voir les prospects →
                    </button>
                  </div>
                  {reminders.length ? (
                    reminders.map((p) => (
                      <button
                        className="reminder"
                        key={p.id}
                        onClick={() => openProspect(p.id)}
                      >
                        <span className="person-avatar">
                          {(p.firstName[0] || "?") + (p.lastName[0] || "")}
                        </span>
                        <span>
                          <strong>{fullName(p)}</strong>
                          <small>{p.nextAction}</small>
                        </span>
                        <em>{date(p.nextActionAt)}</em>
                      </button>
                    ))
                  ) : (
                    <Empty
                      icon="◷"
                      title="Aucun rappel pour le moment"
                      body="Ajoutez une prochaine action sur une fiche prospect."
                    />
                  )}
                </section>
                <section className="panel">
                  <div className="section-head">
                    <div>
                      <h2>Activité récente</h2>
                      <p>Vos dernières avancées</p>
                    </div>
                    <button
                      className="text-link"
                      onClick={() => setTab("activite")}
                    >
                      Tout voir →
                    </button>
                  </div>
                  {data.activity.slice(0, 5).length ? (
                    data.activity.slice(0, 5).map((e) => (
                      <button
                        className="activity-item"
                        key={e.id}
                        onClick={() => openProspect(e.prospectId)}
                      >
                        <span className="activity-dot" />
                        <span>
                          <strong>{e.prospectName}</strong>
                          <small>{e.detail}</small>
                        </span>
                        <time>{date(e.happenedAt)}</time>
                      </button>
                    ))
                  ) : (
                    <Empty
                      icon="◷"
                      title="L’activité apparaîtra ici"
                      body="Créez une recherche ou ajoutez un prospect pour commencer."
                    />
                  )}
                </section>
              </div>
              <section className="panel quick-panel">
                <div>
                  <div className="eyebrow">DÉMARRAGE RAPIDE</div>
                  <h2>
                    De la recherche à la conversation, sans rien perdre de vue.
                  </h2>
                  <p>
                    Enregistrez vos critères, repérez les profils, préparez vos
                    messages et suivez chaque échange.
                  </p>
                </div>
                <div className="quick-steps">
                  <button onClick={() => setTab("recherches")}>
                    <span>01</span> Créer une recherche <b>→</b>
                  </button>
                  <button onClick={() => setTab("prospects")}>
                    <span>02</span> Suivre les prospects <b>→</b>
                  </button>
                  <button onClick={() => setTab("file")}>
                    <span>03</span> Préparer un envoi <b>→</b>
                  </button>
                </div>
              </section>
            </>
          )}
          {tab === "recherches" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">DÉCOUVERTE</div>
                  <h1>Recherches enregistrées</h1>
                  <p>
                    Gardez vos critères et l’URL LinkedIn que vous avez ajustée.
                  </p>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setSelectedSearch(blankSearch());
                    setFilterDrafts(filterText(EMPTY_FILTERS));
                    setCandidateList(null);
                  }}
                >
                  ＋ Nouvelle recherche
                </button>
              </div>
              <div className="search-layout">
                <section className="panel search-list">
                  <div className="section-head">
                    <h2>
                      Vos recherches{" "}
                      <span className="count-pill">{data.searches.length}</span>
                    </h2>
                  </div>
                  {data.searches.length ? (
                    data.searches.map((s) => (
                      <button
                        key={s.id}
                        className={`search-list-item ${selectedSearch.id === s.id ? "selected" : ""}`}
                        onClick={() => {
                          setSelectedSearch(structuredClone(s));
                          setFilterDrafts(filterText(s.filters));
                          setCandidateList(null);
                        }}
                      >
                        <span className="search-icon">⌕</span>
                        <span>
                          <strong>{s.name}</strong>
                          <small>
                            {[...s.filters.titles, ...s.filters.locations]
                              .slice(0, 3)
                              .join(" · ") || "Critères libres"}
                          </small>
                        </span>
                        <span>→</span>
                      </button>
                    ))
                  ) : (
                    <Empty
                      icon="⌕"
                      title="Aucune recherche"
                      body="Créez votre première recherche pour commencer."
                    />
                  )}
                </section>
                <section className="panel editor">
                  <div className="section-head">
                    <div>
                      <h2>
                        {selectedSearch.id
                          ? "Modifier la recherche"
                          : "Nouvelle recherche"}
                      </h2>
                      <p>
                        Ces critères servent de mémo ; affinez les filtres sur
                        LinkedIn.
                      </p>
                    </div>
                    {selectedSearch.id && (
                      <button
                        className="secondary small"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const copy = await post<SavedSearch>(
                              `/searches/${selectedSearch.id}/duplicate`,
                              {},
                            );
                            setSelectedSearch(copy);
                            setFilterDrafts(filterText(copy.filters));
                          }, "Recherche dupliquée.")
                        }
                      >
                        Dupliquer
                      </button>
                    )}
                  </div>
                  <div className="form-grid">
                    <label className="span-2">
                      Nom de la recherche
                      <input
                        value={selectedSearch.name}
                        onChange={(e) =>
                          setSelectedSearch({
                            ...selectedSearch,
                            name: e.target.value,
                          })
                        }
                        placeholder="Ex. CTO — France"
                      />
                    </label>
                    {(
                      [
                        ["titles", "Intitulés de poste"],
                        ["keywords", "Mots-clés"],
                        ["locations", "Pays, régions ou villes"],
                        ["schools", "Écoles / anciens élèves"],
                        ["companies", "Entreprises actuelles"],
                        ["industries", "Secteurs"],
                      ] as [keyof typeof filterDrafts, string][]
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input
                          value={filterDrafts[key]}
                          onChange={(e) =>
                            setFilterDrafts({
                              ...filterDrafts,
                              [key]: e.target.value,
                            })
                          }
                          placeholder="Séparez les valeurs par une virgule"
                        />
                      </label>
                    ))}
                    <label>
                      Niveau d’expérience
                      <input
                        value={selectedSearch.filters.experience}
                        onChange={(e) =>
                          setSelectedSearch({
                            ...selectedSearch,
                            filters: {
                              ...selectedSearch.filters,
                              experience: e.target.value,
                            },
                          })
                        }
                        placeholder="Ex. senior"
                      />
                    </label>
                    <label>
                      URL de recherche LinkedIn
                      <input
                        value={selectedSearch.linkedinUrl}
                        onChange={(e) =>
                          setSelectedSearch({
                            ...selectedSearch,
                            linkedinUrl: e.target.value,
                          })
                        }
                        placeholder="https://www.linkedin.com/search/results/people/…"
                      />
                    </label>
                    <label className="span-2">
                      Notes
                      <textarea
                        rows={3}
                        value={selectedSearch.notes}
                        onChange={(e) =>
                          setSelectedSearch({
                            ...selectedSearch,
                            notes: e.target.value,
                          })
                        }
                        placeholder="Contexte, angle d’approche…"
                      />
                    </label>
                  </div>
                  <div className="button-row">
                    <button
                      className="primary"
                      disabled={busy || !selectedSearch.name.trim()}
                      onClick={saveSearch}
                    >
                      Enregistrer la recherche
                    </button>
                    {selectedSearch.id && (
                      <>
                        <button
                          className="secondary"
                          disabled={busy || demo}
                          onClick={() =>
                            run(async () => {
                              await post("/browser/search", {
                                searchId: selectedSearch.id,
                              });
                            }, "Navigateur ouvert. Ajustez les filtres dans LinkedIn, puis revenez importer les profils visibles.")
                          }
                        >
                          Ouvrir dans LinkedIn ↗
                        </button>
                        <button
                          className="secondary"
                          disabled={busy || demo}
                          onClick={() =>
                            run(async () => {
                              const s = await post<SavedSearch>(
                                "/browser/associate",
                                { searchId: selectedSearch.id },
                              );
                              setSelectedSearch(s);
                            }, "URL courante associée à cette recherche.")
                          }
                        >
                          Associer l’URL courante
                        </button>
                      </>
                    )}
                  </div>
                  <div className="hint-box">
                    Les filtres LinkedIn et la page peuvent changer.
                    L’application ouvre une recherche par mots-clés ; terminez
                    les filtres sur LinkedIn, puis enregistrez l’URL courante.
                    Aucun profil n’est importé automatiquement.
                  </div>
                  {selectedSearch.id && (
                    <div className="import-zone">
                      <div>
                        <h3>Importer les profils visibles</h3>
                        <p>
                          La page « Personnes » ou le profil doit être ouvert
                          dans le navigateur local. Relisez les champs avant
                          l’import.
                        </p>
                      </div>
                      <button
                        className="primary subtle"
                        disabled={busy || demo}
                        onClick={() =>
                          run(async () => {
                            const result = await api<{
                              candidates: Candidate[];
                              note: string;
                            }>("/browser/visible");
                            setCandidateList(
                              result.candidates.map((c) => ({
                                ...c,
                                selected: true,
                              })),
                            );
                            setCandidateNote(result.note);
                          }, "Profils visibles chargés pour vérification.")
                        }
                      >
                        Lire la page courante
                      </button>
                    </div>
                  )}
                  {candidateList && (
                    <div className="candidate-section">
                      <h3>{candidateList.length} profil(s) proposé(s)</h3>
                      <p>{candidateNote}</p>
                      {candidateList.length ? (
                        candidateList.map((c, i) => (
                          <div className="candidate" key={i}>
                            <label className="candidate-check">
                              <input
                                type="checkbox"
                                checked={Boolean(c.selected)}
                                onChange={(e) =>
                                  setCandidateList(
                                    candidateList.map((item, n) =>
                                      n === i
                                        ? {
                                            ...item,
                                            selected: e.target.checked,
                                          }
                                        : item,
                                    ),
                                  )
                                }
                              />{" "}
                              Importer
                            </label>
                            <div className="form-grid">
                              <label>
                                Prénom
                                <input
                                  value={c.firstName}
                                  onChange={(e) =>
                                    setCandidateList(
                                      candidateList.map((item, n) =>
                                        n === i
                                          ? {
                                              ...item,
                                              firstName: e.target.value,
                                            }
                                          : item,
                                      ),
                                    )
                                  }
                                />
                              </label>
                              <label>
                                Nom
                                <input
                                  value={c.lastName}
                                  onChange={(e) =>
                                    setCandidateList(
                                      candidateList.map((item, n) =>
                                        n === i
                                          ? {
                                              ...item,
                                              lastName: e.target.value,
                                            }
                                          : item,
                                      ),
                                    )
                                  }
                                />
                              </label>
                              <label className="span-2">
                                URL du profil
                                <input
                                  value={c.linkedinUrl}
                                  onChange={(e) =>
                                    setCandidateList(
                                      candidateList.map((item, n) =>
                                        n === i
                                          ? {
                                              ...item,
                                              linkedinUrl: e.target.value,
                                            }
                                          : item,
                                      ),
                                    )
                                  }
                                />
                              </label>
                              {(
                                [
                                  "title",
                                  "company",
                                  "location",
                                  "school",
                                ] as const
                              ).map((key) => (
                                <label key={key}>
                                  {
                                    {
                                      title: "Poste",
                                      company: "Entreprise",
                                      location: "Lieu",
                                      school: "École",
                                    }[key]
                                  }
                                  <input
                                    value={c[key]}
                                    onChange={(e) =>
                                      setCandidateList(
                                        candidateList.map((item, n) =>
                                          n === i
                                            ? { ...item, [key]: e.target.value }
                                            : item,
                                        ),
                                      )
                                    }
                                  />
                                </label>
                              ))}
                            </div>
                            {c.visibleText && (
                              <small className="visible-text">
                                Texte visible : {c.visibleText}
                              </small>
                            )}
                          </div>
                        ))
                      ) : (
                        <Empty
                          icon="⌕"
                          title="Aucun profil visible détecté"
                          body="Faites défiler la page LinkedIn, ouvrez un profil ou ajoutez-le manuellement ci-dessous."
                        />
                      )}
                      <div className="button-row">
                        <button
                          className="secondary"
                          onClick={() =>
                            setCandidateList([
                              ...candidateList,
                              {
                                linkedinUrl: "",
                                firstName: "",
                                lastName: "",
                                title: "",
                                company: "",
                                location: "",
                                school: "",
                                selected: true,
                              },
                            ])
                          }
                        >
                          ＋ Ajouter manuellement
                        </button>
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={importCandidates}
                        >
                          Importer les profils sélectionnés
                        </button>
                      </div>
                    </div>
                  )}
                  {selectedSearch.id && !candidateList && (
                    <button
                      className="text-link manual-link"
                      onClick={() =>
                        setCandidateList([
                          {
                            linkedinUrl: "",
                            firstName: "",
                            lastName: "",
                            title: "",
                            company: "",
                            location: "",
                            school: "",
                            selected: true,
                          },
                        ])
                      }
                    >
                      ＋ Ajouter un prospect manuellement à cette recherche
                    </button>
                  )}
                </section>
              </div>
            </>
          )}
          {tab === "prospects" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">CARNET DE CONTACTS</div>
                  <h1>Vos prospects</h1>
                  <p>
                    Retrouvez chaque personne et l’historique de vos échanges.
                  </p>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setTab("recherches");
                    setSelectedSearch(blankSearch());
                    setFilterDrafts(filterText(EMPTY_FILTERS));
                  }}
                >
                  ＋ Ajouter via une recherche
                </button>
              </div>
              <section className="panel list-panel">
                <div className="filters">
                  <input
                    className="search-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="⌕  Rechercher un nom, poste, entreprise…"
                  />
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="">Tous les statuts</option>
                    {STATUSES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <select
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                  >
                    <option value="">Toutes les recherches</option>
                    {data.searches.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <input
                    value={tagFilter}
                    onChange={(e) => setTagFilter(e.target.value)}
                    placeholder="Tag"
                  />
                  <input
                    type="date"
                    value={dateFilter}
                    onChange={(e) => setDateFilter(e.target.value)}
                    title="Ajouté depuis"
                  />
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="recent">Plus récents</option>
                    <option value="name">Nom A–Z</option>
                    <option value="company">Entreprise A–Z</option>
                  </select>
                </div>
                <div className="list-summary">
                  {filtered.length} prospect(s) affiché(s)
                </div>
                {filtered.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Prospect</th>
                          <th>Poste & entreprise</th>
                          <th>Lieu</th>
                          <th>Statut</th>
                          <th>Ajouté le</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((p) => (
                          <tr key={p.id} onClick={() => openProspect(p.id)}>
                            <td>
                              <div className="table-person">
                                <span className="person-avatar">
                                  {(p.firstName[0] || "?") +
                                    (p.lastName[0] || "")}
                                </span>
                                <span>
                                  <strong>{fullName(p)}</strong>
                                  <small>
                                    {p.linkedinUrl
                                      ? "Profil LinkedIn lié"
                                      : "Sans URL LinkedIn"}
                                  </small>
                                </span>
                              </div>
                            </td>
                            <td>
                              <strong>{p.title || "—"}</strong>
                              <small className="cell-sub">
                                {p.company || "Entreprise non renseignée"}
                              </small>
                            </td>
                            <td>{p.location || "—"}</td>
                            <td>
                              <span
                                className={`status ${statusClass(p.status)}`}
                              >
                                {p.status}
                              </span>
                            </td>
                            <td>{date(p.createdAt)}</td>
                            <td className="row-arrow">→</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    icon="♧"
                    title="Aucun prospect trouvé"
                    body="Essayez d’ajuster vos filtres ou importez des profils depuis une recherche."
                  />
                )}
              </section>
            </>
          )}
          {tab === "pipeline" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">SUIVI VISUEL</div>
                  <h1>Pipeline</h1>
                  <p>
                    Chaque colonne correspond à un statut. Ouvrez une carte pour
                    la faire avancer.
                  </p>
                </div>
                <span className="count-pill large">
                  {data.prospects.length} contacts
                </span>
              </div>
              <div className="kanban">
                {STATUSES.map((s) => {
                  const people = data.prospects.filter((p) => p.status === s);
                  return (
                    <section className="kanban-column" key={s}>
                      <div className="kanban-head">
                        <span className={`status-dot ${statusClass(s)}`} />
                        <strong>{s}</strong>
                        <span>{people.length}</span>
                      </div>
                      {people.length ? (
                        people.map((p) => (
                          <button
                            className="kanban-card"
                            key={p.id}
                            onClick={() => openProspect(p.id)}
                          >
                            <span className="person-avatar">
                              {(p.firstName[0] || "?") + (p.lastName[0] || "")}
                            </span>
                            <strong>{fullName(p)}</strong>
                            <small>{p.title || "Poste non renseigné"}</small>
                            <small>{p.company || "—"}</small>
                            {p.nextAction && <em>◷ {p.nextAction}</em>}
                          </button>
                        ))
                      ) : (
                        <div className="kanban-empty">Aucun contact</div>
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}
          {tab === "file" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ENVOI CONTRÔLÉ</div>
                  <h1>File d’actions</h1>
                  <p>
                    Relisez chaque cible et le texte, puis effectuez l’action
                    dans le navigateur visible.
                  </p>
                </div>
                <div className="button-row">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      run(
                        async () => {
                          await post("/queue/pause", {
                            paused: !data.settings.queuePaused,
                          });
                        },
                        data.settings.queuePaused
                          ? "File reprise."
                          : "File mise en pause.",
                      )
                    }
                  >
                    {data.settings.queuePaused
                      ? "▷ Reprendre"
                      : "Ⅱ Mettre en pause"}
                  </button>
                  <button
                    className="secondary danger-text"
                    disabled={
                      busy || !data.queue.some((q) => q.state === "pending")
                    }
                    onClick={() =>
                      run(async () => {
                        await post("/queue/cancel-pending", {});
                      }, "Actions en attente annulées.")
                    }
                  >
                    Annuler les attentes
                  </button>
                </div>
              </div>
              <div className="queue-note">
                <strong>
                  {data.settings.queuePaused
                    ? "File en pause"
                    : "Aucun envoi automatique"}
                </strong>
                <span>
                  Limite : {data.settings.invitationsToday}/
                  {data.settings.invitationLimit} invitations aujourd’hui.
                  Chaque action demande une vérification et une confirmation
                  séparées.
                </span>
              </div>
              <div className="queue-list">
                {data.queue.length ? (
                  data.queue.map((q) => (
                    <section className="panel queue-card" key={q.id}>
                      <div className="queue-card-head">
                        <div className="table-person">
                          <span className="person-avatar">
                            {q.prospectName
                              .split(" ")
                              .map((x) => x[0])
                              .slice(0, 2)
                              .join("")}
                          </span>
                          <span>
                            <strong>{q.prospectName}</strong>
                            <small>
                              {q.kind === "invitation"
                                ? "Invitation"
                                : "Message de suivi"}{" "}
                              · {dateTime(q.createdAt)}
                            </small>
                          </span>
                        </div>
                        <span
                          className={`status ${q.state === "uncertain" ? "red" : q.state === "sent" ? "green" : "amber"}`}
                        >
                          {
                            {
                              pending: "En attente",
                              open: "Profil ouvert",
                              sent: "Envoi confirmé",
                              uncertain: "À vérifier",
                              cancelled: "Annulée",
                            }[q.state]
                          }
                        </span>
                      </div>
                      {demo ? (
                        <span className="profile-link">{q.linkedinUrl}</span>
                      ) : (
                        <a
                          className="profile-link"
                          href={q.linkedinUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {q.linkedinUrl} ↗
                        </a>
                      )}
                      <div className="message-preview">{q.content}</div>
                      {q.error && <p className="queue-error">{q.error}</p>}
                      <div className="button-row">
                        {["pending", "open"].includes(q.state) && (
                          <>
                            <button
                              className="primary"
                              disabled={
                                busy || demo || data.settings.queuePaused
                              }
                              onClick={() =>
                                run(async () => {
                                  await post(`/queue/${q.id}/open`, {});
                                }, "Profil ouvert. Effectuez vous-même l’action sur LinkedIn, puis confirmez ici uniquement après l’avoir vérifiée.")
                              }
                            >
                              Ouvrir le profil ↗
                            </button>
                            {q.state === "open" && (
                              <button
                                className="secondary"
                                onClick={() => {
                                  setConfirmItem(q);
                                  setConfirmChecked(false);
                                }}
                              >
                                J’ai effectué l’envoi
                              </button>
                            )}
                            <button
                              className="secondary danger-text"
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  await post(`/queue/${q.id}/uncertain`, {
                                    reason:
                                      "Résultat signalé comme incertain par l’utilisateur",
                                  });
                                }, "File arrêtée. Vérifiez l’état dans LinkedIn avant toute reprise.")
                              }
                            >
                              Envoi incertain
                            </button>
                            <button
                              className="text-link"
                              disabled={busy}
                              onClick={() => {
                                if (
                                  q.state === "open" &&
                                  !window.confirm(
                                    "Avez-vous vérifié sur LinkedIn que rien n’a été envoyé ?",
                                  )
                                )
                                  return;
                                run(async () => {
                                  await post(`/queue/${q.id}/cancel`, {
                                    verifiedNotSent: q.state === "open",
                                  });
                                }, "Action annulée.");
                              }}
                            >
                              Annuler
                            </button>
                          </>
                        )}
                        {q.state === "uncertain" && (
                          <>
                            <button
                              className="secondary"
                              onClick={() => {
                                setConfirmItem(q);
                                setConfirmChecked(false);
                              }}
                            >
                              Vérifié : envoyé
                            </button>
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  await post(`/queue/${q.id}/cancel`, {
                                    verifiedNotSent: true,
                                  });
                                }, "Action vérifiée non envoyée et annulée. La file peut reprendre.")
                              }
                            >
                              Vérifié : non envoyé
                            </button>
                          </>
                        )}
                      </div>
                    </section>
                  ))
                ) : (
                  <div className="panel">
                    <Empty
                      icon="▷"
                      title="La file est vide"
                      body="Créez un brouillon sur une fiche prospect, relisez-le et ajoutez-le ici."
                    />
                  </div>
                )}
              </div>
            </>
          )}
          {tab === "modeles" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">PERSONNALISATION</div>
                  <h1>Modèles de messages</h1>
                  <p>
                    Utilisez des variables pour préparer un brouillon propre à
                    chaque prospect.
                  </p>
                </div>
                <button
                  className="primary"
                  onClick={() =>
                    setTemplateEdit({
                      id: "",
                      name: "",
                      kind: "invitation",
                      content: "",
                      createdAt: "",
                    })
                  }
                >
                  ＋ Nouveau modèle
                </button>
              </div>
              <div className="template-grid">
                {data.templates.map((t) => (
                  <section className="panel template-card" key={t.id}>
                    <div className="template-top">
                      <span className="template-icon">✎</span>
                      <span
                        className={`status ${t.kind === "invitation" ? "amber" : "blue"}`}
                      >
                        {t.kind === "invitation" ? "Invitation" : "Suivi"}
                      </span>
                    </div>
                    <h2>{t.name}</h2>
                    <p>{t.content}</p>
                    <button
                      className="secondary"
                      onClick={() => setTemplateEdit(structuredClone(t))}
                    >
                      Modifier le modèle
                    </button>
                  </section>
                ))}
              </div>
              <div className="hint-box variable-hint">
                Variables disponibles : <code>{"{prenom}"}</code>{" "}
                <code>{"{nom}"}</code> <code>{"{poste}"}</code>{" "}
                <code>{"{entreprise}"}</code> <code>{"{ecole}"}</code>{" "}
                <code>{"{localisation}"}</code>. Vérifiez le brouillon généré si
                un champ manque.
              </div>
              {templateEdit && (
                <div className="modal-backdrop">
                  <div className="modal">
                    <button
                      className="close"
                      onClick={() => setTemplateEdit(null)}
                    >
                      ×
                    </button>
                    <h2>
                      {templateEdit.id
                        ? "Modifier le modèle"
                        : "Nouveau modèle"}
                    </h2>
                    <label>
                      Nom
                      <input
                        value={templateEdit.name}
                        onChange={(e) =>
                          setTemplateEdit({
                            ...templateEdit,
                            name: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      Type
                      <select
                        value={templateEdit.kind}
                        onChange={(e) =>
                          setTemplateEdit({
                            ...templateEdit,
                            kind: e.target.value as Template["kind"],
                          })
                        }
                      >
                        <option value="invitation">Invitation</option>
                        <option value="suivi">Message de suivi</option>
                      </select>
                    </label>
                    <label>
                      Texte
                      <textarea
                        rows={7}
                        value={templateEdit.content}
                        onChange={(e) =>
                          setTemplateEdit({
                            ...templateEdit,
                            content: e.target.value,
                          })
                        }
                      />
                    </label>
                    <div className="button-row">
                      <button
                        className="secondary"
                        onClick={() => setTemplateEdit(null)}
                      >
                        Annuler
                      </button>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            if (templateEdit.id)
                              await put(
                                `/templates/${templateEdit.id}`,
                                templateEdit,
                              );
                            else await post("/templates", templateEdit);
                            setTemplateEdit(null);
                          }, "Modèle enregistré.")
                        }
                      >
                        Enregistrer
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          {tab === "activite" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">HISTORIQUE</div>
                  <h1>Activité</h1>
                  <p>
                    Une trace chronologique des ajouts, statuts, notes et envois
                    confirmés.
                  </p>
                </div>
              </div>
              <section className="panel activity-panel">
                {data.activity.length ? (
                  data.activity.map((e) => (
                    <button
                      className="activity-row"
                      key={e.id}
                      onClick={() => openProspect(e.prospectId)}
                    >
                      <span className="timeline-marker" />
                      <span>
                        <strong>{e.prospectName}</strong>
                        <small>{e.detail}</small>
                      </span>
                      <time>{dateTime(e.happenedAt)}</time>
                    </button>
                  ))
                ) : (
                  <Empty
                    icon="◷"
                    title="Aucune activité"
                    body="Les changements apparaîtront ici automatiquement."
                  />
                )}
              </section>
            </>
          )}
          {tab === "parametres" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">CONFIGURATION LOCALE</div>
                  <h1>Paramètres</h1>
                  <p>
                    Contrôlez la limite d’invitations, les données et votre
                    navigateur local.
                  </p>
                </div>
              </div>
              <div className="settings-grid">
                <section className="panel settings-card">
                  <h2>Limite quotidienne</h2>
                  <p>
                    Une invitation confirmée compte pour la journée de cet
                    ordinateur.
                  </p>
                  <div className="limit-row">
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={limit}
                      onChange={(e) => setLimit(Number(e.target.value))}
                    />
                    <span>invitations par jour</span>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await post("/settings", { invitationLimit: limit });
                        }, "Limite enregistrée.")
                      }
                    >
                      Enregistrer
                    </button>
                  </div>
                  <small>
                    {data.settings.invitationsToday} invitation(s) confirmée(s)
                    aujourd’hui.
                  </small>
                </section>
                <section className="panel settings-card">
                  <h2>Export & sauvegarde</h2>
                  <p>
                    Exportez vos prospects en CSV. La sauvegarde complète est chiffrée avec une phrase secrète que vous choisissez.
                  </p>
                  <small>
                    Gardez cette phrase séparément du fichier : elle n’est pas enregistrée par l’application. Les sessions du navigateur carrière ne sont pas incluses.
                  </small>
                  <small>
                    {window.anima
                      ? "Dans l’application bureau, le profil, les CV, les réponses, les notes et l’historique sont chiffrés localement avec une clé protégée par Windows."
                      : "La protection locale par Windows est disponible dans l’application bureau ; cette version web de développement utilise les réglages de son hébergement."}
                  </small>
                  <label className="field">
                    <span>Phrase de sauvegarde (12 caractères minimum)</span>
                    <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={backupPassphrase} onChange={(event) => setBackupPassphrase(event.target.value)} />
                  </label>
                  <div className="button-row">
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        download("/export.csv", "anima-connect-prospects.csv")
                      }
                    >
                      Exporter CSV ↓
                    </button>
                    <button
                      className="secondary"
                      disabled={busy || backupPassphrase.length < 12}
                      onClick={createPortableBackup}
                    >
                      Sauvegarder chiffré ↓
                    </button>
                  </div>
                </section>
                <section className="panel settings-card">
                  <h2>Importer un CSV</h2>
                  <p>
                    Colonnes reconnues : linkedinUrl, firstName, lastName,
                    title, company, location, school, status, tags, notes,
                    nextAction.
                  </p>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      await run(async () => {
                        const result = await post<{
                          total: number;
                          created: number;
                          possibleDuplicates: number;
                        }>("/import.csv", { csv: await file.text() });
                        setNotice(
                          `${result.total} lignes lues, ${result.created} nouvelles fiches, ${result.possibleDuplicates} doublons possibles.`,
                        );
                      });
                      e.target.value = "";
                    }}
                  />
                </section>
                <section className="panel settings-card">
                  <h2>Restaurer une sauvegarde</h2>
                  <p>
                    La base actuelle est conservée dans le dossier local avant restauration. Les fichiers .anima-backup nécessitent leur phrase secrète.
                  </p>
                  <label className="field">
                    <span>Phrase de sauvegarde</span>
                    <input type="password" autoComplete="current-password" maxLength={1024} value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} />
                  </label>
                  <input
                    type="file"
                    accept=".anima-backup,.sqlite,application/vnd.anima.backup,application/vnd.sqlite3"
                    disabled={demo}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const legacy = file.name.toLowerCase().endsWith(".sqlite");
                      if (!legacy && restorePassphrase.length < 12) {
                        setError("Saisissez la phrase secrète de cette sauvegarde.");
                        e.target.value = "";
                        return;
                      }
                      if (legacy && !window.confirm("Cette ancienne sauvegarde SQLite est en clair. L’importer explicitement ? Elle sera chiffrée localement après restauration.")) {
                        e.target.value = "";
                        return;
                      }
                      if (
                        !window.confirm(
                          `Restaurer cette sauvegarde ? Une copie de la base actuelle sera gardée ${window.anima ? "dans le dossier de données local" : "dans data/"} avant remplacement.`,
                        )
                      )
                        return;
                      await run(async () => {
                        const response = await apiFetch(`/api/restore?demo=0`, {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/octet-stream",
                            "X-Anima-Backup-Passphrase-Base64": legacy ? "" : base64Utf8(restorePassphrase),
                            ...(legacy ? { "X-Anima-Allow-Legacy-Backup": "1" } : {}),
                          },
                          body: await file.arrayBuffer(),
                        });
                        const payload = await response.json();
                        if (!response.ok) throw new Error(payload.error);
                      }, "Sauvegarde restaurée.");
                      setRestorePassphrase("");
                      e.target.value = "";
                    }}
                  />
                </section>
                <section className="panel settings-card span-2">
                  <h2>Navigateur local</h2>
                  <p>
                    {window.anima ? (
                      "Chromium est inclus avec l’application. "
                    ) : (
                      <>
                        Au premier usage, installez Chromium avec{" "}
                        <code>npx playwright install chromium</code>.{" "}
                      </>
                    )}
                    Ouvrez une recherche depuis « Recherches ». Connectez-vous
                    vous-même à LinkedIn dans cette fenêtre ; Anima Connect ne
                    demande ni ne conserve votre mot de passe. Le profil de
                    navigation reste sur cet ordinateur.
                  </p>
                </section>
              </div>
            </>
          )}
          {tab === "erreurs" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ASSISTANCE</div>
                  <h1>Aide & erreurs</h1>
                  <p>
                    Quelques repères pour reprendre une action en toute
                    confiance.
                  </p>
                </div>
              </div>
              <div className="help-grid">
                <section className="panel">
                  <h2>Je ne vois aucun profil à importer</h2>
                  <p>
                    Vérifiez que le navigateur local affiche une page de
                    résultats « Personnes » ou un profil ouvert. Faites défiler
                    la page pour afficher les cartes voulues, puis cliquez de
                    nouveau sur « Lire la page courante ». Vous pouvez toujours
                    ajouter un prospect manuellement.
                  </p>
                </section>
                <section className="panel">
                  <h2>LinkedIn affiche un contrôle</h2>
                  <p>
                    L’action s’arrête. Reprenez la main dans la fenêtre
                    LinkedIn. Ne contournez pas les contrôles ; revenez ensuite
                    dans l’application.
                  </p>
                </section>
                <section className="panel">
                  <h2>Envoi incertain</h2>
                  <p>
                    La file se met en pause. Vérifiez sur LinkedIn si
                    l’invitation ou le message est parti. Choisissez ensuite «
                    Vérifié : envoyé » ou « Vérifié : non envoyé » pour garder
                    une trace fiable.
                  </p>
                </section>
                <section className="panel">
                  <h2>Où sont mes données ?</h2>
                  <p>
                    {window.anima ? (
                      "La base et le profil de navigation sont conservés dans le dossier Anima Connect de votre profil Windows. "
                    ) : (
                      <>
                        La base et le profil de navigation sont dans le dossier local{" "}
                        <code>data/</code>, exclu de Git. {" "}
                      </>
                    )}
                    Utilisez « Sauvegarder la base » dans les paramètres pour
                    obtenir une copie transportable.
                  </p>
                </section>
              </div>
            </>
          )}
        </div>
      </main>
      {detail && edit && (
        <div className="drawer-backdrop" onClick={() => setDetail(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div className="table-person">
                <span className="person-avatar big">
                  {(detail.firstName[0] || "?") + (detail.lastName[0] || "")}
                </span>
                <span>
                  <h2>{fullName(detail)}</h2>
                  <small>
                    {detail.title || "Poste inconnu"}{" "}
                    {detail.company ? `· ${detail.company}` : ""}
                  </small>
                </span>
              </div>
              <button className="close" onClick={() => setDetail(null)}>
                ×
              </button>
            </div>
            <div className="drawer-scroll">
              <div className="drawer-section">
                <div className="section-head">
                  <h3>Fiche prospect</h3>
                  {detail.linkedinUrl && !demo && (
                    <a
                      className="text-link"
                      href={detail.linkedinUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Voir le profil ↗
                    </a>
                  )}
                </div>
                <div className="form-grid">
                  <label>
                    Prénom
                    <input
                      value={edit.firstName}
                      onChange={(e) =>
                        setEdit({ ...edit, firstName: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Nom
                    <input
                      value={edit.lastName}
                      onChange={(e) =>
                        setEdit({ ...edit, lastName: e.target.value })
                      }
                    />
                  </label>
                  <label className="span-2">
                    URL LinkedIn
                    <input
                      value={edit.linkedinUrl}
                      onChange={(e) =>
                        setEdit({ ...edit, linkedinUrl: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Poste
                    <input
                      value={edit.title}
                      onChange={(e) =>
                        setEdit({ ...edit, title: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Entreprise
                    <input
                      value={edit.company}
                      onChange={(e) =>
                        setEdit({ ...edit, company: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Lieu
                    <input
                      value={edit.location}
                      onChange={(e) =>
                        setEdit({ ...edit, location: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    École
                    <input
                      value={edit.school}
                      onChange={(e) =>
                        setEdit({ ...edit, school: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Statut
                    <select
                      value={edit.status}
                      onChange={(e) =>
                        setEdit({ ...edit, status: e.target.value as Status })
                      }
                    >
                      {STATUSES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Tags
                    <input
                      value={tagDraft}
                      onChange={(e) => setTagDraft(e.target.value)}
                    />
                  </label>
                  <label>
                    Prochaine action
                    <input
                      value={edit.nextAction}
                      onChange={(e) =>
                        setEdit({ ...edit, nextAction: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Date de rappel
                    <input
                      type="date"
                      value={edit.nextActionAt.slice(0, 10)}
                      onChange={(e) =>
                        setEdit({ ...edit, nextActionAt: e.target.value })
                      }
                    />
                  </label>
                  <label className="span-2">
                    Notes
                    <textarea
                      rows={3}
                      value={edit.notes}
                      onChange={(e) =>
                        setEdit({ ...edit, notes: e.target.value })
                      }
                    />
                  </label>
                </div>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={saveProspect}
                >
                  Enregistrer la fiche
                </button>
              </div>
              <div className="drawer-section">
                <h3>Origine</h3>
                {detail.sources?.length ? (
                  detail.sources.map((s) => (
                    <div className="source-chip" key={s.searchId}>
                      <strong>{s.searchName}</strong>
                      <small>
                        {date(s.importedAt)} ·{" "}
                        {[
                          ...s.filters.titles,
                          ...s.filters.locations,
                          ...s.filters.schools,
                        ].join(" · ") || "Filtres libres"}
                      </small>
                    </div>
                  ))
                ) : (
                  <p className="muted-copy">
                    Ajout manuel ou import CSV sans recherche associée.
                  </p>
                )}
              </div>
              <div className="drawer-section">
                <h3>Préparer un message</h3>
                <p className="muted-copy">
                  Un brouillon n’envoie rien. Relisez le texte avant de le
                  placer dans la file.
                </p>
                <div className="button-row">
                  <select
                    value={selectedTemplate}
                    onChange={(e) => setSelectedTemplate(e.target.value)}
                  >
                    {data.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="secondary"
                    disabled={!selectedTemplate || busy}
                    onClick={createDraft}
                  >
                    Générer un brouillon
                  </button>
                </div>
                {detail.messages?.map((m) => (
                  <Draft
                    key={m.id}
                    message={m}
                    onSave={(content) => updateDraft(m, content)}
                    onQueue={() => queueDraft(m)}
                    busy={busy}
                  />
                ))}
              </div>
              <div className="drawer-section">
                <h3>Mise à jour manuelle</h3>
                <p className="muted-copy">
                  N’indiquez une acceptation ou une réponse qu’après l’avoir
                  constatée sur LinkedIn.
                </p>
                <div className="form-grid">
                  <label>
                    État confirmé
                    <select
                      value={manualStatus}
                      onChange={(e) =>
                        setManualStatus(e.target.value as Status)
                      }
                    >
                      {STATUSES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Date
                    <input
                      type="date"
                      value={manualDate}
                      onChange={(e) => setManualDate(e.target.value)}
                    />
                  </label>
                  <label className="span-2">
                    Détail
                    <textarea
                      rows={2}
                      value={manualDetail}
                      onChange={(e) => setManualDetail(e.target.value)}
                      placeholder="Ex. Invitation acceptée, réponse reçue…"
                    />
                  </label>
                </div>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={addManual}
                >
                  Ajouter à la chronologie
                </button>
              </div>
              <div className="drawer-section">
                <h3>Chronologie</h3>
                {detail.events?.length ? (
                  detail.events.map((e) => (
                    <div className="timeline-entry" key={e.id}>
                      <span className="timeline-marker" />
                      <span>
                        <strong>{e.detail}</strong>
                        <small>{dateTime(e.happenedAt)}</small>
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="muted-copy">Aucun événement.</p>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}
      {confirmItem && (
        <div className="modal-backdrop">
          <div className="modal confirm-modal">
            <button className="close" onClick={() => setConfirmItem(null)}>
              ×
            </button>
            <div className="eyebrow">CONFIRMATION EXPLICITE</div>
            <h2>Confirmer l’envoi effectué</h2>
            <p>
              Vérifiez la cible et le texte exact ci-dessous. Cette confirmation
              inscrira un envoi définitif dans l’historique.
            </p>
            <div className="confirm-target">
              <strong>{confirmItem.prospectName}</strong>
              <a
                href={confirmItem.linkedinUrl}
                target="_blank"
                rel="noreferrer"
              >
                {confirmItem.linkedinUrl}
              </a>
            </div>
            <div className="message-preview">{confirmItem.content}</div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
              />{" "}
              J’ai personnellement vérifié sur LinkedIn que ce texte a bien été
              envoyé à ce profil.
            </label>
            <div className="button-row">
              <button
                className="secondary"
                onClick={() => setConfirmItem(null)}
              >
                Retour
              </button>
              <button
                className="primary"
                disabled={!confirmChecked || busy}
                onClick={() =>
                  run(async () => {
                    await post(`/queue/${confirmItem.id}/confirm`, {});
                    setConfirmItem(null);
                  }, "Envoi confirmé et texte exact enregistré.")
                }
              >
                Confirmer l’envoi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Draft({
  message,
  onSave,
  onQueue,
  busy,
}: {
  message: Message;
  onSave: (content: string) => void;
  onQueue: () => void;
  busy: boolean;
}) {
  const [content, setContent] = useState(message.content);
  useEffect(() => setContent(message.content), [message.content]);
  return (
    <div className="draft">
      <div className="section-head">
        <strong>
          {message.kind === "invitation" ? "Invitation" : "Suivi"} ·{" "}
          {message.state === "sent" ? "Envoyé" : "Brouillon"}
        </strong>
        <small>
          {message.sentAt
            ? dateTime(message.sentAt)
            : dateTime(message.createdAt)}
        </small>
      </div>
      <textarea
        rows={5}
        value={content}
        disabled={message.state === "sent"}
        onChange={(e) => setContent(e.target.value)}
      />
      {message.state === "draft" && (
        <div className="button-row">
          <button
            className="secondary small"
            disabled={busy || content === message.content}
            onClick={() => onSave(content)}
          >
            Enregistrer le texte
          </button>
          <button
            className="primary small"
            disabled={busy || content !== message.content}
            onClick={onQueue}
          >
            Placer dans la file →
          </button>
        </div>
      )}
    </div>
  );
}
function Empty({
  icon,
  title,
  body,
}: {
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <div className="empty">
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}
