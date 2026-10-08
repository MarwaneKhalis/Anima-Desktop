import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { startCareerTestServer, waitFor } from "./helpers/career-server.ts";
import type { Application, CareerProfile } from "../src/shared/career.ts";

const profile = (): CareerProfile => ({
  firstName: "Camille", lastName: "Martin", email: "camille@example.test", phone: "+33123456789",
  city: "Paris", country: "France", address: "", postalCode: "", headline: "", summary: "",
  linkedinUrl: "", websiteUrl: "", skills: [], languages: [], experiences: [], education: [],
  preferences: { titles: [], locations: [], remote: false, contract: "" }, answers: {}, updatedAt: "",
});

test("career UI completes a real browser application flow and survives reload", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1365, height: 900 },
  });
  await mkdir("artifacts/career-ui", { recursive: true });
  const screenshot = (name: string) =>
    page.screenshot({
      path: `artifacts/career-ui/${name}.png`,
      fullPage: true,
    });
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) =>
    failedRequests.push(
      `${request.method()} ${request.url()}: ${request.failure()?.errorText}`,
    ),
  );

  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await screenshot("01-dashboard");
  await page.getByRole("button", { name: "Profil & CV" }).click();
  await page.getByLabel("Prénom").fill("Camille");
  await page.getByLabel("Nom", { exact: true }).fill("Martin");
  await page.getByLabel("Email").fill("camille.martin@example.test");
  await page.getByLabel("Téléphone").fill("+33123456789");
  await page.getByLabel("Ville").fill("Paris");
  await page.getByLabel("Pays").fill("France");
  await page.getByRole("button", { name: "Enregistrer le profil" }).click();

  const pdf = Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
  const resumeInput = page.getByLabel("Ajouter un CV");
  await resumeInput.setInputFiles({
    name: "camille-principal.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.getByText("camille-principal.pdf").waitFor();
  const secondPdf = Buffer.from(
    "%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n%%EOF\n",
  );
  await resumeInput.setInputFiles({
    name: "camille-alternatif.pdf",
    mimeType: "application/pdf",
    buffer: secondPdf,
  });
  await page.getByText("camille-alternatif.pdf").waitFor();
  await screenshot("02-profile");

  await page.getByRole("button", { name: "Offres", exact: true }).click();
  await page.getByText("Ajouter une offre avec son lien").click();
  await page.getByLabel("URL de l’offre").fill(`${app.fixture.baseUrl}/simple`);
  await page.getByLabel("Intitulé").fill("Ingénieure plateforme");
  await page.getByLabel("Entreprise").fill("Anima Fixture");
  await page.getByLabel("Lieu").fill("Paris");
  await page.getByRole("button", { name: "Enregistrer l’offre" }).click();
  const offerCard = page.getByText("Ingénieure plateforme").first();
  await offerCard.waitFor();
  await page
    .getByLabel("CV pour les candidatures")
    .selectOption({ label: "camille-alternatif" });
  await screenshot("03-offers");
  await page
    .getByRole("button", { name: "Créer une candidature" })
    .first()
    .click();

  const { value: afterCreate } = await app.json("/api/career/bootstrap");
  assert.equal(afterCreate.profile.email, "camille.martin@example.test");
  assert.equal(afterCreate.resumes.length, 2);
  assert.equal(
    afterCreate.jobs.some((job: any) => job.title === "Ingénieure plateforme"),
    true,
  );
  assert.equal(afterCreate.applications.length, 1);
  const applicationId = afterCreate.applications[0].id;
  assert.equal(
    afterCreate.applications[0].resumeId,
    afterCreate.resumes.find(
      (resume: any) => resume.name === "camille-alternatif",
    )?.id,
    "the explicitly selected CV should be used",
  );
  assert.equal(app.fixture.submissions.length, 0);

  await page
    .getByRole("button", { name: "Préparer sans envoyer", exact: true })
    .click();
  const ready = await waitFor(
    async () =>
      (await app.json(`/api/career/applications/${applicationId}`))
        .value as Application,
    (value) => value.state !== "running",
  );
  assert.equal(ready.state, "ready", ready.lastError);
  assert.equal(app.fixture.submissions.length, 0);
  await page
    .locator(".cw-drawer .cw-status")
    .getByText("Prête", { exact: true })
    .waitFor();
  await screenshot("04-application-ready");
  await page
    .getByRole("button", { name: "Postuler automatiquement", exact: true })
    .click();

  const submitted = await waitFor(
    async () =>
      (await app.json(`/api/career/applications/${applicationId}`))
        .value as Application,
    (value) =>
      value.state === "submitted" ||
      ["blocked", "needs_input", "uncertain", "failed"].includes(value.state),
  );
  assert.equal(submitted.state, "submitted", submitted.lastError);
  assert.ok(submitted.receipt?.reference);
  assert.equal(app.fixture.submissions.length, 1);
  assert.equal(
    app.fixture.submissions[0].fields.email,
    "camille.martin@example.test",
  );
  assert.equal(
    app.fixture.submissions[0].resume?.filename,
    afterCreate.resumes.find(
      (resume: any) => resume.id === afterCreate.applications[0].resumeId,
    ).filename,
  );

  await page
    .locator(".cw-receipt")
    .getByText(submitted.receipt.reference, { exact: false })
    .first()
    .waitFor();
  await screenshot("05-receipt");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Candidatures" }).click();
  await page.getByRole("button", { name: "Ouvrir le suivi →" }).click();
  await page
    .locator(".cw-receipt")
    .getByText(submitted.receipt.reference, { exact: false })
    .first()
    .waitFor();
  const { value: afterReload } = await app.json("/api/career/bootstrap");
  assert.equal(afterReload.metrics.submitted, 1);
  assert.equal(
    afterReload.events.filter(
      (event: any) =>
        event.applicationId === applicationId && event.kind === "submitted",
    ).length,
    1,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("06-mobile");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "mobile layout must fit viewport",
  );
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.getByRole("button", { name: "Fermer la candidature" }).click();
  const beforeBatch = app.fixture.submissions.length;
  for (let batchIndex = 1; batchIndex <= 2; batchIndex++) {
    const createdJob = await app.json("/api/career/jobs", {
      url: `${app.fixture.baseUrl}/simple?batch=${batchIndex}`,
      title: `Lot ${batchIndex}`,
      company: "Fixture Batch",
    });
    const createdApplication = await app.json("/api/career/applications", {
      jobId: createdJob.value.id,
      resumeId: afterCreate.applications[0].resumeId,
    });
    await page
      .getByLabel(`Sélectionner Lot ${batchIndex}`, { exact: true })
      .check();
    await page
      .getByRole("button", { name: "Lancer une campagne · 1 offre(s) · plafond 10 ↗", exact: true })
      .click();
    const result = await waitFor(
      async () =>
        (
          await app.json(
            `/api/career/applications/${createdApplication.value.id}`,
          )
        ).value as Application,
      (a) =>
        a.state === "submitted" ||
        ["failed", "blocked", "needs_input", "uncertain"].includes(a.state),
    );
    assert.equal(result.state, "submitted", result.lastError);
    await page
      .getByRole("button", { name: "Lancer une campagne · 0 offre(s) · plafond 10 ↗", exact: true })
      .waitFor();
  }
  assert.equal(
    app.fixture.submissions.length,
    beforeBatch + 2,
    "successive batches must send each new application exactly once",
  );
  await page.getByRole("button", { name: "Prospection", exact: true }).click();
  await page
    .getByRole("heading", { name: "Vos prochaines conversations." })
    .waitFor();
  assert.equal(
    await page.locator(".cw-legacy > .sidebar").isVisible(),
    false,
    "legacy sidebar must be embedded",
  );
  await screenshot("07-prospecting");
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
});

