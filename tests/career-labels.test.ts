import test from "node:test";
import assert from "node:assert/strict";
import type { ApplicationState, Outcome } from "../src/shared/career.ts";
import type { QueueItem } from "../src/shared/types.ts";
import {
  APPLICATION_STATE_META,
  CAMPAIGN_ITEM_STATE_META,
  CAMPAIGN_STATE_META,
  EMPLOYER_OUTCOME_META,
  EMPLOYER_RESPONSE_TYPE_LABELS,
  EMPLOYER_RESPONSE_CHANNEL_LABELS,
  NETWORK_QUEUE_STATE_META,
  MESSAGE_STATE_META,
} from "../src/shared/career-labels.ts";

test("every application and operation state has a centralized, explained label", () => {
  const groups = [
    APPLICATION_STATE_META,
    CAMPAIGN_STATE_META,
    CAMPAIGN_ITEM_STATE_META,
    NETWORK_QUEUE_STATE_META,
    MESSAGE_STATE_META,
  ];
  for (const group of groups) {
    for (const [key, meta] of Object.entries(group)) {
      assert.ok(meta.label.trim(), `${key} has a label`);
      assert.ok(meta.description.trim(), `${key} explains what happened`);
    }
  }
});

test("automation states are distinct from employer-reported outcomes", () => {
  const applicationStates: ApplicationState[] = ["draft", "running", "ready", "needs_input", "blocked", "submitting", "submitted", "uncertain", "failed"];
  const outcomes: Outcome[] = ["active", "interview", "offer", "rejected", "withdrawn"];
  assert.deepEqual(Object.keys(APPLICATION_STATE_META).sort(), applicationStates.sort());
  assert.deepEqual(Object.keys(EMPLOYER_OUTCOME_META).sort(), outcomes.sort());
  assert.match(APPLICATION_STATE_META.uncertain.description, /avant toute nouvelle tentative/i);
  assert.match(APPLICATION_STATE_META.submitted.description, /portail a confirmé/i);
  assert.match(EMPLOYER_OUTCOME_META.active.description, /aucun résultat employeur/i);
  assert.match(EMPLOYER_OUTCOME_META.interview.description, /retour de l’employeur/i);
  assert.notEqual(APPLICATION_STATE_META.submitted.label, EMPLOYER_OUTCOME_META.interview.label);
  assert.ok(Object.values(EMPLOYER_RESPONSE_TYPE_LABELS).every((label) => label.trim()));
  assert.ok(Object.values(EMPLOYER_RESPONSE_CHANNEL_LABELS).every((label) => label.trim()));
});

test("network queue labels preserve the manual action boundary", () => {
  const states: QueueItem["state"][] = ["pending", "open", "sent", "uncertain", "cancelled"];
  assert.deepEqual(Object.keys(NETWORK_QUEUE_STATE_META).sort(), states.sort());
  assert.match(NETWORK_QUEUE_STATE_META.open.description, /aucun message n’a été envoyé/i);
  assert.match(NETWORK_QUEUE_STATE_META.sent.description, /envoi manuel/i);
  assert.match(MESSAGE_STATE_META.draft.description, /n’a pas été envoyé/i);
  assert.match(MESSAGE_STATE_META.sent.description, /envoi manuel/i);
});
