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

async function chooseCampaignResume(page: import("playwright").Page, label: string) {
  await page.getByRole("button", { name: "Candidatures", exact: true }).click();
  await page.getByLabel("CV pour les candidatures").selectOption({ label });
  await page.getByRole("button", { name: "Offres", exact: true }).click();
}

async function openOfferFilters(page: import("playwright").Page) {
  const details = page.locator(".cw-search-advanced");
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await page.getByText("Source, lieu et filtres avancés", { exact: true }).click();
  }
}

async function revealCampaignActions(page: import("playwright").Page) {
  const details = page.locator(".cw-search-actions-secondary");
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await page.getByText("Collecte programmée et candidature", { exact: true }).click();
  }
}

async function openCampaignActions(page: import("playwright").Page) {
  await revealCampaignActions(page);
  await page.getByRole("button", { name: "Rechercher et préparer un lancement" }).click();
  await confirmCampaignReview(page);
}

async function confirmCampaignReview(page: import("playwright").Page, mode: "prepare" | "submit" = "submit") {
  await page.getByRole("dialog", { name: "Récapitulatif de campagne" }).waitFor();
  if (mode === "submit") {
    const sendMode = page.getByRole("radio", { name: /Envoyer les candidatures/ });
    await sendMode.check();
    assert.equal(await sendMode.isChecked(), true);
    await page.getByRole("button", { name: "Confirmer et envoyer" }).click();
  } else {
    await page.getByRole("button", { name: "Préparer sans envoyer" }).click();
  }
  await page.locator(".cw-notice, .cw-alert").first().waitFor({ timeout: 5_000 });
  const error = page.locator(".cw-alert");
  if (await error.isVisible()) throw new Error(`Campaign launch failed: ${await error.innerText()}`);
}

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
  await screenshot("03-offers");
  await chooseCampaignResume(page, "camille-alternatif");
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
    .getByRole("button", { name: "Préparer avec vérification…", exact: true })
    .click();
  await confirmCampaignReview(page, "prepare");
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
    .getByRole("button", { name: "Préparer avec vérification…", exact: true })
    .click();
  await confirmCampaignReview(page, "submit");

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
  await page.getByLabel("CV pour les candidatures").selectOption({ label: "camille-principal" });
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
    await confirmCampaignReview(page);
    const updatedApplication = await app.json(`/api/career/applications/${createdApplication.value.id}`);
    assert.equal(updatedApplication.value.resumeId, afterCreate.resumes.find((resume: any) => resume.name === "camille-principal")?.id, "The CV selected in the recap is the CV used by the batch engine.");
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
    await page.getByRole("button", { name: "Toutes", exact: true }).click();
    await page
      .getByRole("button", { name: "Lancer une campagne · 0 offre(s) · plafond 10 ↗", exact: true })
      .waitFor();
  }
  assert.equal(
    app.fixture.submissions.length,
    beforeBatch + 2,
    "successive batches must send each new application exactly once",
  );
  await page.getByRole("button", { name: "Réseau", exact: true }).click();
  await page
    .getByRole("heading", { name: "Contacts" })
    .waitFor();
  assert.equal(
    await page.locator(".cw-legacy-module > .sidebar").isVisible(),
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
  await chooseCampaignResume(page, "CV principal");
  await openOfferFilters(page);
  await page.getByLabel("Source d’offres").selectOption("france-travail");
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await openCampaignActions(page);

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
  const campaignPage = await app.json("/api/career/campaigns?limit=10&offset=0");
  assert.equal(campaignPage.value.campaigns.length, 1, JSON.stringify(campaignPage.value));
  const browserCampaignPage = await page.evaluate(async () => fetch("/api/career/campaigns?limit=10&offset=0&demo=0").then((response) => response.json()));
  assert.equal(browserCampaignPage.campaigns.length, 1, JSON.stringify(browserCampaignPage));
  await page.getByRole("button", { name: "Candidatures", exact: true }).click();
  await page.getByRole("button", { name: "Campagnes", exact: true }).click();
  assert.equal(await page.locator(".cw-campaigns").count(), 1, `Visible page: ${await page.locator("main").innerText()} · alert: ${await page.locator(".cw-alert").innerText().catch(() => "none")}`);
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
  assert.equal(await page.locator(".cw-search-keywords input").isVisible(), true, "The main search criterion is visible before advanced filters are opened.");
  await openOfferFilters(page);
  await page.getByLabel("Source d’offres").selectOption("arbeitnow");
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await openCampaignActions(page);
  const completed = await waitFor(async () => {
    const { value } = await app.json("/api/career/campaigns");
    return value.campaigns[0];
  }, (campaign) => campaign?.state === "completed", 20_000);
  assert.equal(completed.counts.submitted, 1);
  const { value: snapshot } = await app.json("/api/career/bootstrap");
  assert.equal(snapshot.jobs[0].title, "Offre de test Arbeitnow France");
  assert.equal(snapshot.applications[0].state, "submitted");
  assert.equal(app.fixture.submissions.length, 1);
  await page.getByRole("button", { name: "Candidatures", exact: true }).click();
  await page.getByRole("button", { name: "Campagnes", exact: true }).click();
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
  await openOfferFilters(page);
  await page.getByLabel("Source d’offres").selectOption("arbeitnow");
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await chooseCampaignResume(page, "CV principal");
  await revealCampaignActions(page);
  await page.getByLabel("Plafond par défaut").selectOption("1");
  await page.getByRole("button", { name: "Rechercher et préparer un lancement" }).click();
  await confirmCampaignReview(page);
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
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Offres", exact: true }).click();
  await openOfferFilters(page);
  await page.getByLabel("Source d’offres").selectOption("arbeitnow");
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await page.getByRole("button", { name: "Rechercher les offres" }).click();
  await page.getByText(/offre\(s\) récupérée/).waitFor();
  const firstOffer = await page.locator(".cw-job").first().boundingBox();
  assert.ok(firstOffer && firstOffer.y < 768 && firstOffer.y + 90 <= 768, "The first offer and its title should appear at 1366 × 768 without scrolling through setup.");
  await mkdir("artifacts/career-ui", { recursive: true });
  await page.screenshot({ path: "artifacts/career-ui/03-offers-1366x768.png" });
  const { value: snapshot } = await app.json("/api/career/bootstrap");
  assert.equal(snapshot.resumes.length, 0);
  assert.equal(snapshot.jobs[0].title, "Offre de test Arbeitnow France");
  assert.deepEqual(snapshot.applications, []);
  await page.getByText("Collecte programmée et candidature", { exact: true }).click();
  const applyButton = page.getByRole("button", { name: "Rechercher et préparer un lancement" });
  assert.equal(await applyButton.isDisabled(), true);
});

