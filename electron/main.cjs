const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const { randomBytes } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { Readable } = require("node:stream");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MAX_JSON_BODY_BYTES = 15 * 1024 * 1024;
const MAX_BINARY_BODY_BYTES = 100 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
const gotSingleInstanceLock = app.requestSingleInstanceLock();
let backend;
let mainWindow;

function databaseContainsProtectedData(databasePath) {
  if (!existsSync(databasePath)) return false;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const marker = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='anima_data_protection'").get();
    if (marker) return true;
    const specs = {
      searches: ["name", "filters", "linkedin_url", "notes"],
      prospects: ["linkedin_url", "first_name", "last_name", "title", "company", "location", "school", "tags", "notes", "next_action"],
      events: ["detail"], templates: ["name", "content"], messages: ["content"], queue: ["error"],
      career_profile: ["value"], career_resumes: ["name", "filename", "mime", "sha256"],
      career_applications: ["outcome", "answers", "missing_fields", "notes", "last_error", "receipt"],
      career_events: ["detail"], career_credentials: ["origin", "label", "username"],
      career_campaign_items: ["error"],
    };
    for (const [table, columns] of Object.entries(specs)) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const column of columns) {
        const quoted = `"${column}"`;
        if (db.prepare(`SELECT 1 FROM "${table}" WHERE typeof(${quoted})='text' AND substr(${quoted},1,19)='anima-protected:v1:' LIMIT 1`).get()) return true;
        if (table === "career_resumes" && column === "sha256" &&
            db.prepare(`SELECT 1 FROM "${table}" WHERE typeof("bytes")='blob' AND substr("bytes",1,8)=x'414e494d41503100' LIMIT 1`).get()) return true;
      }
    }
    return false;
  } finally {
    db.close();
  }
}

