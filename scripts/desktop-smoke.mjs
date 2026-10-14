import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { connect, createServer as createNetServer } from "node:net";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron } from "playwright";

const executablePath = resolve(
  process.env.ANIMA_DESKTOP_EXECUTABLE || "release/win-unpacked/Anima Desktop.exe",
);
if (process.env.CI === "true" && process.env.ANIMA_SMOKE_NO_SANDBOX === "1") {
  throw new Error("Le smoke test CI doit conserver le sandbox Chromium activé.");
}
const fixtureSubmissions = [];
let pauseFixtureRequests = 0;
let pauseGateOpen = false;
const pauseFixtureReleases = [];
function releasePauseFixtures() {
  pauseGateOpen = true;
  for (const release of pauseFixtureReleases.splice(0)) release();
}
const fixture = createServer(async (req, res) => {
  const requestPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (req.method === "GET" && ["/apply", "/apply-campaign", "/apply-pause"].includes(requestPath)) {
    if (requestPath === "/apply-pause") {
      pauseFixtureRequests++;
      await new Promise((resolvePause) => {
        if (pauseGateOpen) resolvePause();
        else pauseFixtureReleases.push(resolvePause);
      });
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="fr"><body>
      <h1>Poste de test</h1>
      <form method="post" action="/submit" enctype="multipart/form-data">
        <label>Prénom <input name="firstName" required></label>
        <label>Nom <input name="lastName" required></label>
        <label>Adresse e-mail <input type="email" name="email" required></label>
        <label>CV <input type="file" name="resume" required></label>
        <button type="submit">Postuler</button>
      </form>
    </body></html>`);
    return;
  }
  if (req.method === "POST" && req.url === "/submit") {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    fixtureSubmissions.push(Buffer.concat(chunks));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><body><h1>Merci pour votre candidature.</h1><p>Candidature reçue. Référence : AC-1234</p></body></html>");
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen(server.address());
    });
  });
}

function requestJson(window, path, method = "GET", body) {
  return window.evaluate(async ({ path, method, body }) => {
    const headers = method === "GET" ? {} : {
      "Content-Type": "application/json",
      "X-Anima-Request": "1",
    };
    return window.anima.request({
      method,
      path,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }, { path, method, body });
}

function parseJson(reply, expectedStatus) {
  assert.equal(reply.status, expectedStatus, reply.body);
  return JSON.parse(reply.body);
}

async function waitForApplication(window, id, expectedState, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = parseJson(await requestJson(window, `/api/career/applications/${id}`), 200);
    if (last.state === expectedState) return last;
    if (!["running", "submitting"].includes(last.state)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  assert.fail(`Candidature attendue en état ${expectedState}, reçue : ${JSON.stringify(last)}`);
}

async function waitForCampaign(window, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const value = parseJson(await requestJson(window, "/api/career/campaigns"), 200);
    last = value.campaigns[0];
    if (last?.state === "completed") return last;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  assert.fail(`Campagne attendue terminée, état reçu : ${JSON.stringify(last)}`);
}

async function waitForCampaignState(window, id, expectedState, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = parseJson(await requestJson(window, `/api/career/campaigns/${id}`), 200);
    if (last.campaign.state === expectedState) return last;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.fail(`Campagne ${id} attendue en état ${expectedState}, état reçu : ${JSON.stringify(last?.campaign?.state)}`);
}

async function findCampaignRowBySubmissionCap(window, maxSubmissions) {
  const rows = window.locator(".cw-campaign-row").filter({ hasText: `plafond ${maxSubmissions}` });
  await rows.first().waitFor({ state: "visible" });
  assert.equal(await rows.count(), 1, `Une campagne doit afficher le plafond unique ${maxSubmissions}.`);
  return rows;
}

async function getFreePort() {
  const server = createNetServer();
  const address = await listen(server);
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function assertNoHttpListener(port) {
  await new Promise((resolveCheck, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Un serveur HTTP écoute sur le port ${port} dans l’application bureau.`));
    });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") resolveCheck();
      else reject(error);
    });
  });
}