test("France Travail search launches a durable application campaign from the desktop UI", async (t) => {
  const app = await startCareerTestServer({ mockFranceTravailSearch: true });
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const initialized = await app.json("/api/career/vault/initialize", {
    passphrase: "fixture-passphrase-123",
  });
  assert.equal(initialized.response.status, 201);
  const profileResponse = await app.json("/api/career/profile", profile(), "PUT");
  assert.equal(profileResponse.response.status, 200);
  const resume = await app.json("/api/career/resumes", {
    name: "CV principal",
    filename: "cv-principal.pdf",
    mime: "application/pdf",
    base64: Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64"),
  });
  assert.equal(resume.response.status, 201);
  const source = await app.json("/api/career/sources/france-travail", {
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    scope: "fixture-scope",
  });
  assert.equal(source.response.status, 200);

  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Offres", exact: true }).click();
  await page.getByLabel("Source d’offres").selectOption("france-travail");
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await page.getByRole("button", { name: "Trouver et candidater automatiquement" }).click();

  const completed = await waitFor(async () => {
    const { value } = await app.json("/api/career/campaigns");
    return value.campaigns[0];
  }, (campaign) => campaign?.state === "completed", 20_000);
  assert.equal(completed.counts.total, 1);
  assert.equal(completed.counts.submitted, 1);

  const { value: snapshot } = await app.json("/api/career/bootstrap");
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.jobs[0].title, "Offre de test France Travail");
  assert.equal(snapshot.applications.length, 1);
  assert.equal(snapshot.applications[0].state, "submitted");
  assert.ok(snapshot.applications[0].receipt?.reference);
  assert.equal(app.fixture.submissions.length, 1);
  assert.equal(app.fixture.submissions[0].fields.email, "camille@example.test");
  await page.getByText("Terminée", { exact: true }).waitFor();
  await mkdir("artifacts/career-ui", { recursive: true });
  await page.screenshot({ path: "artifacts/career-ui/08-france-travail-campaign.png", fullPage: true });
  assert.deepEqual(pageErrors, []);
});

