import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export class DataProtectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataProtectionError";
  }
}

type ProtectedKind = "text" | "blob";
interface ProtectedField { name: string; kind?: ProtectedKind; }
interface ProtectedTable { table: string; id: string | string[]; fields: ProtectedField[]; }
export interface ProtectedScope { name: string; tables: ProtectedTable[]; }
type SerializableDatabase = DatabaseSync & { serialize(): Buffer; deserialize(input: Uint8Array): void };

export function serializeDatabase(db: DatabaseSync): Buffer {
  return Buffer.from((db as SerializableDatabase).serialize());
}

export function deserializeDatabase(db: DatabaseSync, input: Uint8Array): void {
  (db as SerializableDatabase).deserialize(input);
}

export function protectedRowId(...parts: string[]): string {
  return parts.join("\0");
}

const PORTABLE_SCHEMA: Record<string, string[]> = {
  searches: ["id", "name", "filters", "linkedin_url", "notes", "created_at", "updated_at"],
  prospects: ["id", "linkedin_url", "first_name", "last_name", "title", "company", "location", "school", "status", "tags", "notes", "next_action", "next_action_at", "created_at", "updated_at"],
  prospect_sources: ["prospect_id", "search_id", "filters", "imported_at"],
  events: ["id", "prospect_id", "kind", "detail", "happened_at", "created_at"],
  templates: ["id", "name", "kind", "content", "created_at"],
  messages: ["id", "prospect_id", "kind", "content", "state", "created_at", "sent_at"],
  queue: ["id", "prospect_id", "message_id", "kind", "state", "error", "created_at", "updated_at"],
  settings: ["key", "value"],
  career_profile: ["id", "value"],
  career_resumes: ["id", "name", "filename", "mime", "size", "sha256", "bytes", "created_at"],
  career_jobs: ["id", "url", "title", "company", "location", "description", "source_url", "discovered_at", "updated_at"],
  career_applications: ["id", "job_id", "resume_id", "prospect_id", "state", "outcome", "answers", "missing_fields", "notes", "next_action_at", "last_error", "receipt", "created_at", "updated_at", "submitted_at"],
  career_events: ["id", "application_id", "kind", "detail", "source", "happened_at"],
  career_vault: ["id", "version", "salt", "nonce", "ciphertext", "tag"],
  career_credentials: ["id", "origin", "label", "username", "nonce", "ciphertext", "tag", "updated_at"],
  career_ai_settings: ["id", "base_url", "model", "nonce", "ciphertext", "tag", "updated_at"],
  career_france_travail: ["id", "nonce", "ciphertext", "tag", "updated_at"],
  career_campaigns: ["id", "idempotency_key", "resume_id", "credential_id", "expected_job_ids", "max_submissions", "state", "start_requested", "created_at", "updated_at"],
  career_campaign_items: ["id", "campaign_id", "application_id", "job_id", "state", "error", "created_at", "updated_at"],
  anima_data_protection: ["scope", "version", "verifier"],
};
const PORTABLE_REQUIRED_TABLES = Object.keys(PORTABLE_SCHEMA).filter(name => name !== "anima_data_protection");
const LEGACY_REQUIRED_TABLES = ["searches", "prospects", "events", "messages", "queue"];
const LEGACY_CAMPAIGN_OPTIONAL_COLUMNS = new Set(["idempotency_key", "credential_id", "expected_job_ids", "start_requested"]);
const PORTABLE_INDEXES: Record<string, { table: string; sql: string }> = {
  idx_events_prospect: { table: "events", sql: "CREATE INDEX idx_events_prospect ON events(prospect_id, happened_at DESC)" },
  idx_queue_state: { table: "queue", sql: "CREATE INDEX idx_queue_state ON queue(state, created_at)" },
  idx_prospects_status: { table: "prospects", sql: "CREATE INDEX idx_prospects_status ON prospects(status)" },
  career_events_by_application: { table: "career_events", sql: "CREATE INDEX career_events_by_application ON career_events(application_id,happened_at DESC)" },
  career_campaign_items_order: { table: "career_campaign_items", sql: "CREATE INDEX career_campaign_items_order ON career_campaign_items(campaign_id,state,created_at)" },
  career_campaigns_idempotency: { table: "career_campaigns", sql: "CREATE UNIQUE INDEX career_campaigns_idempotency ON career_campaigns(idempotency_key) WHERE idempotency_key<>''" },
};

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/["`]/g, "").replace(/\s+/g, "").replace(/;$/, "");
}