test("default public search aggregates sources and launches one desktop campaign", async (t) => {
  const app = await startCareerTestServer({ mockAllPublicSearch: true });
  t.after(() => app.close());
  const searchProfile = profile();
  searchProfile.preferences.titles = ["Ingénieure logiciel"];
  assert.equal((await app.json("/api/career/profile", searchProfile, "PUT")).response.status, 200);
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
  await openOfferFilters(page);
  const source = page.getByLabel("Source d’offres");
  assert.equal(await source.inputValue(), "all");
  assert.equal(await page.getByLabel("Métier(s) ou mot(s)-clé(s)").inputValue(), "Ingénieure logiciel");
  await page.getByText("Sources et limites de collecte", { exact: true }).click();
  assert.match(await page.locator(".cw-automation-note").innerText(), /Himalayas et Remotive ne fournissent qu’une zone d’éligibilité par pays ou région/);
  await chooseCampaignResume(page, "CV principal");
  await openCampaignActions(page);
  const completed = await waitFor(async () => {
    const { value } = await app.json("/api/career/campaigns");
    return value.campaigns[0];
  }, campaign => campaign?.state === "completed" || campaign?.state === "paused", 30_000);
  const { value: snapshot } = await app.json("/api/career/bootstrap");
  assert.equal(completed.state, "completed", JSON.stringify(snapshot.applications.map((application: Application) => ({ state: application.state, missingFields: application.missingFields, lastError: application.lastError, job: snapshot.jobs.find((job: { id: string }) => job.id === application.jobId) }))));
  assert.equal(completed.counts.total, 5);
  assert.equal(completed.counts.submitted, 5);
  assert.equal(snapshot.jobs.length, 5);
  assert.deepEqual(new Set(snapshot.jobs.map((job: { sourceUrl: string }) => job.sourceUrl)), new Set([
    "https://www.arbeitnow.fr/",
    "https://jobicy.com/jobs/test",
    "https://remoteok.com/remote-jobs/test",
    "https://himalayas.app/companies/test/jobs/test-role",
    "https://remotive.com/remote-jobs/test",
  ]));
  await page.getByRole("button", { name: "Offres", exact: true }).click();
  assert.equal(await page.getByRole("link", { name: /Source Himalayas/ }).getAttribute("href"), "https://himalayas.app/companies/test/jobs/test-role");
  assert.equal(await page.getByRole("link", { name: /Source Remotive/ }).getAttribute("href"), "https://remotive.com/remote-jobs/test");
  assert.equal(snapshot.applications.length, 5);
  assert.ok(snapshot.applications.every((application: Application) => application.state === "submitted"));
  assert.equal(app.fixture.submissions.length, 5);
  assert.deepEqual(pageErrors, []);
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
  await openOfferFilters(page);
  const offerLimit = page.getByLabel("Nombre d’offres à examiner");
  await page.getByLabel("Source d’offres").selectOption("arbeitnow");
  await offerLimit.selectOption("450");
  await page.getByLabel("Source d’offres").selectOption("jobicy");
  assert.equal(await offerLimit.inputValue(), "200", "Jobicy's UI limit matches its 200-offer page cap");
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await chooseCampaignResume(page, "CV principal");
  await revealCampaignActions(page);
  await page.getByRole("button", { name: "Rechercher et préparer un lancement" }).click();
  await confirmCampaignReview(page);

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

test("Remote OK search keeps source attribution and starts a desktop application campaign", async (t) => {
  const app = await startCareerTestServer({ mockRemoteOkSearch: true });
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
  await openOfferFilters(page);
  const offerLimit = page.getByLabel("Nombre d’offres à examiner");
  await page.getByLabel("Source d’offres").selectOption("arbeitnow");
  await offerLimit.selectOption("450");
  await page.getByLabel("Source d’offres").selectOption("remoteok");
  assert.equal(await offerLimit.inputValue(), "200", "Remote OK's UI limit matches its feed cap");
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await chooseCampaignResume(page, "CV principal");
  await openOfferFilters(page);
  await revealCampaignActions(page);
  await page.getByRole("button", { name: "Rechercher les offres" }).click();
  await page.getByRole("heading", { name: "Offre de test Remote OK" }).waitFor();
  const sourceLink = page.getByRole("link", { name: "Source Remote OK" });
  assert.equal(await sourceLink.getAttribute("href"), "https://remoteok.com/remote-jobs/test");
  await page.getByRole("button", { name: "Rechercher et préparer un lancement" }).click();
  await confirmCampaignReview(page);

  const campaign = await waitFor(async () => {
    const { value } = await app.json("/api/career/campaigns");
    return value.campaigns[0];
  }, value => value?.state === "completed" || value?.state === "paused", 20_000);
  if (campaign.state !== "completed") {
    const { value: detail } = await app.json(`/api/career/campaigns/${campaign.id}`);
    const { value: bootstrap } = await app.json("/api/career/bootstrap");
    assert.equal(campaign.state, "completed", JSON.stringify({ campaign, items: detail.items, applications: bootstrap.applications }));
  }
  const completed = campaign;
  assert.equal(completed.counts.submitted, 1);
  const { value: snapshot } = await app.json("/api/career/bootstrap");
  assert.equal(snapshot.jobs[0].title, "Offre de test Remote OK");
  assert.equal(snapshot.jobs[0].sourceUrl, "https://remoteok.com/remote-jobs/test");
  assert.equal(snapshot.applications[0].state, "submitted");
  assert.ok(snapshot.applications[0].receipt);
  assert.equal(app.fixture.submissions.length, 1);
  assert.deepEqual(pageErrors, []);
  await mkdir("artifacts/career-ui", { recursive: true });
  await page.screenshot({ path: "artifacts/career-ui/11-remoteok-campaign.png", fullPage: true });
});

test("Himalayas search starts a verified ATS application from its attributed job page", async (t) => {
  const app = await startCareerTestServer({ mockHimalayasSearch: true });
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
  await openOfferFilters(page);
  await page.getByLabel("Source d’offres").selectOption("himalayas");
  assert.equal(await page.getByLabel("Nombre d’offres à examiner").inputValue(), "20");
  assert.equal(await page.getByLabel("Ville ou commune (facultatif)").count(), 0);
  await page.getByText("Sources et limites de collecte", { exact: true }).click();
  assert.match(await page.locator(".cw-automation-note").innerText(), /ne filtre pas par ville/);
  await page.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Product Manager");
  await chooseCampaignResume(page, "CV principal");
  await openOfferFilters(page);
  await revealCampaignActions(page);
  await page.getByRole("button", { name: "Rechercher et préparer un lancement" }).click();
  await confirmCampaignReview(page);
  const completed = await waitFor(async () => {
    const { value } = await app.json("/api/career/campaigns");
    return value.campaigns[0];
  }, campaign => campaign?.state === "completed" || campaign?.state === "paused", 10_000);
  const { value: snapshot } = await app.json("/api/career/bootstrap");
  assert.equal(completed.state, "completed", JSON.stringify(snapshot.applications.map((application: Application) => ({ state: application.state, missingFields: application.missingFields, lastError: application.lastError, jobId: application.jobId }))));
  assert.equal(completed.counts.submitted, 1);
  assert.equal(snapshot.jobs[0].sourceUrl, "https://himalayas.app/companies/test/jobs/test-role");
  assert.equal(snapshot.applications[0].state, "submitted");
  assert.ok(snapshot.applications[0].receipt);
  assert.equal(app.fixture.submissions.length, 1);
  assert.deepEqual(pageErrors, []);
});

test("test mode keeps every unmocked public source offline", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());

  for (const source of ["all-public", "arbeitnow", "jobicy", "remoteok", "himalayas", "remotive"]) {
    const { response, value } = await app.json(`/api/career/sources/${source}/search`, {
      keywords: "Engineer",
      ...(!["himalayas", "remotive"].includes(source) ? { commune: "Paris" } : {}),
    });
    assert.equal(response.status, 200, source);
    assert.deepEqual(value.jobs, [], source);
    assert.match(value.note, /Flux externe neutralisé en mode test/, source);
    if (source === "all-public") assert.match(value.note, /Remotive : Flux externe neutralisé en mode test/);
  }

  await app.json("/api/career/vault/initialize", { passphrase: "test search isolation vault" });
  await app.json("/api/career/sources/france-travail", {
    clientId: "test-client",
    clientSecret: "test-secret",
    scope: "test-scope",
  }, "POST");
  const franceTravail = await app.json("/api/career/sources/france-travail/search", { keywords: "Engineer", commune: "Paris" });
  assert.equal(franceTravail.response.status, 200);
  assert.deepEqual(franceTravail.value.jobs, []);
  assert.match(franceTravail.value.note, /Aucune offre avec lien de candidature exploitable/);
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
  await page.getByRole("button", { name: "Préparer avec vérification…", exact: true }).click();
  await confirmCampaignReview(page);
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

test("today puts active campaigns first and combines blocked, application, and contact actions", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const resume = await app.json("/api/career/resumes", {
    name: "CV relances", filename: "cv-relances.pdf", mime: "application/pdf",
    base64: Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64"),
  });
  const dueAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (let index = 1; index <= 4; index++) {
    const job = await app.json("/api/career/jobs", {
      url: `${app.fixture.baseUrl}/simple?followup=${index}`,
      title: `Relance ${index}`, company: "Fixture Relances",
    });
    const application = await app.json("/api/career/applications", {
      jobId: job.value.id, resumeId: resume.value.id,
    });
    const updated = await app.json(`/api/career/applications/${application.value.id}`, { nextActionAt: dueAt }, "PATCH");
    assert.equal(updated.response.status, 200);
  }
  const blockedJob = await app.json("/api/career/jobs", {
    url: `${app.fixture.baseUrl}/unknown`, title: "Candidature bloquée", company: "Fixture Blocage",
  });
  const blockedApplication = await app.json("/api/career/applications", {
    jobId: blockedJob.value.id, resumeId: resume.value.id,
  });
  await app.json(`/api/career/applications/${blockedApplication.value.id}/run`, { mode: "prepare" }, "POST");
  await waitFor(
    async () => (await app.json(`/api/career/applications/${blockedApplication.value.id}`)).value,
    (value) => value.state !== "running",
  );
  const blockedState = await app.json(`/api/career/applications/${blockedApplication.value.id}`);
  assert.equal(blockedState.value.state, "needs_input");
  const contactDueAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const imported = await app.json("/api/prospects/import", {
    prospects: [{
      linkedinUrl: "https://www.linkedin.com/in/amelie-fixture",
      firstName: "Amélie", lastName: "Durant", title: "Recruteuse",
      company: "Fixture Réseau", status: "Invitation acceptée",
      nextAction: "Préparer un échange", nextActionAt: contactDueAt,
    }],
  }, "POST");
  assert.equal(imported.response.status, 200);
  const snapshot = await app.json("/api/career/bootstrap");
  const campaign = await app.json("/api/career/campaigns", {
    resumeId: resume.value.id, jobIds: [snapshot.value.jobs[0].id],
    maxSubmissions: 1, idempotencyKey: "today-active-campaign",
  }, "POST");
  assert.equal(campaign.response.status, 201);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const campaignListRequests: string[] = [];
  const activeCampaignRequests: string[] = [];
  await page.route((url) => new URL(url).pathname === "/api/career/campaigns", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const requestUrl = route.request().url();
    campaignListRequests.push(requestUrl);
    const parsed = new URL(requestUrl);
    if (parsed.searchParams.get("active") !== "1") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    activeCampaignRequests.push(requestUrl);
    await route.fulfill({ response, json: { ...body, total: 11 } });
  });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  const actions = page.locator(".cw-panel").filter({ has: page.getByRole("heading", { name: "À ne pas laisser passer" }) });
  await actions.getByRole("button", { name: /Campagne · En attente/ }).waitFor();
  const rows = actions.locator(".cw-row");
  assert.match(await rows.nth(0).innerText(), /Campagne · En attente/);
  assert.match(await rows.nth(1).innerText(), /Voir les 11 campagnes actives/);
  assert.match(await rows.nth(2).innerText(), /Candidature bloquée/);
  assert.equal(await rows.count(), 8, "the list includes one campaign, one overflow link, one blocker, four application reminders, and one contact reminder");
  assert.match(await actions.locator(".cw-muted").innerText(), /11 campagne\(s\) active\(s\) · 1 candidature\(s\) à traiter · 5 relance\(s\) échue\(s\)/);

  await actions.getByRole("button", { name: "Voir les 11 campagnes actives" }).click();
  await page.getByRole("heading", { name: "Campagnes actives", level: 2 }).waitFor({ timeout: 5000 }).catch(async () => {
    assert.fail(`Expected the active campaign list. Current page: ${await page.locator("main").innerText()}`);
  });
  await page.getByText("Page 1 sur 2", { exact: true }).waitFor();
  const requestsBeforePolling = campaignListRequests.length;
  const polledActiveList = await waitFor(
    async () => campaignListRequests.slice(requestsBeforePolling).find((url) => {
      const parsed = new URL(url);
      return parsed.searchParams.get("active") === "1" && parsed.searchParams.get("offset") === "0";
    }),
    Boolean,
    6000,
  );
  assert.ok(polledActiveList, "the automatic refresh keeps the active-only filter");
  await page.getByRole("button", { name: "Suivant" }).click();
  await page.getByText("Page 2 sur 2", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Campagnes", exact: true }).click();
  await page.getByRole("heading", { name: "Campagnes de candidature", level: 2 }).waitFor();
  assert.ok(activeCampaignRequests.some((url) => new URL(url).searchParams.get("offset") === "0"));
  assert.ok(activeCampaignRequests.some((url) => new URL(url).searchParams.get("offset") === "10"));

  await page.getByRole("button", { name: "Aujourd’hui", exact: true }).click();
  const todayRows = actions.locator(".cw-row");

  await todayRows.nth(0).click();
  await page.getByRole("heading", { name: "Campagnes actives", level: 2 }).waitFor();
  await page.locator(".cw-campaign-items").waitFor();
  await page.getByRole("button", { name: "Aujourd’hui", exact: true }).click();
  await rows.filter({ hasText: "Candidature bloquée" }).first().click();
  await page.locator(".cw-drawer h2").getByText("Candidature bloquée", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Fermer la candidature" }).click();
  await page.getByRole("button", { name: "Aujourd’hui", exact: true }).click();
  await rows.filter({ hasText: "Relance contact · Amélie Durant" }).click();
  await page.getByRole("heading", { name: "Amélie Durant" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Réseau", exact: true }).getAttribute("aria-current"), "page");
  assert.deepEqual(await app.fixture.submissions, []);
});

test("keyboard tab focus has a visible outline in the active section accent", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    const style = element ? getComputedStyle(element) : null;
    return { tag: element?.tagName, outlineStyle: style?.outlineStyle, outlineWidth: style?.outlineWidth, outlineColor: style?.outlineColor };
  });
  assert.equal(focus.tag, "A", "the first keyboard stop is the app brand link");
  assert.equal(focus.outlineStyle, "solid");
  assert.equal(focus.outlineWidth, "3px");
  assert.equal(focus.outlineColor, "rgb(128, 97, 31)", "the focus ring follows the Xenogears home accent");
});

test("form controls keep a visible keyboard focus ring, including forced colors", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Offres", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Rechercher une offre" });
  await search.focus();
  const normalFocus = await search.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
  });
  assert.equal(normalFocus.outlineStyle, "solid");
  assert.equal(normalFocus.outlineWidth, "3px");
  assert.equal(normalFocus.outlineColor, "rgb(57, 117, 122)", "the search focus ring follows the Weltall-2 offers accent");

  await page.emulateMedia({ forcedColors: "active" });
  const forcedFocus = await search.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor, boxShadow: style.boxShadow };
  });
  assert.equal(forcedFocus.outlineStyle, "solid");
  assert.equal(forcedFocus.outlineWidth, "3px");
  assert.notEqual(forcedFocus.outlineColor, "rgba(0, 0, 0, 0)");
  assert.equal(forcedFocus.boxShadow, "none");
});