test("Arbeitnow France can discover and campaign for an offer without France Travail access", async (t) => {
  const app = await startCareerTestServer({ mockArbeitnowSearch: true });
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const profileResponse = await app.json("/api/career/profile", profile(), "PUT");
  assert.equal(profileResponse.response.status, 200);
  const resume = await app.json("/api/career/resumes", {
    name: "CV principal", filename: "cv.pdf", mime: "application/pdf",
    base64: Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64"),
  });
  assert.equal(resume.response.status, 201);
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Offres", exact: true }).click();
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await page.getByRole("button", { name: "Trouver et candidater automatiquement" }).click();
  const completed = await waitFor(async () => {
    const { value } = await app.json("/api/career/campaigns");
    return value.campaigns[0];
  }, (campaign) => campaign?.state === "completed", 20_000);
  assert.equal(completed.counts.submitted, 1);
  const { value: snapshot } = await app.json("/api/career/bootstrap");
  assert.equal(snapshot.jobs[0].title, "Offre de test Arbeitnow France");
  assert.equal(snapshot.applications[0].state, "submitted");
  assert.equal(app.fixture.submissions.length, 1);
  await page.getByRole("button", { name: "Détails" }).click();
  await page.getByRole("button", { name: "Voir la candidature" }).waitFor();
  await page.getByRole("button", { name: "Voir la candidature" }).click();
  await page.locator(".cw-overlay").waitFor({ state: "visible" });
  await mkdir("artifacts/career-ui", { recursive: true });
  await page.screenshot({ path: "artifacts/career-ui/09-arbeitnow-campaign.png", fullPage: true });
  assert.deepEqual(pageErrors, []);
});

test("automatic campaign submits the highest-ranked offer first when capped", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const profileResponse = await app.json("/api/career/profile", profile(), "PUT");
  assert.equal(profileResponse.response.status, 200);
  const resume = await app.json("/api/career/resumes", {
    name: "CV principal", filename: "cv.pdf", mime: "application/pdf",
    base64: Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64"),
  });
  assert.equal(resume.response.status, 201);
  const preferred = await app.json("/api/career/jobs", {
    url: `${app.fixture.baseUrl}/simple?rank=1`, title: "Offre la mieux classée", company: "Fixture", location: "Paris",
  });
  const secondary = await app.json("/api/career/jobs", {
    url: `${app.fixture.baseUrl}/simple?rank=2`, title: "Offre moins bien classée", company: "Fixture", location: "Paris",
  });
  assert.equal(preferred.response.status, 201);
  assert.equal(secondary.response.status, 201);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.route((url) => new URL(url).pathname === "/api/career/sources/arbeitnow/search", (route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [preferred.value, secondary.value], note: "Résultats classés pour le test." }) });
  });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Offres", exact: true }).click();
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await page.getByLabel("CV pour les candidatures").selectOption({ label: "CV principal" });
  await page.getByLabel("Plafond d’envoi par campagne").selectOption("1");
  await page.getByRole("button", { name: "Trouver et candidater automatiquement" }).click();
  const campaign = await waitFor(async () => (await app.json("/api/career/campaigns")).value.campaigns[0], (value) => value?.state === "limit_reached", 20_000);
  assert.equal(campaign.counts.total, 2);
  assert.equal(campaign.counts.submitted, 1);
  assert.equal(campaign.counts.pending, 1);
  const detail = await app.json(`/api/career/campaigns/${campaign.id}`);
  assert.deepEqual(detail.value.items.map((item: { jobId: string }) => item.jobId), [preferred.value.id, secondary.value.id]);
  assert.equal(detail.value.items[0].state, "submitted");
  assert.equal(detail.value.items[1].state, "pending");
  const { value: snapshot } = await app.json("/api/career/bootstrap");
  assert.equal(snapshot.applications.find((item: Application) => item.state === "submitted")?.jobId, preferred.value.id);
  assert.equal(app.fixture.submissions.length, 1);
});

