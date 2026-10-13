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
const fixture = createServer(async (req, res) => {
  if (req.method === "GET" && ["/apply", "/apply-campaign"].includes(req.url)) {
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
  await window.getByRole("button", { name: "Aujourd’hui" }).waitFor({ state: "visible" });
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
  await window.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await window.getByText("Collecte programmée et candidature", { exact: true }).click();
  await window.getByRole("button", { name: "Rechercher et préparer un lancement" }).click();
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
  await networkContactRow.click();
  await window.getByRole("heading", { name: "Nadia Leroy", exact: true }).waitFor();
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
  const queuedNetworkCard = window.locator(".queue-card").filter({ hasText: "Nadia Leroy" });
  await queuedNetworkCard.getByRole("button", { name: "Ouvrir le profil ↗", exact: true }).waitFor({ state: "visible" });
  assert.equal(fixtureSubmissions.length, 2, "Mettre le brouillon dans la file ne déclenche aucun envoi.");
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

  if (process.env.ANIMA_CAPTURE_DESKTOP_PREVIEW === "1") {
    await mkdir("artifacts", { recursive: true });
    await restartedWindow.screenshot({ path: "artifacts/anima-desktop.png", timeout: 60_000 });
  }
  console.log("Installé dans un profil temporaire : brouillon de profil après navigation/rechargement, Chromium embarqué, préparation sans envoi, envoi fixture unique, reçu et campagne persistée après redémarrage vérifiés ; aucun serveur HTTP détecté.");
} catch (error) {
  smokeError = error;
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