/** Strictly inspect an imported SQLite image before applying any schema or data migrations. */
export function validatePortableDatabase(db: DatabaseSync, options: { legacy?: boolean } = {}): void {
  db.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;");
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const tableNames = new Set(objects.filter(item => item.type === "table").map(item => item.name));
  for (const name of options.legacy ? LEGACY_REQUIRED_TABLES : PORTABLE_REQUIRED_TABLES) {
    if (!tableNames.has(name)) throw new DataProtectionError("Sauvegarde incomplète : table requise absente (" + name + ").");
  }
  for (const object of objects) {
    if (object.type === "table") {
      const expected = PORTABLE_SCHEMA[object.name];
      if (!expected) throw new DataProtectionError("Sauvegarde refusée : table SQLite inattendue (" + object.name + ").");
      const columns = (db.prepare("PRAGMA table_info(" + quote(object.name) + ")").all() as { name: string }[]).map(column => column.name).sort();
      const legacyCampaign = options.legacy && object.name === "career_campaigns";
      const expectedColumns = legacyCampaign ? expected.filter(column => !LEGACY_CAMPAIGN_OPTIONAL_COLUMNS.has(column)) : expected;
      const compatibleLegacyCampaign = legacyCampaign && columns.every(column => expected.includes(column)) && expectedColumns.every(column => columns.includes(column));
      if (!compatibleLegacyCampaign && columns.join("\0") !== [...expected].sort().join("\0"))
        throw new DataProtectionError("Sauvegarde refusée : schéma non pris en charge pour " + object.name + ".");
    } else if (object.type === "index") {
      const expected = PORTABLE_INDEXES[object.name];
      if (!expected || object.tbl_name !== expected.table || !object.sql || normalizeSql(object.sql) !== normalizeSql(expected.sql))
        throw new DataProtectionError("Sauvegarde refusée : index SQLite inattendu ou altéré (" + object.name + ").");
    } else {
      throw new DataProtectionError("Sauvegarde refusée : objet SQLite inattendu (" + object.type + ").");
    }
  }
  const integrity = db.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
  if (!integrity.length || integrity.some(row => String(row.quick_check).toLowerCase() !== "ok"))
    throw new DataProtectionError("Sauvegarde SQLite corrompue (quick_check).");
  if ((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length)
    throw new DataProtectionError("Sauvegarde SQLite incohérente : références de lignes invalides.");
}

const TEXT_PREFIX = "anima-protected:v1:";
const BLOB_MAGIC = Buffer.from([0x41, 0x4e, 0x49, 0x4d, 0x41, 0x50, 0x31, 0x00]);
const BACKUP_MAGIC = Buffer.from("ANIMABK1", "ascii");
const BACKUP_VERSION = 1;
const BACKUP_HEADER_BYTES = 8 + 1 + 16 + 12 + 16;
const BACKUP_AAD_PREFIX = Buffer.from("Anima Connect portable backup", "utf8");
const DATA_FORMAT_VERSION = 1;
const VERIFIER = "Anima Connect local-data key check v1";

export const PROTECTED_SCOPES: ProtectedScope[] = [
  {
    name: "crm",
    tables: [
      { table: "searches", id: "id", fields: [{ name: "name" }, { name: "filters" }, { name: "linkedin_url" }, { name: "notes" }] },
      { table: "prospects", id: "id", fields: [{ name: "linkedin_url" }, { name: "first_name" }, { name: "last_name" }, { name: "title" }, { name: "company" }, { name: "location" }, { name: "school" }, { name: "tags" }, { name: "notes" }, { name: "next_action" }] },
      { table: "prospect_sources", id: ["prospect_id", "search_id"], fields: [{ name: "filters" }] },

      { table: "events", id: "id", fields: [{ name: "detail" }] },
      { table: "templates", id: "id", fields: [{ name: "name" }, { name: "content" }] },
      { table: "messages", id: "id", fields: [{ name: "content" }] },
      { table: "queue", id: "id", fields: [{ name: "error" }] },
    ],
  },
  {
    name: "career",
    tables: [
      { table: "career_profile", id: "id", fields: [{ name: "value" }] },
      { table: "career_resumes", id: "id", fields: [{ name: "name" }, { name: "filename" }, { name: "mime" }, { name: "sha256" }, { name: "bytes", kind: "blob" }] },
      { table: "career_applications", id: "id", fields: [{ name: "outcome" }, { name: "answers" }, { name: "missing_fields" }, { name: "notes" }, { name: "last_error" }, { name: "receipt" }] },
      { table: "career_events", id: "id", fields: [{ name: "detail" }] },
    ],
  },
  {
    name: "vault",
    tables: [
      { table: "career_credentials", id: "id", fields: [{ name: "origin" }, { name: "label" }, { name: "username" }] },
    ],
  },
  {
    name: "campaign",
    tables: [
      { table: "career_campaign_items", id: "id", fields: [{ name: "error" }] },
    ],
  },
];

function aad(table: string, id: string, column: string): Buffer {
  return Buffer.from("anima-local-data:v" + DATA_FORMAT_VERSION + ":" + table + ":" + id + ":" + column, "utf8");
}

function seal(key: Buffer, associatedData: Buffer, plain: Buffer): Buffer {
  if (key.length !== 32) throw new DataProtectionError("Clé locale invalide.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}

function open(key: Buffer, associatedData: Buffer, envelope: Buffer): Buffer {
  if (key.length !== 32 || envelope.length < 28)
    throw new DataProtectionError("Donnée locale chiffrée invalide ou tronquée.");
  const nonce = envelope.subarray(0, 12);
  const tag = envelope.subarray(12, 28);
  const encrypted = envelope.subarray(28);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(associatedData);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new DataProtectionError("La clé locale est incorrecte ou les données ont été altérées.");
  }
}

export function isProtectedText(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(TEXT_PREFIX);
}

export function isProtectedBlob(value: unknown): boolean {
  return (Buffer.isBuffer(value) || value instanceof Uint8Array) &&
    Buffer.from(value).subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC);
}

export function protectText(key: Buffer, table: string, rowId: string, column: string, value: string): string {
  if (isProtectedText(value))
    throw new DataProtectionError("La valeur " + table + "." + column + " est déjà chiffrée.");
  const encrypted = seal(key, aad(table, rowId, column), Buffer.from(value, "utf8"));
  return TEXT_PREFIX + encrypted.toString("base64");
}

export function revealText(key: Buffer, table: string, rowId: string, column: string, value: unknown): string {
  if (typeof value !== "string" || !isProtectedText(value))
    throw new DataProtectionError("La valeur " + table + "." + column + " n’est pas chiffrée comme attendu.");
  const encoded = value.slice(TEXT_PREFIX.length);
  const encrypted = Buffer.from(encoded, "base64");
  if (encrypted.toString("base64") !== encoded)
    throw new DataProtectionError("La valeur " + table + "." + column + " est corrompue.");
  return open(key, aad(table, rowId, column), encrypted).toString("utf8");
}

export function protectBlob(key: Buffer, table: string, rowId: string, column: string, value: Buffer): Buffer {
  if (isProtectedBlob(value))
    throw new DataProtectionError("La valeur binaire " + table + "." + column + " est déjà chiffrée.");
  return Buffer.concat([BLOB_MAGIC, seal(key, aad(table, rowId, column), value)]);
}

export function revealBlob(key: Buffer, table: string, rowId: string, column: string, value: unknown): Buffer {
  if (!isProtectedBlob(value))
    throw new DataProtectionError("La valeur binaire " + table + "." + column + " n’est pas chiffrée comme attendu.");
  return open(key, aad(table, rowId, column), Buffer.from(value as Uint8Array).subarray(BLOB_MAGIC.length));
}

export class LocalDataProtector {
  readonly key?: Buffer;
  constructor(key?: Buffer) {
    if (key && key.length !== 32) throw new DataProtectionError("Clé locale invalide.");
    this.key = key;
  }

  writeText(table: string, rowId: string, column: string, value: string): string {
    return this.key ? protectText(this.key, table, rowId, column, value) : value;
  }

  readText(table: string, rowId: string, column: string, value: unknown): string {
    if (value == null) return "";
    if (this.key) return revealText(this.key, table, rowId, column, value);
    if (isProtectedText(value)) throw new DataProtectionError("Cette base est chiffrée et doit être ouverte par Anima Connect sur son compte Windows d’origine.");
    return String(value ?? "");
  }

  writeBlob(table: string, rowId: string, column: string, value: Buffer): Buffer {
    return this.key ? protectBlob(this.key, table, rowId, column, value) : value;
  }

  readBlob(table: string, rowId: string, column: string, value: unknown): Buffer {
    if (this.key) return revealBlob(this.key, table, rowId, column, value);
    if (isProtectedBlob(value)) throw new DataProtectionError("Cette base est chiffrée et doit être ouverte par Anima Connect sur son compte Windows d’origine.");
    return Buffer.from(value as Uint8Array);
  }
}

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier))
    throw new DataProtectionError("Nom de colonne interne invalide.");
  return '"' + identifier + '"';
}
function idColumns(table: ProtectedTable): string[] {
  return Array.isArray(table.id) ? table.id : [table.id];
}
function rowId(table: ProtectedTable, row: Record<string, unknown>): string {
  return protectedRowId(...idColumns(table).map(column => String(row[column])));
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function protectedValue(
  key: Buffer,
  scope: ProtectedScope,
  table: ProtectedTable,
  rowId: string,
  field: ProtectedField,
  value: unknown,
  reverse: boolean,
): string | Buffer {
  const kind = field.kind ?? "text";
  if (kind === "blob") {
    const bytes = Buffer.from(value as Uint8Array);
    return reverse
      ? revealBlob(key, table.table, rowId, field.name, bytes)
      : protectBlob(key, table.table, rowId, field.name, bytes);
  }
  const text = String(value);
  return reverse
    ? revealText(key, table.table, rowId, field.name, text)
    : protectText(key, table.table, rowId, field.name, text);
}

function dataMarker(db: DatabaseSync, scope: string): Record<string, unknown> | undefined {
  if (!tableExists(db, "anima_data_protection")) return undefined;
  return db.prepare("SELECT scope,version,verifier FROM anima_data_protection WHERE scope=?").get(scope) as Record<string, unknown> | undefined;
}

function verifyKey(key: Buffer, scope: string, marker: Record<string, unknown>): void {
  if (Number(marker.version) !== DATA_FORMAT_VERSION)
    throw new DataProtectionError("Version de chiffrement inconnue pour les données " + scope + ".");
  try {
    const value = revealText(key, "anima_data_protection", scope, "verifier", marker.verifier);
    if (value !== VERIFIER) throw new Error("invalid verifier");
  } catch {
    throw new DataProtectionError("La clé locale est incorrecte ou les données ont été altérées. Restaurez une sauvegarde chiffrée.");
  }
}

/** Repair the one released schema-ordering bug before normal protection validation. */
export function repairCareerApplicationLastErrorLayout(db: DatabaseSync, key?: Buffer): void {
  const marker = dataMarker(db, "career");
  if (!marker || !tableExists(db, "career_applications")) return;
  if (!key) throw new DataProtectionError("La base contient des données chiffrées; l’ouverture sans sa clé est refusée.");
  verifyKey(key, "career", marker);
  const rows = db.prepare("SELECT id,next_action_at,last_error FROM career_applications").all() as { id: string; next_action_at: unknown; last_error: unknown }[];
  const candidates = rows.filter(row => isProtectedText(row.next_action_at));
  if (!candidates.length) return;

  // Decode and validate every candidate before beginning the write transaction, so
  // one unrelated or corrupted value cannot leave a partially repaired database.
  const repairs = candidates.map(row => {
    const id = String(row.id);
    const displacedError = revealText(key, "career_applications", id, "last_error", row.next_action_at);
    if (displacedError !== "")
      throw new DataProtectionError("Valeur de relance chiffrée inattendue; la base n’a pas été modifiée.");
    let lastError: string;
    if (row.last_error === "" || row.last_error == null) {
      lastError = protectText(key, "career_applications", id, "last_error", "");
    } else if (isProtectedText(row.last_error)) {
      // A later status update may already have replaced the initial empty error.
      revealText(key, "career_applications", id, "last_error", row.last_error);
      lastError = String(row.last_error);
    } else {
      throw new DataProtectionError("Valeur d’erreur inattendue; la base n’a pas été modifiée.");
    }
    return { id, lastError, oldNextActionAt: String(row.next_action_at) };
  });

  db.exec("PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
  try {
    const update = db.prepare("UPDATE career_applications SET next_action_at='',last_error=? WHERE id=? AND next_action_at=?");
    for (const repair of repairs) update.run(repair.lastError, repair.id, repair.oldNextActionAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  cleanupPlaintextResidue(db);
}

function containsProtectedValues(db: DatabaseSync, tables: ProtectedTable[]): boolean {
  for (const table of tables) {
    if (!tableExists(db, table.table)) continue;
    const columns = table.fields.map(field => quote(field.name)).join(",");
    const ids = idColumns(table).map(quote).join(",");
    const rows = db.prepare("SELECT " + ids + "," + columns + " FROM " + quote(table.table)).all() as Record<string, unknown>[];
    for (const row of rows) {
      for (const field of table.fields) {
        const value = row[field.name];
        if (value == null) continue;
        if (field.kind === "blob" ? isProtectedBlob(value) : isProtectedText(value)) return true;
      }
    }
  }
  return false;
}

function assertScopesDoNotContainProtectedValues(db: DatabaseSync, scopes: ProtectedScope[]): void {
  for (const scope of scopes) {
    if (dataMarker(db, scope.name))
      throw new DataProtectionError("Cette base contient des données chiffrées; aucune lecture en clair ne sera tentée.");
    if (containsProtectedValues(db, scope.tables))
      throw new DataProtectionError("Données chiffrées sans marqueur de version. La base est refusée pour éviter toute lecture ou migration ambiguë.");
  }
}

function cleanupPlaintextResidue(db: DatabaseSync): void {
  db.exec("PRAGMA secure_delete=ON;");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.exec("VACUUM;");
}

function assertScopeEncrypted(db: DatabaseSync, scope: ProtectedScope): void {
  for (const table of scope.tables) {
    if (!tableExists(db, table.table)) continue;
    const columns = table.fields.map(field => quote(field.name)).join(",");
    const ids = idColumns(table).map(quote).join(",");
    const rows = db.prepare("SELECT " + ids + "," + columns + " FROM " + quote(table.table)).all() as Record<string, unknown>[];
    for (const row of rows) {
      for (const field of table.fields) {
        const value = row[field.name];
        if (value == null) continue;
        if (field.kind === "blob" ? !isProtectedBlob(value) : !isProtectedText(value))
          throw new DataProtectionError("La base contient une valeur non chiffrée dans " + table.table + "." + field.name + "; elle est refusée.");
      }
    }
  }
}

export function ensureProtectedScope(db: DatabaseSync, scope: ProtectedScope, key?: Buffer): void {
  const existing = dataMarker(db, scope.name);
  if (!key) {
    if (existing || containsProtectedValues(db, scope.tables))
      throw new DataProtectionError("Cette base est chiffrée; l’ouverture sans sa clé est refusée.");
    return;
  }
  if (key.length !== 32) throw new DataProtectionError("Clé locale invalide.");
  db.exec("CREATE TABLE IF NOT EXISTS anima_data_protection(scope TEXT PRIMARY KEY, version INTEGER NOT NULL, verifier TEXT NOT NULL)");
  const marker = dataMarker(db, scope.name);
  if (marker) {
    verifyKey(key, scope.name, marker);
    assertScopeEncrypted(db, scope);
    return;
  }
  if (containsProtectedValues(db, scope.tables))
    throw new DataProtectionError("Les données " + scope.name + " contiennent un chiffrement sans migration enregistrée.");
  db.exec("PRAGMA secure_delete=ON;");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of scope.tables) {
      if (!tableExists(db, table.table)) continue;
      const columns = table.fields.map(field => quote(field.name)).join(",");
      const ids = idColumns(table);
      const rows = db.prepare("SELECT " + ids.map(quote).join(",") + "," + columns + " FROM " + quote(table.table)).all() as Record<string, unknown>[];
      const update = db.prepare("UPDATE " + quote(table.table) + " SET " + table.fields.map(field => quote(field.name) + "=?").join(",") + " WHERE " + ids.map(column => quote(column) + "=?").join(" AND "));
      for (const row of rows) {
        const rowIdValue = rowId(table, row);
        const values = table.fields.map(field => {
          const value = row[field.name];
          if (value == null) return null;
          return protectedValue(key, scope, table, rowIdValue, field, value, false);
        });
        update.run(...values, ...ids.map(column => row[column] as string));
      }
    }
    const verifier = protectText(key, "anima_data_protection", scope.name, "verifier", VERIFIER);
    db.prepare("INSERT INTO anima_data_protection(scope,version,verifier) VALUES (?,?,?)").run(scope.name, DATA_FORMAT_VERSION, verifier);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  cleanupPlaintextResidue(db);
}

export function ensureAllProtectedScopes(db: DatabaseSync, key?: Buffer): void {
  if (!key) {
    assertScopesDoNotContainProtectedValues(db, PROTECTED_SCOPES);
    return;
  }
  for (const scope of PROTECTED_SCOPES) ensureProtectedScope(db, scope, key);
}

export function unprotectAllScopes(db: DatabaseSync, key?: Buffer): void {
  if (!key) {
    assertScopesDoNotContainProtectedValues(db, PROTECTED_SCOPES);
    return;
  }
  const scopesWithMarkers = PROTECTED_SCOPES.filter(scope => dataMarker(db, scope.name));
  for (const scope of PROTECTED_SCOPES) {
    const marker = dataMarker(db, scope.name);
    if (marker) {
      verifyKey(key, scope.name, marker);
      assertScopeEncrypted(db, scope);
    } else if (containsProtectedValues(db, scope.tables)) {
      throw new DataProtectionError("Données chiffrées sans marqueur de version; sauvegarde refusée.");
    }
  }
  if (scopesWithMarkers.length === 0) {
    if (containsProtectedValues(db, PROTECTED_SCOPES.flatMap(scope => scope.tables)))
      throw new DataProtectionError("Données chiffrées sans marqueur de version; sauvegarde refusée.");
    return;
  }
  db.exec("PRAGMA secure_delete=ON;");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const scope of scopesWithMarkers) {
      for (const table of scope.tables) {
        if (!tableExists(db, table.table)) continue;
        const columns = table.fields.map(field => quote(field.name)).join(",");
        const ids = idColumns(table);
        const rows = db.prepare("SELECT " + ids.map(quote).join(",") + "," + columns + " FROM " + quote(table.table)).all() as Record<string, unknown>[];
        const update = db.prepare("UPDATE " + quote(table.table) + " SET " + table.fields.map(field => quote(field.name) + "=?").join(",") + " WHERE " + ids.map(column => quote(column) + "=?").join(" AND "));
        for (const row of rows) {
          const rowIdValue = rowId(table, row);
          const values = table.fields.map(field => {
            const value = row[field.name];
            if (value == null) return null;
            return protectedValue(key, scope, table, rowIdValue, field, value, true);
          });
          update.run(...values, ...ids.map(column => row[column] as string));
        }
      }
      db.prepare("DELETE FROM anima_data_protection WHERE scope=?").run(scope.name);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if ((db.prepare("SELECT COUNT(*) AS n FROM anima_data_protection").get() as { n: number }).n === 0)
    db.exec("DROP TABLE anima_data_protection");
  cleanupPlaintextResidue(db);
}

export function encryptPortableBackup(database: Buffer, passphrase: string): Buffer {
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024)
    throw new DataProtectionError("La phrase de sauvegarde doit contenir de 12 à 1024 caractères.");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const version = Buffer.from([BACKUP_VERSION]);
  const key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const aadBytes = Buffer.concat([BACKUP_AAD_PREFIX, version, salt, nonce]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aadBytes);
    const ciphertext = Buffer.concat([cipher.update(database), cipher.final()]);
    return Buffer.concat([BACKUP_MAGIC, version, salt, nonce, cipher.getAuthTag(), ciphertext]);
  } finally {
    key.fill(0);
  }
}

export function decryptPortableBackup(input: Buffer, passphrase: string, allowLegacyPlain = false): { database: Buffer; legacy: boolean } {
  if (typeof passphrase !== "string" || passphrase.length > 1024)
    throw new DataProtectionError("Phrase de sauvegarde invalide.");
  if (input.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    if (input.length < BACKUP_HEADER_BYTES)
      throw new DataProtectionError("Sauvegarde chiffrée tronquée.");
    const version = input[8];
    if (version !== BACKUP_VERSION)
      throw new DataProtectionError("Version de sauvegarde " + version + " non prise en charge.");
    if (passphrase.length < 12)
      throw new DataProtectionError("Phrase de sauvegarde invalide.");
    const salt = input.subarray(9, 25);
    const nonce = input.subarray(25, 37);
    const tag = input.subarray(37, 53);
    const ciphertext = input.subarray(BACKUP_HEADER_BYTES);
    const key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(Buffer.concat([BACKUP_AAD_PREFIX, input.subarray(8, 9), salt, nonce]));
      decipher.setAuthTag(tag);
      return { database: Buffer.concat([decipher.update(ciphertext), decipher.final()]), legacy: false };
    } catch {
      throw new DataProtectionError("Phrase incorrecte ou sauvegarde altérée; aucune donnée n’a été restaurée.");
    } finally {
      key.fill(0);
    }
  }
  if (allowLegacyPlain && input.subarray(0, 16).toString("ascii") === "SQLite format 3\0")
    return { database: input, legacy: true };
  throw new DataProtectionError("Format de sauvegarde inconnu. Utilisez une sauvegarde Anima Connect.");
}