test("Arbeitnow search can save offers before a CV is added", async (t) => {
  const app = await startCareerTestServer({ mockArbeitnowSearch: true });
  t.after(() => app.close());
  const profileResponse = await app.json("/api/career/profile", profile(), "PUT");
  assert.equal(profileResponse.response.status, 200);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Offres", exact: true }).click();
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await page.getByRole("button", { name: "Rechercher les offres" }).click();
  await page.getByText(/offre\(s\) récupérée/).waitFor();
  const { value: snapshot } = await app.json("/api/career/bootstrap");
  assert.equal(snapshot.resumes.length, 0);
  assert.equal(snapshot.jobs[0].title, "Offre de test Arbeitnow France");
  assert.deepEqual(snapshot.applications, []);
  const applyButton = page.getByRole("button", { name: "Trouver et candidater automatiquement" });
  assert.equal(await applyButton.isDisabled(), true);
});

test("Jobicy search starts a desktop application campaign without a pasted job URL", async (t) => {
  const app = await startCareerTestServer({ mockJobicySearch: true });
  t.after(() => app.close());
  assert.equal((await app.json("/api/career/profile", profile(), "PUT")).response.status, 200);
  const resume = await app.json("/api/career/resumes", {
    name: "CV principal", filename: "cv.pdf", mime: "application/pdf",
    base64: Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64"),
  });
  assert.equal(resume.response.status, 201);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Offres", exact: true }).click();
  const offerLimit = page.getByLabel("Nombre d’offres à examiner");
  await offerLimit.selectOption("450");
  await page.getByLabel("Source d’offres").selectOption("jobicy");
  assert.equal(await offerLimit.inputValue(), "200", "Jobicy's UI limit matches its 200-offer page cap");
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await page.getByLabel("CV pour les candidatures").selectOption({ label: "CV principal" });
  await page.getByRole("button", { name: "Trouver et candidater automatiquement" }).click();

  const completed = await waitFor(async () => {
    const { value } = await app.json("/api/career/campaigns");
    return value.campaigns[0];
  }, campaign => campaign?.state === "completed", 20_000);
  assert.equal(completed.counts.submitted, 1);
  const { value: snapshot } = await app.json("/api/career/bootstrap");
  assert.equal(snapshot.jobs[0].title, "Offre de test Jobicy France");
  assert.equal(snapshot.jobs[0].sourceUrl, "https://jobicy.com/jobs/test");
  assert.equal(snapshot.applications[0].state, "submitted");
  assert.ok(snapshot.applications[0].receipt);
  assert.equal(app.fixture.submissions.length, 1);
  assert.deepEqual(pageErrors, []);
  await mkdir("artifacts/career-ui", { recursive: true });
  await page.screenshot({ path: "artifacts/career-ui/10-jobicy-campaign.png", fullPage: true });
});

test("career UI resumes a paused application after saving a missing answer", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const profileResponse = await app.json("/api/career/profile", profile(), "PUT");
  assert.equal(profileResponse.response.status, 200);
  const bytes = Buffer.from("%PDF-1.7\n%%EOF\n");
  const createdResume = await app.json("/api/career/resumes", {
    name: "CV de test",
    filename: "cv-test.pdf",
    mime: "application/pdf",
    base64: bytes.toString("base64"),
  });
  assert.equal(createdResume.response.status, 201);
  const createdJob = await app.json("/api/career/jobs", {
    url: `${app.fixture.baseUrl}/unknown`,
    title: "Poste avec réponse requise",
    company: "Anima Fixture",
    location: "Paris",
  });
  assert.equal(createdJob.response.status, 201);
  const createdApplication = await app.json("/api/career/applications", {
    jobId: createdJob.value.id,
    resumeId: createdResume.value.id,
  });
  assert.equal(createdApplication.response.status, 201);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Candidatures" }).click();
  await page.getByRole("button", { name: "Ouvrir le suivi →" }).click();
  await page.getByRole("button", { name: "Postuler automatiquement", exact: true }).click();
  const paused = await waitFor(
    async () => (await app.json(`/api/career/applications/${createdApplication.value.id}`)).value as Application,
    (value) => value.state === "needs_input",
  );
  assert.match(paused.lastError, /champs requis/i);
  await page.getByLabel("Work authorization").selectOption({ label: "Yes" });
  await page.getByRole("button", { name: "Reprendre la session ouverte" }).click();
  const submitted = await waitFor(
    async () => (await app.json(`/api/career/applications/${createdApplication.value.id}`)).value as Application,
    (value) => value.state === "submitted" || ["blocked", "failed", "uncertain"].includes(value.state),
  );
  assert.equal(submitted.state, "submitted", submitted.lastError);
  assert.equal(app.fixture.submissions.length, 1);
  assert.equal(app.fixture.submissions[0].fields.workAuthorization, "Yes");
});
