import assert from "node:assert/strict";
import test from "node:test";
import { startCareerTestServer } from "./helpers/career-server.ts";

test("portable backup round-trips a durable SQLite database", async (t) => {
  const server = await startCareerTestServer();
  t.after(() => server.close());

  await server.json("/api/career/profile", { firstName: "Léa", lastName: "Martin" }, "PUT");
  const passphrase = "AnimaDesktopSmokeRestore-2026";
  const backupResponse = await server.request("/api/backup?demo=0", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  assert.equal(backupResponse.status, 200, await backupResponse.clone().text());
  const backup = Buffer.from(await backupResponse.arrayBuffer());
  assert.equal(backup.subarray(0, 8).toString("ascii"), "ANIMABK1");

  await server.json("/api/career/profile", { firstName: "Édith", lastName: "Test" }, "PUT");
  const restoreResponse = await server.request("/api/restore?demo=0", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Anima-Backup-Passphrase-Base64": Buffer.from(passphrase, "utf8").toString("base64"),
    },
    body: backup,
  });
  assert.equal(restoreResponse.status, 200, await restoreResponse.clone().text());
  assert.equal((await restoreResponse.json()).restored, true);
  const profile = await server.json("/api/career/bootstrap");
  assert.equal(profile.response.status, 200);
  assert.equal(profile.value.profile.firstName, "Léa");
});