test("campaign review traps keyboard focus and Escape returns to its opener", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const resume = await app.json("/api/career/resumes", {
    name: "CV clavier", filename: "cv-clavier.pdf", mime: "application/pdf",
    base64: Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64"),
  });
  const job = await app.json("/api/career/jobs", { url: `${app.fixture.baseUrl}/keyboard`, title: "Poste au clavier", company: "Employeur Fixture" });
  await app.json("/api/career/applications", { jobId: job.value.id, resumeId: resume.value.id });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Candidatures", exact: true }).click();
  await page.getByRole("button", { name: "Ouvrir le suivi →" }).click();
  const trigger = page.getByRole("button", { name: "Préparer le lancement…" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Récapitulatif de campagne" });
  await dialog.waitFor();
  const initialFocus = await dialog.getByRole("button", { name: "Fermer le récapitulatif" }).evaluate((element) => document.activeElement === element);
  assert.equal(initialFocus, true, "opening the modal moves focus to its close button");

  const lastButton = dialog.getByRole("button").last();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await lastButton.evaluate((element) => document.activeElement === element), true, "Shift+Tab wraps to the last action");
  await page.keyboard.press("Tab");
  assert.equal(await dialog.getByRole("button", { name: "Fermer le récapitulatif" }).evaluate((element) => document.activeElement === element), true, "Tab wraps to the first control");

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await trigger.evaluate((element) => document.activeElement === element), true, "closing restores focus to the launch action");
});

