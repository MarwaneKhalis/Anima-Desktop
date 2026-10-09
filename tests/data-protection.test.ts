import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/db.ts";
import { CareerStore } from "../server/career-store.ts";
import { Vault } from "../server/vault.ts";
import { CareerCampaignStore } from "../server/career-campaign.ts";
import {
  decryptPortableBackup,
  deserializeDatabase,
  encryptPortableBackup,
  ensureAllProtectedScopes,
  ensureProtectedScope,
  isProtectedBlob,
  isProtectedText,
  LocalDataProtector,
  PROTECTED_SCOPES,
  protectText,
  revealText,
  serializeDatabase,
  unprotectAllScopes,
  validatePortableDatabase,
} from "../server/data-protection.ts";

const cleanup = (path: string) => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
};

test("migration atomique chiffre les données personnelles et reste lisible uniquement avec la clé locale", () => {
  const path = join(tmpdir(), `anima-protection-${randomUUID()}.sqlite`);
  const key = randomBytes(32);
  let migrated: Store | undefined;
  try {
    const plainCrm = new Store(path);
    const career = new CareerStore(plainCrm.db);
    const vault = new Vault(plainCrm.db);
    const campaigns = new CareerCampaignStore(plainCrm.db);
    const search = plainCrm.saveSearch({ name: "Postes RH confidentiels", filters: { titles: ["RH"] } as any, linkedinUrl: "", notes: "Recherche privée" });
    const prospect = plainCrm.importProspects(search.id, [{ linkedinUrl: "linkedin.com/in/prospect-prive", firstName: "Nadia", lastName: "Confidentiel", company: "Entreprise privée", notes: "Échange confidentiel" }])[0].prospect;
    plainCrm.addManualEvent(prospect.id, "entretien", "Échange privé avec le contact");
    career.saveProfile({ firstName: "Nadia", lastName: "Martin", email: "nadia.private@example.test", phone: "+33123456789", country: "France", summary: "Résumé professionnel privé", answers: { authorization: "réponse confidentielle" } });
    const resume = career.saveResume({ name: "CV confidentiel", filename: "cv-prive.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.7\nPRIVATE-CV-CONTENT\n%%EOF\n") });
    const job = career.saveJob({ url: "https://careers.example.org/jobs/private", sourceUrl: "https://careers.example.org/jobs/private", title: "Poste privé", company: "Entreprise privée", location: "Paris", description: "Description publique" });
    const application = career.createApplication({ jobId: job.id, resumeId: resume.id });
    career.updateApplication(application.id, { answers: { salary: "65000 privé" }, notes: "Notes de candidature privées", outcome: "interview" });
    vault.initialize("phrase coffre assez longue");
    vault.saveCredential({ origin: "https://careers.example.org", label: "Compte privé", username: "nadia.private@example.test", password: "mot-de-passe privé" });
    const campaign = campaigns.create(resume.id, 2, randomUUID(), null, [job.id]);
    const item = campaigns.enqueue(campaign.id, career.getApplication(application.id));
    campaigns.finish(item.id, "failed", "Erreur privée du parcours");
    plainCrm.close();

    migrated = new Store(path, key);
    const migratedCareer = new CareerStore(migrated.db, { dataProtectionKey: key });
    const migratedVault = new Vault(migrated.db, { dataProtectionKey: key });
    const migratedCampaigns = new CareerCampaignStore(migrated.db, key);
    const raw = new DatabaseSync(path);
    try {
      const profileValue = String((raw.prepare("SELECT value FROM career_profile WHERE id=1").get() as { value: string }).value);
      const resumeRow = raw.prepare("SELECT name,filename,bytes FROM career_resumes").get() as { name: string; filename: string; bytes: Uint8Array };
      const appRow = raw.prepare("SELECT answers,notes FROM career_applications WHERE id=?").get(application.id) as { answers: string; notes: string };
      const careerEvent = raw.prepare("SELECT detail FROM career_events LIMIT 1").get() as { detail: string };
      const crmRow = raw.prepare("SELECT first_name,notes FROM prospects LIMIT 1").get() as { first_name: string; notes: string };
      const sourceRow = raw.prepare("SELECT filters FROM prospect_sources LIMIT 1").get() as { filters: string };
      const credential = raw.prepare("SELECT origin,label,username FROM career_credentials LIMIT 1").get() as { origin: string; label: string; username: string };
      const campaignRow = raw.prepare("SELECT error FROM career_campaign_items LIMIT 1").get() as { error: string };
      assert.ok(isProtectedText(profileValue));
      assert.ok(isProtectedText(resumeRow.name));
      assert.ok(isProtectedText(resumeRow.filename));
      assert.ok(isProtectedBlob(resumeRow.bytes));
      assert.ok(isProtectedText(appRow.answers));
      assert.ok(isProtectedText(appRow.notes));
      assert.ok(isProtectedText(careerEvent.detail));
      assert.ok(isProtectedText(crmRow.first_name));
      assert.ok(isProtectedText(crmRow.notes));
      assert.ok(isProtectedText(sourceRow.filters));
      assert.ok(isProtectedText(credential.origin));
      assert.ok(isProtectedText(credential.label));
      assert.ok(isProtectedText(credential.username));
      assert.ok(isProtectedText(campaignRow.error));
      const rawSnapshot = serializeDatabase(raw).toString("utf8");
      for (const secret of ["nadia.private@example.test", "Résumé professionnel privé", "PRIVATE-CV-CONTENT", "65000 privé", "Notes de candidature privées", "Échange privé avec le contact", "Erreur privée du parcours"])
        assert.ok(!rawSnapshot.includes(secret), `plain text remains in migrated database: ${secret}`);
      const noKey = new LocalDataProtector();
      assert.throws(() => noKey.readText("career_profile", "1", "value", profileValue), /chiffrée/i);
      const careerScope = PROTECTED_SCOPES.find((scope) => scope.name === "career")!;
      assert.throws(() => ensureProtectedScope(raw, careerScope), /chiffrée|clé/i);
      assert.throws(() => ensureProtectedScope(raw, careerScope, randomBytes(32)), /incorrecte|altérées/i);

      const tampered = Buffer.from(profileValue.slice("anima-protected:v1:".length), "base64");
      tampered[tampered.length - 1] ^= 0x01;
      assert.throws(
        () => revealText(key, "career_profile", "1", "value", "anima-protected:v1:" + tampered.toString("base64")),
        /incorrecte|altérées/i,
      );
    } finally {
      raw.close();
    }
    assert.equal(migratedCareer.getProfile().email, "nadia.private@example.test");
    assert.equal(migratedCareer.getResume(resume.id).bytes.toString("utf8").includes("PRIVATE-CV-CONTENT"), true);
    assert.equal(migratedCareer.getApplication(application.id).notes, "Notes de candidature privées");
    assert.equal(migrated.listProspects()[0].firstName, "Nadia");
    assert.deepEqual(migrated.listProspects()[0].sources?.[0].filters.titles, ["RH"]);
    assert.equal(migratedCampaigns.listItems(migratedCampaigns.list(1)[0].id)[0].error, "Erreur privée du parcours");
    migratedVault.unlock("phrase coffre assez longue");
    assert.equal(migratedVault.getCredential(migratedVault.listCredentials()[0].id, "https://careers.example.org").username, "nadia.private@example.test");
  } finally {
    migrated?.close();
    cleanup(path);
  }
});

