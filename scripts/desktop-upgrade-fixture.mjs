import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { _electron as electron } from "playwright";

const executablePath = resolve(process.env.ANIMA_DESKTOP_EXECUTABLE || "");
const mode = process.env.ANIMA_UPGRADE_FIXTURE_MODE;
const expectedUserData = resolve(process.env.APPDATA || "", "Anima Connect");
const profilePath = resolve(process.env.ANIMA_UPGRADE_PROFILE || expectedUserData);
const passphrase = "anima-desktop-upgrade-fixture-passphrase";
const resumeBytes = Buffer.from("%PDF-1.7\nANIMA-DESKTOP-UPGRADE-PRESERVATION-FIXTURE\n%%EOF\n");

assert.ok(executablePath, "ANIMA_DESKTOP_EXECUTABLE est requis.");
assert.ok(["seed", "verify"].includes(mode), "Le mode de fixture est invalide.");
assert.equal(profilePath, expectedUserData, "Le fixture doit utiliser le profil isolé du runner Windows.");

function parse(reply, expectedStatus) {
  assert.equal(reply.status, expectedStatus, reply.body);
  return JSON.parse(reply.body);
}

async function request(window, path, method = "GET", body) {
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

const application = await electron.launch({ executablePath, env: process.env });
try {
  const window = await application.firstWindow();
  await window.waitForLoadState("load");
  await window.waitForFunction(() => Boolean(window.anima));

  if (mode === "seed") {
    const before = parse(await request(window, "/api/career/bootstrap"), 200);
    assert.deepEqual(before.jobs, [], "Le profil de départ du runner doit être vierge.");
    assert.deepEqual(before.resumes, [], "Le profil de départ du runner doit être vierge.");

    parse(await request(window, "/api/career/profile", "PUT", {
      firstName: "Camille",
      lastName: "Martin",
      email: "upgrade.fixture@example.test",
      country: "France",
      city: "Lyon",
      headline: "Profil synthétique de mise à niveau",
      skills: ["TypeScript", "Windows upgrade fixture"],
      answers: { fixtureAnswer: "conservée" },
      preferences: { remote: true, contract: "CDI" },
    }), 200);
    const resume = parse(await request(window, "/api/career/resumes", "POST", {
      name: "CV de fixture mise à niveau",
      filename: "upgrade-fixture.pdf",
      mime: "application/pdf",
      base64: resumeBytes.toString("base64"),
    }), 201);
    const job = parse(await request(window, "/api/career/jobs", "POST", {
      url: "https://jobs.example.org/anima-upgrade-fixture",
      title: "Ingénieure logiciel — fixture de mise à niveau",
      company: "Entreprise synthétique",
      location: "Lyon",
      description: "Donnée locale synthétique utilisée uniquement par la CI.",
    }), 201);
    const applicationRecord = parse(await request(window, "/api/career/applications", "POST", {
      jobId: job.id,
      resumeId: resume.id,
    }), 201);
    parse(await request(window, "/api/career/applications/" + applicationRecord.id, "PATCH", {
      notes: "Note chiffrée de conservation après mise à niveau.",
    }), 200);
    parse(await request(window, "/api/career/vault/initialize", "POST", { passphrase }), 201);
    parse(await request(window, "/api/career/credentials", "POST", {
      origin: "https://jobs.example.org",
      label: "Identifiant synthétique CI",
      username: "upgrade-fixture@example.test",
      password: "synthetic-only-password-not-a-real-secret",
    }), 201);

    console.log(JSON.stringify({ mode, resumeId: resume.id, jobId: job.id, applicationId: applicationRecord.id }));
  } else {
    const bootstrap = parse(await request(window, "/api/career/bootstrap"), 200);
    assert.equal(bootstrap.profile.email, "upgrade.fixture@example.test");
    assert.equal(bootstrap.profile.headline, "Profil synthétique de mise à niveau");
    assert.deepEqual(bootstrap.profile.answers, { fixtureAnswer: "conservée" });

    const resume = bootstrap.resumes.find((entry) => entry.filename === "upgrade-fixture.pdf");
    assert.ok(resume, "Le CV synthétique doit rester enregistré.");
    assert.equal(resume.sha256, (await import("node:crypto")).createHash("sha256").update(resumeBytes).digest("hex"));
    const download = await request(window, `/api/career/resumes/${resume.id}/download`);
    assert.equal(download.status, 200, download.body);
    const savedBytes = Buffer.from(download.body, "base64");
    // The preload returns binary responses as base64 for this API bridge.
    assert.deepEqual(savedBytes, resumeBytes);

    const job = bootstrap.jobs.find((entry) => entry.url === "https://jobs.example.org/anima-upgrade-fixture");
    assert.ok(job, "L’offre synthétique doit rester enregistrée.");
    const applicationRecord = bootstrap.applications.find((entry) => entry.jobId === job.id);
    assert.ok(applicationRecord, "La candidature synthétique doit rester enregistrée.");
    assert.equal(applicationRecord.resumeId, resume.id);
    assert.equal(applicationRecord.notes, "Note chiffrée de conservation après mise à niveau.");

    parse(await request(window, "/api/career/vault/unlock", "POST", { passphrase }), 200);
    const verified = parse(await request(window, "/api/career/bootstrap"), 200);
    const credentials = verified.credentials;
    assert.ok(credentials.some((entry) => entry.label === "Identifiant synthétique CI" && entry.username === "upgrade-fixture@example.test"));
    console.log(JSON.stringify({ mode, resumeId: resume.id, jobId: job.id, applicationId: applicationRecord.id, credentials: credentials.length }));
  }
} finally {
  await application.close();
}

const dataDir = resolve(profilePath, "data");
const database = await readFile(resolve(dataDir, "anima-connect.sqlite"));
assert.ok(database.byteLength > 0, "La base SQLite doit être persistée.");
await readFile(resolve(dataDir, "local-data-key.dpapi"));
