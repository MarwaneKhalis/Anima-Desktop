import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LocalBrowser } from "./browser.ts";
import { Store } from "./db.ts";
import { CareerError, CareerStore } from "./career-store.ts";
import { Vault } from "./vault.ts";
import { CareerBrowser } from "./career-browser.ts";
import { CareerRunner } from "./career-runner.ts";
import { CareerAI } from "./career-ai.ts";
import { handleCareerApi } from "./career-api.ts";
import { createCareerCampaignRuntime } from "./career-campaign-runtime.ts";
import { handleCareerCampaignApi } from "./career-campaign-api.ts";
import { JobDiscovery } from "./job-discovery.ts";
import { FranceTravailDiscovery } from "./france-travail-discovery.ts";
import { ArbeitnowFranceDiscovery } from "./arbeitnow-france-discovery.ts";
import { JobicyRemoteDiscovery } from "./jobicy-remote-discovery.ts";
import { csvParse, csvStringify, makeSearchUrl } from "./domain.ts";
import type { Prospect, SavedSearch, Template } from "../src/shared/types.ts";
import type { OfferSearchService } from "../src/shared/career.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = process.env.ANIMA_DATA_DIR
  ? resolve(process.env.ANIMA_DATA_DIR)
  : join(root, "data");
mkdirSync(dataDir, { recursive: true });
const realPath = join(dataDir, "anima-connect.sqlite");
const demoPath = join(dataDir, "demo.sqlite");
let realStore = new Store(realPath);
const demoStore = new Store(demoPath);
demoStore.seedDemo();
const browser = new LocalBrowser(join(dataDir, "browser-profile"));
const port = Number(process.env.PORT || 4174);
const allowedTestOrigins: string[] =
  process.env.ANIMA_TEST_MODE === "1"
    ? JSON.parse(process.env.CAREER_TEST_ORIGINS || "[]")
    : [];
if (
  !Array.isArray(allowedTestOrigins) ||
  allowedTestOrigins.some(
    (origin) =>
      typeof origin !== "string" ||
      !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin),
  )
)
  throw new Error("Origines de test invalides.");
const careerOptions = { allowedTestOrigins };
const careerBrowser = new CareerBrowser({
  ...careerOptions,
  headless: process.env.CAREER_HEADLESS === "1",
});
const discovery = new JobDiscovery(allowedTestOrigins);
const testFranceTravailUrl = process.env.ANIMA_TEST_MODE === "1"
  ? process.env.CAREER_TEST_FRANCE_TRAVAIL_URL
  : undefined;
const testOfferSearch: OfferSearchService | undefined = testFranceTravailUrl
  ? {
      search: async (criteria) => ({
        offers: [{
          url: testFranceTravailUrl,
          title: "Offre de test France Travail",
          company: "Entreprise de test",
          location: "Paris",
          description: "Offre synthétique pour test de bout en bout.",
          sourceUrl: testFranceTravailUrl,
        }],
        note: `Résultat de test pour ${criteria.keywords}.`,
      }),
    }
  : undefined;
const testArbeitnowUrl = process.env.ANIMA_TEST_MODE === "1" ? process.env.CAREER_TEST_ARBEITNOW_URL : undefined;
const testPublicOfferSearch: OfferSearchService | undefined = testArbeitnowUrl
  ? { search: async (criteria) => ({ offers: [{ url: testArbeitnowUrl, title: "Offre de test Arbeitnow France", company: "Entreprise de test", location: "Paris, France", description: "Offre synthétique pour test de bout en bout.", sourceUrl: "https://www.arbeitnow.fr" }], note: `Résultat de test pour ${criteria.keywords}.` }) }
  : undefined;
const testJobicyUrl = process.env.ANIMA_TEST_MODE === "1" ? process.env.CAREER_TEST_JOBICY_URL : undefined;
const testJobicyOfferSearch: OfferSearchService | undefined = testJobicyUrl
  ? { search: async (criteria) => ({ offers: [{ url: testJobicyUrl, title: "Offre de test Jobicy France", company: "Entreprise de test", location: "France (Remote)", description: "Offre synthétique pour test de bout en bout.", sourceUrl: "https://jobicy.com/jobs/test" }], note: `Résultat de test Jobicy pour ${criteria.keywords}.` }) }
  : undefined;
