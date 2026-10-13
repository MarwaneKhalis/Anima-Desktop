import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { Store } from "../server/db.ts";
import { candidateFromVisibleText } from "../server/browser.ts";
import {
  cleanFilters,
  csvParse,
  csvStringify,
  makeSearchUrl,
  normalizeLinkedInUrl,
} from "../server/domain.ts";

function sampleStore() {
  const store = new Store(":memory:");
  const search = store.saveSearch({
    name: "CTO — France",
    filters: cleanFilters({ titles: ["CTO"], locations: ["France"] }),
    linkedinUrl: "",
    notes: "",
  });
  return { store, search };
}

test("normalise les URL de profil et refuse les autres domaines", () => {
  assert.equal(
    normalizeLinkedInUrl("linkedin.com/in/Ada-Lovelace/?trk=public#top"),
    "https://www.linkedin.com/in/ada-lovelace/",
  );
  assert.equal(
    normalizeLinkedInUrl("https://www.linkedin.com/in/ada-lovelace/"),
    "https://www.linkedin.com/in/ada-lovelace/",
  );
  assert.throws(() =>
    normalizeLinkedInUrl("https://linkedin.com.evil.test/in/ada/"),
  );
  assert.throws(() =>
    normalizeLinkedInUrl("https://www.linkedin.com/search/results/people/"),
  );
});

test("importe plusieurs fois le même profil sans doublon et conserve la source", () => {
  const { store, search } = sampleStore();
  try {
    const profile = {
      linkedinUrl: "https://www.linkedin.com/in/demo-ada/?trk=x",
      firstName: "Ada",
      lastName: "Martin",
      company: "FictionLab",
    };
    const first = store.importProspects(search.id, [profile])[0];
    const second = store.importProspects(search.id, [
      { ...profile, linkedinUrl: "linkedin.com/in/DEMO-ADA/", title: "CTO" },
    ])[0];
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(store.listProspects().length, 1);
    assert.equal(second.prospect.title, "CTO");
    assert.equal(second.prospect.sources?.length, 1);
    assert.equal(second.prospect.sources?.[0].searchName, "CTO — France");
  } finally {
    store.close();
  }
});

test("signale un doublon possible lorsque nom et entreprise coïncident avec une autre URL", () => {
  const { store, search } = sampleStore();
  try {
    store.importProspects(search.id, [
      {
        linkedinUrl: "linkedin.com/in/demo-ada-1",
        firstName: "Ada",
        lastName: "Martin",
        company: "FictionLab",
      },
    ]);
    const second = store.importProspects(search.id, [
      {
        linkedinUrl: "linkedin.com/in/demo-ada-2",
        firstName: "Ada",
        lastName: "Martin",
        company: "FictionLab",
      },
    ])[0];
    assert.equal(second.possibleDuplicates.length, 1);
  } finally {
    store.close();
  }
});

test("repère les doublons possibles sans tenir compte de la casse ni des accents", () => {
  const { store, search } = sampleStore();
  try {
    store.importProspects(search.id, [{
      linkedinUrl: "linkedin.com/in/demo-amelie-existing",
      firstName: "Amélie",
      lastName: "Lévy",
      company: "Étoile",
    }]);
    const imported = store.importProspects(search.id, [{
      linkedinUrl: "linkedin.com/in/demo-amelie-new",
      firstName: "AMELIE",
      lastName: "Levy",
      company: "Etoile",
    }])[0];
    assert.equal(imported.created, true);
    assert.equal(imported.possibleDuplicates.length, 1);
    assert.equal(imported.possibleDuplicates[0].firstName, "Amélie");
  } finally {
    store.close();
  }
});

