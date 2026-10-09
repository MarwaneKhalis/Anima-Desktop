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
const profileWithHistory: CareerProfile = {
  ...profile,
  experiences: [
    { company: "Analytical Engines", title: "Senior Engineer", start: "2022", end: "2025", description: "Led the platform team." },
    { company: "Difference Engine Ltd", title: "Software Engineer", start: "2019", end: "2022", description: "Built numerical tools." },
  ],
  education: [{ school: "University of London", degree: "Mathematics", start: "2015", end: "2018" }],
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
test("Remote OK redirector refuses non-ATS targets before opening or sending applicant data", async () => {
  const before = fx.submissions.length;
  const { outcome, marker } = await run("/remoteok-unsafe-job", "submit");
  assert.equal(outcome.state, "blocked");
  assert.equal(marker, 0);
  assert.equal(fx.submissions.length, before);
});
test("profile experience and education entries fill matching ATS fields in order", async () => {
  const submissions = fx.submissions.length;
  const makeInput = (mode: RunMode, answers: Record<string, string | boolean> = {}) => ({
    ...inputFor("/profile-history", mode, { answers }),
    profile: profileWithHistory,
  });
  const preparation = new CareerBrowser({ headless: true, allowedTestOrigins: [new URL(fx.baseUrl).origin] });
  try {
    const ready = await preparation.run(makeInput("prepare"));
    assert.equal(ready.state, "ready", ready.message);
    assert.equal(fx.submissions.length, submissions, "profile preparation never sends an application");
  } finally { await preparation.close(); }

  const submit = new CareerBrowser({ headless: true, allowedTestOrigins: [new URL(fx.baseUrl).origin] });
  try {
    const result = await submit.run(makeInput("submit"));
    assert.equal(result.state, "submitted", result.message);
    assert.equal(fx.submissions.length, submissions + 1);
    const fields = fx.submissions.at(-1)!.fields;
    assert.equal(fields.employment_0_company, "Analytical Engines");
    assert.equal(fields.employment_0_position, "Senior Engineer");
    assert.equal(fields.employment_0_start_date, "2022");
    assert.equal(fields.employment_0_end_date, "2025");
    assert.equal(fields.employment_0_responsibilities, "Led the platform team.");
    assert.equal(fields.employment_1_company, "Difference Engine Ltd");
    assert.equal(fields.employment_1_position, "Software Engineer");
    assert.equal(fields.employment_1_start_date, "2019");
    assert.equal(fields.employment_1_end_date, "2022");
    assert.equal(fields.employment_1_responsibilities, "Built numerical tools.");
    assert.equal(fields.education_0_school, "University of London");
    assert.equal(fields.education_0_degree, "Mathematics");
    assert.equal(fields.education_0_start_date, "2015");
    assert.equal(fields.education_0_end_date, "2018");
  } finally { await submit.close(); }

  const override = new CareerBrowser({ headless: true, allowedTestOrigins: [new URL(fx.baseUrl).origin] });
  try {
    const result = await override.run(makeInput("submit", { employment_0_company: "Corrected employer" }));
    assert.equal(result.state, "submitted", result.message);
    assert.equal(fx.submissions.at(-1)?.fields.employment_0_company, "Corrected employer", "application-specific answers take precedence over profile history");
  } finally { await override.close(); }
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
test("Teamtailor documented application URL is followed even when the Apply button text is customized", async () => {
  const allowedTestOrigins = [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin];
  const before = fx.submissions.length;
  let marker = 0;
  const makeInput = (mode: RunMode, answers: Record<string, string | boolean> = {}) => inputFor(
    "/jobicy-teamtailor", mode, { answers }, () => { marker++; },
  );

  const preparation = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const missing = await preparation.run(makeInput("prepare"));
    assert.equal(missing.state, "needs_input");
    assert.match(missing.missingFields[0]?.label || "", /work in France/i);
    assert.equal(fx.submissions.length, before);
    const ready = await preparation.resume(makeInput("prepare", { tt_work_france: "Yes" }));
    assert.equal(ready.state, "ready");
    assert.equal(fx.submissions.length, before, "prepare never posts to the Teamtailor fixture");
  } finally { await preparation.close(); }

  const submit = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const submitted = await submit.run(makeInput("submit", { tt_work_france: "Yes" }));
    assert.equal(submitted.state, "submitted");
    assert.equal(marker, 1);
    assert.equal(fx.submissions.length, before + 1);
    assert.equal(fx.submissions.at(-1)?.fields.firstName, profile.firstName);
    assert.equal(fx.submissions.at(-1)?.fields.tt_work_france, "Yes");
    assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-a", bytesA).sha256);
  } finally { await submit.close(); }
});
test("Workday multi-step form pauses for unknown answers and handles Save and Continue without an early POST", async () => {
  const allowedTestOrigins = [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin];
  const before = fx.submissions.length;
  let marker = 0;
  const makeInput = (mode: RunMode, answers: Record<string, string | boolean> = {}) => ({
    ...inputFor("/jobicy-workday", mode, { answers }, () => { marker++; }),
    profile: profileWithHistory,
  });

  const preparation = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const missing = await preparation.run(makeInput("prepare"));
    assert.equal(missing.state, "needs_input");
    assert.match(missing.missingFields[0]?.label || "", /work in France/i);
    assert.equal(fx.submissions.length, before);
    const ready = await preparation.resume(makeInput("prepare", { wd_work_france: "Yes" }));
    assert.equal(ready.state, "ready");
    assert.equal(fx.submissions.length, before, "prepare never posts to the Workday fixture");
  } finally { await preparation.close(); }

  const submit = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const submitted = await submit.run(makeInput("submit", { wd_work_france: "Yes" }));
    assert.equal(submitted.state, "submitted");
    assert.equal(marker, 1);
    assert.equal(fx.submissions.length, before + 1);
    assert.equal(fx.submissions.at(-1)?.fields.firstName, profile.firstName);
    assert.equal(fx.submissions.at(-1)?.fields.wd_work_france, "Yes");
    assert.equal(fx.submissions.at(-1)?.fields.employment_0_company, "Analytical Engines");
    assert.equal(fx.submissions.at(-1)?.fields.employment_1_company, "Difference Engine Ltd");
    assert.equal(fx.submissions.at(-1)?.fields.employment_0_responsibilities, "Led the platform team.");
    assert.equal(fx.submissions.at(-1)?.fields.education_0_degree, "Mathematics");
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
  const fixtureJob: JobOffer = { ...job("/jobicy-discovered"), ...discovered, id: "job", url: fx.jobicyAshbyUrl };
  const allowedTestOrigins = [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin];
  const makeInput = (mode: RunMode, answers: Record<string, string | boolean> = {}, beforeSubmit = () => {}) => ({
    application: app(answers), job: fixtureJob, profile,
    resume: { meta: meta("cv-a", bytesA), bytes: bytesA }, mode,
    getCredential: () => null, beforeSubmit,
  });
  const answers = { workAuthorization: "Yes", visa_sponsorship: "No", motivation: "I want to build useful software." };

  const initialCount = fx.submissions.length;
  const prep = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const challenge = await prep.run(makeInput("prepare"));
    assert.equal(challenge.state, "blocked");
    assert.match(challenge.message, /CAPTCHA ou MFA/i);
    assert.equal(prep.hasPausedSession(), true);
    fx.resolveAshbyChallenge();
    await new Promise(resolve => setTimeout(resolve, 250));
    const missing = await prep.resume(makeInput("prepare"));
    assert.equal(missing.state, "needs_input", missing.message);
    assert.deepEqual(missing.missingFields.map(field => field.key).sort(), ["motivation", "visa sponsorship", "work authorization"].sort());
    assert.equal(prep.hasPausedSession(), true);
    assert.equal(fx.submissions.length, initialCount);
    const ready = await prep.resume(makeInput("prepare", answers));
    assert.equal(ready.state, "ready");
    assert.equal(fx.submissions.length, initialCount, "preparation never sends the application");
  } finally { await prep.close(); }

  let marker = 0;
  const submit = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const result = await submit.run(makeInput("submit", answers, () => { marker++; }));
    assert.equal(result.state, "submitted");
    assert.equal(marker, 1, "the final submission is marked once after the user-confirmed submit mode");
    assert.equal(fx.submissions.length, initialCount + 1);
    assert.equal(fx.submissions.at(-1)?.fields.email, profile.email);
    assert.equal(fx.submissions.at(-1)?.fields.country, "France", "the known country is mapped from the profile");
    assert.equal(fx.submissions.at(-1)?.fields.workAuthorization, "Yes");
    assert.equal(fx.submissions.at(-1)?.fields.visa_sponsorship, "No");
    assert.equal(fx.submissions.at(-1)?.fields.motivation, answers.motivation);
    assert.equal(fx.submissions.at(-1)?.fields.gender, undefined, "optional demographic data is omitted when unanswered");
    assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-a", bytesA).sha256);
    assert.match(result.receipt?.reference || "", /^ATS-/);
  } finally { await submit.close(); }
});
test("Ashby lookalike links and external form actions are rejected without data exfiltration", async () => {
  const allowedTestOrigins = [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin];
  const before = fx.submissions.length;
  const lookalikeBrowser = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const lookalike = await lookalikeBrowser.run(inputFor("/jobicy-ashby-lookalike", "submit"));
    assert.equal(lookalike.state, "blocked");
    assert.equal(fx.submissions.length, before);
  } finally { await lookalikeBrowser.close(); }

  const exfilBefore = fx.exfilCount;
  const external = new CareerBrowser({ headless: true, allowedTestOrigins });
  try {
    const outcome = await external.run(inputFor("/jobicy-ashby-external", "submit"));
    assert.equal(outcome.state, "blocked");
    assert.match(outcome.message, /origine différente interdite/i);
    assert.equal(fx.submissions.length, before, "the foreign form action is never submitted");
    assert.equal(fx.exfilCount, exfilBefore, "the external tracking request is denied");
  } finally { await external.close(); }
});
test("submission sends exactly one POST and selected resume bytes", async () => {
  const count = fx.submissions.length;
  const { outcome, marker } = await run("/simple", "submit");
  assert.equal(outcome.state, "submitted"); assert.equal(marker, 1); assert.equal(fx.submissions.length, count + 1);
  const posted = fx.submissions.at(-1)!;
  assert.equal(posted.fields.firstName, "Ada"); assert.equal(posted.fields.lastName, "Lovelace"); assert.equal(posted.fields.email, "ada@example.test");
  assert.equal(posted.fields.disability, ""); assert.equal(posted.resume?.sha256, meta("cv-a", bytesA).sha256); assert.deepEqual(posted.resume?.bytes, bytesA);
  assert.match(outcome.receipt?.reference || "", /^REC-/);
});
test("second selected CV is sent, never the default CV", async () => {
  const { outcome } = await run("/alternate", "submit", { bytes: bytesB });
  assert.equal(outcome.state, "submitted");
  assert.equal(fx.submissions.at(-1)?.resume?.filename, "cv-b.pdf");
  assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-b", bytesB).sha256);
});
test("login redirects back and repeats in a fresh ephemeral context", async () => {
  const initial = fx.loginCount;
  const credential = { username: "applicant@example.test", password: "secret-pass" };
  assert.equal((await run("/login-apply", "submit", { credential })).outcome.state, "submitted");
  assert.equal((await run("/login-apply", "submit", { credential })).outcome.state, "submitted");
  assert.equal(fx.loginCount, initial + 2);
});
test("readonly login failure never logs the stored password", async () => {
  const old = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const { outcome } = await run("/readonly-login", "submit", { credential: { username: "applicant@example.test", password: "secret-pass" } });
    assert.equal(outcome.state, "blocked");
    assert.equal(logged.join("\n").includes("secret-pass"), false);
  } finally { console.error = old; }
});
test("multistep prepare reaches recap without POST; submit receives bytes", async () => {
  const count = fx.submissions.length;
  assert.equal((await run("/multi", "prepare", { answers: { "Work authorization": "Yes" } })).outcome.state, "ready");
  assert.equal(fx.submissions.length, count);
  assert.equal((await run("/multi", "submit", { answers: { "Work authorization": "Yes" } })).outcome.state, "submitted");
  assert.equal(fx.submissions.length, count + 1);
  assert.equal(fx.submissions.at(-1)?.resume?.sha256, meta("cv-a", bytesA).sha256);
});
test("unknown required answer, select mismatch and consent block; explicit answer works", async () => {
  const count = fx.submissions.length;
  const unknown = await run("/unknown", "submit");
  assert.equal(unknown.outcome.state, "needs_input"); assert.equal(unknown.marker, 0);
  assert.match(unknown.outcome.missingFields[0]?.label || "", /Work authorization/);
  assert.equal((await run("/unknown", "submit", { answers: { "Work authorization": "Maybe" } })).outcome.state, "needs_input");
  assert.equal((await run("/consent", "submit", { answers: { "I agree to the terms": false } })).outcome.state, "needs_input");
  assert.equal(fx.submissions.length, count);
  assert.equal((await run("/unknown", "submit", { answers: { "Work authorization": "Yes" } })).outcome.state, "submitted");
});
test("required answers can resume in the original open browser session", async () => {
  const b = browser();
  try {
    const visits = fx.unknownVisits;
    const submissions = fx.submissions.length;
    let marker = 0;
    const paused = await b.run(inputFor("/unknown", "submit", {}, () => { marker++; }));
    assert.equal(paused.state, "needs_input");
    assert.equal(paused.missingFields[0]?.key, "work authorization");
    assert.equal(b.hasPausedSession(), true);
    assert.equal(marker, 0);
    assert.equal(fx.unknownVisits, visits + 1);

    const resumed = await b.resume(inputFor("/unknown", "submit", { answers: { workAuthorization: "Yes" } }, () => { marker++; }));
    assert.equal(resumed.state, "submitted");
    assert.equal(marker, 1);
    assert.equal(fx.submissions.length, submissions + 1);
    assert.equal(fx.unknownVisits, visits + 1, "resume must not navigate back to the job form");
    assert.equal(b.hasPausedSession(), false);
  } finally { await b.close(); }
});
test("a manually entered required answer survives resume without profile automation overwriting it", async () => {
  const b = browser();
  try {
    const submissions = fx.submissions.length;
    const visits = fx.unknownVisits;
    const paused = await b.run(inputFor("/unknown", "submit"));
    assert.equal(paused.state, "needs_input");
    fx.resolveUnknownAnswer("No");
    await new Promise(resolveTimer => setTimeout(resolveTimer, 250));
    const resumed = await b.resume(inputFor("/unknown", "submit"));
    assert.equal(resumed.state, "submitted");
    assert.equal(fx.submissions.length, submissions + 1);
    assert.equal(fx.submissions.at(-1)?.fields.workAuthorization, "No");
    assert.equal(fx.unknownVisits, visits + 1);
  } finally { await b.close(); }
});
test("required select default Yes remains unanswered without explicit fact", async () => {
  const count = fx.submissions.length;
  const unknown = await run("/select-default", "submit");
  assert.equal(unknown.outcome.state, "needs_input");
  assert.equal(unknown.marker, 0);
  assert.equal(fx.submissions.length, count);
  const answered = await run("/select-default", "submit", { answers: { workAuthorization: "No" } });
  assert.equal(answered.outcome.state, "submitted");
  assert.equal(fx.submissions.at(-1)?.fields.workAuthorization, "No");
});
test("optional sensitive select default is not transmitted without an answer", async () => {
  const { outcome } = await run("/optional-default", "submit");
  assert.equal(outcome.state, "submitted");
  assert.equal(fx.submissions.at(-1)?.fields.disabilityStatus, undefined);
});
test("required radio group needs explicit answer and selects only matching choice", async () => {
  const count = fx.submissions.length;
  const unknown = await run("/radio-authorization", "submit");
  assert.equal(unknown.outcome.state, "needs_input");
  assert.equal(fx.submissions.length, count);
  const yes = await run("/radio-authorization", "submit", { answers: { workAuthorization: true } });
  assert.equal(yes.outcome.state, "submitted");
  assert.equal(fx.submissions.at(-1)?.fields.workAuthorization, "Yes");
  const no = await run("/radio-authorization", "submit", { answers: { workAuthorization: false } });
  assert.equal(no.outcome.state, "submitted");
  assert.equal(fx.submissions.at(-1)?.fields.workAuthorization, "No");
});
test('application answers override profile answers across field-name aliases',async()=>{
  const outcome=await browser().run({application:app({workAuthorization:'No'}),job:job('/select-default'),profile:{...profile,answers:{'Work authorization':'Yes'}},resume:{meta:meta('cv-a',bytesA),bytes:bytesA},mode:'submit',getCredential:()=>null,beforeSubmit:()=>{}});
  assert.equal(outcome.state,'submitted');assert.equal(fx.submissions.at(-1)?.fields.workAuthorization,'No');
});