test("primary and secondary navigation announce the active destination", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  const primaryNav = page.getByRole("navigation", { name: "Navigation principale" });
  assert.equal(await primaryNav.getByRole("button", { name: "Aujourd’hui", exact: true }).getAttribute("aria-current"), "page");
  await primaryNav.getByRole("button", { name: "Offres", exact: true }).click();
  assert.equal(await primaryNav.getByRole("button", { name: "Offres", exact: true }).getAttribute("aria-current"), "page");
  assert.equal(await primaryNav.getByRole("button", { name: "Aujourd’hui", exact: true }).getAttribute("aria-current"), null);
  await page.getByRole("navigation", { name: "Navigation secondaire" }).getByRole("button", { name: "Paramètres" }).click();
  assert.equal(await page.getByRole("navigation", { name: "Navigation secondaire" }).getByRole("button", { name: "Paramètres" }).getAttribute("aria-current"), "page");
});

test("application drawer records a structured employer response without changing the outcome", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const resume = await app.json("/api/career/resumes", {
    name: "CV retour", filename: "cv-retour.pdf", mime: "application/pdf",
    base64: Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64"),
  });
  const job = await app.json("/api/career/jobs", { url: `${app.fixture.baseUrl}/simple?response=1`, title: "Poste avec retour", company: "Employeur Fixture" });
  const application = await app.json("/api/career/applications", { jobId: job.value.id, resumeId: resume.value.id });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Candidatures", exact: true }).click();
  await page.getByRole("button", { name: "Ouvrir le suivi →" }).click();
  await page.getByRole("heading", { name: "Consigner un retour reçu" }).waitFor();
  await page.getByLabel("Date de réception").fill("2020-01-02");
  await page.getByLabel("Canal").selectOption("phone");
  await page.getByLabel("Type de retour").selectOption("interview");
  await page.getByLabel("Résumé").fill("Entretien proposé jeudi à 14 h.");
  await page.screenshot({ path: "artifacts/career-ui/12-employer-response.png", fullPage: true });
  await page.getByRole("button", { name: "Ajouter à l’historique" }).click();
  await page.getByText("Retour employeur · Entretien proposé", { exact: true }).waitFor();
  await page.getByText("Entretien proposé jeudi à 14 h.", { exact: true }).waitFor();
  await page.getByText(/Reçu le 02\/01\/2020 via Téléphone/).waitFor();
  const snapshot = (await app.json("/api/career/bootstrap")).value;
  assert.equal(snapshot.applications.find((item: Application) => item.id === application.value.id).outcome, "active");
  assert.equal(snapshot.metrics.interviews, 0);
  assert.equal(app.fixture.submissions.length, 0, "recording a manual employer response sends no application or message");
});