function getOrCreateLocalDataKey(dataDirectory, databasePath) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("Le stockage sécurisé Windows (DPAPI) est indisponible. Les données n’ont pas été ouvertes.");
  mkdirSync(dataDirectory, { recursive: true });
  const keyPath = path.join(dataDirectory, "local-data-key.dpapi");
  if (existsSync(keyPath)) {
    let saved;
    try { saved = JSON.parse(readFileSync(keyPath, "utf8")); }
    catch { throw new Error("La clé locale est illisible. La base n’a pas été modifiée."); }
    if (!saved || saved.version !== 1 || saved.provider !== "electron-safeStorage" || typeof saved.ciphertext !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(saved.ciphertext))
      throw new Error("Le fichier de clé locale est invalide. La base n’a pas été modifiée.");
    try {
      const ciphertext = Buffer.from(saved.ciphertext, "base64");
      if (ciphertext.toString("base64") !== saved.ciphertext) throw new Error();
      const key = Buffer.from(safeStorage.decryptString(ciphertext), "base64");
      if (key.length !== 32 || key.toString("base64") !== safeStorage.decryptString(ciphertext)) throw new Error();
      return key;
    } catch {
      throw new Error("Impossible de déchiffrer la clé locale avec le compte Windows actuel. La base n’a pas été modifiée.");
    }
  }
  if (databaseContainsProtectedData(databasePath))
    throw new Error("La base est déjà chiffrée mais sa clé locale est absente. Aucun remplacement de clé n’a été tenté.");
  const key = randomBytes(32);
  const encrypted = safeStorage.encryptString(key.toString("base64"));
  const tempPath = `${keyPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify({ version: 1, provider: "electron-safeStorage", ciphertext: encrypted.toString("base64") }), { flag: "wx", mode: 0o600 });
    renameSync(tempPath, keyPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  return key;
}

if (!gotSingleInstanceLock) app.quit();
if (process.platform === "win32") app.setAppUserModelId("com.animaconnect.desktop");

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function bodyBytes(body) {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === "string") {
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > MAX_JSON_BODY_BYTES) throw new Error("Requête IPC trop volumineuse.");
    return Buffer.from(body, "utf8");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 || typeof body.base64 !== "string") {
    throw new Error("Format de corps IPC invalide.");
  }
  const encoded = body.base64;
  if (encoded.length > Math.ceil(MAX_BINARY_BODY_BYTES / 3) * 4 + 4 ||
      encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Corps binaire IPC invalide ou trop volumineux.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_BINARY_BODY_BYTES || bytes.toString("base64") !== encoded)
    throw new Error("Corps binaire IPC invalide ou trop volumineux.");
  return bytes;
}

function makeRequest(input) {
  const bytes = bodyBytes(input.body);
  const req = Readable.from(bytes.length ? [bytes] : []);
  req.method = input.method.toUpperCase();
  req.url = input.path;
  req.headers = Object.fromEntries(Object.entries(input.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v).slice(0, 4096)]));
  req.headers["content-length"] = String(bytes.length);
  req.headers.host = `127.0.0.1:${process.env.PORT || 4174}`;
  return req;
}

function makeResponse() {
  return {
    status: 200,
    headers: {},
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; },
    end(value = "") { this.value = value; },
  };
}

async function handleApiRequest(_event, input) {
  const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  const pathIsSmall = typeof input?.path === "string" && input.path.length <= 4096;
  const methodIsSmall = typeof input?.method === "string" && input.method.length <= 10;
  if (!mainWindow || _event.sender !== mainWindow.webContents ||
      _event.senderFrame !== mainWindow.webContents.mainFrame || !input ||
      !pathIsSmall || !/^\/api\/[A-Za-z0-9_./?=&%-]*$/.test(input.path) ||
      !methodIsSmall ||
      !methods.has(input.method.toUpperCase()) ||
      (input.headers !== undefined && (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers) || Object.keys(input.headers).length > 32)))
    throw new Error("Requête Anima Connect invalide.");
  const req = makeRequest(input);
  const res = makeResponse();
  await backend.handleRequest(req, res);
  const value = Buffer.isBuffer(res.value) ? res.value : Buffer.from(String(res.value ?? ""));
  if (value.length > MAX_RESPONSE_BYTES) throw new Error("Réponse IPC trop volumineuse.");
  const binary = !String(res.headers["Content-Type"] || "").includes("json") &&
    !String(res.headers["Content-Type"] || "").startsWith("text/");
  return {
    status: res.status,
    headers: res.headers,
    body: binary ? value.toString("base64") : value.toString("utf8"),
    ...(binary ? { base64: true } : {}),
  };
}

async function createWindow() {
  const rendererUrl = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

if (gotSingleInstanceLock) app.whenReady().then(async () => {
  process.env.ANIMA_ELECTRON_MODE = "1";
  const dataDirectory = path.join(app.getPath("userData"), "data");
  process.env.ANIMA_DATA_DIR = dataDirectory;
  process.env.ANIMA_LOCAL_DATA_KEY_BASE64 = getOrCreateLocalDataKey(dataDirectory, path.join(dataDirectory, "anima-connect.sqlite")).toString("base64");
  process.env.PLAYWRIGHT_BROWSERS_PATH = app.isPackaged
    ? path.join(process.resourcesPath, "playwright-browsers")
    : path.join(__dirname, "..", ".playwright-browsers");
  backend = await import(pathToFileURL(path.join(__dirname, "..", ".desktop-build", "server", "index.js")).href);
  ipcMain.handle("anima:request", handleApiRequest);
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:" && !parsed.username && !parsed.password)
          shell.openExternal(parsed.href).catch(() => {});
      } catch { /* Ignore malformed or unsupported external destinations. */ }
      return { action: "deny" };
    });
    const rendererUrl = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
    contents.on("will-navigate", (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
    contents.on("will-redirect", (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => {
  console.error("Impossible de démarrer Anima Connect", error);
  dialog.showErrorBox("Impossible d’ouvrir les données Anima Connect", error instanceof Error ? error.message : String(error));
  app.quit();
});

let shutdownStarted = false;
app.on("before-quit", async (event) => {
  if (!backend || shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  try { await backend.shutdown(); } finally { app.exit(0); }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
