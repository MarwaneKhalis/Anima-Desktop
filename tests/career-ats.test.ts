import assert from "node:assert/strict";
import { test } from "node:test";
import { allowsCareerAtsNavigation, allowsCareerAtsResource, careerAtsForHostname, careerAtsForUrl } from "../server/career-ats.ts";

test("only the explicit public Greenhouse and Lever job-board hosts are ATS destinations", () => {
  assert.equal(careerAtsForHostname("boards.greenhouse.io"), "greenhouse");
  assert.equal(careerAtsForHostname("job-boards.greenhouse.io"), "greenhouse");
  assert.equal(careerAtsForHostname("boards.eu.greenhouse.io"), "greenhouse");
  assert.equal(careerAtsForHostname("jobs.lever.co"), "lever");
  assert.equal(careerAtsForHostname("jobs.eu.lever.co"), "lever");
  assert.equal(careerAtsForUrl("https://boards.greenhouse.io/acme/jobs/123"), "greenhouse");
  assert.equal(careerAtsForHostname("greenhouse.io.evil.example"), null);
  assert.equal(careerAtsForHostname("jobs.lever.co.evil.example"), null);
  assert.equal(careerAtsForHostname("boards.greenhouse.com"), null);
});

test("cross-origin ATS allowances are limited to passive GET assets on named vendor origins", () => {
  const request = { from: "https://boards.greenhouse.io/acme/jobs/123", to: "https://job-boards.greenhouse.io/assets/form.js", method: "GET", kind: "script" as const };
  assert.equal(allowsCareerAtsResource(request), true);
  assert.equal(allowsCareerAtsResource({ ...request, to: "https://static.greenhouse.io/assets/form.css", kind: "stylesheet" }), true);
  assert.equal(allowsCareerAtsResource({ ...request, to: "https://static.greenhouse.io/collect.gif?email=private", kind: "image" }), false);
  assert.equal(allowsCareerAtsResource({ ...request, to: "https://static.greenhouse.io/assets/logo.svg", kind: "image" }), false);
  assert.equal(allowsCareerAtsResource({ ...request, to: "https://static.greenhouse.io/assets/form.js", kind: "script" }), false);
  assert.equal(allowsCareerAtsResource({ ...request, to: "https://static.greenhouse.io/personal.css", kind: "stylesheet" }), false);
  assert.equal(allowsCareerAtsResource({ ...request, to: "https://boards.greenhouse.io/submit", method: "POST", kind: "xhr" }), false);
  assert.equal(allowsCareerAtsResource({ ...request, from: "https://jobs.lever.co/acme/123", to: "https://boards.greenhouse.io/assets/form.js" }), false);
  assert.equal(allowsCareerAtsResource({ ...request, to: "https://evil.example/form.js" }), false);
  assert.equal(allowsCareerAtsResource({ ...request, to: "http://job-boards.greenhouse.io/assets/form.js" }), false);
  assert.equal(allowsCareerAtsResource({ ...request, kind: "document" }), false);
});

test("cross-origin document navigation needs an explicit Apply target or same-vendor redirect", () => {
  const testOrigins = new Set<string>();
  const base = { from: "https://careers.example/jobs/1", initialNavigation: false, redirected: false, testOrigins };
  assert.equal(allowsCareerAtsNavigation({ ...base, to: "https://boards.greenhouse.io/acme/jobs/12/apply", pendingAtsOrigin: "https://boards.greenhouse.io" }), true);
  assert.equal(allowsCareerAtsNavigation({ ...base, to: "https://jobs.lever.co/acme/id/apply", pendingAtsOrigin: "https://jobs.lever.co" }), true);
  assert.equal(allowsCareerAtsNavigation({ ...base, to: "https://evil.example/apply", pendingAtsOrigin: "https://evil.example" }), false);
  assert.equal(allowsCareerAtsNavigation({ ...base, from: "https://boards.greenhouse.io/acme/jobs/12", to: "https://job-boards.greenhouse.io/acme/jobs/12/apply", redirected: true }), true);
  assert.equal(allowsCareerAtsNavigation({ ...base, from: "https://boards.greenhouse.io/acme/jobs/12", to: "https://jobs.lever.co/acme/id/apply", redirected: true }), false);
});