test("dashboard shortcuts reset the destination to its primary view", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Candidatures", exact: true }).click();
  await page.getByRole("button", { name: "Campagnes", exact: true }).click();
  await page.getByRole("button", { name: "Aujourd’hui", exact: true }).click();
  await page.getByRole("button", { name: "Tout voir →", exact: true }).click();
  await page.getByRole("heading", { name: "Vos candidatures" }).waitFor();

  await page.getByRole("button", { name: "Offres", exact: true }).click();
  await page.getByRole("button", { name: "Recherches enregistrées", exact: true }).click();
  await page.getByRole("button", { name: "Candidatures", exact: true }).click();
  await page.getByRole("button", { name: "+ Nouvelle candidature", exact: true }).click();
  await page.getByRole("heading", { name: "Trouver une offre" }).waitFor();
});

test("saved recurring searches can edit criteria and cadence", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const created = await app.json("/api/career/saved-searches?demo=0", {
    source: "arbeitnow",
    criteria: { keywords: "TypeScript", commune: "Paris", contractType: "CDI", limit: 50 },
    intervalHours: 24,
    enabled: true,
  });
  assert.equal(created.response.status, 201);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Offres", exact: true }).click();
  await page.getByRole("button", { name: "Recherches enregistrées", exact: true }).click();
  await page.getByRole("button", { name: "Modifier", exact: true }).click();
  const editor = page.getByRole("form", { name: "Modifier la recherche TypeScript" });
  await editor.getByLabel("Mots-clés").fill("Product designer");
  await editor.getByLabel("Ville ou commune").fill("Lyon");
  await editor.getByLabel("Type de contrat").fill("CDI");
  await editor.getByLabel("Nombre d’offres").selectOption("100");
  await editor.getByLabel("Fréquence").selectOption("168");
  await editor.getByRole("button", { name: "Enregistrer les changements" }).click();

  const { value } = await app.json("/api/career/saved-searches?demo=0");
  assert.deepEqual(value.searches[0].criteria, { keywords: "Product designer", commune: "Lyon", contractType: "CDI", limit: 100 });
  assert.equal(value.searches[0].intervalHours, 168);
  assert.equal(value.searches[0].enabled, true);
});
