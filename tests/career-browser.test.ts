Warning: truncated output (original token count: 9238)
Total output lines: 592

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { CareerBrowser } from "../server/career-browser.ts";
import { JobicyRemoteDiscovery } from "../server/jobicy-remote-discovery.ts";
import { CareerRunner } from "../server/career-runner.ts";
import { CareerStore } from "../server/career-store.ts";
import { Vault } from "../server/vault.ts";
import { Store } from "../server/db.ts";
import type { Application, CareerProfile, JobOffer, Resume, RunMode } from "../src/shared/career.ts";
import { startCareerFixtures, type CareerFixtures } from "./fixtures/careers.ts";

let fx: CareerFixtures;
before(async () => { fx = await startCareerFixtures(); });
after(async () => { await fx?.close(); });
const bytesA = Buffer.from("%PDF-1.4\nCareer CV alpha\n%%EOF");
const bytesB = Buffer.from("%PDF-1.4\nAlternate CV beta\n%%EOF");
const meta = (id: string, bytes: Buffer): Resume => ({ id, name: id, filename: `${id}.pdf`, mime: "application/pdf", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: "2026-01-01T00:00:00Z" });
const profile: CareerProfile = {
  firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", phone: "12345", city: "Paris", country: "France", address: "", postalCode: "", headline: "", summary: "", linkedinUrl: "", websiteUrl: "", skills: [], languages: [], experiences: [], education: [], preferences: { titles: [], locations: [], remote: false, contract: "" }, answers: {}, updatedAt: "2026-01-01T00:00:00Z",
};
const app = (answers: Record<string, string | boolean> = {}): Application => ({ id: "app", jobId: "job", resumeId: "cv-a", prospectId: null, state: "running", outcome: "active", answers, missingFields: [], notes: "", nextActionAt: "", lastError: "", receipt: null, createdAt: "", updatedAt: "", submittedAt: null });
const job = (path: string): JobOffer => ({ id: "job", url: fx.baseUrl + path, title: "Engineer", company: "Fixture", location: "Paris", description: "", sourceUrl: fx.baseUrl, discoveredAt: "", updatedAt: "" });
const browser = () => new CareerBrowser({ headless: true, allowedTestOrigins: [new URL(fx.baseUrl).origin] });
function inputFor(path: string, mode: RunMode, options: { answers?: Record<string, string | boolean>; bytes?: Buffer; credential?: { username: string; password: string } | null } = {}, beforeSubmit: () => void = () => {}) {
  const bytes = options.bytes || bytesA;
  return { application: app(options.answers), job: job(path), profile, resume: { meta: meta(bytes === bytesB ? "cv-b" : "cv-a", bytes), bytes }, mode, getCredential: () => options.credential || null, beforeSubmit };
}
async function run(path: string, mode: RunMode, options: { answers?: Record<string, string | boolean>; bytes?: Buffer; credential?: { username: string; password: string } | null } = {}) {
  const b = browser();
  let marker = 0;
  const outcome = await b.run(inputFor(path, mode, options, () => { marker++; }));
  if (b.hasPausedSession()) await b.close();
  return { outcome, marker };
}

