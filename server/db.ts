import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  cleanFilters,
  isStatus,
  normalizeLinkedInUrl,
  renderTemplate,
  samePersonKey,
} from "./domain.ts";
import {
  EMPTY_FILTERS,
  type ActionKind,
  type Prospect,
  type QueueItem,
  type SavedSearch,
  type SearchFilters,
  type Status,
  type Template,
} from "../src/shared/types.ts";
import { ensureProtectedScope, LocalDataProtector, protectedRowId, PROTECTED_SCOPES } from "./data-protection.ts";

type Row = Record<string, unknown>;
type ProspectInput = Partial<Prospect> & {
  firstName?: string;
  lastName?: string;
  linkedinUrl?: string;
};
const now = () => new Date().toISOString();
const localDay = () => new Date().toLocaleDateString("en-CA");
const str = (value: unknown) => String(value ?? "").trim();
const json = (value: unknown, fallback: unknown) => {
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

export class Store {
  db: DatabaseSync;
  private readonly protectedData: LocalDataProtector;
  constructor(path: string, dataProtectionKey?: Buffer) {
    this.db = new DatabaseSync(path);
    this.protectedData = new LocalDataProtector(dataProtectionKey);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS searches (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, filters TEXT NOT NULL, linkedin_url TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prospects (
        id TEXT PRIMARY KEY, linkedin_url TEXT UNIQUE, first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
        school TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'À examiner', tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '', next_action_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prospect_sources (
        prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
        filters TEXT NOT NULL, imported_at TEXT NOT NULL,
        PRIMARY KEY (prospect_id, search_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, detail TEXT NOT NULL, happened_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, content TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS queue (
        id TEXT PRIMARY KEY, prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id), kind TEXT NOT NULL, state TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_events_prospect ON events(prospect_id, happened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_queue_state ON queue(state, created_at);
      CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
    `);
    const crmScope = PROTECTED_SCOPES.find((scope) => scope.name === "crm");
    if (!crmScope) throw new Error("Schéma de protection CRM absent.");
    ensureProtectedScope(this.db, crmScope, dataProtectionKey);
    this.db
      .prepare("INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)")
      .run("invitation_limit", "10");
    this.db
      .prepare("INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)")
      .run("queue_paused", "0");
    if (!this.db.prepare("SELECT 1 FROM templates LIMIT 1").get())
      this.seedTemplates();
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private one(
    sql: string,
    ...args: (string | number | null)[]
  ): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private event(
    prospectId: string,
    kind: string,
    detail: string,
    happenedAt = now(),
  ) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO events VALUES (?,?,?,?,?,?)")
      .run(id, prospectId, kind, this.protectedData.writeText("events", id, "detail", detail), happenedAt, now());
  }
  private searchRow(row: Row): SavedSearch {
    const id = str(row.id);
    return {
      id,
      name: this.protectedData.readText("searches", id, "name", row.name),
      filters: cleanFilters(json(this.protectedData.readText("searches", id, "filters", row.filters), EMPTY_FILTERS)),
      linkedinUrl: this.protectedData.readText("searches", id, "linkedin_url", row.linkedin_url),
      notes: this.protectedData.readText("searches", id, "notes", row.notes),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }
  listSearches(): SavedSearch[] {
    return this.all("SELECT * FROM searches ORDER BY updated_at DESC").map(
      (row) => this.searchRow(row),
    );
  }
  getSearch(id: string): SavedSearch {
    const row = this.one("SELECT * FROM searches WHERE id=?", id);
    if (!row) throw new Error("Recherche introuvable.");
    return this.searchRow(row);
  }
  saveSearch(
    input: Partial<SavedSearch> & { name: string },
    id?: string,
  ): SavedSearch {
    const name = str(input.name);
    if (!name) throw new Error("Donnez un nom à la recherche.");
    const filters = cleanFilters(input.filters);
    const url = str(input.linkedinUrl);
    if (url) {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" ||
        !["linkedin.com", "www.linkedin.com"].includes(
          parsed.hostname.toLowerCase(),
        )
      )
        throw new Error("URL de recherche LinkedIn invalide.");
    }
    const stamp = now();
    if (id) {
      this.getSearch(id);
      this.db
        .prepare(
          "UPDATE searches SET name=?, filters=?, linkedin_url=?, notes=?, updated_at=? WHERE id=?",
        )
        .run(
          this.protectedData.writeText("searches", id, "name", name),
          this.protectedData.writeText("searches", id, "filters", JSON.stringify(filters)),
          this.protectedData.writeText("searches", id, "linkedin_url", url),
          this.protectedData.writeText("searches", id, "notes", str(input.notes)), stamp, id,
        );
      return this.getSearch(id);
    }
    const newId = randomUUID();
    this.db
      .prepare("INSERT INTO searches VALUES (?,?,?,?,?,?,?)")
      .run(
        newId,
        this.protectedData.writeText("searches", newId, "name", name),
        this.protectedData.writeText("searches", newId, "filters", JSON.stringify(filters)),
        this.protectedData.writeText("searches", newId, "linkedin_url", url),
        this.protectedData.writeText("searches", newId, "notes", str(input.notes)),
        stamp,
        stamp,
      );
    return this.getSearch(newId);
  }
  duplicateSearch(id: string): SavedSearch {
    const source = this.getSearch(id);
    return this.saveSearch({ ...source, name: `${source.name} — copie` });
  }
  private prospectRow(row: Row): Prospect {
    const id = str(row.id);
    return {
      id,
      linkedinUrl: this.protectedData.readText("prospects", id, "linkedin_url", row.linkedin_url),
      firstName: this.protectedData.readText("prospects", id, "first_name", row.first_name),
      lastName: this.protectedData.readText("prospects", id, "last_name", row.last_name),
      title: this.protectedData.readText("prospects", id, "title", row.title),
      company: this.protectedData.readText("prospects", id, "company", row.company),
      location: this.protectedData.readText("prospects", id, "location", row.location),
      school: this.protectedData.readText("prospects", id, "school", row.school),
      status: str(row.status) as Status,
      tags: json(this.protectedData.readText("prospects", id, "tags", row.tags), []),
      notes: this.protectedData.readText("prospects", id, "notes", row.notes),
      nextAction: this.protectedData.readText("prospects", id, "next_action", row.next_action),
      nextActionAt: str(row.next_action_at),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }
  listProspects(): Prospect[] {
    const people = this.all(
      "SELECT * FROM prospects ORDER BY updated_at DESC",
    ).map((row) => this.prospectRow(row));
    const sources = this.all(
      `SELECT ps.*, s.name AS search_name FROM prospect_sources ps JOIN searches s ON s.id=ps.search_id`,
    );
    const byProspect = new Map<string, Prospect["sources"]>();
    for (const row of sources) {
      const id = str(row.prospect_id);
      if (!byProspect.has(id)) byProspect.set(id, []);
      byProspect
        .get(id)!
        .push({
          searchId: str(row.search_id),
          searchName: this.protectedData.readText("searches", str(row.search_id), "name", row.search_name),
          filters: cleanFilters(json(this.protectedData.readText("prospect_sources", protectedRowId(id, str(row.search_id)), "filters", row.filters), EMPTY_FILTERS)),
          importedAt: str(row.imported_at),
        });
    }
    for (const person of people)
      person.sources = byProspect.get(person.id) || [];
    return people;
  }
  getProspect(id: string): Prospect {
    const row = this.one("SELECT * FROM prospects WHERE id=?", id);
    if (!row) throw new Error("Prospect introuvable.");
    const prospect = this.prospectRow(row);
    prospect.sources = this.all(
      `SELECT ps.*, s.name AS search_name FROM prospect_sources ps JOIN searches s ON s.id=ps.search_id WHERE ps.prospect_id=? ORDER BY ps.imported_at DESC`,
      id,
      ).map((source) => ({
      searchId: str(source.search_id),
        searchName: this.protectedData.readText("searches", str(source.search_id), "name", source.search_name),
        filters: cleanFilters(json(this.protectedData.readText("prospect_sources", protectedRowId(id, str(source.search_id)), "filters", source.filters), EMPTY_FILTERS)),
      importedAt: str(source.imported_at),
    }));
    prospect.events = this.all(
      "SELECT * FROM events WHERE prospect_id=? ORDER BY happened_at DESC, created_at DESC",
      id,
    ).map((e) => ({
      id: str(e.id),
      prospectId: id,
      kind: str(e.kind),
      detail: this.protectedData.readText("events", str(e.id), "detail", e.detail),
      happenedAt: str(e.happened_at),
      createdAt: str(e.created_at),
    }));
    prospect.messages = this.all(
      "SELECT * FROM messages WHERE prospect_id=? ORDER BY created_at DESC",
      id,
    ).map((m) => ({
      id: str(m.id),
      prospectId: id,
      kind: str(m.kind) as ActionKind,
      content: this.protectedData.readText("messages", str(m.id), "content", m.content),
      state: str(m.state) as "draft" | "sent",
      createdAt: str(m.created_at),
      sentAt: str(m.sent_at),
    }));
    return prospect;
  }
  possibleDuplicates(input: ProspectInput, exceptId = ""): Prospect[] {
    const key = samePersonKey(
      str(input.firstName),
      str(input.lastName),
      str(input.company),
    );
    if (key === "||" || !input.firstName || !input.lastName || !input.company)
      return [];
    return this.listProspects().filter(
      (p) =>
        p.id !== exceptId &&
        samePersonKey(p.firstName, p.lastName, p.company) === key,
    );
  }
  importProspects(searchId: string | undefined, items: ProspectInput[]) {
    if (searchId) this.getSearch(searchId);
    if (!Array.isArray(items) || items.length > 100)
      throw new Error("Import limité à 100 profils par opération.");
    return this.transaction(() => {
      const results: {
        prospect: Prospect;
        created: boolean;
        possibleDuplicates: Prospect[];
      }[] = [];
      for (const item of items) {
        const url = normalizeLinkedInUrl(str(item.linkedinUrl));
        const firstName = str(item.firstName),
          lastName = str(item.lastName);
        if (!url && !firstName && !lastName)
          throw new Error("Ajoutez une URL ou un nom pour chaque prospect.");
        const existing = url
          ? this.all("SELECT * FROM prospects").find((row) => this.prospectRow(row).linkedinUrl === url)
          : undefined;
        const possibleDuplicates = this.possibleDuplicates(
          item,
          existing ? str(existing.id) : "",
        );
        let id: string,
          created = false;
        if (existing) {
          id = str(existing.id);
          const old = this.prospectRow(existing);
          this.db
            .prepare(
              `UPDATE prospects SET first_name=?, last_name=?, title=?, company=?, location=?, school=?, updated_at=? WHERE id=?`,
            )
            .run(
              this.protectedData.writeText("prospects", id, "first_name", old.firstName || firstName),
              this.protectedData.writeText("prospects", id, "last_name", old.lastName || lastName),
              this.protectedData.writeText("prospects", id, "title", old.title || str(item.title)),
              this.protectedData.writeText("prospects", id, "company", old.company || str(item.company)),
              this.protectedData.writeText("prospects", id, "location", old.location || str(item.location)),
              this.protectedData.writeText("prospects", id, "school", old.school || str(item.school)),
              now(),
              id,
            );
        } else {
          id = randomUUID();
          created = true;
          const stamp = now();
          const status = isStatus(str(item.status))
            ? str(item.status)
            : "À examiner";
          this.db
            .prepare(
              `INSERT INTO prospects (id,linkedin_url,first_name,last_name,title,company,location,school,status,tags,notes,next_action,next_action_at,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              url ? this.protectedData.writeText("prospects", id, "linkedin_url", url) : null,
              this.protectedData.writeText("prospects", id, "first_name", firstName),
              this.protectedData.writeText("prospects", id, "last_name", lastName),
              this.protectedData.writeText("prospects", id, "title", str(item.title)),
              this.protectedData.writeText("prospects", id, "company", str(item.company)),
              this.protectedData.writeText("prospects", id, "location", str(item.location)),
              this.protectedData.writeText("prospects", id, "school", str(item.school)),
              status,
              this.protectedData.writeText("prospects", id, "tags", JSON.stringify(Array.isArray(item.tags) ? item.tags : [])),
              this.protectedData.writeText("prospects", id, "notes", str(item.notes)),
              this.protectedData.writeText("prospects", id, "next_action", str(item.nextAction)),
              str(item.nextActionAt),
              stamp,
              stamp,
            );
          this.event(id, "created", "Prospect ajouté");
        }
        if (searchId) {
          const search = this.getSearch(searchId);
          this.db
            .prepare("INSERT OR IGNORE INTO prospect_sources VALUES (?,?,?,?)")
            .run(id, searchId, this.protectedData.writeText("prospect_sources", protectedRowId(id, searchId), "filters", JSON.stringify(search.filters)), now());
          if (created)
            this.event(id, "source", `Trouvé via « ${search.name} »`);
        }
        results.push({
          prospect: this.getProspect(id),
          created,
          possibleDuplicates,
        });
      }
      return results;
    });
  }
  updateProspect(id: string, patch: Partial<Prospect>): Prospect {
    const old = this.getProspect(id);
    const url =
      patch.linkedinUrl === undefined
        ? old.linkedinUrl
        : normalizeLinkedInUrl(str(patch.linkedinUrl));
    if (url && this.all("SELECT * FROM prospects").some((row) => str(row.id) !== id && this.prospectRow(row).linkedinUrl === url))
      throw new Error("Cette URL LinkedIn est déjà associée à un prospect.");
    const status = patch.status === undefined ? old.status : str(patch.status);
    if (!isStatus(status)) throw new Error("Statut inconnu.");
    const tags = patch.tags === undefined ? old.tags : patch.tags;
    if (!Array.isArray(tags)) throw new Error("Tags invalides.");
    const next = {
      firstName: patch.firstName ?? old.firstName,
      lastName: patch.lastName ?? old.lastName,
      title: patch.title ?? old.title,
      company: patch.company ?? old.company,
      location: patch.location ?? old.location,
      school: patch.school ?? old.school,
      notes: patch.notes ?? old.notes,
      nextAction: patch.nextAction ?? old.nextAction,
      nextActionAt: patch.nextActionAt ?? old.nextActionAt,
    };
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE prospects SET linkedin_url=?,first_name=?,last_name=?,title=?,company=?,location=?,school=?,status=?,tags=?,notes=?,next_action=?,next_action_at=?,updated_at=? WHERE id=?`,
        )
        .run(
          url ? this.protectedData.writeText("prospects", id, "linkedin_url", url) : null,
          this.protectedData.writeText("prospects", id, "first_name", str(next.firstName)),
          this.protectedData.writeText("prospects", id, "last_name", str(next.lastName)),
          this.protectedData.writeText("prospects", id, "title", str(next.title)),
          this.protectedData.writeText("prospects", id, "company", str(next.company)),
          this.protectedData.writeText("prospects", id, "location", str(next.location)),
          this.protectedData.writeText("prospects", id, "school", str(next.school)),
          status,
          this.protectedData.writeText("prospects", id, "tags", JSON.stringify(tags.map(str).filter(Boolean))),
          this.protectedData.writeText("prospects", id, "notes", str(next.notes)),
          this.protectedData.writeText("prospects", id, "next_action", str(next.nextAction)),
          str(next.nextActionAt),
          now(),
          id,
        );
      if (status !== old.status)
        this.event(id, "status", `${old.status} → ${status}`);
      if (str(next.notes) !== old.notes)
        this.event(id, "note", str(next.notes) || "Note effacée");
      return this.getProspect(id);
    });
  }
  addManualEvent(
    id: string,
    kind: string,
    detail: string,
    happenedAt?: string,
    status?: string,
  ) {
    this.getProspect(id);
    const stamp = happenedAt ? new Date(happenedAt).toISOString() : now();
    if (stamp === "Invalid Date") throw new Error("Date invalide.");
    return this.transaction(() => {
      if (status) {
        if (!isStatus(status)) throw new Error("Statut inconnu.");
        const old = this.getProspect(id).status;
        this.db
          .prepare("UPDATE prospects SET status=?,updated_at=? WHERE id=?")
          .run(status, now(), id);
        if (status !== old)
          this.event(id, "status", `${old} → ${status}`, stamp);
      }
      this.event(id, kind || "manual", detail || "Mise à jour manuelle", stamp);
      return this.getProspect(id);
    });
  }
  listActivity() {
    return this.all(
      `SELECT e.*, p.first_name, p.last_name FROM events e JOIN prospects p ON p.id=e.prospect_id ORDER BY e.happened_at DESC, e.created_at DESC LIMIT 200`,
    ).map((e) => ({
      id: str(e.id),
      prospectId: str(e.prospect_id),
      kind: str(e.kind),
      detail: this.protectedData.readText("events", str(e.id), "detail", e.detail),
      happenedAt: str(e.happened_at),
      createdAt: str(e.created_at),
      prospectName: `${this.protectedData.readText("prospects", str(e.prospect_id), "first_name", e.first_name)} ${this.protectedData.readText("prospects", str(e.prospect_id), "last_name", e.last_name)}`.trim(),
    }));
  }
  getMetrics() {
    const prospects = this.listProspects();
    const inStages = (stages: string[]) =>
      prospects.filter((p) => stages.includes(p.status)).length;
    return {
      found: prospects.length,
      qualified: inStages(["Qualifié"]),
      invited: Number(
        this.one(
          "SELECT COUNT(DISTINCT prospect_id) AS total FROM messages WHERE kind='invitation' AND state='sent'",
        )?.total || 0,
      ),
      accepted: inStages([
        "Invitation acceptée",
        "Message de suivi à valider",
        "Message envoyé",
        "Réponse reçue",
        "Échange en cours",
        "Rendez-vous prévu",
        "Converti",
      ]),
      replies: inStages([
        "Réponse reçue",
        "Échange en cours",
        "Rendez-vous prévu",
        "Converti",
      ]),
      meetings: inStages(["Rendez-vous prévu", "Converti"]),
    };
  }
  private seedTemplates() {
    const stamp = now();
    const invitationId = randomUUID();
    this.db
      .prepare("INSERT INTO templates VALUES (?,?,?,?,?)")
      .run(
        invitationId,
        this.protectedData.writeText("templates", invitationId, "name", "Invitation courte"),
        "invitation",
        this.protectedData.writeText("templates", invitationId, "content", "Bonjour {prenom}, votre parcours en {poste} chez {entreprise} a retenu mon attention. Au plaisir d’échanger !"),
        stamp,
      );
    const followupId = randomUUID();
    this.db
      .prepare("INSERT INTO templates VALUES (?,?,?,?,?)")
      .run(
        followupId,
        this.protectedData.writeText("templates", followupId, "name", "Suivi après connexion"),
        "suivi",
        this.protectedData.writeText("templates", followupId, "content", "Bonjour {prenom}, merci pour la connexion. J’aimerais échanger avec vous au sujet de {entreprise}. Seriez-vous disponible pour un court échange ?"),
        stamp,
      );
  }
  listTemplates(): Template[] {
    return this.all("SELECT * FROM templates ORDER BY created_at").map((t) => ({
      id: str(t.id),
      name: this.protectedData.readText("templates", str(t.id), "name", t.name),
      kind: str(t.kind) as ActionKind,
      content: this.protectedData.readText("templates", str(t.id), "content", t.content),
      createdAt: str(t.created_at),
    }));
  }
  saveTemplate(
    input: Pick<Template, "name" | "kind" | "content">,
    id?: string,
  ): Template {
    if (
      !str(input.name) ||
      !str(input.content) ||
      !["invitation", "suivi"].includes(input.kind)
    )
      throw new Error("Modèle incomplet.");
    if (id) {
      if (!this.one("SELECT 1 FROM templates WHERE id=?", id))
        throw new Error("Modèle introuvable.");
      this.db
        .prepare("UPDATE templates SET name=?,kind=?,content=? WHERE id=?")
        .run(
          this.protectedData.writeText("templates", id, "name", str(input.name)), input.kind,
          this.protectedData.writeText("templates", id, "content", input.content), id,
        );
    } else {
      id = randomUUID();
      this.db
        .prepare("INSERT INTO templates VALUES (?,?,?,?,?)")
        .run(id, this.protectedData.writeText("templates", id, "name", str(input.name)), input.kind,
          this.protectedData.writeText("templates", id, "content", input.content), now());
    }
    return this.listTemplates().find((t) => t.id === id)!;
  }
  createDraft(prospectId: string, templateId: string) {
    const prospect = this.getProspect(prospectId);
    const template = this.listTemplates().find((t) => t.id === templateId);
    if (!template) throw new Error("Modèle introuvable.");
    const content = renderTemplate(template.content, prospect);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)")
      .run(id, prospectId, template.kind, this.protectedData.writeText("messages", id, "content", content), "draft", now(), "");
    this.event(prospectId, "draft", `Brouillon ${template.kind} créé`);
    if (
      template.kind === "invitation" &&
      ["À examiner", "Qualifié"].includes(prospect.status)
    )
      this.updateProspect(prospectId, { status: "Brouillon à valider" });
    return this.getProspect(prospectId).messages!.find((m) => m.id === id)!;
  }
  updateDraft(messageId: string, content: string) {
    const message = this.one("SELECT * FROM messages WHERE id=?", messageId);
    if (!message || message.state !== "draft")
      throw new Error("Seuls les brouillons peuvent être modifiés.");
    if (
      this.one(
        "SELECT 1 FROM queue WHERE message_id=? AND state IN ('pending','open','uncertain')",
        messageId,
      )
    )
      throw new Error("Retirez ce brouillon de la file avant de le modifier.");
    if (!content.trim()) throw new Error("Le message ne peut pas être vide.");
    this.db
      .prepare("UPDATE messages SET content=? WHERE id=?")
      .run(this.protectedData.writeText("messages", messageId, "content", content), messageId);
    return this.getProspect(str(message.prospect_id)).messages!.find(
      (m) => m.id === messageId,
    )!;
  }
  getSettings() {
    const rows = Object.fromEntries(
      this.all("SELECT * FROM settings").map((row) => [
        str(row.key),
        str(row.value),
      ]),
    );
    return {
      invitationLimit: Math.max(1, Number(rows.invitation_limit || 10)),
      queuePaused: rows.queue_paused === "1",
      invitationsToday: this.invitationsToday(),
    };
  }
  setSetting(key: "invitation_limit" | "queue_paused", value: string) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  setInvitationLimit(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 100)
      throw new Error("Choisissez une limite entre 1 et 100.");
    this.setSetting("invitation_limit", String(value));
    return this.getSettings();
  }
  invitationsToday(): number {
    return Number(
      this.one(
        "SELECT COUNT(*) AS total FROM messages WHERE kind='invitation' AND state='sent' AND substr(sent_at,1,10)=?",
        localDay(),
      )?.total || 0,
    );
  }
  private invitationBlock(prospectId: string, excludeQueueId = ""): string {
    const p = this.getProspect(prospectId);
    if (!p.linkedinUrl)
      return "Ajoutez une URL de profil LinkedIn avant une invitation.";
    if (p.status === "À ne pas contacter" || p.status === "Sans suite")
      return "Ce prospect est marqué comme non contactable.";
    if (
      [
        "Invitation envoyée",
        "Invitation acceptée",
        "Message de suivi à valider",
        "Message envoyé",
        "Réponse reçue",
        "Échange en cours",
        "Rendez-vous prévu",
        "Converti",
      ].includes(p.status)
    )
      return "Ce prospect est déjà invité ou connecté.";
    if (
      this.one(
        "SELECT 1 FROM messages WHERE prospect_id=? AND kind='invitation' AND state='sent'",
        prospectId,
      )
    )
      return "Une invitation a déjà été confirmée pour ce prospect.";
    if (
      this.one(
        "SELECT 1 FROM events WHERE prospect_id=? AND kind='invitation_sent'",
        prospectId,
      )
    )
      return "L’historique contient déjà une invitation envoyée.";
    if (
      this.one(
        "SELECT 1 FROM queue WHERE prospect_id=? AND kind='invitation' AND state IN ('pending','open','uncertain') AND id<>?",
        prospectId,
        excludeQueueId,
      )
    )
      return "Une invitation est déjà en attente ou incertaine.";
    return "";
  }
  private followupBlock(prospectId: string): string {
    const prospect = this.getProspect(prospectId);
    if (!prospect.linkedinUrl) return "Ajoutez une URL de profil LinkedIn.";
    if (
      prospect.status === "À ne pas contacter" ||
      prospect.status === "Sans suite"
    )
      return "Ce prospect est marqué comme non contactable.";
    if (
      this.one(
        "SELECT 1 FROM queue WHERE prospect_id=? AND kind='invitation' AND state IN ('pending','open','uncertain')",
        prospectId,
      )
    )
      return "Une invitation est encore en attente ou incertaine.";
    if (
      ![
        "Invitation acceptée",
        "Message de suivi à valider",
        "Message envoyé",
        "Réponse reçue",
        "Échange en cours",
        "Rendez-vous prévu",
        "Converti",
      ].includes(prospect.status)
    )
      return "Confirmez d’abord la connexion avant un message de suivi.";
    return "";
  }
  queueDraft(messageId: string): QueueItem {
    const message = this.one("SELECT * FROM messages WHERE id=?", messageId);
    if (!message || message.state !== "draft")
      throw new Error("Brouillon introuvable.");
    const messageContent = this.protectedData.readText("messages", messageId, "content", message.content);
    if (
      /\{(?:prenom|nom|poste|entreprise|ecole|localisation)\}/i.test(
        messageContent,
      )
    )
      throw new Error(
        "Complétez les variables manquantes dans le brouillon avant de le placer dans la file.",
      );
    if (
      this.one(
        "SELECT 1 FROM queue WHERE message_id=? AND state IN ('pending','open','uncertain')",
        messageId,
      )
    )
      throw new Error("Ce brouillon est déjà dans la file.");
    const prospectId = str(message.prospect_id),
      kind = str(message.kind);
    const prospect = this.getProspect(prospectId);
    if (!prospect.linkedinUrl)
      throw new Error("Ajoutez une URL de profil LinkedIn.");
    if (prospect.status === "À ne pas contacter")
      throw new Error("Prospect à ne pas contacter.");
    if (kind === "invitation") {
      const block = this.invitationBlock(prospectId);
      if (block) throw new Error(block);
      if (this.invitationsToday() >= this.getSettings().invitationLimit)
        throw new Error("Limite quotidienne d’invitations atteinte.");
    } else {
      const block = this.followupBlock(prospectId);
      if (block) throw new Error(block);
    }
    const id = randomUUID(),
      stamp = now();
    this.db
      .prepare("INSERT INTO queue VALUES (?,?,?,?,?,?,?,?)")
      .run(id, prospectId, messageId, kind, "pending", this.protectedData.writeText("queue", id, "error", ""), stamp, stamp);
    this.updateProspect(prospectId, {
      status:
        kind === "invitation"
          ? "Invitation prête"
          : "Message de suivi à valider",
    });
    return this.getQueueItem(id);
  }
  listQueue(): QueueItem[] {
    return this.all(
      `SELECT q.*, m.content, p.first_name, p.last_name, p.linkedin_url FROM queue q
      JOIN messages m ON m.id=q.message_id JOIN prospects p ON p.id=q.prospect_id ORDER BY q.created_at DESC`,
    ).map((row) => ({
      id: str(row.id),
      prospectId: str(row.prospect_id),
      prospectName: `${this.protectedData.readText("prospects", str(row.prospect_id), "first_name", row.first_name)} ${this.protectedData.readText("prospects", str(row.prospect_id), "last_name", row.last_name)}`.trim(),
      linkedinUrl: this.protectedData.readText("prospects", str(row.prospect_id), "linkedin_url", row.linkedin_url),
      messageId: str(row.message_id),
      kind: str(row.kind) as ActionKind,
      content: this.protectedData.readText("messages", str(row.message_id), "content", row.content),
      state: str(row.state) as QueueItem["state"],
      error: this.protectedData.readText("queue", str(row.id), "error", row.error),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    }));
  }
  getQueueItem(id: string): QueueItem {
    const item = this.listQueue().find((q) => q.id === id);
    if (!item) throw new Error("Action introuvable.");
    return item;
  }
  openQueue(id: string) {
    const item = this.getQueueItem(id);
    if (this.getSettings().queuePaused)
      throw new Error("La file est en pause.");
    if (!["pending", "open"].includes(item.state))
      throw new Error("Cette action ne peut plus être ouverte.");
    if (item.kind === "invitation") {
      const block = this.invitationBlock(item.prospectId, id);
      if (block) throw new Error(block);
    } else {
      const block = this.followupBlock(item.prospectId);
      if (block) throw new Error(block);
    }
    this.db
      .prepare("UPDATE queue SET state='open',updated_at=? WHERE id=?")
      .run(now(), id);
    return this.getQueueItem(id);
  }
  confirmQueue(id: string) {
    const item = this.getQueueItem(id);
    if (!["open", "uncertain"].includes(item.state))
      throw new Error(
        "Ouvrez le profil et vérifiez l’envoi avant de confirmer.",
      );
    if (item.kind === "invitation") {
      const block = this.invitationBlock(item.prospectId, id);
      if (block) throw new Error(block);
      if (this.invitationsToday() >= this.getSettings().invitationLimit)
        throw new Error("Limite quotidienne d’invitations atteinte.");
    } else {
      const block = this.followupBlock(item.prospectId);
      if (block) throw new Error(block);
    }
    return this.transaction(() => {
      const sentAt = `${localDay()}T${new Date().toTimeString().slice(0, 8)}`;
      this.db
        .prepare(
          "UPDATE messages SET state='sent',sent_at=? WHERE id=? AND state='draft'",
        )
        .run(sentAt, item.messageId);
      this.db
        .prepare(
          "UPDATE queue SET state='sent',error=?,updated_at=? WHERE id=?",
        )
        .run(this.protectedData.writeText("queue", id, "error", ""), now(), id);
      const status =
        item.kind === "invitation" ? "Invitation envoyée" : "Message envoyé";
      const old = this.getProspect(item.prospectId).status;
      this.db
        .prepare("UPDATE prospects SET status=?,updated_at=? WHERE id=?")
        .run(status, now(), item.prospectId);
      if (old !== status)
        this.event(item.prospectId, "status", `${old} → ${status}`);
      this.event(
        item.prospectId,
        item.kind === "invitation" ? "invitation_sent" : "message_sent",
        `Envoi confirmé manuellement : ${item.content}`,
      );
      if (
        item.state === "uncertain" &&
        !this.one("SELECT 1 FROM queue WHERE state='uncertain' AND id<>?", id)
      )
        this.setSetting("queue_paused", "0");
      return this.getQueueItem(id);
    });
  }
  markUncertain(id: string, reason: string) {
    const item = this.getQueueItem(id);
    if (!["pending", "open"].includes(item.state))
      throw new Error("Action déjà terminée.");
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE queue SET state='uncertain',error=?,updated_at=? WHERE id=?",
        )
        .run(this.protectedData.writeText("queue", id, "error", reason || "Résultat incertain"), now(), id);
      this.setSetting("queue_paused", "1");
      this.event(
        item.prospectId,
        "uncertain",
        `Envoi à vérifier : ${reason || "résultat incertain"}`,
      );
      return this.getQueueItem(id);
    });
  }
  cancelQueue(id: string, verifiedNotSent = false) {
    const item = this.getQueueItem(id);
    if (!["pending", "open", "uncertain"].includes(item.state))
      throw new Error("Action déjà terminée.");
    if (item.state !== "pending" && !verifiedNotSent)
      throw new Error(
        "Vérifiez d’abord sur LinkedIn que le message n’est pas parti.",
      );
    return this.transaction(() => {
      this.db
        .prepare("UPDATE queue SET state='cancelled',updated_at=? WHERE id=?")
        .run(now(), id);
      this.event(
        item.prospectId,
        "queue_cancelled",
        verifiedNotSent
          ? "Action vérifiée non envoyée puis annulée"
          : "Action annulée",
      );
      if (
        item.state === "uncertain" &&
        !this.one("SELECT 1 FROM queue WHERE state='uncertain' AND id<>?", id)
      )
        this.setSetting("queue_paused", "0");
      return this.getQueueItem(id);
    });
  }
  pauseQueue(paused: boolean) {
    if (!paused && this.one("SELECT 1 FROM queue WHERE state='uncertain'"))
      throw new Error("Résolvez les envois incertains avant de reprendre.");
    this.setSetting("queue_paused", paused ? "1" : "0");
    return this.getSettings();
  }
  seedDemo() {
    if (this.one("SELECT 1 FROM prospects LIMIT 1")) return;
    const cto = this.saveSearch({
      name: "CTO — France",
      filters: cleanFilters({ titles: ["CTO"], locations: ["France"] }),
      linkedinUrl: "",
      notes: "Exemple fictif",
    });
    const data = this.saveSearch({
      name: "Data Engineer — international",
      filters: cleanFilters({
        titles: ["Data Engineer"],
        locations: ["Europe", "Canada"],
      }),
      linkedinUrl: "",
      notes: "Exemple fictif",
    });
    const prospects = [
      {
        firstName: "Camille",
        lastName: "Moreau",
        title: "CTO",
        company: "Atelier Nuage",
        location: "Paris",
        linkedinUrl: "https://www.linkedin.com/in/demo-camille-moreau/",
      },
      {
        firstName: "Noah",
        lastName: "Leroy",
        title: "Directeur technique",
        company: "FictionLab",
        location: "Lyon",
        linkedinUrl: "https://www.linkedin.com/in/demo-noah-leroy/",
      },
      {
        firstName: "Inès",
        lastName: "Bernard",
        title: "Data Engineer",
        company: "SampleWorks",
        location: "Montréal",
        linkedinUrl: "https://www.linkedin.com/in/demo-ines-bernard/",
      },
      {
        firstName: "Alex",
        lastName: "Petit",
        title: "Data Engineer",
        company: "Studio Démo",
        location: "Berlin",
        linkedinUrl: "https://www.linkedin.com/in/demo-alex-petit/",
      },
    ];
    const a = this.importProspects(cto.id, prospects.slice(0, 2));
    const b = this.importProspects(data.id, prospects.slice(2));
    this.updateProspect(a[0].prospect.id, {
      status: "Qualifié",
      tags: ["tech", "France"],
      nextAction: "Préparer une invitation",
      nextActionAt: new Date().toISOString().slice(0, 10),
    });
    // Historique synthétique pour illustrer le parcours, sans navigateur ni envoi réel.
    const demoDraft = this.createDraft(
      a[1].prospect.id,
      this.listTemplates().find((template) => template.kind === "invitation")!.id,
    );
    const demoQueue = this.queueDraft(demoDraft.id);
    this.openQueue(demoQueue.id);
    this.confirmQueue(demoQueue.id);
    this.updateProspect(a[1].prospect.id, {
      status: "Invitation acceptée",
      tags: ["CTO"],
      notes: "Exemple de suivi manuel.",
    });
    this.updateProspect(b[0].prospect.id, {
      status: "Réponse reçue",
      tags: ["data", "Canada"],
    });
    this.updateProspect(b[1].prospect.id, {
      status: "À examiner",
      tags: ["data"],
    });
  }
}