test("création directe avec clé protège last_error initial et seed démo", () => {
  const key = randomBytes(32);
  const store = new Store(":memory:", key);
  try {
    const career = new CareerStore(store.db, { dataProtectionKey: key });
    career.seedDemo();
    const rows = store.db.prepare("SELECT last_error,receipt FROM career_applications").all() as { last_error: string; receipt: string | null }[];
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(isProtectedText(row.last_error));
      assert.equal(row.receipt, null);
    }
  } finally {
    store.close();
  }
});

test("répare une base déjà marquée contenant l’ancien last_error déplacé, sans réécriture en clair", () => {
  const key = randomBytes(32);
  const store = new Store(":memory:", key);
  try {
    const career = new CareerStore(store.db, { dataProtectionKey: key });
    const resume = career.saveResume({ name: "CV", filename: "cv.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.7\nfixture\n%%EOF\n") });
    const job = career.saveJob({ url: "https://careers.example.org/fix", title: "Développeur", company: "Exemple", location: "France" });
    const application = career.createApplication({ jobId: job.id, resumeId: resume.id });
    const oldMisplacedCiphertext = protectText(key, "career_applications", application.id, "last_error", "");
    store.db.prepare("UPDATE career_applications SET next_action_at=?,last_error='' WHERE id=?").run(oldMisplacedCiphertext, application.id);

    const before = store.db.prepare("SELECT scope FROM anima_data_protection WHERE scope='career'").get();
    assert.ok(before, "La fixture doit reproduire une base déjà marquée comme chiffrée.");
    const repaired = new CareerStore(store.db, { dataProtectionKey: key });
    const raw = store.db.prepare("SELECT next_action_at,last_error,receipt FROM career_applications WHERE id=?").get(application.id) as { next_action_at: string; last_error: string; receipt: string | null };
    assert.equal(raw.next_action_at, "");
    assert.ok(isProtectedText(raw.last_error));
    assert.equal(raw.receipt, null);
    assert.equal(repaired.getApplication(application.id).lastError, "");
    assert.equal(repaired.getApplication(application.id).nextActionAt, "");

    // Reopening after a successful repair is a no-op and still reads the row.
    const reopened = new CareerStore(store.db, { dataProtectionKey: key });
    assert.equal(reopened.getApplication(application.id).lastError, "");
  } finally {
    store.close();
  }
});