test("preparation fills standard form but sends no application", async () => {
  const count = fx.submissions.length;
  const { outcome, marker } = await run("/simple", "prepare");
  assert.equal(outcome.state, "ready"); assert.equal(marker, 0); assert.equal(fx.submissions.length, count);
});
test("follows one visible Apply link and waits for its first-party form script", async () => {
  const count = fx.submissions.length;
  const scripts = fx.applyScriptVisits;
  const prepared = await run("/apply-link", "prepare");
  assert.equal(prepared.outcome.state, "ready");
  assert.equal(prepared.marker, 0);
  assert.equal(fx.applyScriptVisits, scripts + 1);
  assert.equal(fx.submissions.length, count);

  const submitted = await run("/apply-link", "submit");
  assert.equal(submitted.outcome.state, "submitted");
  assert.equal(fx.submissions.length, count + 1);
  assert.equal(fx.submissions.at(-1)?.fields.email, profile.email);
  assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-a", bytesA).sha256);
});
test("ambiguous Apply links stop before any profile data or CV is sent", async () => {
  const count = fx.submissions.length;
  const { outcome, marker } = await run("/ambiguous-apply", "submit");
  assert.equal(outcome.state, "blocked");
  assert.match(outcome.message, /Plusieurs liens/);
  assert.equal(marker, 0);
  assert.equal(fx.submissions.length, count);
});
test("Lever-style full-name form and Greenhouse-style custom questions use safe field matching", async () => {
  const beforeLever = fx.submissions.length;
  const lever = await run("/lever-job", "submit");
  assert.equal(lever.outcome.state, "submitted");
  assert.equal(fx.submissions.length, beforeLever + 1);
  assert.equal(fx.submissions.at(-1)?.fields.fullName, "Ada Lovelace");
  assert.equal(fx.submissions.at(-1)?.fields.email, profile.email);
  assert.equal(fx.submissions.at(-1)?.fields.location, profile.city);
  assert.equal(fx.submissions.at(-1)?.fields["urls[LinkedIn]"], "");
  assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-a", bytesA).sha256);

  const beforeGreenhouse = fx.submissions.length;
  const paused = await run("/greenhouse-application", "submit");
  assert.equal(paused.outcome.state, "needs_input");
  assert.match(paused.outcome.missingFields[0]?.label || "", /eligible to work/i);
  assert.equal(paused.marker, 0);
  assert.equal(fx.submissions.length, beforeGreenhouse);
  const answered = await run("/greenhouse-application", "submit", { answers: { custom_work_authorized: "No" } });
  assert.equal(answered.outcome.state, "submitted");
  assert.equal(fx.submissions.at(-1)?.fields.first_name, profile.firstName);
  assert.equal(fx.submissions.at(-1)?.fields.last_name, profile.lastName);
  assert.equal(fx.submissions.at(-1)?.fields.custom_work_authorized, "No");
});
test("Recruitee career link pauses for unknown required facts and submits only after an explicit answer", async () => {
  const allowedTestOrigins = [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin];
  const before = fx.submissions.length;
  let marker = 0;
  const makeInput = (mode: RunMode, answers: Record<string, string | boolean> = {}) => inputFor(
    "/jobicy-recruitee", mode, { answers }, () => { marker++; },
  );

  const preparation = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const missing = await preparation.run(makeInput("prepare"));
    assert.equal(missing.state, "needs_input");
    assert.match(missing.missingFields[0]?.label || "", /legally allowed to work in France/i);
    assert.equal(marker, 0);
    assert.equal(fx.submissions.length, before);
    assert.equal(preparation.hasPausedSession(), true);
    const ready = await preparation.resume(makeInput("prepare", { legal_work_authorized: "Yes" }));
    assert.equal(ready.state, "ready");
    assert.equal(fx.submissions.length, before, "prepare never posts to the Recruitee fixture");
  } finally { await preparation.close(); }

  const submit = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const submitted = await submit.run(makeInput("submit", { legal_work_authorized: "Yes" }));
    assert.equal(submitted.state, "submitted");
    assert.equal(marker, 1);
    assert.equal(fx.submissions.length, before + 1);
    assert.equal(fx.submissions.at(-1)?.fields.firstName, profile.firstName);
    assert.equal(fx.submissions.at(-1)?.fields.legal_work_authorized, "Yes");
    assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-a", bytesA).sha256);
  } finally { await submit.close(); }
});
test("Workable career link prepares without sending, then submits with an explicit answer", async () => {
  const allowedTestOrigins = [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin];
  const before = fx.submissions.length;
  let marker = 0;
  const makeInput = (mode: RunMode, answers: Record<string, string | boolean> = {}) => inputFor(
    "/jobicy-workable", mode, { answers }, () => { marker++; },
  );

  const preparation = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const missing = await preparation.run(makeInput("prepare"));
    assert.equal(missing.state, "needs_input");
    assert.match(missing.missingFields[0]?.label || "", /available during US business hours/i);
    assert.equal(marker, 0);
    assert.equal(fx.submissions.length, before);
    const ready = await preparation.resume(makeInput("prepare", { available_us_hours: "Yes" }));
    assert.equal(ready.state, "ready");
    assert.equal(fx.submissions.length, before, "prepare never posts to the Workable fixture");
  } finally { await preparation.close(); }

  const submit = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const submitted = await submit.run(makeInput("submit", { available_us_hours: "Yes" }));
    assert.equal(submitted.state, "submitted");
    assert.equal(marker, 1);
    assert.equal(fx.submissions.length, before + 1);
    assert.equal(fx.submissions.at(-1)?.fields.firstName, profile.firstName);
    assert.equal(fx.submissions.at(-1)?.fields.available_us_hours, "Yes");
    assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-a", bytesA).sha256);
  } finally { await submit.close(); }
});
test("SmartRecruiters 'I'm interested' flow pauses on a required answer and submits only after it is supplied", async () => {
  const allowedTestOrigins = [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin];
  const before = fx.submissions.length;
  let marker = 0;
  const makeInput = (mode: RunMode, answers: Record<string, string | boolean> = {}) => inputFor(
    "/jobicy-smartrecruiters", mode, { answers }, () => { marker++; },
  );

  const preparation = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const missing = await preparation.run(makeInput("prepare"));
    assert.equal(missing.state, "needs_input");
    assert.match(missing.missingFields[0]?.label || "", /work in France/i);
    assert.equal(fx.submissions.length, before);
    const ready = await preparation.resume(makeInput("prepare", { can_work_in_france: "Yes" }));
    assert.equal(ready.state, "ready");
    assert.equal(fx.submissions.length, before, "prepare never posts to the SmartRecruiters fixture");
  } finally { await preparation.close(); }

  const submit = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const submitted = await submit.run(makeInput("submit", { can_work_in_france: "Yes" }));
    assert.equal(submitted.state, "submitted");
    assert.equal(marker, 1);
    assert.equal(fx.submissions.length, before + 1);
    assert.equal(fx.submissions.at(-1)?.fields.firstName, profile.firstName);
    assert.equal(fx.submissions.at(-1)?.fields.can_work_in_france, "Yes");
    assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-a", bytesA).sha256);
  } finally { await submit.close(); }
});
test("Jobicy-discovered offer follows visible Apply links to a simulated Ashby form and waits for confirmation", async () => {
  const discovery = new JobicyRemoteDiscovery(async () => Response.json({ jobs: [{
    url: "https://www.jobicy.com/jobs/remote-software-engineer",
    jobTitle: "Software Engineer", companyName: "Ashby Fixture", jobGeo: "France (Remote)",
    jobType: ["Full-Time"], jobExcerpt: "Build software", jobDescription: "A public remote role.",
  }] }));
  const found = await discovery.search({ keywords: "software engineer" });
  assert.equal(found.offers.length, 1);
  const discovered = found.offers[0]!;
  // Map the public Jobicy listing onto a local page fixture; the listing links onward
  // to a second local origin which models jobs.ashbyhq.com and its public application.
  const fixtureJob: JobOffer = { ...job("/jobicy-discovered"), ...discovered…3238 tokens truncated…resuming cannot submit while the challenge remains visible");
      resolve();
      await new Promise(resolveTimer => setTimeout(resolveTimer, 350));
      const resumed = await b.resume(inputFor(path, "submit"));
      assert.equal(resumed.state, "submitted");
      assert.equal(b.hasPausedSession(), false);
    } finally { await b.close(); }
  }
  assert.equal(fx.submissions.length, count + 2);
});
test("missing receipt is uncertain after exactly one POST", async () => {
  const count = fx.submissions.length;
  const { outcome, marker } = await run("/uncertain", "submit");
  assert.equal(outcome.state, "uncertain"); assert.equal(marker, 1); assert.equal(fx.submissions.length, count + 1);
});
test("a pre-existing unrelated thank-you line does not count as a receipt", async () => {
  const count = fx.submissions.length;
  const { outcome } = await run("/false-receipt", "submit");
  assert.equal(outcome.state, "uncertain");
  assert.equal(fx.submissions.length, count + 1);
});
test("hidden labeled CV control uploads the selected bytes", async () => {
  const { outcome } = await run("/hidden-cv", "submit", { bytes: bytesB });
  assert.equal(outcome.state, "submitted");
  assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-b", bytesB).sha256);
});
test("a visible CV label maps to its file input even when the field name is unrelated", async () => {
  const { outcome } = await run("/weird-cv", "submit", { bytes: bytesB });
  assert.equal(outcome.state, "submitted");
  assert.equal(fx.submissions.at(-1)?.resume?.filename, "cv-b.pdf");
  assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-b", bytesB).sha256);
});
test("a required non-CV file can be explicitly resolved with the selected stored resume", async () => {
  const b = browser();
  try {
    const submissions = fx.submissions.length;
    const paused = await b.run(inputFor("/portfolio", "submit"));
    assert.equal(paused.state, "needs_input");
    assert.deepEqual(paused.missingFields.map(field => [field.key, field.type]), [["portfolio", "file"]]);
    assert.equal(b.hasPausedSession(), true);
    const resumed = await b.resume({ ...inputFor("/portfolio", "submit", { bytes: bytesB }), fileFieldKey: "portfolio" });
    assert.equal(resumed.state, "submitted");
    assert.equal(fx.submissions.length, submissions + 1);
    assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-b", bytesB).sha256);
  } finally { await b.close(); }
});
test("initial ATS redirect uses only destination-origin credential", async () => {
  const b = new CareerBrowser({ headless: true, allowedTestOrigins: [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin] });
  const seen: string[] = [];
  const outcome = await b.run({ application: app(), job: job("/ats-redirect"), profile, resume: { meta: meta("cv-a", bytesA), bytes: bytesA }, mode: "submit", getCredential: origin => { seen.push(origin); return origin === new URL(fx.atsUrl).origin ? { username: "ats@example.test", password: "ats-secret" } : null; }, beforeSubmit: () => {} });
  assert.equal(outcome.state, "submitted");
  assert.deepEqual(seen, [new URL(fx.atsUrl).origin]);
});
test("third-party exfiltration request is blocked while filling", async () => {
  const count = fx.exfilCount;
  const { outcome } = await run("/exfil", "submit");
  assert.equal(outcome.state, "submitted");
  assert.equal(fx.exfilCount, count);
});
test("rejects private URL outside exact constructor test origin", async () => {
  const b = new CareerBrowser({ headless: true });
  const outcome = await b.run({ application: app(), job: job("/simple"), profile, resume: { meta: meta("cv-a", bytesA), bytes: bytesA }, mode: "submit", getCredential: () => null, beforeSubmit: () => assert.fail() });
  assert.equal(outcome.state, "blocked");
});