test("interdit une seconde invitation après envoi, y compris après redémarrage et retour manuel au statut initial", () => {
  const path = join(tmpdir(), `anima-test-${randomUUID()}.sqlite`);
  let store = new Store(path);
  let id = "";
  try {
    const search = store.saveSearch({
      name: "Test",
      filters: cleanFilters({}),
      linkedinUrl: "",
      notes: "",
    });
    id = store.importProspects(search.id, [
      {
        linkedinUrl: "linkedin.com/in/demo-noah",
        firstName: "Noah",
        lastName: "Leroy",
        title: "CTO",
        company: "FictionLab",
      },
    ])[0].prospect.id;
    const template = store
      .listTemplates()
      .find((t) => t.kind === "invitation")!;
    const draft = store.createDraft(id, template.id);
    const item = store.queueDraft(draft.id);
    const secondPendingDraft = store.createDraft(id, template.id);
    assert.throws(
      () => store.queueDraft(secondPendingDraft.id),
      /attente|invitation/i,
    );
    store.openQueue(item.id);
    store.confirmQueue(item.id);
    store.updateProspect(id, { status: "À examiner" });
    store.close();
    store = new Store(path);
    const another = store.createDraft(id, template.id);
    assert.throws(() => store.queueDraft(another.id), /déjà|invitation/i);
    assert.equal(
      store.getProspect(id).messages?.filter((m) => m.state === "sent").length,
      1,
    );
  } finally {
    store.close();
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(path + suffix, { force: true });
  }
});

test("journalise les transitions et arrête la file sur résultat incertain", () => {
  const { store, search } = sampleStore();
  try {
    const id = store.importProspects(search.id, [
      {
        linkedinUrl: "linkedin.com/in/demo-ines",
        firstName: "Inès",
        lastName: "Bernard",
        title: "Data Engineer",
        company: "SampleWorks",
      },
    ])[0].prospect.id;
    store.updateProspect(id, { status: "Qualifié" });
    const draft = store.createDraft(id, store.listTemplates()[0].id);
    const item = store.queueDraft(draft.id);
    store.openQueue(item.id);
    assert.throws(() => store.cancelQueue(item.id), /Vérifiez/);
    store.markUncertain(item.id, "Délai dépassé");
    assert.equal(store.getSettings().queuePaused, true);
    assert.throws(() => store.pauseQueue(false), /incertains/i);
    assert.equal(store.getQueueItem(item.id).state, "uncertain");
    assert.ok(
      store
        .getProspect(id)
        .events?.some((e) => e.detail.includes("À examiner → Qualifié")),
    );
    assert.ok(
      store.getProspect(id).events?.some((e) => e.kind === "uncertain"),
    );
    store.cancelQueue(item.id, true);
    assert.equal(store.getSettings().queuePaused, false);
  } finally {
    store.close();
  }
});

test("CSV résiste aux virgules, guillemets et retours à la ligne ; URL de recherche ordinaire", () => {
  const csv = csvStringify(
    [{ firstName: "Ada", notes: 'Bonjour, "à bientôt"\nSuite' }],
    ["firstName", "notes"],
  );
  assert.deepEqual(csvParse(csv), [
    { firstName: "Ada", notes: 'Bonjour, "à bientôt"\nSuite' },
  ]);
  assert.equal(
    makeSearchUrl(cleanFilters({ titles: ["CTO"], keywords: ["France"] })),
    "https://www.linkedin.com/search/results/people/?keywords=CTO%20France",
  );
});

test("un brouillon avec variable manquante doit être corrigé avant la file", () => {
  const { store, search } = sampleStore();
  try {
    const id = store.importProspects(search.id, [
      {
        linkedinUrl: "linkedin.com/in/demo-alex",
        firstName: "Alex",
        lastName: "Petit",
      },
    ])[0].prospect.id;
    const draft = store.createDraft(
      id,
      store.listTemplates().find((t) => t.kind === "invitation")!.id,
    );
    assert.match(draft.content, /\{poste\}/);
    assert.throws(() => store.queueDraft(draft.id), /variables manquantes/);
  } finally {
    store.close();
  }
});

test("lit seulement les champs proposés par une carte fictive visible", () => {
  const candidate = candidateFromVisibleText(
    "https://www.linkedin.com/in/demo-louise/",
    "Louise Durand",
    [
      "Louise Durand",
      "2nd",
      "CTO chez Exemple Studio",
      "Paris, France",
      "École fictive",
    ],
  );
  assert.equal(candidate.title, "CTO");
  assert.equal(candidate.company, "Exemple Studio");
  assert.equal(candidate.location, "Paris, France");
  assert.equal(candidate.school, "École fictive");
});

test("le mode démo initialise des données fictives sans navigateur", () => {
  const store = new Store(":memory:");
  try {
    store.seedDemo();
    assert.equal(store.listSearches().length, 2);
    assert.equal(store.listProspects().length, 4);
    assert.equal(store.getMetrics().invited, 1);
    assert.equal(store.listQueue().filter((item) => item.state === "sent").length, 1);
  } finally {
    store.close();
  }
});
