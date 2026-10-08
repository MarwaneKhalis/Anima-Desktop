import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { deflateRawSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { startCareerTestServer, waitFor } from "./helpers/career-server.ts";
import type { CareerProfile, Application } from "../src/shared/career.ts";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeDocx(): Buffer {
  const files = [
    [
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    ],
    [
      "word/document.xml",
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Anima test resume</w:t></w:r></w:p></w:body></w:document>',
    ],
  ] as const;
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(content);
    const compressed = deflateRawSync(raw);
    const checksum = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, compressed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function profile(): Omit<CareerProfile, "updatedAt"> {
  return {
    firstName: "Camille",
    lastName: "Martin",
    email: "camille.martin@example.test",
    phone: "+33123456789",
    city: "Paris",
    country: "France",
    address: "10 rue des Lilas",
    postalCode: "75011",
    headline: "Ingénieure logiciel",
    summary: "Expérience en systèmes web.",
    linkedinUrl: "https://www.linkedin.com/in/camille-martin-test",
    websiteUrl: "https://camille.example.test",
    skills: ["TypeScript", "Node.js"],
    languages: ["Français", "Anglais"],
    experiences: [
      {
        company: "Atelier Exemple",
        title: "Ingénieure",
        start: "2022-01",
        end: "2025-05",
        description: "Applications web.",
      },
    ],
    education: [
      {
        school: "Université Exemple",
        degree: "Master informatique",
        start: "2020",
        end: "2022",
      },
    ],
    preferences: {
      titles: ["Ingénieure logiciel"],
      locations: ["Paris"],
      remote: true,
      contract: "CDI",
    },
    answers: { "work-authorisation": "France", "consent-to-contact": true },
  };
}

test("career HTTP API drives isolated real-store application runs", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const assertOk = (response: Response, expected: number) =>
    assert.equal(
      response.status,
      expected,
      `unexpected HTTP response ${response.status}`,
    );

  await t.test(
    "real bootstrap, complete profile, PDF and DOCX bytes, safe download, idempotent application",
    async () => {
      const { response: initialResponse, value: initial } = await app.json(
        "/api/career/bootstrap",
      );
      assertOk(initialResponse, 200);
      assert.deepEqual(initial.jobs, []);
      assert.deepEqual(initial.applications, []);
      assert.deepEqual(initial.metrics, {
        savedJobs: 0,
        applications: 0,
        submitted: 0,
        needsAttention: 0,
        interviews: 0,
        offers: 0,
        rejected: 0,
      });
      assert.equal(initial.vault.initialized, false);

      const savedProfile = await app.json(
        "/api/career/profile",
        profile(),
        "PUT",
      );
      assertOk(savedProfile.response, 200);
      assert.equal(savedProfile.value.firstName, "Camille");
      assert.equal(savedProfile.value.answers["work-authorisation"], "France");

      const pdf = Buffer.from(
        "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n",
      );
      const docx = makeDocx();
      const uploaded: Array<{
        id: string;
        bytes: Buffer;
        filename: string;
        mime: string;
      }> = [];
      for (const item of [
        {
          name: "Profil ingénierie",
          filename: "camille.pdf",
          mime: "application/pdf",
          bytes: pdf,
        },
        {
          name: "Version recherche",
          filename: "camille.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes: docx,
        },
      ]) {
        const created = await app.json("/api/career/resumes", {
          name: item.name,
          filename: item.filename,
          mime: item.mime,
          base64: item.bytes.toString("base64"),
        });
        assertOk(created.response, 201);
        assert.equal(
          created.value.sha256,
          createHash("sha256").update(item.bytes).digest("hex"),
        );
        assert.equal(created.value.size, item.bytes.length);
        const download = await app.request(
          `/api/career/resumes/${created.value.id}/download`,
        );
        assertOk(download, 200);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), item.bytes);
        uploaded.push({
          id: created.value.id,
          bytes: item.bytes,
          filename: item.filename,
          mime: item.mime,
        });
      }

      const offer = await app.json("/api/career/jobs", {
        url: `${app.fixture.baseUrl}/simple`,
        title: "Ingénieure plateforme",
        company: "Anima Fixture",
        location: "Paris",
      });
      assertOk(offer.response, 201);
      const createBody = { jobId: offer.value.id, resumeId: uploaded[0].id };
      const first = await app.json("/api/career/applications", createBody);
      const second = await app.json("/api/career/applications", createBody);
      assertOk(first.response, 201);
      assert.equal(second.response.status, 200);
      assert.equal(first.value.id, second.value.id);
      assert.equal(second.value.resumeId, uploaded[0].id);
    },
  );

  await t.test(
    "prepare leaves final POST untouched; explicit submit records one verified receipt",
    async () => {
      const { value: snapshot } = await app.json("/api/career/bootstrap");
      const job = snapshot.jobs[0];
      const applicationId = snapshot.applications[0].id;
      const before = app.fixture.submissions.length;
      const start = await app.json(
        `/api/career/applications/${applicationId}/run`,
        { mode: "prepare" },
      );
      assertOk(start.response, 202);
      const ready = await waitFor(
        async () =>
          (await app.json(`/api/career/applications/${applicationId}`))
            .value as Application,
        (value) => value.state !== "running",
      );
      assert.equal(ready.state, "ready");
      assert.equal(app.fixture.submissions.length, before);

      const submitted = await app.json(
        `/api/career/applications/${applicationId}/run`,
        { mode: "submit" },
      );
      assertOk(submitted.response, 202);
      const final = await waitFor(
        async () =>
          (await app.json(`/api/career/applications/${applicationId}`))
            .value as Application,
        (value) => value.state !== "running" && value.state !== "submitting",
      );
      assert.equal(final.state, "submitted");
      assert.ok(final.receipt?.reference);
      assert.ok(final.submittedAt);
      const posts = app.fixture.submissions.slice(before);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].fields.email, "camille.martin@example.test");
      assert.equal(posts[0].fields.firstName, "Camille");
      assert.equal(posts[0].resume?.filename, "camille.pdf");
      assert.equal(
        posts[0].resume?.sha256,
        createHash("sha256").update(posts[0].resume.bytes).digest("hex"),
      );
      const replay = await app.json(
        `/api/career/applications/${applicationId}/run`,
        { mode: "submit" },
      );
      assert.equal(replay.response.status, 409);
      assert.equal(app.fixture.submissions.length, before + 1);
      const { value: fresh } = await app.json("/api/career/bootstrap");
      assert.equal(
        fresh.events.filter(
          (event: any) =>
            event.applicationId === job.id && event.kind === "submitted",
        ).length,
        0,
      );
      assert.equal(
        fresh.events.filter(
          (event: any) =>
            event.applicationId === applicationId && event.kind === "submitted",
        ).length,
        1,
      );
    },
  );

  await t.test(
    "multi-page prepare reaches recap without sending, then submit sends once",
    async () => {
      const { value: snapshot } = await app.json("/api/career/bootstrap");
      const job = await app.json("/api/career/jobs", {
        url: `${app.fixture.baseUrl}/multi`,
        title: "Ingénieure multi étapes",
        company: "Anima Fixture",
        location: "Lyon",
      });
      assertOk(job.response, 201);
      const chosenResume = snapshot.resumes.find(
        (resume: any) => resume.filename === "camille.docx",
      );
      assert.ok(chosenResume);
      const created = await app.json("/api/career/applications", {
        jobId: job.value.id,
        resumeId: chosenResume.id,
      });
      const id = created.value.id;
      const answers = await app.json(
        `/api/career/applications/${id}`,
        { answers: { "Work authorization": "Yes" } },
        "PATCH",
      );
      assertOk(answers.response, 200);
      const before = app.fixture.submissions.length;
      assertOk(
        (
          await app.json(`/api/career/applications/${id}/run`, {
            mode: "prepare",
          })
        ).response,
        202,
      );
      let current = await waitFor(
        async () =>
          (await app.json(`/api/career/applications/${id}`))
            .value as Application,
        (value) => value.state !== "running",
      );
      assert.equal(current.state, "ready");
      assert.equal(app.fixture.submissions.length, before);
      assertOk(
        (
          await app.json(`/api/career/applications/${id}/run`, {
            mode: "submit",
          })
        ).response,
        202,
      );
      current = await waitFor(
        async () =>
          (await app.json(`/api/career/applications/${id}`))
            .value as Application,
        (value) => value.state !== "running" && value.state !== "submitting",
      );
      assert.equal(current.state, "submitted");
      assert.equal(app.fixture.submissions.length - before, 1);
      assert.equal(app.fixture.submissions.at(-1)?.path, "/submit");
      assert.equal(
        app.fixture.submissions.at(-1)?.resume?.filename,
        "camille.docx",
      );
      assert.equal(
        app.fixture.submissions.at(-1)?.resume?.sha256,
        chosenResume.sha256,
      );
    },
  );

  await t.test(
    "missing answer and CAPTCHA stop before submission; unknown answers stay unanswered",
    async () => {
      const { value: snapshot } = await app.json("/api/career/bootstrap");
      for (const [path, expected] of [
        ["unknown", "needs_input"],
        ["challenge", "blocked"],
        ["mfa", "blocked"],
      ] as const) {
        const job = await app.json("/api/career/jobs", {
          url: `${app.fixture.baseUrl}/${path}`,
          title: path,
          company: "Anima Fixture",
          location: "Paris",
        });
        assertOk(job.response, 201);
        const created = await app.json("/api/career/applications", {
          jobId: job.value.id,
          resumeId: snapshot.resumes[0].id,
        });
        const id = created.value.id;
        const before = app.fixture.submissions.length;
        assertOk(
          (
            await app.json(`/api/career/applications/${id}/run`, {
              mode: "submit",
            })
          ).response,
          202,
        );
        const final = await waitFor(
          async () =>
            (await app.json(`/api/career/applications/${id}`))
              .value as Application,
          (value) => value.state !== "running" && value.state !== "submitting",
        );
        assert.equal(
          final.state,
          expected,
          `${path} must stop as ${expected}: ${final.lastError}`,
        );
        assert.equal(app.fixture.submissions.length, before);
        if (path === "unknown")
          assert.ok(
            final.missingFields.some((field) =>
              /work authorization/i.test(field.label),
            ),
          );
        // A paused browser is intentionally retained for an explicit resume.
        // Close it between independent API scenarios so the next run can start.
        assertOk((await app.json("/api/career/vault/lock", {})).response, 200);
      }
    },
  );

  await t.test(
    "a missing non-CV file resumes with the explicitly selected saved CV",
    async () => {
      const { value: snapshot } = await app.json("/api/career/bootstrap");
      const alternateBytes = Buffer.from("%PDF-1.7\nAlternate CV\n%%EOF\n");
      const alternate = await app.json("/api/career/resumes", {
        name: "CV ciblé",
        filename: "cv-cible.pdf",
        mime: "application/pdf",
        base64: alternateBytes.toString("base64"),
      });
      assertOk(alternate.response, 201);
      const job = await app.json("/api/career/jobs", {
        url: `${app.fixture.baseUrl}/portfolio`,
        title: "Portfolio requis",
        company: "Anima Fixture",
        location: "Paris",
      });
      const created = await app.json("/api/career/applications", {
        jobId: job.value.id,
        resumeId: snapshot.resumes[0].id,
      });
      const started = await app.json(
        `/api/career/applications/${created.value.id}/run`,
        { mode: "submit" },
      );
      assertOk(started.response, 202);
      const paused = await waitFor(
        async () =>
          (await app.json(`/api/career/applications/${created.value.id}`))
            .value as Application,
        (value) => value.state === "needs_input",
      );
      assert.ok(paused.missingFields.some((field) => field.key === "portfolio" && field.type === "file"));
      const resumed = await app.json(
        `/api/career/applications/${created.value.id}/resume`,
        { fileFieldKey: "portfolio", resumeId: alternate.value.id },
      );
      assertOk(resumed.response, 202);
      const submitted = await waitFor(
        async () =>
          (await app.json(`/api/career/applications/${created.value.id}`))
            .value as Application,
        (value) => value.state === "submitted" || ["blocked", "failed", "uncertain"].includes(value.state),
      );
      assert.equal(submitted.state, "submitted", submitted.lastError);
      assert.equal(submitted.resumeId, alternate.value.id);
      assert.equal(app.fixture.submissions.at(-1)?.resume?.filename, "cv-cible.pdf");
    },
  );

  await t.test(
    "an accepted POST without a verifiable receipt stays uncertain and cannot be replayed",
    async () => {
      const { value: snapshot } = await app.json("/api/career/bootstrap");
      const job = await app.json("/api/career/jobs", {
        url: `${app.fixture.baseUrl}/uncertain`,
        title: "Uncertain fixture",
        company: "Anima Fixture",
        location: "Paris",
      });
      const created = await app.json("/api/career/applications", {
        jobId: job.value.id,
        resumeId: snapshot.resumes[0].id,
      });
      const before = app.fixture.submissions.length;
      assertOk(
        (
          await app.json(`/api/career/applications/${created.value.id}/run`, {
            mode: "submit",
          })
        ).response,
        202,
      );
      const final = await waitFor(
        async () =>
          (await app.json(`/api/career/applications/${created.value.id}`))
            .value as Application,
        (value) => value.state !== "running" && value.state !== "submitting",
      );
      assert.equal(final.state, "uncertain", final.lastError);
      assert.equal(app.fixture.submissions.length, before + 1);
      assert.equal(app.fixture.submissions.at(-1)?.path, "/submit-uncertain");
      const replay = await app.json(
        `/api/career/applications/${created.value.id}/run`,
        { mode: "submit" },
      );
      assert.equal(replay.response.status, 409);
      assert.equal(app.fixture.submissions.length, before + 1);
    },
  );

  await t.test(
    "encrypted credential logs in on its exact origin; public projection and disk omit secrets",
    async () => {
      const passphrase = "correct horse fixture battery";
      const password = "secret-pass";
      const initialized = await app.json("/api/career/vault/initialize", {
        passphrase,
      });
      assertOk(initialized.response, 201);
      assert.equal(initialized.value.unlocked, true);
      const sourceSettings = await app.json("/api/career/sources/france-travail", {
        clientId: "fixture-client-id",
        clientSecret: "fixture-client-secret",
        scope: "fixture-scope",
      });
      assertOk(sourceSettings.response, 200);
      assert.equal(JSON.stringify(sourceSettings.value).includes("fixture-client-secret"), false);
      const sourceSummary = await app.json("/api/career/sources/france-travail");
      assert.equal(sourceSummary.value.configured, true);
      assert.equal(JSON.stringify(sourceSummary.value).includes("fixture-client-id"), false);
      const invalidSearch = await app.json("/api/career/sources/france-travail/search", {
        keywords: "développeur",
        commune: "7501",
      });
      assert.equal(invalidSearch.response.status, 400);
      assert.equal(invalidSearch.value.code, "validation");
      assert.equal((await app.json("/api/career/sources/france-travail", {}, "DELETE")).response.status, 200);
      const savedCredential = await app.json("/api/career/credentials", {
        origin: app.fixture.baseUrl,
        label: "Fixture",
        username: "applicant@example.test",
        password,
      });
      assertOk(savedCredential.response, 201);
      assert.equal(
        JSON.stringify(savedCredential.value).includes(password),
        false,
      );
      const { value: snapshot } = await app.json("/api/career/bootstrap");
      assert.equal(JSON.stringify(snapshot).includes(password), false);
      const job = await app.json("/api/career/jobs", {
        url: `${app.fixture.baseUrl}/login-apply`,
        title: "Login fixture",
        company: "Anima Fixture",
        location: "Paris",
      });
      const created = await app.json("/api/career/applications", {
        jobId: job.value.id,
        resumeId: snapshot.resumes[0].id,
      });
      assertOk(
        (
          await app.json(`/api/career/applications/${created.value.id}/run`, {
            mode: "submit",
            credentialId: savedCredential.value.id,
          })
        ).response,
        202,
      );
      const final = await waitFor(
        async () =>
          (await app.json(`/api/career/applications/${created.value.id}`))
            .value as Application,
        (value) => value.state !== "running" && value.state !== "submitting",
      );
      assert.equal(final.state, "submitted", final.lastError);
      assert.ok(app.fixture.loginCount > 0);
      assert.equal(
        app.fixture.submissions.at(-1)?.fields.email,
        "camille.martin@example.test",
      );

      const files = await readdir(app.dataDir);
      const databaseContents = (
        await Promise.all(
          files.map(async (file) => readFile(join(app.dataDir, file))),
        )
      )
        .map((buffer) => buffer.toString("latin1"))
        .join("\n");
      assert.equal(databaseContents.includes(password), false);
      assert.equal(databaseContents.includes(passphrase), false);

      const unsafeJob = await app.json("/api/career/jobs", {
        url: `${app.fixture.baseUrl}/bad-origin`,
        title: "Hostile redirect",
        company: "Anima Fixture",
        location: "Paris",
      });
      const unsafeApplication = await app.json("/api/career/applications", {
        jobId: unsafeJob.value.id,
        resumeId: snapshot.resumes[0].id,
      });
      const loginsBefore = app.fixture.loginCount;
      const submissionsBefore = app.fixture.submissions.length;
      assertOk(
        (
          await app.json(
            `/api/career/applications/${unsafeApplication.value.id}/run`,
            { mode: "submit", credentialId: savedCredential.value.id },
          )
        ).response,
        202,
      );
      const blocked = await waitFor(
        async () =>
          (
            await app.json(
              `/api/career/applications/${unsafeApplication.value.id}`,
            )
          ).value as Application,
        (value) => value.state !== "running" && value.state !== "submitting",
      );
      assert.equal(blocked.state, "blocked", blocked.lastError);
      assert.equal(app.fixture.loginCount, loginsBefore);
      assert.equal(app.fixture.submissions.length, submissionsBefore);
      assertOk((await app.json("/api/career/vault/lock", {})).response, 200);
    },
  );

  await t.test(
    "concurrent requests return 409 and vault lock stops the active run",
    async () => {
      const { value: snapshot } = await app.json("/api/career/bootstrap");
      const slowJob = await app.json("/api/career/jobs", {
        url: `${app.fixture.baseUrl}/slow`,
        title: "Slow fixture",
        company: "Anima Fixture",
      });
      const secondJob = await app.json("/api/career/jobs", {
        url: `${app.fixture.baseUrl}/simple?concurrent=1`,
        title: "Second fixture",
        company: "Anima Fixture",
      });
      const first = await app.json("/api/career/applications", {
        jobId: slowJob.value.id,
        resumeId: snapshot.resumes[0].id,
      });
      const second = await app.json("/api/career/applications", {
        jobId: secondJob.value.id,
        resumeId: snapshot.resumes[0].id,
      });
      const count = app.fixture.submissions.length;
      assert.equal(
        (
          await app.json(`/api/career/applications/${first.value.id}/run`, {
            mode: "submit",
          })
        ).response.status,
        202,
      );
      assert.equal(
        (
          await app.json(`/api/career/applications/${second.value.id}/run`, {
            mode: "submit",
          })
        ).response.status,
        409,
      );
      assert.equal(
        (await app.json("/api/career/vault/lock", {})).response.status,
        200,
      );
      const stopped = (
        await app.json(`/api/career/applications/${first.value.id}`)
      ).value;
      assert.equal(stopped.state, "failed");
      assert.equal(app.fixture.submissions.length, count);
      assert.equal(
        (await app.json("/api/career/bootstrap")).value.vault.unlocked,
        false,
      );
    },
  );

  await t.test(
    "mutations require request marker and same-origin policy rejects hostile origin",
    async () => {
      const missingHeader = await fetch(`${app.baseUrl}/api/career/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `${app.fixture.baseUrl}/simple`,
          title: "X",
          company: "Y",
          location: "Z",
        }),
      });
      assert.equal(missingHeader.status, 403);
      const hostile = await app.request("/api/career/bootstrap", {
        headers: {
          Origin: "https://evil.example",
          "Sec-Fetch-Site": "cross-site",
        },
      });
      assert.equal(hostile.status, 403);
      const wrongHost = await new Promise<number>((resolve, reject) => {
        const target = new URL(app.baseUrl);
        const req = httpRequest(
          {
            hostname: target.hostname,
            port: Number(target.port),
            path: "/api/career/bootstrap",
            method: "GET",
            headers: { Host: "evil.example", "X-Anima-Request": "1" },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode || 0));
          },
        );
        req.once("error", reject);
        req.end();
      });
      assert.equal(wrongHost, 403);
      const safe = await app.request("/api/career/bootstrap");
      assert.equal(safe.headers.get("cache-control"), "no-store");
    },
  );
});