test("un échec au milieu de la migration annule toute la transaction", () => {
  const store = new Store(":memory:");
  try {
    const search = store.saveSearch({ name: "Avant migration", filters: {} as any, linkedinUrl: "", notes: "note claire" });
    const first = store.importProspects(search.id, [{ firstName: "Premier", lastName: "Contact", company: "Exemple" }])[0].prospect;
    const second = store.importProspects(search.id, [{ firstName: "Second", lastName: "Contact", company: "Exemple" }])[0].prospect;
    const scope = PROTECTED_SCOPES.find((item) => item.name === "crm")!;
    store.db.exec(`CREATE TRIGGER block_second BEFORE UPDATE ON prospects WHEN OLD.id='${second.id}' BEGIN SELECT RAISE(ABORT,'test migration failure'); END;`);
    assert.throws(() => ensureProtectedScope(store.db, scope, randomBytes(32)), /test migration failure/);
    assert.equal((store.db.prepare("SELECT name FROM searches WHERE id=?").get(search.id) as { name: string }).name, "Avant migration");
    assert.equal((store.db.prepare("SELECT first_name FROM prospects WHERE id=?").get(first.id) as { first_name: string }).first_name, "Premier");
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM anima_data_protection").get() as { n: number }).n, 0);
  } finally {
    store.close();
  }
});

