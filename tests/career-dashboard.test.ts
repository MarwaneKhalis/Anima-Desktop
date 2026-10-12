import test from "node:test";
import assert from "node:assert/strict";
import type { Application } from "../src/shared/career.ts";
import type { Prospect } from "../src/shared/types.ts";
import { dueFollowups, dueProspectFollowups, prioritizeAttention, summarizeDailyActions } from "../src/shared/career-dashboard.ts";

const application = (overrides: Partial<Application> = {}): Application => ({
  id: "app",
  jobId: "job",
  resumeId: "resume",
  prospectId: null,
  state: "draft",
  outcome: "active",
  answers: {},
  missingFields: [],
  notes: "",
  nextActionAt: "",
  lastError: "",
  receipt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  submittedAt: null,
  ...overrides,
});

const prospect = (overrides: Partial<Prospect> = {}): Prospect => ({
  id: "prospect",
  linkedinUrl: "",
  firstName: "Camille",
  lastName: "Martin",
  title: "Recruteuse",
  company: "Fixture",
  location: "",
  school: "",
  status: "À examiner",
  tags: [],
  notes: "",
  nextAction: "",
  nextActionAt: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("daily restart prioritizes uncertain and blocked work before generic failures", () => {
  const applications = [
    application({ id: "failed", state: "failed", updatedAt: "2026-10-12T12:00:00Z" }),
    application({ id: "blocked", state: "blocked" }),
    application({ id: "needs-input", state: "needs_input" }),
    application({ id: "uncertain", state: "uncertain" }),
    application({ id: "draft", state: "draft" }),
  ];
  assert.deepEqual(prioritizeAttention(applications).map(({ id }) => id), [
    "uncertain", "needs-input", "blocked", "failed",
  ]);
});

test("daily restart orders due follow-ups and excludes future, inactive, and already blocked applications", () => {
  const applications = [
    application({ id: "later-due", nextActionAt: "2026-10-11T09:00:00.000Z" }),
    application({ id: "earlier-due", nextActionAt: "2026-10-09T09:00:00.000Z" }),
    application({ id: "interview-due", nextActionAt: "2026-10-10T09:00:00.000Z", outcome: "interview" }),
    application({ id: "offer-due", nextActionAt: "2026-10-10T10:00:00.000Z", outcome: "offer" }),
    application({ id: "future", nextActionAt: "2026-10-13T09:00:00.000Z" }),
    application({ id: "rejected", nextActionAt: "2026-10-08T09:00:00.000Z", outcome: "rejected" }),
    application({ id: "withdrawn", nextActionAt: "2026-10-08T09:00:00.000Z", outcome: "withdrawn" }),
    application({ id: "blocked", state: "needs_input", nextActionAt: "2026-10-08T09:00:00.000Z" }),
  ];
  assert.deepEqual(
    dueFollowups(applications, new Date("2026-10-12T12:00:00.000Z")).map(({ id }) => id),
    ["earlier-due", "interview-due", "offer-due", "later-due"],
  );
});

test("follow-up due state uses the exact instant, including timezone offsets", () => {
  const applications = [
    application({ id: "later-instant", nextActionAt: "2026-10-12T10:30:00-04:00" }),
    application({ id: "earlier-today", nextActionAt: "2026-10-12T14:00:00+02:00" }),
    application({ id: "later-today", nextActionAt: "2026-10-12T16:00:00+02:00" }),
    application({ id: "malformed", nextActionAt: "not-a-date" }),
  ];
  assert.deepEqual(
    dueFollowups(applications, new Date("2026-10-12T16:00:00.000Z")).map(({ id }) => id),
    ["earlier-today", "later-today", "later-instant"],
  );
});

test("daily contact reminders require an action, exclude inactive contacts, and sort by due time", () => {
  const prospects = [
    prospect({ id: "later", firstName: "Zoé", nextAction: "Envoyer un message manuellement", nextActionAt: "2026-10-11T10:30:00-04:00" }),
    prospect({ id: "earlier", firstName: "Amélie", nextAction: "Préparer un échange", nextActionAt: "2026-10-10T09:00:00Z" }),
    prospect({ id: "future", nextAction: "Relancer", nextActionAt: "2026-10-13T09:00:00Z" }),
    prospect({ id: "no-action", nextActionAt: "2026-10-09T09:00:00Z" }),
    prospect({ id: "no-date", nextAction: "Relancer" }),
    prospect({ id: "inactive", status: "Sans suite", nextAction: "Relancer", nextActionAt: "2026-10-08T09:00:00Z" }),
    prospect({ id: "do-not-contact", status: "À ne pas contacter", nextAction: "Relancer", nextActionAt: "2026-10-08T09:00:00Z" }),
    prospect({ id: "malformed", nextAction: "Relancer", nextActionAt: "pas une date" }),
  ];
  assert.deepEqual(
    dueProspectFollowups(prospects, new Date("2026-10-12T12:00:00.000Z")).map(({ id }) => id),
    ["earlier", "later"],
  );
});

test("daily summary counts every action while keeping extra blockers discoverable", () => {
  const summary = summarizeDailyActions(["running"], ["uncertain", "needs-input", "blocked", "failed"], ["application", "contact"], 12);
  assert.deepEqual(summary, {
    campaignCount: 12,
    hiddenCampaignCount: 11,
    attentionCount: 4,
    followupCount: 2,
    visibleAttention: ["uncertain", "needs-input", "blocked"],
    hiddenAttentionCount: 1,
    totalCount: 18,
  });
});