async function assertSingleInstance(exe, env, userData) {
  const child = spawn(exe, [`--user-data-dir=${userData}`], { env, stdio: "ignore", windowsHide: true });
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Le second lancement ne s’est pas fermé."));
    }, 15_000);
    child.once("exit", (exitCode) => { clearTimeout(timer); resolveExit(exitCode); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  assert.equal(code, 0, "Le deuxième lancement doit quitter proprement après le verrou d’instance.");
}

let application;
let restarted;
let diagnosticWindow;
let activeSmokeCampaignId;
let userDataDir;
let smokeError;
try {
  const fixtureAddress = await listen(fixture);
  const fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;
  const expectedPort = await getFreePort();
  userDataDir = await mkdtemp(join(tmpdir(), "anima-connect-desktop-smoke-"));
  const resolvedTemp = resolve(tmpdir());
  const resolvedUserData = resolve(userDataDir);
  if (!isAbsolute(resolvedUserData) || !resolvedUserData.startsWith(resolvedTemp + sep)) {
    throw new Error("Le dossier de données temporaire de test est hors de son répertoire prévu.");
  }
  const env = {
    ...process.env,
    PORT: String(expectedPort),
    ANIMA_TEST_MODE: "1",
    CAREER_TEST_ORIGINS: JSON.stringify([fixtureOrigin]),
    CAREER_TEST_ARBEITNOW_URL: `${fixtureOrigin}/apply-campaign`,
    CAREER_HEADLESS: "1",
  };
  const launchArgs = [`--user-data-dir=${userDataDir}`];
  if (process.env.ANIMA_SMOKE_NO_SANDBOX === "1") launchArgs.push("--no-sandbox");
  const launchOptions = {
    executablePath,
    args: launchArgs,
    env,
  };

  application = await electron.launch(launchOptions);
  const window = diagnosticWindow = await application.firstWindow();
  await window.waitForLoadState("load");
  assert.match(await window.title(), /Anima Desktop/i);
  const skipLink = window.getByRole("link", { name: "Passer au contenu", exact: true });
  await window.keyboard.press("Tab");
  assert.equal(await skipLink.evaluate((element) => element === document.activeElement), true,
    "Le premier Tab doit proposer un accès direct au contenu principal.");
  await window.keyboard.press("Enter");
  const mainContent = window.locator("#career-content");
  assert.equal(await mainContent.evaluate((element) => element === document.activeElement), true,
    "Activer le lien d’évitement doit placer le focus sur le contenu principal.");
  const todayNavigation = window.getByRole("button", { name: "Aujourd’hui", exact: true });
  await todayNavigation.waitFor({ state: "visible" });
  await window.setViewportSize({ width: 1366, height: 768 });
  const homeOffersButton = window.getByRole("button", { name: /Trouver des offres/ });
  await homeOffersButton.focus();
  await window.keyboard.press("Enter");
  const offerKeyword = window.getByLabel("Métier(s) ou mot(s)-clé(s)");
  await offerKeyword.waitFor({ state: "visible" });
  assert.equal(await offerKeyword.evaluate((input) => input === document.activeElement), true,
    "Depuis Aujourd’hui, Entrée doit ouvrir Offres et placer le focus dans la recherche.");
  await todayNavigation.focus();
  await window.keyboard.press("Tab");
  const offersNavigation = window.getByRole("button", { name: "Offres", exact: true });
  assert.equal(await offersNavigation.evaluate((element) => element === document.activeElement), true,
    "Tab depuis Aujourd’hui doit avancer vers Offres dans la navigation principale.");
  await window.keyboard.press("Enter");
  assert.equal(await offersNavigation.getAttribute("aria-current"), "page",
    "Entrée doit ouvrir Offres et signaler la destination active.");
  const firstOffers = parseJson(await requestJson(window, "/api/career/bootstrap"), 200);
  assert.equal(firstOffers.jobs.length, 0, "Le smoke doit commencer avec une liste d’offres vierge.");
  assert.equal(firstOffers.resumes.length, 0, "Le smoke doit couvrir le parcours sans CV.");
  const addResumeButton = window.getByRole("button", { name: "Ajouter un CV →", exact: true });
  await addResumeButton.focus();
  await window.keyboard.press("Enter");
  const profileHeading = window.getByRole("heading", { name: "Votre profil. Vos possibilités.", exact: true });
  await profileHeading.waitFor({ state: "visible" });
  const resumeUpload = window.getByLabel("Ajouter un CV");
  assert.equal(await resumeUpload.evaluate((input) => input === document.activeElement), true,
    "Depuis Offres sans CV, Entrée doit ouvrir le profil et placer le focus sur l’ajout de CV.");
  await offersNavigation.click();
  await window.getByRole("button", { name: "Candidatures", exact: true }).click();
  await window.getByText("Choisissez une offre et un CV. Le moteur s’occupe du parcours pris en charge.", { exact: true }).waitFor();
  const viewOffersButton = window.getByRole("button", { name: /Voir les offres/ });
  await viewOffersButton.focus();
  await window.keyboard.press("Enter");
  await offerKeyword.waitFor({ state: "visible" });
  assert.equal(await offerKeyword.evaluate((input) => input === document.activeElement), true,
    "Depuis Candidatures vide, Entrée doit ouvrir Offres et placer le focus dans la recherche.");
  await window.getByText("Importez des offres ou ajoutez votre premier lien pour commencer.", { exact: true }).waitFor();
  const addOfferDetails = window.locator("details.cw-details").filter({
    has: window.getByText("Ajouter une offre avec son lien", { exact: true }),
  });
  const addOfferButton = window.getByRole("button", { name: "Ajouter une offre", exact: true });
  await addOfferButton.focus();
  await window.keyboard.press("Enter");
  assert.equal(await addOfferDetails.evaluate((details) => details.open), true,
    "L’action depuis l’état vide doit ouvrir le formulaire du lien.");
  const offerUrl = window.getByLabel("URL de l’offre");
  assert.equal(await offerUrl.evaluate((input) => input === document.activeElement), true,
    "L’action depuis l’état vide doit placer le curseur dans le champ URL.");
  await addOfferDetails.locator("summary").click();
  await mkdir("artifacts/career-ui", { recursive: true });
  await window.screenshot({ path: "artifacts/career-ui/03-offers-1366-packaged.png" });
  await window.setViewportSize({ width: 390, height: 844 });
  assert.equal(await offerKeyword.isVisible(), true, "La recherche reste visible sur un écran de 390 px.");
  const mobileLayout = await window.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(mobileLayout.content <= mobileLayout.viewport + 1, `La vue mobile ne doit pas déborder horizontalement : ${JSON.stringify(mobileLayout)}`);
  await window.screenshot({ path: "artifacts/career-ui/03-offers-390-packaged.png" });
  await window.setViewportSize({ width: 1366, height: 768 });
  const defaultZoomRatio = await window.evaluate(() => window.devicePixelRatio);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2);
  });
  await window.waitForFunction(
    (defaultRatio) => window.devicePixelRatio >= defaultRatio * 1.9,
    defaultZoomRatio,
  );
  const zoomedOfferLayout = await window.evaluate(() => ({
    ratio: window.devicePixelRatio,
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(zoomedOfferLayout.ratio >= defaultZoomRatio * 1.9,
    `Le zoom à 200 % doit agrandir le contenu : ${JSON.stringify(zoomedOfferLayout)}`);
  assert.ok(zoomedOfferLayout.content <= zoomedOfferLayout.viewport + 1,
    `Les offres ne doivent pas déborder horizontalement à 200 % : ${JSON.stringify(zoomedOfferLayout)}`);
  assert.equal(await offerKeyword.isVisible(), true, "La recherche reste visible à 200 %.");
  await window.screenshot({ path: "artifacts/career-ui/03-offers-zoom-packaged.png" });
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5);
  });
  await window.waitForFunction(
    (defaultRatio) => window.devicePixelRatio >= defaultRatio * 1.4 &&
      window.devicePixelRatio < defaultRatio * 1.6,
    defaultZoomRatio,
  );
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1);
  });
  await window.waitForFunction(
    (defaultRatio) => Math.abs(window.devicePixelRatio - defaultRatio) < 0.01,
    defaultZoomRatio,
  );
  await window.keyboard.press("Tab");
  const keyboardFocus = await window.evaluate(() => {
    const active = document.activeElement;
    const style = getComputedStyle(active);
    return {
      visible: active.matches(":focus-visible"),
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
    };
  });
  assert.equal(keyboardFocus.visible, true, "La navigation clavier doit afficher un focus visible.");
  assert.equal(keyboardFocus.outlineWidth, "3px", "Le focus visible doit garder un anneau de 3 px.");
  assert.equal(keyboardFocus.outlineStyle, "solid");
  await window.emulateMedia({ forcedColors: "active" });
  assert.equal(await window.evaluate(() => matchMedia("(forced-colors: active)").matches), true);
  const forcedColorsFocus = await window.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return { outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle };
  });
  assert.equal(forcedColorsFocus.outlineWidth, "3px", "Le focus reste visible en couleurs forcées.");
  assert.equal(forcedColorsFocus.outlineStyle, "solid");
  await window.emulateMedia({ forcedColors: "none" });
  assert.equal((await application.windows()).length, 1);
  await assertNoHttpListener(expectedPort);
  await assertSingleInstance(executablePath, env, userDataDir);

  const rendererRequests = await window.evaluate(() =>
    performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => /^https?:/i.test(url)),
  );
  assert.deepEqual(rendererRequests, [], "Le renderer bureau ne doit faire aucune requête HTTP.");

  const bootstrap = parseJson(await requestJson(window, "/api/career/bootstrap"), 200);
  assert.deepEqual(bootstrap.jobs, []);
  await window.getByRole("button", { name: "Profil & CV" }).click();
  await window.getByLabel("Prénom").fill("Camille");
  await window.getByLabel("Nom", { exact: true }).fill("Martin");
  await window.getByLabel("Email").fill("camille.martin@example.test");
  await window.getByLabel("Ville").fill("Paris");
  await window.getByLabel("Pays").fill("France");
  await window.getByText("Brouillon sauvegardé automatiquement", { exact: true }).waitFor({ timeout: 10_000 });
  await window.getByRole("button", { name: "Offres", exact: true }).click();
  await window.getByRole("button", { name: "Profil & CV" }).click();
  assert.equal(await window.getByLabel("Email").inputValue(), "camille.martin@example.test");
  await window.reload();
  await window.waitForLoadState("load");
  await window.getByRole("button", { name: "Profil & CV" }).click();
  assert.equal(await window.getByLabel("Prénom").inputValue(), "Camille");
  assert.equal(await window.getByLabel("Ville").inputValue(), "Paris");
  await mkdir("artifacts/career-ui", { recursive: true });
  await window.screenshot({ path: "artifacts/career-ui/10-profile-draft-recovery-packaged.png" });
  await window.getByRole("button", { name: "Enregistrer le profil" }).click();
  await window.getByText("Profil enregistré", { exact: true }).waitFor({ timeout: 10_000 });
  const profileAfterSave = parseJson(await requestJson(window, "/api/career/bootstrap"), 200);
  assert.equal(profileAfterSave.profile.email, "camille.martin@example.test");
  assert.equal(profileAfterSave.profileDraft, null, "L’enregistrement explicite doit effacer le brouillon restauré.");

  const firstResumeBytes = Buffer.from("%PDF-1.7\nCV non sélectionné\n%%EOF\n");
  const selectedResumeBytes = Buffer.from("%PDF-1.7\nANIMA-DESKTOP-SMOKE-SELECTED-CV\n%%EOF\n");
  const firstResume = parseJson(await requestJson(window, "/api/career/resumes", "POST", {
    name: "CV non sélectionné",
    filename: "non-selectionne.pdf",
    mime: "application/pdf",
    base64: firstResumeBytes.toString("base64"),
  }), 201);
  const selectedResume = parseJson(await requestJson(window, "/api/career/resumes", "POST", {
    name: "CV sélectionné",
    filename: "cv-selectionne.pdf",
    mime: "application/pdf",
    base64: selectedResumeBytes.toString("base64"),
  }), 201);
  assert.notEqual(firstResume.id, selectedResume.id);

  const job = parseJson(await requestJson(window, "/api/career/jobs", "POST", {
    url: `${fixtureOrigin}/apply`,
    sourceUrl: `${fixtureOrigin}/apply`,
    title: "Ingénieure logiciel",
    company: "Entreprise de test",
    location: "Paris",
  }), 201);
  const created = parseJson(await requestJson(window, "/api/career/applications", "POST", {
    jobId: job.id,
    resumeId: selectedResume.id,
  }), 201);

  parseJson(await requestJson(window, `/api/career/applications/${created.id}/run`, "POST", { mode: "prepare" }), 202);
  const ready = await waitForApplication(window, created.id, "ready");
  assert.equal(ready.resumeId, selectedResume.id);
  assert.equal(fixtureSubmissions.length, 0, "La préparation ne doit jamais envoyer le formulaire.");

  parseJson(await requestJson(window, `/api/career/applications/${created.id}/run`, "POST", { mode: "submit" }), 202);
  const submitted = await waitForApplication(window, created.id, "submitted");
  assert.equal(fixtureSubmissions.length, 1, "La candidature fixture doit être envoyée exactement une fois.");
  assert.match(fixtureSubmissions[0].toString("utf8"), /camille\.martin@example\.test/);
  assert.ok(fixtureSubmissions[0].includes(selectedResumeBytes), "Le formulaire doit recevoir le CV sélectionné.");
  assert.ok(!fixtureSubmissions[0].includes(firstResumeBytes), "Le formulaire ne doit pas recevoir l’autre CV.");
  assert.match(submitted.receipt?.reference || "", /AC-1234/);

  // CVs were inserted through the local API above, so reload the UI to refresh its
  // snapshot and explicitly choose the intended CV before creating the campaign.
  await window.reload();
  await window.waitForLoadState("load");
  await window.getByRole("button", { name: "Candidatures", exact: true }).click();
  await window.getByLabel("CV pour les candidatures").selectOption(selectedResume.id);
  await window.getByRole("button", { name: "Offres", exact: true }).click();
  const offerListSearch = window.getByLabel("Rechercher une offre");
  await offerListSearch.fill("Aucune correspondance smoke R03");
  await window.getByText("Aucune offre ne correspond à ces filtres.").waitFor();
  await mkdir("artifacts/career-ui", { recursive: true });
  await window.screenshot({ path: "artifacts/career-ui/03-offers-empty-packaged.png" });
  await window.getByRole("button", { name: "Afficher toutes les offres", exact: true }).click();
  assert.equal(await window.locator(".cw-job").count(), 1, "L’action de l’état vide doit rétablir l’offre filtrée.");
  await window.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await window.getByText("Collecte programmée et candidature", { exact: true }).click();
  const launchReviewButton = window.getByRole("button", { name: "Rechercher et préparer un lancement" });
  await launchReviewButton.click();
  const campaignReviewHeading = window.getByRole("heading", { name: "Récapitulatif de campagne" });
  await campaignReviewHeading.waitFor({ state: "visible" });
  const campaignReviewDialog = window.getByRole("dialog", { name: "Récapitulatif de campagne" });
  const dialogCloseButton = campaignReviewDialog.getByRole("button", { name: "Fermer le récapitulatif" });
  assert.equal(await dialogCloseButton.evaluate((element) => element === document.activeElement), true, "L’ouverture doit placer le focus dans le récapitulatif.");
  await window.keyboard.press("Shift+Tab");
  const lastDialogButton = campaignReviewDialog.getByRole("button", { name: "Créer la campagne sans envoi" });
  assert.equal(await lastDialogButton.evaluate((element) => element === document.activeElement), true, "Maj+Tab depuis le premier contrôle doit rester dans le dialogue.");
  await window.keyboard.press("Tab");
  assert.equal(await dialogCloseButton.evaluate((element) => element === document.activeElement), true, "Tab depuis le dernier contrôle doit revenir au premier.");
  await window.keyboard.press("Escape");
  await campaignReviewHeading.waitFor({ state: "hidden" });
  const restoredFocus = await launchReviewButton.evaluate((element) => ({
    returned: element === document.activeElement,
    activeTag: document.activeElement?.tagName,
    activeText: document.activeElement?.textContent?.trim().slice(0, 80),
  }));
  assert.equal(restoredFocus.returned, true, `Fermer le récapitulatif par Échap doit rendre le focus au bouton déclencheur : ${JSON.stringify(restoredFocus)}`);
  assert.equal(fixtureSubmissions.length, 1, "Fermer le récapitulatif ne doit envoyer aucun formulaire.");
  await launchReviewButton.click();
  await window.getByRole("heading", { name: "Récapitulatif de campagne" }).waitFor({ state: "visible" });
  await window.locator('input[name="campaign-mode"][value="submit"]').check();
  await window.getByRole("button", { name: "Confirmer et envoyer" }).click();
  const campaign = await waitForCampaign(window);
  assert.equal(campaign.counts.submitted, 1, "La campagne bureau doit envoyer le formulaire fixture.");
  assert.equal(fixtureSubmissions.length, 2, "Chaque candidature fixture doit être envoyée exactement une fois.");
  assert.ok(fixtureSubmissions[1].includes(selectedResumeBytes), "La campagne doit reprendre le CV choisi.");
  await window.getByText("Terminée", { exact: true }).waitFor();

  const queuedJob = parseJson(await requestJson(window, "/api/career/jobs", "POST", {
    url: `${fixtureOrigin}/apply-campaign?queued=1`,
    sourceUrl: `${fixtureOrigin}/apply-campaign?queued=1`,
    title: "Campagne à reprendre",
    company: "Entreprise de test",
    location: "Paris",
  }), 201);
  const queuedCampaign = parseJson(await requestJson(window, "/api/career/campaigns", "POST", {
    jobIds: [queuedJob.id],
    resumeId: selectedResume.id,
    maxSubmissions: 1,
    idempotencyKey: "anima-desktop-smoke-persisted-queue",
  }), 201);
  assert.equal(queuedCampaign.campaign.state, "queued", "La campagne reste en attente de confirmation humaine.");
  assert.equal(fixtureSubmissions.length, 2, "La mise en file d’attente ne doit déclencher aucun envoi.");

  const pauseJobs = [];
  for (const [title, url] of [
    ["Campagne initiale smoke", `${fixtureOrigin}/apply-campaign?step=1`],
    ["Campagne secondaire smoke", `${fixtureOrigin}/apply-campaign?step=2`],
    ["Campagne pause smoke", `${fixtureOrigin}/apply-pause?hold=1`],
    ["Campagne reprise smoke", `${fixtureOrigin}/apply-campaign?step=4`],
  ]) {
    pauseJobs.push(parseJson(await requestJson(window, "/api/career/jobs", "POST", {
      url, sourceUrl: url, title, company: "Fixture Anima Desktop", location: "Paris",
    }), 201));
  }
  const pauseCampaign = parseJson(await requestJson(window, "/api/career/campaigns", "POST", {
    jobIds: pauseJobs.map((item) => item.id), resumeId: selectedResume.id, maxSubmissions: 4,
    idempotencyKey: "anima-desktop-smoke-pause-resume",
  }), 201);
  activeSmokeCampaignId = pauseCampaign.campaign.id;
  const stopJob = parseJson(await requestJson(window, "/api/career/jobs", "POST", {
    url: `${fixtureOrigin}/apply`, title: "Campagne arrêt smoke", company: "Fixture Anima Desktop", location: "Paris",
  }), 201);
  const stopCampaign = parseJson(await requestJson(window, "/api/career/campaigns", "POST", {
    jobIds: [stopJob.id], resumeId: selectedResume.id, maxSubmissions: 2,
    idempotencyKey: "anima-desktop-smoke-stop",
  }), 201);
  const skipJob = parseJson(await requestJson(window, "/api/career/jobs", "POST", {
    url: `${fixtureOrigin}/apply`, title: "Campagne offre passée smoke", company: "Fixture Anima Desktop", location: "Paris",
  }), 201);
  const skipCampaign = parseJson(await requestJson(window, "/api/career/campaigns", "POST", {
    jobIds: [skipJob.id], resumeId: selectedResume.id, maxSubmissions: 3,
    idempotencyKey: "anima-desktop-smoke-skip",
  }), 201);
  assert.equal(pauseCampaign.campaign.state, "queued");
  assert.equal(stopCampaign.campaign.state, "queued");
  assert.equal(skipCampaign.campaign.state, "queued");
  assert.equal(fixtureSubmissions.length, 2, "La préparation des campagnes de contrôle ne doit rien envoyer.");

  await window.getByRole("button", { name: "Candidatures", exact: true }).click();
  await window.getByRole("button", { name: "Campagnes", exact: true }).click();
  await (await findCampaignRowBySubmissionCap(window, 4))
    .getByRole("button", { name: "Reprendre", exact: true }).click();
  await waitForCampaignState(window, pauseCampaign.campaign.id, "running");
  const pauseRequestDeadline = Date.now() + 10_000;
  while (pauseFixtureRequests === 0 && Date.now() < pauseRequestDeadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.ok(pauseFixtureRequests > 0, "La campagne doit être entrée dans la page fixture suspendue avant sa pause.");
  await (await findCampaignRowById(window, pauseCampaign.campaign.id))
    .getByRole("button", { name: "Pause", exact: true }).click();
  releasePauseFixtures();
  const pausedCampaign = await waitForCampaignState(window, pauseCampaign.campaign.id, "paused");
  const pauseDrainDeadline = Date.now() + 15_000;
  let pausedAndDrained = pausedCampaign;
  while (Date.now() < pauseDrainDeadline &&
    (pausedAndDrained.campaign.state !== "paused" || pausedAndDrained.campaign.counts.running !== 0)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    pausedAndDrained = parseJson(await requestJson(window, `/api/career/campaigns/${pauseCampaign.campaign.id}`), 200);
  }
  assert.equal(pausedAndDrained.campaign.state, "paused");
  assert.equal(pausedAndDrained.campaign.counts.running, 0, "Pause attend la fin de l’offre en cours.");
  assert.equal(pausedAndDrained.items.filter((item) => item.state === "pending").length, 1,
    "Mettre en pause conserve les offres restantes après l’offre déjà engagée.");
  assert.equal(pausedAndDrained.items.filter((item) => item.state === "submitted").length, 3);
  assert.equal(fixtureSubmissions.length, 5, "Seules les trois offres locales déjà engagées ont été traitées.");
  await (await findCampaignRowById(window, pauseCampaign.campaign.id))
    .getByRole("button", { name: "Reprendre", exact: true }).waitFor({ state: "visible" });
  await (await findCampaignRowById(window, pauseCampaign.campaign.id))
    .getByRole("button", { name: "Reprendre", exact: true }).click();
  const resumedCampaign = await waitForCampaignState(window, pauseCampaign.campaign.id, "completed");
  activeSmokeCampaignId = null;
  assert.equal(resumedCampaign.items.filter((item) => item.state === "submitted").length, 4,
    "La reprise traite la seule offre restante après la pause.");
  assert.equal(fixtureSubmissions.length, 6, "La reprise envoie uniquement la dernière candidature synthétique locale.");

  const stopRow = await findCampaignRowBySubmissionCap(window, 2);
  await stopRow.getByRole("button", { name: "Arrêter", exact: true }).click();
  const stoppedControl = await waitForCampaignState(window, stopCampaign.campaign.id, "stopped");
  assert.equal(stoppedControl.items.filter((item) => item.state === "pending").length, 1,
    "Arrêter conserve l’offre en attente pour l’audit sans la lancer.");
  const skipRow = await findCampaignRowBySubmissionCap(window, 3);
  await skipRow.getByRole("button", { name: "Détails", exact: true }).click();
  await skipRow.getByRole("button", { name: "Passer cette offre", exact: true }).waitFor({ state: "visible" });
  await skipRow.getByRole("button", { name: "Passer cette offre", exact: true }).click();
  const skippedControl = await waitForCampaignState(window, skipCampaign.campaign.id, "completed");
  assert.equal(skippedControl.campaign.counts.skipped, 1, "Passer une offre la marque comme ignorée et termine la campagne.");
  assert.equal(fixtureSubmissions.length, 6, "Arrêter et passer une offre ne déclenchent aucun envoi.");

  const backupPassphrase = "AnimaDesktopSmokeRestore-2026";
  const portableBackup = await window.evaluate(async (passphrase) => window.anima.request({
    method: "POST",
    path: "/api/backup?demo=0",
    headers: { "Content-Type": "application/json", "X-Anima-Request": "1" },
    body: JSON.stringify({ passphrase }),
  }), backupPassphrase);
  assert.equal(portableBackup.status, 200, "La sauvegarde chiffrée doit être exportée dans l’app empaquetée.");
  assert.equal(portableBackup.base64, true, "Le fichier de sauvegarde doit traverser le pont IPC en binaire.");
  const stoppedCampaign = parseJson(await requestJson(window, `/api/career/campaigns/${queuedCampaign.campaign.id}/stop`, "POST", {}), 200);
  assert.equal(stoppedCampaign.campaign.state, "stopped", "La campagne de fixture doit être arrêtée avant restauration.");
  const restoredBackup = await window.evaluate(async ({ passphrase, portableBackup }) => window.anima.request({
    method: "POST",
    path: "/api/restore?demo=0",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Anima-Request": "1",
      "X-Anima-Backup-Passphrase-Base64": btoa(passphrase),
    },
    body: { base64: portableBackup },
  }), { passphrase: backupPassphrase, portableBackup: portableBackup.body });
  assert.equal(restoredBackup.status, 200, restoredBackup.body);
  assert.equal(JSON.parse(restoredBackup.body).restored, true);
  const campaignsAfterRestore = parseJson(await requestJson(window, "/api/career/campaigns"), 200);
  const restoredQueueAfterRestore = campaignsAfterRestore.campaigns.find((item) => item.id === queuedCampaign.campaign.id);
  assert.equal(restoredQueueAfterRestore?.state, "queued", "La restauration doit rétablir la campagne en attente sans l’exécuter.");
  assert.equal(fixtureSubmissions.length, 2, "La restauration ne doit déclencher aucun envoi.");

  // Exercise the offer toolbar in the installed Windows renderer using local
  // rows only; none of these external-looking links are opened during the smoke.
  parseJson(await requestJson(window, "/api/career/jobs", "POST", {
    url: "https://jobicy.com/jobs/anima-desktop-smoke-analyst",
    title: "Analyste données",
    company: "Alpha Data",
    location: "Lyon",
    description: "Offre synthétique pour vérifier la recherche locale.",
  }), 201);
  parseJson(await requestJson(window, "/api/career/jobs", "POST", {
    url: "https://remoteok.com/remote-jobs/anima-desktop-smoke-qa",
    title: "Remote QA Engineer",
    company: "Zeta Studio",
    location: "France",
    description: "Offre synthétique, aucun formulaire externe ne sera ouvert.",
  }), 201);
  await window.reload();
  await window.waitForLoadState("load");
  await window.getByRole("button", { name: "Offres", exact: true }).click();
  const offerCards = window.locator(".cw-job");
  await window.getByRole("heading", { name: "Analyste données" }).waitFor();
  await window.getByRole("heading", { name: "Remote QA Engineer" }).waitFor();
  assert.ok(await offerCards.count() >= 3, "Les offres existantes et les offres synthétiques doivent apparaître dans l’app installée.");
  const today = await window.evaluate(() => {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  });
  await window.getByLabel("Repérée depuis").fill(today);
  await window.getByLabel("Repérée jusqu’au").fill(today);
  assert.ok(await offerCards.count() >= 3, "La période locale doit conserver les offres découvertes aujourd’hui.");
  await window.getByLabel("Filtrer par candidature").selectOption("applied");
  assert.ok(await offerCards.count() >= 1, "Le filtre candidature doit retrouver une offre suivie.");
  await window.getByLabel("Filtrer par candidature").selectOption("unapplied");
  await window.getByRole("heading", { name: "Remote QA Engineer" }).waitFor();
  await window.getByRole("button", { name: "Effacer les filtres" }).click();
  const offerQuery = window.getByLabel("Rechercher une offre");
  await offerQuery.fill("remote qa");
  assert.equal(await window.locator(".cw-job").count(), 1, "La recherche locale doit réduire la liste au résultat correspondant.");
  await window.getByLabel("Filtrer par source").selectOption({ label: "Remote OK" });
  assert.equal(await window.locator(".cw-job").count(), 1, "Le filtre par source doit s’appliquer au résultat.");
  await window.getByRole("heading", { name: "Remote QA Engineer" }).waitFor();
  await window.getByRole("button", { name: "Effacer les filtres" }).click();
  await window.getByLabel("Trier les offres").selectOption("company");
  const companies = await offerCards.evaluateAll((cards) => cards.map((card) =>
    card.querySelector("p")?.textContent?.split("·")[0]?.trim() ?? "",
  ));
  assert.deepEqual(companies, [...companies].sort((left, right) => left.localeCompare(right, "fr")),
    "Le tri alphabétique doit suivre l’entreprise dans l’app installée.");
  const comfortableView = window.getByRole("button", { name: "Vue confortable" });
  assert.equal(await window.locator(".cw-job-density").getAttribute("aria-pressed"), "true",
    "La densité compacte doit être activée par défaut dans l’app installée.");
  await comfortableView.click();
  assert.equal(await window.locator(".cw-job-density").getAttribute("aria-pressed"), "false");
  assert.equal(await window.locator(".cw-jobs").evaluate((node) => node.classList.contains("is-compact")), false);
  await window.getByRole("button", { name: "Vue compacte" }).click();
  assert.equal(await window.locator(".cw-job-density").getAttribute("aria-pressed"), "true");
  assert.equal(await window.locator(".cw-jobs").evaluate((node) => node.classList.contains("is-compact")), true);
  await mkdir("artifacts/career-ui", { recursive: true });
  await window.screenshot({ path: "artifacts/career-ui/09-offer-filters-packaged.png" });

  // Verify the reorganized destinations and their legacy embedded screens in
  // the installed app without changing preferences or triggering any sends.
  const visit = async (buttonName, headingName) => {
    await window.getByRole("button", { name: buttonName, exact: true }).click();
    await window.getByRole("heading", { name: headingName, exact: true, level: 1 }).waitFor();
  };
  await visit("Aujourd’hui", "Bonjour Camille.");
  await visit("Candidatures", "Vos candidatures");
  const applicationSearch = window.getByRole("searchbox", { name: "Rechercher une candidature" });
  await applicationSearch.fill("Ingénieure logiciel");
  assert.ok(await window.locator(".cw-application").count() >= 1, "La recherche doit retrouver une candidature par intitulé.");
  await window.getByLabel("Filtrer par état de candidature").selectOption("submitted");
  assert.ok(await window.locator(".cw-application").count() >= 1, "Le filtre d’état doit garder les candidatures envoyées correspondantes.");
  await window.getByLabel("Filtrer par retour employeur").selectOption("active");
  await window.getByLabel("Trier les candidatures").selectOption("action");
  await window.getByRole("button", { name: "Effacer les filtres" }).click();
  assert.ok(await window.locator(".cw-application").count() >= 1, "La remise à zéro doit restaurer la liste des candidatures.");
  await visit("Profil & CV", "Votre profil. Vos possibilités.");
  await window.getByRole("button", { name: "Réseau", exact: true }).click();
  await window.getByRole("button", { name: "Recherches LinkedIn", exact: true }).click();
  await window.getByRole("heading", { name: "Recherches enregistrées", exact: true, level: 1 }).waitFor();
  const networkSearchName = "Recherche smoke R18";
  await window.getByLabel("Nom de la recherche").fill(networkSearchName);
  await window.getByLabel("Intitulés de poste").fill("Responsable recrutement");
  await window.getByLabel("Pays, régions ou villes").fill("Paris");
  await window.getByRole("button", { name: "Enregistrer la recherche", exact: true }).click();
  await window.getByText("Recherche enregistrée.", { exact: true }).waitFor();
  const savedNetworkSearch = parseJson(await requestJson(window, "/api/bootstrap"), 200).searches
    .find((item) => item.name === networkSearchName);
  assert.ok(savedNetworkSearch?.id, "Les critères saisis doivent être enregistrés localement.");
  assert.deepEqual(savedNetworkSearch.filters.titles, ["Responsable recrutement"]);
  await window.getByRole("button", { name: /Ajouter un prospect manuellement à cette recherche/ }).click();
  const manualCandidate = window.locator(".candidate").first();
  await manualCandidate.getByLabel("Prénom").fill("Nadia");
  await manualCandidate.getByLabel("Nom", { exact: true }).fill("Leroy");
  await manualCandidate.getByLabel("URL du profil").fill("https://www.linkedin.com/in/anima-desktop-smoke-r18-nadia/");
  await manualCandidate.getByLabel("Poste").fill("Responsable recrutement");
  await manualCandidate.getByLabel("Entreprise").fill("Atelier Horizon");
  await manualCandidate.getByLabel("Lieu").fill("Paris");
  await window.getByRole("button", { name: "Importer les profils sélectionnés", exact: true }).click();
  await window.getByRole("heading", { name: "Contacts", exact: true, level: 1 }).waitFor();
  const networkContact = parseJson(await requestJson(window, "/api/bootstrap"), 200).prospects
    .find((item) => item.firstName === "Nadia" && item.lastName === "Leroy");
  assert.ok(networkContact?.id, "Le profil relu doit être importé dans Contacts.");
  assert.ok(networkContact.sources?.some((source) => source.searchId === savedNetworkSearch.id),
    "Le contact importé doit conserver le lien vers sa recherche LinkedIn.");
  const networkTemplate = parseJson(await requestJson(window, "/api/templates", "POST", {
    name: "Invitation smoke R18",
    kind: "invitation",
    content: "Bonjour {prenom}, ceci est un brouillon de test à envoyer manuellement.",
  }), 201);
  await window.reload();
  await window.waitForLoadState("load");
  await visit("Réseau", "Contacts");
  const networkContactRow = window.getByRole("row").filter({ hasText: "Nadia Leroy" });
  await networkContactRow.waitFor({ state: "visible" });
  await networkContactRow.focus();
  await window.keyboard.press("Enter");
  const contactDialog = window.getByRole("dialog", { name: "Nadia Leroy", exact: true });
  await contactDialog.waitFor({ state: "visible" });
  const closeContactDialog = window.getByRole("button", { name: "Fermer la fiche contact", exact: true });
  assert.equal(await closeContactDialog.evaluate((element) => element === document.activeElement), true,
    "La fiche contact doit recevoir le focus initial et exposer un dialogue nommé.");
  await window.keyboard.press("Shift+Tab");
  assert.equal(await contactDialog.evaluate((dialog) => dialog.contains(document.activeElement)), true,
    "Maj+Tab doit conserver le focus dans la fiche contact.");
  await window.keyboard.press("Escape");
  await contactDialog.waitFor({ state: "hidden" });
  assert.equal(await networkContactRow.evaluate((row) => row === document.activeElement), true,
    "Échap doit fermer la fiche et restituer le focus à la ligne déclencheuse.");
  await window.keyboard.press("Enter");
  await contactDialog.waitFor({ state: "visible" });
  const prepareMessageSection = window.locator(".drawer-section").filter({
    has: window.getByRole("heading", { name: "Préparer un message", exact: true }),
  });
  await prepareMessageSection.getByRole("combobox").selectOption(networkTemplate.id);
  await prepareMessageSection.getByRole("button", { name: "Générer un brouillon", exact: true }).click();
  const networkDraft = window.locator(".drawer .draft textarea");
  await networkDraft.waitFor({ state: "visible" });
  assert.equal(await networkDraft.inputValue(), "Bonjour Nadia, ceci est un brouillon de test à envoyer manuellement.");
  await prepareMessageSection.getByRole("button", { name: "Placer dans la file →", exact: true }).click();
  await window.getByText("Action ajoutée à la file. Aucune invitation ou message n’a été envoyé.", { exact: true }).waitFor();
  await window.getByRole("button", { name: "Messages", exact: true }).click();
  await window.getByRole("heading", { name: "File d’actions", exact: true, level: 1 }).waitFor();
  await window.getByText("Aucun envoi automatique", { exact: true }).waitFor();
  const queuedNetworkAction = parseJson(await requestJson(window, "/api/bootstrap"), 200).queue
    .find((item) => item.prospectId === networkContact.id);
  assert.equal(queuedNetworkAction?.state, "pending", "Le brouillon reste en attente d’une action humaine.");
  const isolatedUncertainReply = await requestJson(
    window,
    `/api/queue/${queuedNetworkAction.id}/uncertain`,
    "POST",
    { reason: "État de test isolé pour le smoke test clavier." },
  );
  assert.ok(isolatedUncertainReply.status >= 200 && isolatedUncertainReply.status < 300,
    isolatedUncertainReply.body);
  const uncertainNetworkAction = parseJson(await requestJson(window, "/api/bootstrap"), 200).queue
    .find((item) => item.id === queuedNetworkAction.id);
  assert.equal(uncertainNetworkAction?.state, "uncertain",
    "Le smoke prépare un état incertain local sans ouvrir LinkedIn ni envoyer de message.");
  await window.reload();
  await window.waitForLoadState("load");
  await visit("Réseau", "Contacts");
  await window.getByRole("button", { name: "Messages", exact: true }).click();
  await window.getByRole("heading", { name: "File d’actions", exact: true, level: 1 }).waitFor();
  const queuedNetworkCard = window.locator(".queue-card").filter({ hasText: "Nadia Leroy" });
  const confirmNetworkAction = queuedNetworkCard.getByRole("button", { name: "Vérifié : envoyé", exact: true });
  await confirmNetworkAction.waitFor({ state: "visible" });
  await confirmNetworkAction.focus();
  await window.keyboard.press("Enter");
  const confirmDialog = window.getByRole("dialog", { name: "Confirmer l’envoi effectué", exact: true });
  await confirmDialog.waitFor({ state: "visible" });
  const closeConfirmation = window.getByRole("button", { name: "Fermer la confirmation", exact: true });
  assert.equal(await closeConfirmation.evaluate((element) => element === document.activeElement), true,
    "La confirmation doit avoir un nom accessible et un focus initial visible.");
  await window.keyboard.press("Shift+Tab");
  assert.equal(await confirmDialog.evaluate((dialog) => dialog.contains(document.activeElement)), true,
    "Le focus doit rester dans la confirmation quand on recule depuis son premier contrôle.");
  await window.keyboard.press("Escape");
  await confirmDialog.waitFor({ state: "hidden" });
  assert.equal(await confirmNetworkAction.evaluate((element) => element === document.activeElement), true,
    "Échap doit fermer la confirmation et rendre le focus à son déclencheur.");
  assert.equal(fixtureSubmissions.length, 2, "Fermer la confirmation ne doit envoyer aucun formulaire.");
  await window.getByRole("button", { name: "Contacts", exact: true }).click();
  await window.getByRole("heading", { name: "Contacts", exact: true, level: 1 }).waitFor();
  await window.getByRole("button", { name: "Colonnes", exact: true }).click();
  await window.getByRole("heading", { name: "Pipeline", exact: true, level: 1 }).waitFor();
  await window.getByRole("button", { name: "Liste", exact: true }).click();
  await window.getByRole("heading", { name: "Contacts", exact: true, level: 1 }).waitFor();
  await window.getByRole("button", { name: "Recherches LinkedIn", exact: true }).click();
  await window.getByRole("heading", { name: "Recherches enregistrées", exact: true, level: 1 }).waitFor();
  await window.getByRole("button", { name: "Messages", exact: true }).click();
  await window.getByRole("heading", { name: "File d’actions", exact: true, level: 1 }).waitFor();
  await window.getByRole("button", { name: "Modèles", exact: true }).click();
  await window.getByRole("heading", { name: "Modèles de messages", exact: true, level: 1 }).waitFor();
  const newTemplateButton = window.getByRole("button", { name: /Nouveau modèle/ });
  await newTemplateButton.focus();
  await window.keyboard.press("Enter");
  const templateDialog = window.getByRole("dialog", { name: "Nouveau modèle", exact: true });
  await templateDialog.waitFor({ state: "visible" });
  const templateName = window.getByLabel("Nom", { exact: true });
  assert.equal(await templateName.evaluate((input) => input === document.activeElement), true,
    "L’éditeur de modèle doit annoncer son rôle et placer le focus dans son premier champ.");
  await window.keyboard.press("Escape");
  await templateDialog.waitFor({ state: "hidden" });
  assert.equal(await newTemplateButton.evaluate((element) => element === document.activeElement), true,
    "Échap doit fermer l’éditeur sans enregistrer et rendre le focus à son déclencheur.");
  await window.getByRole("button", { name: "Historique", exact: true }).click();
  await window.getByRole("heading", { name: "Activité", exact: true, level: 1 }).waitFor();
  await visit("Paramètres", "Les comptes, sans la répétition.");
  await window.getByRole("button", { name: "Données & sauvegardes", exact: true }).click();
  await window.getByRole("heading", { name: "Données & sauvegardes", exact: true, level: 1 }).waitFor();
  const uiBackupPassphrase = "AnimaDesktopSmokeUiBackup-2026";
  await window.getByLabel("Phrase de sauvegarde (12 caractères minimum)").fill(uiBackupPassphrase);
  await window.getByRole("button", { name: "Sauvegarder chiffré ↓", exact: true }).click();
  await window.getByText("Sauvegarde chiffrée téléchargée.", { exact: true }).waitFor();
  const uiBackupReply = await window.evaluate(async (passphrase) => window.anima.request({
    method: "POST",
    path: "/api/backup?demo=0",
    headers: { "Content-Type": "application/json", "X-Anima-Request": "1" },
    body: JSON.stringify({ passphrase }),
  }), uiBackupPassphrase);
  assert.equal(uiBackupReply.status, 200, "Le fichier réimporté doit venir d’une sauvegarde valide.");
  assert.equal(uiBackupReply.base64, true, "La sauvegarde chiffrée doit traverser le pont IPC en binaire.");
  const uiBackupBytes = Buffer.from(uiBackupReply.body, "base64");
  assert.ok(uiBackupBytes.length > 0, "L’export UI doit produire une sauvegarde chiffrée non vide.");
  await window.getByLabel("Phrase de sauvegarde", { exact: true }).fill(uiBackupPassphrase);
  const restoreDialogs = [];
  const acceptRestoreDialog = async (dialog) => {
    restoreDialogs.push(dialog.message());
    await dialog.accept();
  };
  window.on("dialog", acceptRestoreDialog);
  await window.locator('input[type="file"][accept*=".anima-backup"]').setInputFiles({
    name: "anima-desktop-smoke.anima-backup",
    mimeType: "application/vnd.anima.backup",
    buffer: uiBackupBytes,
  });
  await window.getByText("Sauvegarde restaurée.", { exact: true }).waitFor();
  window.off("dialog", acceptRestoreDialog);
  assert.equal(restoreDialogs.length, 1, "La restauration UI doit demander sa confirmation avant de remplacer les données.");
  await window.getByRole("button", { name: "Préférences", exact: true }).click();
  await window.getByRole("heading", { name: "Préférences", exact: true, level: 1 }).waitFor();
  const campaignDefaultLimit = window.getByLabel("Nombre maximal de candidatures", { exact: true });
  await campaignDefaultLimit.fill("2");
  assert.equal(await campaignDefaultLimit.inputValue(), "2", "Le plafond de campagne choisi doit rester visible comme valeur par défaut.");
  const invitationLimit = window.locator(".limit-row input");
  await invitationLimit.fill("9");
  await window.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await window.getByText("Limite enregistrée.", { exact: true }).waitFor();
  const savedSettings = parseJson(await requestJson(window, "/api/bootstrap"), 200);
  assert.equal(savedSettings.settings.invitationLimit, 9, "La limite quotidienne doit être persistée dans les réglages locaux.");
  await window.getByRole("button", { name: "À propos", exact: true }).click();
  await window.getByRole("heading", { name: "Anima Desktop", exact: true, level: 1 }).waitFor();
  await visit("Aide", "Aide & erreurs");

  const userDatabase = join(userDataDir, "data", "anima-connect.sqlite");
  assert.ok((await stat(userDatabase)).isFile(), "La base doit être écrite dans le profil utilisateur temporaire.");
  await application.close();
  application = undefined;

  restarted = await electron.launch(launchOptions);
  const restartedWindow = await restarted.firstWindow();
  await restartedWindow.waitForLoadState("load");
  const afterRestart = parseJson(await requestJson(restartedWindow, "/api/career/bootstrap"), 200);
  assert.equal(afterRestart.applications.find((item) => item.id === created.id)?.state, "submitted");
  assert.equal(afterRestart.profile.firstName, "Camille", "Le profil enregistré doit être conservé après redémarrage.");
  assert.equal(afterRestart.profileDraft, null, "Un brouillon enregistré ne doit pas réapparaître après redémarrage.");
  assert.equal(afterRestart.resumes.length, 2);
  const campaignsAfterRestart = parseJson(await requestJson(restartedWindow, "/api/career/campaigns"), 200);
  const completedCampaignAfterRestart = campaignsAfterRestart.campaigns.find((item) => item.id === campaign.id);
  assert.equal(completedCampaignAfterRestart?.state, "completed", "La campagne terminée doit rester persistée après redémarrage.");
  assert.equal(completedCampaignAfterRestart?.counts.submitted, 1);
  const restoredQueue = campaignsAfterRestart.campaigns.find((item) => item.id === queuedCampaign.campaign.id);
  assert.equal(restoredQueue?.state, "queued", "La campagne non lancée doit rester en attente après redémarrage.");
  await restartedWindow.getByRole("button", { name: "Aujourd’hui", exact: true }).click();
  const todayActions = restartedWindow.locator(".cw-panel").filter({ has: restartedWindow.getByRole("heading", { name: "À ne pas laisser passer" }) });
  const queuedAction = todayActions.getByRole("button", { name: /Campagne · En attente/ });
  await queuedAction.waitFor({ state: "visible" });
  await queuedAction.click();
  await restartedWindow.getByRole("heading", { name: "Campagnes actives", level: 2 }).waitFor();
  assert.equal(fixtureSubmissions.length, 2, "Ouvrir la campagne depuis Aujourd’hui ne lance aucun envoi.");

  // The packaged demo must use its isolated fixtures and block actions that
  // could affect real accounts or send applications.
  await restartedWindow.getByRole("button", { name: /Explorer la démo/ }).click();
  const demoBanner = restartedWindow.locator(".cw-banner");
  await demoBanner.waitFor({ state: "visible" });
  assert.match(await demoBanner.innerText(), /Données fictives/);
  const demoSnapshot = parseJson(await requestJson(restartedWindow, "/api/career/bootstrap?demo=1"), 200);
  assert.ok(demoSnapshot.jobs.some((item) => item.company === "Atelier Horizon"), "Le mode démo doit afficher ses offres fictives.");
  assert.ok(!afterRestart.jobs.some((item) => demoSnapshot.jobs.some((demoJob) => demoJob.id === item.id)),
    "Les offres de démonstration doivent rester séparées des offres réelles.");
  await restartedWindow.getByRole("button", { name: "Offres", exact: true }).click();
  assert.equal(await restartedWindow.getByRole("button", { name: /Rechercher les offres/ }).isDisabled(), true,
    "La recherche externe doit être désactivée en mode démo.");
  const demoCampaignAttempt = await requestJson(restartedWindow, "/api/career/campaigns?demo=1", "POST", {
    jobIds: [demoSnapshot.jobs[0].id],
    resumeId: demoSnapshot.resumes[0].id,
    maxSubmissions: 1,
  });
  assert.equal(demoCampaignAttempt.status, 403, "L’API doit refuser la création de campagne en mode démo.");

  await restartedWindow.getByRole("button", { name: /Démo · quitter/ }).click();
  await demoBanner.waitFor({ state: "hidden" });
  await restartedWindow.getByRole("button", { name: /Explorer la démo/ }).waitFor({ state: "visible" });
  const realDataAfterDemo = parseJson(await requestJson(restartedWindow, "/api/career/bootstrap"), 200);
  assert.deepEqual(realDataAfterDemo.jobs.map(({ id, title, company }) => ({ id, title, company })),
    afterRestart.jobs.map(({ id, title, company }) => ({ id, title, company })),
    "Quitter la démo doit préserver les offres réelles.");
  assert.deepEqual(realDataAfterDemo.applications.map(({ id, state }) => ({ id, state })),
    afterRestart.applications.map(({ id, state }) => ({ id, state })),
    "Quitter la démo doit préserver les candidatures réelles.");
  assert.equal(fixtureSubmissions.length, 2, "L’exploration de la démo ne doit envoyer aucun formulaire.");
  await assertNoHttpListener(expectedPort);

  await restarted.close();
  restarted = undefined;
  application = await electron.launch(launchOptions);
  const dpiWindow = diagnosticWindow = await application.firstWindow();
  await dpiWindow.waitForLoadState("load");
  const dpiSession = await dpiWindow.context().newCDPSession(dpiWindow);
  await dpiSession.send("Emulation.setDeviceMetricsOverride", {
    width: 912,
    height: 512,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  await dpiWindow.getByRole("button", { name: "Offres", exact: true }).click();
  await dpiWindow.getByLabel("Métier(s) ou mot(s)-clé(s)").waitFor({ state: "visible" });
  const dpiOffersLayout = await dpiWindow.evaluate(() => ({
    scale: window.devicePixelRatio,
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(dpiOffersLayout.scale >= 1.45,
    `Le rendu Chromium doit conserver un facteur d’échelle de 150 % : ${JSON.stringify(dpiOffersLayout)}`);
  assert.ok(dpiOffersLayout.content <= dpiOffersLayout.viewport + 1,
    `La vue Offres ne doit pas déborder à 150 % d’échelle : ${JSON.stringify(dpiOffersLayout)}`);
  await dpiWindow.screenshot({ path: "artifacts/career-ui/03-offers-dpi-150-packaged.png" });

  if (process.env.ANIMA_CAPTURE_DESKTOP_PREVIEW === "1") {
    await mkdir("artifacts", { recursive: true });
    await dpiWindow.screenshot({ path: "artifacts/anima-desktop.png", timeout: 60_000 });
  }
  console.log("Installé dans un profil temporaire : brouillon de profil après navigation/rechargement, Chromium embarqué, préparation sans envoi, envoi fixture unique, reçu et campagne persistée après redémarrage vérifiés ; aucun serveur HTTP détecté.");
} catch (error) {
  smokeError = error;
  console.error("Smoke test failure:", error);
  if (diagnosticWindow) {
    try {
      await mkdir("artifacts", { recursive: true });
      await diagnosticWindow.screenshot({ path: "artifacts/desktop-smoke-failure.png", timeout: 10_000 });
      console.error("Capture d’échec : artifacts/desktop-smoke-failure.png");
      console.error((await diagnosticWindow.locator("body").innerText()).slice(0, 2000));
    } catch { /* preserve the original smoke failure */ }
  }
}

const cleanupErrors = [];
for (const cleanup of [
  async () => {
    releasePauseFixtures();
    if (!application || !diagnosticWindow || !activeSmokeCampaignId) return;
    let timer;
    try {
      await Promise.race([
        requestJson(diagnosticWindow, `/api/career/campaigns/${activeSmokeCampaignId}/stop`, "POST", {}),
        new Promise((resolveStop) => { timer = setTimeout(resolveStop, 5_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
  () => application?.close(),
  () => restarted?.close(),
  () => fixture.listening ? new Promise((resolveClose, reject) => fixture.close((error) => error ? reject(error) : resolveClose())) : undefined,
  () => userDataDir ? rm(userDataDir, { recursive: true, force: true }) : undefined,
]) {
  try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
}
if (smokeError) {
  if (cleanupErrors.length) console.error("Nettoyage du smoke test partiellement échoué.", cleanupErrors);
  throw smokeError;
}
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Nettoyage du smoke test échoué.");