test("sauvegarde AES-GCM portable restaure les données et les re-chiffre avec une nouvelle clé DPAPI", () => {
  const sourceKey = randomBytes(32);
  const targetKey = randomBytes(32);
  const phrase = "une phrase secrète longue de sauvegarde";
  let copy: DatabaseSync | undefined;
  let restored: DatabaseSync | undefined;
  try {
    const store = new Store(":memory:", sourceKey);
    const career = new CareerStore(store.db, { dataProtectionKey: sourceKey });
    new Vault(store.db, { dataProtectionKey: sourceKey });
    new CareerCampaignStore(store.db, sourceKey);
    career.saveProfile({ firstName: "Léa", email: "lea.backup@example.test", summary: "Profil de restauration" });
    const snapshot = serializeDatabase(store.db);
    store.close();
    copy = new DatabaseSync(":memory:");
    deserializeDatabase(copy, snapshot);
    unprotectAllScopes(copy, sourceKey);
    validatePortableDatabase(copy);
    const portable = encryptPortableBackup(serializeDatabase(copy), phrase);
    assert.equal(portable.subarray(0, 8).toString("ascii"), "ANIMABK1");
    assert.equal(portable[8], 1);
    assert.throws(() => decryptPortableBackup(portable, "mauvaise phrase"), /incorrecte|altérée/i);
    const damaged = Buffer.from(portable);
    damaged[damaged.length - 1] ^= 0x01;
    assert.throws(() => decryptPortableBackup(damaged, phrase), /incorrecte|altérée/i);
    const clear = decryptPortableBackup(portable, phrase);
    assert.equal(clear.legacy, false);
    restored = new DatabaseSync(":memory:");
    deserializeDatabase(restored, clear.database);
    ensureAllProtectedScopes(restored, targetKey);
    const restoredCareer = new CareerStore(restored, { dataProtectionKey: targetKey });
    assert.equal(restoredCareer.getProfile().email, "lea.backup@example.test");
    const raw = String((restored.prepare("SELECT value FROM career_profile WHERE id=1").get() as { value: string }).value);
    assert.ok(isProtectedText(raw));
    assert.ok(!raw.includes("lea.backup@example.test"));
  } finally {
    copy?.close();
    restored?.close();
  }
});

test("validation de sauvegarde refuse schéma incomplet, colonnes inconnues et objets SQLite inattendus", () => {
  const legacy = new Store(":memory:");
  try {
    assert.throws(() => validatePortableDatabase(legacy.db), /table requise absente.*career_profile/i);
    assert.doesNotThrow(() => validatePortableDatabase(legacy.db, { legacy: true }));
  } finally {
    legacy.close();
  }

  const withExtraColumn = new Store(":memory:");
  try {
    new CareerStore(withExtraColumn.db);
    new Vault(withExtraColumn.db);
    new CareerCampaignStore(withExtraColumn.db);
    withExtraColumn.db.exec("ALTER TABLE prospects ADD COLUMN unexpected TEXT");
    assert.throws(() => validatePortableDatabase(withExtraColumn.db), /schéma non pris en charge pour prospects/i);
  } finally {
    withExtraColumn.close();
  }

  const withTrigger = new Store(":memory:");
  try {
    new CareerStore(withTrigger.db);
    new Vault(withTrigger.db);
    new CareerCampaignStore(withTrigger.db);
    withTrigger.db.exec("CREATE TRIGGER unexpected_trigger AFTER INSERT ON prospects BEGIN SELECT 1; END");
    assert.throws(() => validatePortableDatabase(withTrigger.db), /objet SQLite inattendu.*trigger/i);
  } finally {
    withTrigger.close();
  }

  const withUnexpectedTable = new Store(":memory:");
  try {
    new CareerStore(withUnexpectedTable.db);
    new Vault(withUnexpectedTable.db);
    new CareerCampaignStore(withUnexpectedTable.db);
    withUnexpectedTable.db.exec("CREATE TABLE unexpected(payload TEXT)");
    assert.throws(() => validatePortableDatabase(withUnexpectedTable.db), /table SQLite inattendue/i);
  } finally {
    withUnexpectedTable.close();
  }

  const withTamperedIndex = new Store(":memory:");
  try {
    new CareerStore(withTamperedIndex.db);
    new Vault(withTamperedIndex.db);
    new CareerCampaignStore(withTamperedIndex.db);
    withTamperedIndex.db.exec("DROP INDEX idx_queue_state; CREATE INDEX idx_queue_state ON settings(value)");
    assert.throws(() => validatePortableDatabase(withTamperedIndex.db), /index SQLite inattendu ou altéré/i);
  } finally {
    withTamperedIndex.close();
  }
});

test("les sauvegardes SQLite historiques ne sont acceptées que par le chemin explicitement autorisé", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES ('old export');");
    const legacy = serializeDatabase(db);
    assert.throws(() => decryptPortableBackup(legacy, ""), /Format de sauvegarde inconnu/);
    const result = decryptPortableBackup(legacy, "", true);
    assert.equal(result.legacy, true);
    assert.deepEqual(result.database, legacy);
  } finally {
    db.close();
  }
});
