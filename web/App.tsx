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
          <button className="demo-switch" onClicu��w����k�w��le message est parti. Choisissez ensuite «
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
