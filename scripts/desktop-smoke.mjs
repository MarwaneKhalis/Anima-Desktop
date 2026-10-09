import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { connect, createServer as createNetServer } from "node:net";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron } from "playwright";

const executablePath = resolve(
  process.env.ANIMA_DESKTOP_EXECUTABLE || "release/win-unpacked/Anima Connect.exe",
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
  assert.match(await window.title(), /Anima Connect/i);
  await window.getByRole("button", { name: "Tableau de bord" }).waitFor({ state: "visible" });
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
  const profile = {
    firstName: "Camille",
    lastName: "Martin",
    email: "camille.martin@example.test",
    country: "France",
    answers: {},
    preferences: { remote: false },
  };
  parseJson(await requestJson(window, "/api/career/profile", "PUT", profile), 200);

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
  await window.getByRole("button", { name: "Offres", exact: true }).click();
  await window.getByLabel("CV pour les candidatures").selectOption(selectedResume.id);
  await window.getByLabel("Métier(s) ou mot(s)-clé(s)").fill("Ingénieure logiciel");
  await window.getByRole("button", { name: "Trouver et candidater automatiquement" }).click();
  const campaign = await waitForCampaign(window);
  assert.equal(campaign.counts.submitted, 1, "La campagne bureau doit envoyer le formulaire fixture.");
  assert.equal(fixtureSubmissions.length, 2, "Chaque candidature fixture doit être envoyée exactement une fois.");
  assert.ok(fixtureSubmissions[1].includes(selectedResumeBytes), "La campagne doit reprendre le CV choisi.");
  await window.getByText("Terminée", { exact: true }).waitFor();

  const userDatabase = join(userDataDir, "data", "anima-connect.sqlite");
  assert.ok((await stat(userDatabase)).isFile(), "La base doit être écrite dans le profil utilisateur temporaire.");
  await application.close();
  application = undefined;

  restarted = await electron.launch(launchOptions);
  const restartedWindow = await restarted.firstWindow();
  await restartedWindow.waitForLoadState("load");
  const afterRestart = parseJson(await requestJson(restartedWindow, "/api/career/bootstrap"), 200);
  assert.equal(afterRestart.applications.find((item) => item.id === created.id)?.state, "submitted");
  assert.equal(afterRestart.resumes.length, 2);
  const campaignsAfterRestart = parseJson(await requestJson(restartedWindow, "/api/career/campaigns"), 200);
  assert.equal(campaignsAfterRestart.campaigns[0]?.state, "completed", "La campagne terminée doit rester persistée après redémarrage.");
  assert.equal(campaignsAfterRestart.campaigns[0]?.counts.submitted, 1);
  await assertNoHttpListener(expectedPort);

  if (process.env.ANIMA_CAPTURE_DESKTOP_PREVIEW === "1") {
    await mkdir("artifacts", { recursive: true });
    await restartedWindow.screenshot({ path: "artifacts/anima-connect-desktop.png", timeout: 60_000 });
  }
  console.log("Installé dans un profil temporaire : Chromium embarqué, préparation sans envoi, envoi fixture unique, reçu, campagne persistée après redémarrage et données restaurées vérifiés ; aucun serveur HTTP détecté.");
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