let careerStore = new CareerStore(realStore.db, careerOptions);
let vault = new Vault(realStore.db, careerOptions);
let runner = new CareerRunner(careerStore, vault, careerBrowser);
careerStore.recoverInterruptedRuns();
let campaignRuntime = createCareerCampaignRuntime(careerStore, runner);
void campaignRuntime.engine.recoverAfterRestart().catch((error) =>
  console.error("Échec de reprise des campagnes de candidature :", error),
);
const demoCareerStore = new CareerStore(demoStore.db);
const demoVault = new Vault(demoStore.db);
const demoBrowser = new CareerBrowser();
const demoRunner = new CareerRunner(demoCareerStore, demoVault, demoBrowser);
demoCareerStore.seedDemo();
const demoCampaignRuntime = createCareerCampaignRuntime(demoCareerStore, demoRunner);

function respond(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
function fail(res: ServerResponse, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  respond(res, /introuvable/i.test(message) ? 404 : 400, { error: message });
}
async function body(
  req: IncomingMessage,
  maxBytes = 2_000_000,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Fichier ou requête trop volumineux.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage): Promise<Record<string, any>> {
  if (!(req.headers["content-type"] || "").includes("application/json"))
    throw new Error("Contenu JSON attendu.");
  const raw = await body(req);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("JSON invalide.");
  }
}
function download(
  res: ServerResponse,
  filename: string,
  content: string | Buffer,
  type: string,
) {
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(content);
}
function staticFile(pathname: string, res: ServerResponse) {
  const dist = join(root, "dist");
  const path = resolve(
    dist,
    "." + (pathname === "/" ? "/index.html" : pathname),
  );
  const target =
    path.startsWith(dist + sep) && existsSync(path)
      ? path
      : join(dist, "index.html");
  if (!existsSync(target)) {
    res.writeHead(404);
    res.end("Build absent. Lancez pnpm dev ou pnpm build.");
    return;
  }
  const mime: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };
  res.writeHead(200, {
    "Content-Type":
      (mime[extname(target)] || "application/octet-stream") + "; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(readFileSync(target));
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (
    !hosts.includes(req.headers.host || "") ||
    req.headers["sec-fetch-site"] === "cross-site"
  ) {
    respond(res, 403, {
      error: "Requête locale non autorisée.",
      code: "origin",
    });
    return;
  }
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const path = url.pathname,
    method = req.method || "GET";
  if (!path.startsWith("/api/")) {
    staticFile(path, res);
    return;
  }
  const origin = req.headers.origin;
  if (
    origin &&
    ![
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ].includes(origin)
  ) {
    respond(res, 403, { error: "Origine non autorisée." });
    return;
  }
  const demo = url.searchParams.get("demo") === "1";
  const store = demo ? demoStore : realStore;
  try {
    const campaigns = demo ? demoCampaignRuntime : campaignRuntime;
    if (
      await handleCareerCampaignApi(req, res, url, {
        careerStore: demo ? demoCareerStore : careerStore,
        campaigns: campaigns.campaigns,
        engine: campaigns.engine,
        demo,
          credentialExists: (id) => (demo ? demoVault : vault).listCredentials().some((credential) => credential.id === id),
          closePausedRunnerFor: async (applicationId) => {
            const selectedRunner = demo ? demoRunner : runner;
            if (selectedRunner.pausedApplicationId() === applicationId) await selectedRunner.stop();
          },
        ensureRunnerAvailable: () => {
          const selectedRunner = demo ? demoRunner : runner;
          if (selectedRunner.isBusy() || selectedRunner.hasPausedSession())
            throw new CareerError(409, "browser_busy", "Le navigateur traite déjà une candidature ou attend une intervention.");
        },
        onBackgroundError: (error, campaignId) =>
          console.error(`Campagne ${campaignId} interrompue :`, error),
      })
    )
      return;
    if (
      await handleCareerApi(req, res, url, {
        store: demo ? demoCareerStore : careerStore,
        vault: demo ? demoVault : vault,
        ai: electronMode && !demo ? new CareerAI(careerStore, vault) : undefined,
        runner: demo ? demoRunner : runner,
        discovery,
        offerSearch: demo
          ? new FranceTravailDiscovery(demoVault)
          : testOfferSearch || new FranceTravailDiscovery(vault),
        publicOfferSearch: testPublicOfferSearch || new ArbeitnowFranceDiscovery(),
        jobicyOfferSearch: testJobicyOfferSearch || (demo ? undefined : new JobicyRemoteDiscovery()),
        demo,
        allowedTestOrigins,
      })
    )
      return;
    if (method === "GET" && path === "/api/bootstrap") {
      respond(res, 200, {
        searches: store.listSearches(),
        prospects: store.listProspects(),
        templates: store.listTemplates(),
        queue: store.listQueue(),
        settings: store.getSettings(),
        activity: store.listActivity(),
        metrics: store.getMetrics(),
        demo,
      });
      return;
    }
    if (method === "GET" && /^\/api\/prospects\/[^/]+$/.test(path)) {
      respond(res, 200, store.getProspect(path.split("/")[3]));
      return;
    }
    if (method === "POST" && path === "/api/searches") {
      respond(
        res,
        201,
        store.saveSearch((await json(req)) as unknown as SavedSearch),
      );
      return;
    }
    if (method === "PUT" && /^\/api\/searches\/[^/]+$/.test(path)) {
      respond(
        res,
        200,
        store.saveSearch(
          (await json(req)) as unknown as SavedSearch,
          path.split("/")[3],
        ),
      );
      return;
    }
    if (method === "POST" && /^\/api\/searches\/[^/]+\/duplicate$/.test(path)) {
      respond(res, 201, store.duplicateSearch(path.split("/")[3]));
      return;
    }
    if (method === "POST" && path === "/api/prospects/import") {
      const input = await json(req);
      respond(res, 200, store.importProspects(input.searchId, input.prospects));
      return;
    }
    if (method === "PUT" && /^\/api\/prospects\/[^/]+$/.test(path)) {
      respond(
        res,
        200,
        store.updateProspect(
          path.split("/")[3],
          (await json(req)) as Partial<Prospect>,
        ),
      );
      return;
    }
    if (method === "POST" && /^\/api\/prospects\/[^/]+\/events$/.test(path)) {
      const input = await json(req);
      respond(
        res,
        200,
        store.addManualEvent(
          path.split("/")[3],
          String(input.kind || "manual"),
          String(input.detail || ""),
          input.happenedAt,
          input.status,
        ),
      );
      return;
    }
    if (method === "POST" && path === "/api/templates") {
      respond(
        res,
        201,
        store.saveTemplate((await json(req)) as unknown as Template),
      );
      return;
    }
    if (method === "PUT" && /^\/api\/templates\/[^/]+$/.test(path)) {
      respond(
        res,
        200,
        store.saveTemplate(
          (await json(req)) as unknown as Template,
          path.split("/")[3],
        ),
      );
      return;
    }
    if (method === "POST" && path === "/api/drafts") {
      const input = await json(req);
      respond(res, 201, store.createDraft(input.prospectId, input.templateId));
      return;
    }
    if (method === "PUT" && /^\/api\/drafts\/[^/]+$/.test(path)) {
      const input = await json(req);
      respond(res, 200, store.updateDraft(path.split("/")[3], input.content));
      return;
    }
    if (method === "POST" && path === "/api/queue") {
      const input = await json(req);
      respond(res, 201, store.queueDraft(input.messageId));
      return;
    }
    if (method === "POST" && path === "/api/queue/pause") {
      const input = await json(req);
      respond(res, 200, store.pauseQueue(Boolean(input.paused)));
      return;
    }
    if (method === "POST" && path === "/api/queue/cancel-pending") {
      const items = store
        .listQueue()
        .filter((item) => item.state === "pending");
      for (const item of items) store.cancelQueue(item.id);
      respond(res, 200, { cancelled: items.length });
      return;
    }
    const queueMatch = path.match(
      /^\/api\/queue\/([^/]+)\/(open|confirm|uncertain|cancel)$/,
    );
    if (method === "POST" && queueMatch) {
      const [, id, action] = queueMatch;
      if (action === "open") {
        if (demo)
          throw new Error("Le mode démo ne lance pas de navigateur LinkedIn.");
        const item = store.openQueue(id);
        try {
          await browser.open(item.linkedinUrl);
          respond(res, 200, item);
        } catch (error) {
          store.markUncertain(
            id,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      } else if (action === "confirm")
        respond(res, 200, store.confirmQueue(id));
      else if (action === "uncertain") {
        const input = await json(req);
        respond(
          res,
          200,
          store.markUncertain(id, String(input.reason || "Résultat incertain")),
        );
      } else {
        const input = await json(req);
        respond(
          res,
          200,
          store.cancelQueue(id, Boolean(input.verifiedNotSent)),
        );
      }
      return;
    }
    if (method === "POST" && path === "/api/settings") {
      const input = await json(req);
      respond(
        res,
        200,
        store.setInvitationLimit(Number(input.invitationLimit)),
      );
      return;
    }
    if (method === "POST" && path === "/api/browser/search") {
      if (demo) throw new Error("Le navigateur est désactivé en mode démo.");
      const input = await json(req),
        search = store.getSearch(input.searchId);
      respond(
        res,
        200,
        await browser.open(search.linkedinUrl || makeSearchUrl(search.filters)),
      );
      return;
    }
    if (method === "GET" && path === "/api/browser/visible") {
      if (demo) throw new Error("Le navigateur est désactivé en mode démo.");
      respond(res, 200, await browser.visibleCandidates());
      return;
    }
    if (method === "POST" && path === "/api/browser/associate") {
      if (demo) throw new Error("Le navigateur est désactivé en mode démo.");
      const input = await json(req),
        search = store.getSearch(input.searchId);
      respond(
        res,
        200,
        store.saveSearch(
          { ...search, linkedinUrl: await browser.currentUrl() },
          search.id,
        ),
      );
      return;
    }
    if (method === "GET" && path === "/api/export.csv") {
      const rows = store.listProspects().map((p) => ({
        linkedinUrl: p.linkedinUrl,
        firstName: p.firstName,
        lastName: p.lastName,
        title: p.title,
        company: p.company,
        location: p.location,
        school: p.school,
        status: p.status,
        tags: p.tags.join("; "),
        notes: p.notes,
        nextAction: p.nextAction,
        nextActionAt: p.nextActionAt,
        createdAt: p.createdAt,
        sources: (store.getProspect(p.id).sources || [])
          .map((s) => s.searchName)
          .join("; "),
      }));
      download(
        res,
        `anima-connect-${new Date().toISOString().slice(0, 10)}.csv`,
        csvStringify(rows, [
          "linkedinUrl",
          "firstName",
          "lastName",
          "title",
          "company",
          "location",
          "school",
          "status",
          "tags",
          "notes",
          "nextAction",
          "nextActionAt",
          "createdAt",
          "sources",
        ]),
        "text/csv; charset=utf-8",
      );
      return;
    }
    if (method === "POST" && path === "/api/import.csv") {
      const input = await json(req);
      const rows = csvParse(String(input.csv || ""));
      if (rows.length > 10000) throw new Error("CSV limité à 10 000 lignes.");
      const results = [];
      for (let i = 0; i < rows.length; i += 100)
        results.push(
          ...store.importProspects(
            input.searchId,
            rows.slice(i, i + 100).map((row) => ({
              ...row,
              tags: row.tags
                ? row.tags.split(";").map((tag) => tag.trim())
                : [],
            })),
          ),
        );
      respond(res, 200, {
        total: results.length,
        created: results.filter((r) => r.created).length,
        possibleDuplicates: results.filter((r) => r.possibleDuplicates.length)
          .length,
      });
      return;
    }
    if (method === "GET" && path === "/api/backup") {
      const temp = join(dataDir, `backup-${randomUUID()}.sqlite`);
      try {
        store.db.exec(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
        download(
          res,
          `anima-connect-${demo ? "demo-" : ""}${new Date().toISOString().slice(0, 10)}.sqlite`,
          readFileSync(temp),
          "application/vnd.sqlite3",
        );
      } finally {
        rmSync(temp, { force: true });
      }
      return;
    }
    if (method === "POST" && path === "/api/restore") {
      if (demo)
        throw new Error("Quittez le mode démo pour restaurer une sauvegarde.");
      if (req.headers["content-type"] !== "application/octet-stream")
        throw new Error("Fichier SQLite attendu.");
      const bytes = await body(req, 100_000_000);
      if (bytes.subarray(0, 16).toString("ascii") !== "SQLite format 3\0")
        throw new Error("Ce fichier n’est pas une base SQLite.");
      const temp = join(dataDir, `restore-${randomUUID()}.sqlite`);
      writeFileSync(temp, bytes);
      try {
        const check = new DatabaseSync(temp, { readOnly: true });
        const tables = check
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[];
        check.close();
        if (
          !["prospects", "searches", "events", "messages", "queue"].every(
            (name) => tables.some((t) => t.name === name),
          )
        )
          throw new Error("Sauvegarde Anima Connect incomplète.");
        campaignRuntime.engine.pauseAll();
        await runner.stop();
        await campaignRuntime.engine.waitAll();
        vault.lock();
        await browser.close();
        realStore.close();
        const rollback = join(
          dataDir,
          `avant-restauration-${Date.now()}.sqlite`,
        );
        copyFileSync(realPath, rollback);
        try {
          renameSync(temp, realPath);
          realStore = new Store(realPath);
          careerStore = new CareerStore(realStore.db, careerOptions);
          vault = new Vault(realStore.db, careerOptions);
          runner = new CareerRunner(careerStore, vault, careerBrowser);
          careerStore.recoverInterruptedRuns();
          campaignRuntime = createCareerCampaignRuntime(careerStore, runner);
          void campaignRuntime.engine.recoverAfterRestart().catch((error) =>
            console.error("Échec de reprise des campagnes après restauration :", error),
          );
        } catch (error) {
          copyFileSync(rollback, realPath);
          realStore = new Store(realPath);
          careerStore = new CareerStore(realStore.db, careerOptions);
          vault = new Vault(realStore.db, careerOptions);
          runner = new CareerRunner(careerStore, vault, careerBrowser);
          careerStore.recoverInterruptedRuns();
          campaignRuntime = createCareerCampaignRuntime(careerStore, runner);
          throw error;
        }
        respond(res, 200, { restored: true, safetyCopy: rollback });
      } finally {
        rmSync(temp, { force: true });
      }
      return;
    }
    respond(res, 404, { error: "Page ou action introuvable." });
  } catch (error) {
    fail(res, error);
  }
}
const electronMode = process.env.ANIMA_ELECTRON_MODE === "1";
const server = electronMode ? undefined : createServer(handleRequest);

if (server)
  server.listen(port, "127.0.0.1", () =>
    console.log(`Anima Connect : http://127.0.0.1:${port}`),
  );
async function shutdown() {
  campaignRuntime.engine.pauseAll();
  demoCampaignRuntime.engine.pauseAll();
  await runner.stop();
  await demoRunner.stop();
  await campaignRuntime.engine.waitAll();
  await demoCampaignRuntime.engine.waitAll();
  vault.lock();
  demoVault.lock();
  await browser.close();
  server?.close();
  realStore.close();
  demoStore.close();
}
if (!electronMode) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
export { shutdown };
