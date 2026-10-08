import assert from "node:assert/strict";
import test from "node:test";
import { resolveTestFixtureUrl } from "../server/test-fixtures.ts";

test("test URLs accept only explicitly allowed loopback origins", () => {
  const origin = "http://127.0.0.1:43127";
  assert.equal(resolveTestFixtureUrl(`${origin}/apply`, [origin]), `${origin}/apply`);
  assert.equal(resolveTestFixtureUrl(undefined, [origin]), undefined);
  assert.equal(resolveTestFixtureUrl("", [origin]), undefined);
  assert.throws(() => resolveTestFixtureUrl("https://jobs.example/apply", [origin]), /local/);
  assert.throws(() => resolveTestFixtureUrl("http://127.0.0.1:43128/apply", [origin]), /autorisée/);
  assert.throws(() => resolveTestFixtureUrl("http://127.0.0.1:43127@jobs.example/apply", [origin]), /local/);
  assert.throws(() => resolveTestFixtureUrl("not a URL", [origin]), /invalide/);
});
