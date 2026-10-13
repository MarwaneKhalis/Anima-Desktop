import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startCareerTestServer } from "./helpers/career-server.ts";

test("AI cover-letter drafts autosave per application, survive reload, and remain after failed regeneration", async (t) => {
  const app = await startCareerTestServer();
  t.after(() => app.close());
  const resume = await app.json("/api/career/resumes", {
    name: "CV lettres", filename: "cv-lettres.pdf", mime: "application/pdf",
    base64: Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64"),
  });
  const firstJob = await app.json("/api/career/jobs", { url: `${app.fixture.baseUrl}/simple?letter=one`, title: "Ingénieure produit", company: "Atelier Horizon" });
  const secondJob = await app.json("/api/career/jobs", { url: `${app.fixture.baseUrl}/simple?letter=two`, title: "Designer produit", company: "Studio Minéral" });
  const first = await app.json("/api/career/applications", { jobId: firstJob.value.id, resumeId: resume.value.id });
  const second = await app.json("/api/career/applications", { jobId: secondJob.value.id, resumeId: resume.value.id });
  const saved = new Map<string, { draft: string; model: string; updatedAt: string }>();
  let failNextGeneration = false;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.addInitScript(() => { (window as unknown as { anima?: unknown }).anima = {}; });
  await page.route("**/api/career/ai/config*", async (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ configured: true, vaultUnlocked: true, settings: { baseUrl: "https://api.example.test/v1", model: "fixture-model", updatedAt: "" } }),
  }));
  await page.route("**/api/career/applications/*/cover-letter-draft*", async (route) => {
    const request = route.request();
    const applicationId = new URL(request.url()).pathname.split("/").at(-2)!;
    if (request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ draft: saved.get(applicationId) || null }) });
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as { draft: string; model: string };
      const value = { ...body, updatedAt: new Date().toISOString() };
      saved.set(applicationId, value);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ draft: value }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true }) });
  });
  await page.route("**/api/career/ai/cover-letter*", async (route) => {
    if (failNextGeneration) {
      failNextGeneration = false;
      return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Fournisseur IA indisponible." }) });
    }
    const body = route.request().postDataJSON() as { applicationId: string };
    const value = { draft: `Brouillon généré pour ${body.applicationId}.`, model: "fixture-model", updatedAt: new Date().toISOString() };
    saved.set(body.applicationId, value);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });

  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Candidatures", exact: true }).click();
  const firstRow = page.locator(".cw-application").filter({ hasText: "Ingénieure produit" });
  await firstRow.getByRole("button", { name: "Ouvrir le suivi →" }).click();
  const editor = page.locator(".ai-assistant__draft textarea");
  await editor.waitFor();
  await page.getByRole("button", { name: "Générer le brouillon" }).click();
  await editor.waitFor();
  await page.waitForFunction(() => (document.querySelector(".ai-assistant__draft textarea") as HTMLTextAreaElement | null)?.value.startsWith("Brouillon généré pour"));
  await editor.fill("Lettre personnelle conservée et vérifiable.");
  await page.getByText("Enregistré.", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(saved.get(first.value.id)?.draft, "Lettre personnelle conservée et vérifiable.");

  failNextGeneration = true;
  await page.getByRole("button", { name: "Générer le brouillon" }).click();
  await page.getByRole("alert").filter({ hasText: "Fournisseur IA indisponible." }).waitFor();
  assert.equal(await editor.inputValue(), "Lettre personnelle conservée et vérifiable.");
  assert.equal(saved.get(first.value.id)?.draft, "Lettre personnelle conservée et vérifiable.");

  await page.getByRole("button", { name: "Fermer la candidature" }).click();
  const secondRow = page.locator(".cw-application").filter({ hasText: "Designer produit" });
  await secondRow.getByRole("button", { name: "Ouvrir le suivi →" }).click();
  await editor.waitFor();
  assert.equal(await editor.inputValue(), "", "Une autre candidature ne réutilise jamais le brouillon précédent.");
  await page.getByRole("button", { name: "Fermer la candidature" }).click();
  await firstRow.getByRole("button", { name: "Ouvrir le suivi →" }).click();
  await page.waitForFunction(() => (document.querySelector(".ai-assistant__draft textarea") as HTMLTextAreaElement | null)?.value === "Lettre personnelle conservée et vérifiable.");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Candidatures", exact: true }).click();
  await page.locator(".cw-application").filter({ hasText: "Ingénieure produit" }).getByRole("button", { name: "Ouvrir le suivi →" }).click();
  await page.waitForFunction(() => (document.querySelector(".ai-assistant__draft textarea") as HTMLTextAreaElement | null)?.value === "Lettre personnelle conservée et vérifiable.");
});