test("runner rejects parallel runs and never repeats uncertain submission", async () => {
  const db = new Store(":memory:");
  const origin = new URL(fx.baseUrl).origin;
  const store = new CareerStore(db.db, { allowedTestOrigins: [origin] });
  const vault = new Vault(db.db, { allowedTestOrigins: [origin] });
  store.saveProfile(profile);
  const resume = store.saveResume({ name: "CV", filename: "cv.pdf", mime: "application/pdf", bytes: bytesA });
  const uncertainJob = store.saveJob({ url: fx.baseUrl + "/uncertain", title: "Engineer", company: "Fixture", location: "Paris" });
  const otherJob = store.saveJob({ url: fx.baseUrl + "/simple", title: "Designer", company: "Fixture", location: "Paris" });
  const first = store.createApplication({ jobId: uncertainJob.id, resumeId: resume.id });
  const second = store.createApplication({ jobId: otherJob.id, resumeId: resume.id });
  const runner = new CareerRunner(store, vault, browser());
  const count = fx.submissions.length;
  assert.equal(runner.start(first.id, "submit").state, "running");
  assert.throws(() => runner.start(second.id, "submit"), { status: 409, code: "browser_busy" });
  const deadline = Date.now() + 30_000;
  while (runner.isBusy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(runner.isBusy(), false);
  assert.equal(store.getApplication(first.id).state, "uncertain");
  assert.equal(fx.submissions.length, count + 1);
  assert.throws(() => runner.start(first.id, "submit"));
  store.recoverInterruptedRuns();
  assert.throws(() => new CareerRunner(store, vault, browser()).start(first.id, "submit"));
  assert.equal(fx.submissions.length, count + 1);
  db.db.close();
});
test("runner uses the selected account for an ATS origin when multiple accounts are saved", async () => {
  const db = new Store(":memory:");
  const atsOrigin = new URL(fx.atsUrl).origin;
  const store = new CareerStore(db.db, { allowedTestOrigins: [new URL(fx.baseUrl).origin, atsOrigin] });
  const vault = new Vault(db.db, { allowedTestOrigins: [new URL(fx.baseUrl).origin, atsOrigin] });
  store.saveProfile(profile);
  const resume = store.saveResume({ name: "CV", filename: "cv.pdf", mime: "application/pdf", bytes: bytesA });
  const offer = store.saveJob({ url: `${atsOrigin}/ats-apply`, title: "Engineer", company: "Fixture", location: "Paris" });
  const application = store.createApplication({ jobId: offer.id, resumeId: resume.id });
  vault.initialize("a sufficiently long test passphrase");
  vault.saveCredential({ origin: atsOrigin, label: "Other", username: "wrong@example.test", password: "wrong-secret" });
  const selected = vault.saveCredential({ origin: atsOrigin, label: "Selected", username: "ats@example.test", password: "ats-secret" });
  const selectedAccountBrowser = new CareerBrowser({ headless: true, allowedTestOrigins: [new URL(fx.baseUrl).origin, atsOrigin] });
  const runner = new CareerRunner(store, vault, selectedAccountBrowser);
  const loginsBefore = fx.loginCount, submissionsBefore = fx.submissions.length;
  runner.start(application.id, "submit", selected.id);
  const deadline = Date.now() + 30_000;
  while (runner.isBusy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.getApplication(application.id).state, "submitted");
  assert.equal(fx.loginCount, loginsBefore + 1);
  assert.equal(fx.submissions.length, submissionsBefore + 1);
  assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-a", bytesA).sha256);
  await runner.stop();
  db.db.close();
});
test("runner retains a paused attempt and resumes it with newly saved answers", async () => {
  const db = new Store(":memory:");
  const origin = new URL(fx.baseUrl).origin;
  const store = new CareerStore(db.db, { allowedTestOrigins: [origin] });
  const vault = new Vault(db.db, { allowedTestOrigins: [origin] });
  store.saveProfile(profile);
  const resume = store.saveResume({ name: "CV", filename: "cv.pdf", mime: "application/pdf", bytes: bytesA });
  const savedJob = store.saveJob({ url: fx.baseUrl + "/unknown", title: "Engineer", company: "Fixture" });
  const application = store.createApplication({ jobId: savedJob.id, resumeId: resume.id });
  const runner = new CareerRunner(store, vault, browser());
  const count = fx.submissions.length;
  const visits = fx.unknownVisits;
  runner.start(application.id, "submit");
  const deadline = Date.now() + 30_000;
  while (runner.isBusy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runner.isBusy(), false);
  assert.equal(store.getApplication(application.id).state, "needs_input");
  assert.equal(runner.hasPausedSession(), true);
  store.updateApplication(application.id, { answers: { workAuthorization: "Yes" } });
  runner.resume(application.id);
  while (runner.isBusy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.getApplication(application.id).state, "submitted");
  assert.equal(fx.submissions.length, count + 1);
  assert.equal(fx.unknownVisits, visits + 1);
  assert.equal(runner.hasPausedSession(), false);
  await runner.stop();
  db.db.close();
});
test("runner stop closes a browser held for user input without submitting", async () => {
  const db = new Store(":memory:");
  const origin = new URL(fx.baseUrl).origin;
  const store = new CareerStore(db.db, { allowedTestOrigins: [origin] });
  const vault = new Vault(db.db, { allowedTestOrigins: [origin] });
  store.saveProfile(profile);
  const resume = store.saveResume({ name: "CV", filename: "cv.pdf", mime: "application/pdf", bytes: bytesA });
  const savedJob = store.saveJob({ url: fx.baseUrl + "/unknown", title: "Engineer", company: "Fixture" });
  const application = store.createApplication({ jobId: savedJob.id, resumeId: resume.id });
  const runner = new CareerRunner(store, vault, browser());
  const count = fx.submissions.length;
  runner.start(application.id, "submit");
  const deadline = Date.now() + 30_000;
  while (runner.isBusy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.getApplication(application.id).state, "needs_input");
  assert.equal(runner.hasPausedSession(), true);
  await runner.stop();
  assert.equal(runner.hasPausedSession(), false);
  assert.equal(store.getApplication(application.id).state, "needs_input");
  assert.equal(fx.submissions.length, count);
  db.db.close();
});
test("runner stop persists failed before marker and uncertain after marker", async () => {
  const db = new Store(":memory:");
  const origin = new URL(fx.baseUrl).origin;
  const store = new CareerStore(db.db, { allowedTestOrigins: [origin] });
  const vault = new Vault(db.db, { allowedTestOrigins: [origin] });
  store.saveProfile(profile);
  const resume = store.saveResume({ name: "CV", filename: "cv.pdf", mime: "application/pdf", bytes: bytesA });
  const before = store.createApplication({ jobId: store.saveJob({ url: fx.baseUrl + "/slow", title: "Slow", company: "Fixture" }).id, resumeId: resume.id });
  const after = store.createApplication({ jobId: store.saveJob({ url: fx.baseUrl + "/slow-submit", title: "Slow submit", company: "Fixture" }).id, resumeId: resume.id });
  const runner = new CareerRunner(store, vault, browser());
  const count = fx.submissions.length;
  runner.start(before.id, "submit");
  await runner.stop();
  assert.equal(store.getApplication(before.id).state, "failed");
  assert.equal(fx.submissions.length, count);
  runner.start(after.id, "submit");
  const deadline = Date.now() + 30_000;
  while (fx.submissions.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fx.submissions.length, count + 1);
  assert.equal(store.getApplication(after.id).state, "submitting");
  await runner.stop();
  assert.equal(store.getApplication(after.id).state, "uncertain");
  assert.throws(() => runner.start(after.id, "submit"));
  db.db.close();
});