test("CAPTCHA, MFA and foreign redirect stop before posting or credential use", async () => {
  const count = fx.submissions.length;
  let credentials = 0;
  assert.equal((await run("/challenge", "submit")).outcome.state, "blocked");
  assert.equal((await run("/mfa", "submit")).outcome.state, "blocked");
  const b = browser();
  try {
    const bad = await b.run({ application: app(), job: job("/bad-origin"), profile, resume: { meta: meta("cv-a", bytesA), bytes: bytesA }, mode: "submit", getCredential: () => { credentials++; return { username: "x", password: "y" }; }, beforeSubmit: () => assert.fail("must not submit") });
    assert.equal(bad.state, "blocked"); assert.equal(credentials, 0); assert.equal(fx.submissions.length, count);
  } finally { await b.close(); }
});
test("CAPTCHA and MFA leave the browser open until the user resolves the challenge and resumes", async () => {
  const count = fx.submissions.length;
  for (const [path, resolve] of [["/challenge", () => fx.resolveChallenge()], ["/mfa", () => fx.resolveMfa()]] as const) {
    const b = browser();
    try {
      const beforeIntervention = fx.submissions.length;
      const paused = await b.run(inputFor(path, "submit"));
      assert.equal(paused.state, "blocked");
      assert.match(paused.message, /CAPTCHA ou MFA/);
      assert.equal(b.hasPausedSession(), true);
      assert.equal(fx.submissions.length, beforeIntervention);
      const prematureResume = await b.resume(inputFor(path, "submit"));
      assert.equal(prematureResume.state, "blocked", "the live challenge must remain an intervention gate");
      assert.equal(b.hasPausedSession(), true);
      assert.equal(fx.submissions.length, beforeIntervention, "resuming cannot submit while the challenge remains visible");
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
test("an initial job-page redirect to an ATS is blocked before personal data or submission", async () => {
  const b = new CareerBrowser({ headless: true, allowedTestOrigins: [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin] });
  const seen: string[] = [];
  const submissions = fx.submissions.length;
  try {
    const outcome = await b.run({ application: app(), job: job("/ats-redirect"), profile, resume: { meta: meta("cv-a", bytesA), bytes: bytesA }, mode: "submit", getCredential: origin => { seen.push(origin); return origin === new URL(fx.atsUrl).origin ? { username: "ats@example.test", password: "ats-secret" } : null; }, beforeSubmit: () => {} });
    assert.equal(outcome.state, "blocked");
    assert.deepEqual(seen, []);
    assert.equal(fx.submissions.length, submissions);
  } finally { await b.close(); }
});
test("third-party exfiltration request is blocked while filling", async () => {
  const count = fx.exfilCount;
  const { outcome } = await run("/exfil", "submit");
  assert.equal(outcome.state, "submitted");
  assert.equal(fx.exfilCount, count);
});
test("service workers are blocked so they cannot bypass request interception with applicant data", async () => {
  const b = new CareerBrowser({ headless: true, allowedTestOrigins: [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin] });
  const input = inputFor("/service-worker-job", "submit");
  const exfilBefore = fx.exfilCount;
  const submissionsBefore = fx.submissions.length;
  try {
    let outcome = await b.run(input);
    assert.equal(outcome.state, "blocked", "the Apply link stays hidden until the Service Worker registration resolves");
    const context = (b as unknown as { context: import("playwright").BrowserContext }).context;
    const page = context.pages()[0];
    assert.ok(page);
    const registration = await page.evaluate(async () => {
      if (!navigator.serviceWorker) return "unavailable";
      try {
        const reg = await navigator.serviceWorker.register("/service-worker.js");
        await new Promise(resolve => setTimeout(resolve, 250));
        return reg.active?.state || reg.installing?.state || reg.waiting?.state || "registered";
      } catch { return "blocked"; }
    });
    assert.ok(registration === "unavailable" || registration === "blocked" || registration === "redundant", `Service Worker registration was not blocked: ${registration}`);
    assert.equal(context.serviceWorkers().length, 0, "the application context has no active Service Worker capable of intercepting requests");
    await page.locator("#apply").evaluate((link) => { (link as HTMLAnchorElement).hidden = false; });
    outcome = await b.resume(input);
    assert.equal(outcome.state, "submitted", outcome.message);
    assert.equal(fx.submissions.length, submissionsBefore + 1);
    assert.equal(fx.exfilCount, exfilBefore, "the attempted worker sent no applicant data to the cross-origin fixture");
  } finally { await b.close(); }
});
test("cross-origin WebSockets cannot bypass the application network filter", async () => {
  const b = new CareerBrowser({ headless: true, allowedTestOrigins: [new URL(fx.baseUrl).origin, new URL(fx.atsUrl).origin] });
  try {
    const outcome = await b.run(inputFor("/service-worker-job", "submit"));
    assert.equal(outcome.state, "blocked");
    const context = (b as unknown as { context: import("playwright").BrowserContext }).context;
    const page = context.pages()[0];
    assert.ok(page);
    const attemptsBefore = fx.websocketAttempts;
    const result = await page.evaluate((url) => new Promise<string>(resolve => {
      const socket = new WebSocket(url);
      let finished = false;
      const finish = (value: string) => {
        if (finished) return;
        finished = true;
        resolve(value);
      };
      socket.addEventListener("open", () => { socket.send("private applicant data"); finish("open"); }, { once: true });
      socket.addEventListener("close", () => finish("closed"), { once: true });
      socket.addEventListener("error", () => finish("error"), { once: true });
      setTimeout(() => finish("timeout"), 1500);
    }), fx.atsUrl.replace(/^http:/, "ws:") + "/collect-ws");
    assert.notEqual(result, "open", "the cross-origin WebSocket never becomes writable");
    assert.equal(fx.websocketAttempts, attemptsBefore, "the external fixture server receives no WebSocket handshake");
  } finally { await b.close(); }
});
test("rejects private URL outside exact constructor test origin", async () => {
  const b = new CareerBrowser({ headless: true });
  const outcome = await b.run({ application: app(), job: job("/simple"), profile, resume: { meta: meta("cv-a", bytesA), bytes: bytesA }, mode: "submit", getCredential: () => null, beforeSubmit: () => assert.fail() });
  assert.equal(outcome.state, "blocked");
});

test("rejects non-standard HTTPS ports before browser navigation", async () => {
  const b = new CareerBrowser({ headless: true });
  try {
    const input = inputFor("/simple", "submit");
    const outcome = await b.run({ ...input, job: { ...input.job, url: "https://careers.example.org:444/jobs/42" } });
    assert.equal(outcome.state, "blocked");
  } finally { await b.close(); }
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
