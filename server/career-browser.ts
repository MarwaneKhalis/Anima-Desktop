import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  Application, CareerProfile, JobOffer, MissingField, Receipt, Resume, RunMode, RunResult,
} from "../src/shared/career.ts";
import { allowsCareerAtsNavigation, allowsCareerAtsResource, careerAtsForUrl, findApplyLink, isRemoteOkApplyRedirectorUrl } from "./career-ats.ts";

export interface CareerBrowserOptions { headless?: boolean; allowedTestOrigins?: string[] }
type Control = { index: number; tag: string; type: string; label: string; name: string; key: string; required: boolean; value: string; checked: boolean; uploaded: boolean; options: string[] };
type Button = { index: number; text: string; disabled: boolean };
type BrowserRunInput = {
  application: Application; job: JobOffer; profile: CareerProfile;
  resume: { meta: Resume; bytes: Buffer }; mode: RunMode;
  getCredential: (origin: string) => { username: string; password: string } | null;
  beforeSubmit: () => void; signal?: AbortSignal; fileFieldKey?: string; closeOnNeedsInput?: boolean;
};
type BrowserSession = {
  input: BrowserRunInput; page: Page; flowOrigin: string; initialNavigation: boolean;
  pendingAtsOrigin?: string;
  seen: Set<string>; loggedIn: boolean; resumeCount: number; initialValues: Map<string, string>;
  submittedClick: boolean;
  pausedPageBody?: string;
};
const tidy = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const safeText = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 240);
const result = (state: RunResult["state"], message: string, missingFields: MissingField[] = [], receipt: Receipt | null = null): RunResult => ({ state, message, missingFields, receipt });
const REMOTE_OK_APPLY_REDIRECT = "remoteok-apply-redirect";

function safeUrl(value: string, testOrigins: Set<string>): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || url.hash) throw new Error("Adresse de candidature non prise en charge.");
  if (testOrigins.has(url.origin) && url.protocol === "http:") return url;
  if (url.protocol !== "https:" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host) || !host.includes(".")) {
    throw new Error("La candidature exige une adresse HTTPS publique.");
  }
  return url;
}
async function assertPublic(url: URL, testOrigins: Set<string>): Promise<void> {
  safeUrl(url.href, testOrigins);
  if (testOrigins.has(url.origin)) return;
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => {
    const ip = address.toLowerCase();
    return /^10\.|^127\.|^0\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
      || ip === "::1" || ip === "::" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:");
  })) throw new Error("Destination réseau privée interdite.");
}

const knownValue = (key: string, p: CareerProfile): string | undefined => {
  const rules: Array<[RegExp, string]> = [
    [/^(first name|given name|prenom)$/, p.firstName],
    [/^(last name|family name|surname|nom de famille|nom)$/, p.lastName],
    [/^(full name|your name|nom complet)$/, [p.firstName, p.lastName].filter(Boolean).join(" ")],
    [/^(e mail|email|email address|adresse e mail|courriel)$/, p.email],
    [/^(phone|phone number|telephone|numero de telephone|mobile)$/, p.phone],
    [/^(city|ville|current city|location city|current location)$/, p.city],
    [/^(country|pays)$/, p.country],
    [/^(address|street address|adresse)$/, p.address],
    [/^(postal code|zip code|code postal)$/, p.postalCode],
    [/^(linkedin|linkedin url|linkedin profile|profil linkedin)$/, p.linkedinUrl],
    [/^(website|website url|personal website|site web)$/, p.websiteUrl],
  ];
  return rules.find(([re]) => re.test(key))?.[1];
};
type RepeatedProfileField = { collection: "experiences" | "education"; field: string };
const repeatedProfileField = (control: Control): RepeatedProfileField | undefined => {
  const label = tidy(control.label);
  const key = tidy([control.name, control.key].filter(Boolean).join(" "));
  const combined = `${label} ${key}`.trim();
  const hasExperienceContext = /\b(experience|employment|work history|previous job|prior job)\b/.test(combined);
  const hasEducationContext = /\b(education|school history|academic history|study history)\b/.test(combined);

  if (/\b(school|school name|university|college|institution|institution name)\b/.test(combined)) return { collection: "education", field: "school" };
  if (/\b(degree|degree name|qualification|diploma)\b/.test(combined)) return { collection: "education", field: "degree" };
  if (/\b(education|school|study|academic) (start|from) date\b/.test(combined) || (hasEducationContext && /\b(start|from) date\b/.test(label))) return { collection: "education", field: "start" };
  if (/\b(education|school|study|academic) (end|to) date\b/.test(combined) || (hasEducationContext && /\b(end|to) date\b/.test(label))) return { collection: "education", field: "end" };

  if (/\b(company|company name|employer|employer name|organization|organization name)\b/.test(combined)) return { collection: "experiences", field: "company" };
  if (/\b(job title|position title|role title|employment title|job position|position|role)\b/.test(combined)) return { collection: "experiences", field: "title" };
  if (/\b(experience|employment|work) (start|from) date\b/.test(combined) || (hasExperienceContext && /\b(start|from) date\b/.test(label)) || /\b(employment|work|experience)[ _-]?(start|from)[ _-]?(date|year)\b/.test(key)) return { collection: "experiences", field: "start" };
  if (/\b(experience|employment|work) (end|to) date\b/.test(combined) || (hasExperienceContext && /\b(end|to) date\b/.test(label)) || /\b(employment|work|experience)[ _-]?(end|to)[ _-]?(date|year)\b/.test(key)) return { collection: "experiences", field: "end" };
  if (/\b(job duties|responsibilities|duties|role description|employment description|experience description)\b/.test(combined)) return { collection: "experiences", field: "description" };
  return undefined;
};
const profileValuesFor = (controls: Control[], profile: CareerProfile): Map<number, string | undefined> => {
  const counts = new Map<string, number>();
  const values = new Map<number, string | undefined>();
  for (const control of controls) {
    const field = repeatedProfileField(control);
    if (!field) continue;
    const countKey = `${field.collection}.${field.field}`;
    const index = counts.get(countKey) || 0;
    counts.set(countKey, index + 1);
    const entry = profile[field.collection][index] as unknown as Record<string, string> | undefined;
    values.set(control.index, entry?.[field.field]);
  }
  return values;
};
const missingType = (c: Control): MissingField["type"] => c.type === "file" ? "file" : c.tag === "select" ? "select" : ["checkbox", "radio"].includes(c.type) ? "boolean" : ["text", "email", "tel", "url", "textarea"].includes(c.type) ? "text" : "unknown";
const loginButton = (s: string) => /^(log in|login|sign in|connexion|se connecter|connecter|submit)$/i.test(s.trim());
const loginField = (c: Control) => c.type === "email" || [c.name, c.label, c.key].some(value => /(^| )(username|user name|email|e mail|identifiant|login)( |$)/i.test(tidy(value)));
const nextButton = (s: string) => /^(next|continue|save and continue|suivant|suivante|continuer|enregistrer et continuer|prochaine etape)$/i.test(tidy(s));
const finalButton = (s: string) => /^(submit( application)?|send( application)?|apply( now)?|complete application|envoyer( ma candidature| la candidature)?|soumettre( ma candidature)?|postuler|valider la candidature)$/i.test(tidy(s));
const resumeField = (c: Control) => /\b(cv|resume)\b|curriculum vitae/i.test(tidy([c.label, c.name, c.key].join(" ")));
const controlValue = (c: Control) => c.type === "file" ? `file:${c.uploaded}` : ["checkbox", "radio"].includes(c.type) ? `checked:${c.checked}` : c.value;
async function interventionSignature(page: Page, body: string): Promise<string | null> {
  const textMatch = body.match(/captcha|recaptcha|hcaptcha|verify you are human|verification humaine|authenticator|two.factor|multi.factor|one.time code|code de verification|mfa/i)?.[0]?.toLowerCase() || "";
  const widgets = await page.locator('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i]').evaluateAll(nodes => nodes.filter(el => {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  }).map(el => `${el.tagName.toLowerCase()}#${el.id}.${typeof el.className === "string" ? el.className : ""}`).join("|")).catch(() => "");
  return textMatch || widgets ? `${page.url()}|${textMatch}|${widgets}` : null;
}

async function controls(page: Page): Promise<Control[]> {
  return page.locator("input, select, textarea").evaluateAll((nodes) => nodes.flatMap((node, index) => {
    const el = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const type = el instanceof HTMLInputElement ? el.type.toLowerCase() : el.tagName.toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type) || el.disabled || el.closest('[aria-hidden="true"], [hidden]')) return [];
    const style = getComputedStyle(el);
    if (type !== "file" && (style.display === "none" || style.visibility === "hidden" || el.getClientRects().length === 0)) return [];
    const label = [el.labels && [...el.labels].map(x => {
      const copy = x.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("input, select, textarea").forEach(control => control.remove());
      return copy.textContent?.trim();
    }).filter(Boolean).join(" "), ...(el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent?.trim()), el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title")].filter(Boolean).join(" ");
    const name = el.getAttribute("name") || el.id || "";
    const key = [label, name, el.getAttribute("autocomplete"), el.getAttribute("data-automation-id"), el.getAttribute("data-testid")].filter(Boolean).join(" ");
    const options = el instanceof HTMLSelectElement ? [...el.options].map(o => o.textContent?.trim() || o.value) : [];
    return [{ index, tag: el.tagName.toLowerCase(), type, label, name, key, required: el.required || el.getAttribute("aria-required") === "true", value: el.value, checked: el instanceof HTMLInputElement ? el.checked : false, uploaded: el instanceof HTMLInputElement && el.type === "file" ? Boolean(el.files?.length) : false, options }];
  }));
}
async function buttons(page: Page): Promise<Button[]> {
  return page.locator('button, input[type="submit"]').evaluateAll(nodes => nodes.map((node, index) => {
    const el = node as HTMLButtonElement | HTMLInputElement;
    return { index, text: (el instanceof HTMLInputElement ? el.value : el.textContent || el.getAttribute("aria-label") || "").trim(), disabled: el.disabled || el.getClientRects().length === 0 };
  }));
}
const receiptPattern = /(?:application (?:received|submitted)|thank you for (?:applying|your application)|candidature (?:recue|reçue|envoyee|envoyée)|merci pour votre candidature)/i;
async function receipt(page: Page, previousText: string): Promise<Receipt | null> {
  const full = await page.locator("body").innerText().catch(() => "");
  const body = safeText(full);
  const matches = receiptPattern.test(full);
  if (!matches || (await buttons(page)).some(b => !b.disabled && finalButton(b.text))) return null;
  const reference = full.match(/(?:reference|référence|confirmation|receipt|reçu)\s*(?:number|no|n°|#|:)?\s*([A-Z0-9-]{4,})/i)?.[1] || "";
  if (receiptPattern.test(previousText) && (!reference || previousText.includes(reference))) return null;
  const url = new URL(page.url()); url.search = ""; url.hash = "";
  return { url: url.href, text: body, reference, observedAt: new Date().toISOString() };
}
async function sameOriginForm(page: Page, control: ReturnType<Page["locator"]>, origin: string): Promise<boolean> {
  const action = await control.evaluate(el => (el as HTMLInputElement).form?.action || location.href);
  return new URL(action).origin === origin;
}
async function advance(page: Page, control: ReturnType<Page["locator"]>): Promise<void> {
  const before = await page.evaluate(() => ({ url: location.href, html: document.body.innerHTML }));
  await Promise.all([
    page.waitForFunction(({ url, html }) => location.href !== url || document.body.innerHTML !== html, before, { timeout: 12_000 }),
    control.click(),
  ]);
}

export class CareerBrowser {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private active = false;
  private pausedSession: BrowserSession | undefined;
  private options: CareerBrowserOptions;
  private readonly testOrigins: Set<string>;
  constructor(options: CareerBrowserOptions = {}) { this.options = options; this.testOrigins = new Set(options.allowedTestOrigins || []); }

  hasPausedSession(): boolean { return Boolean(this.pausedSession && this.isLive(this.pausedSession)); }

  async close(): Promise<void> {
    this.pausedSession = undefined;
    await this.context?.close().catch(() => {}); this.context = undefined;
    await this.browser?.close().catch(() => {}); this.browser = undefined;
  }

  private isLive(session: BrowserSession): boolean {
    try { return Boolean(this.browser?.isConnected() && !session.page.isClosed()); } catch { return false; }
  }

  private async finish(session: BrowserSession, outcome: RunResult): Promise<RunResult> {
    if (outcome.state === "needs_input" && session.input.closeOnNeedsInput) await this.close();
    else if ((outcome.state === "needs_input" || outcome.state === "blocked") && this.isLive(session)) {
      const cs = await controls(session.page).catch(() => []);
      const pageSignature = session.page.url() + "|" + cs.map(c => c.name + ":" + c.key).join("|");
      for (const c of cs) session.initialValues.set(pageSignature + "|" + c.index + "|" + c.type + "|" + (c.name || c.key), controlValue(c));
      session.pausedPageBody = (await session.page.locator("body").innerText().catch(() => "")).slice(0, 5000);
      this.pausedSession = session;
    }
    else await this.close();
    return outcome;
  }

  async discover(url: string): Promise<{ offers: Omit<JobOffer, "id" | "discoveredAt" | "updatedAt">[]; note: string }> {
    safeUrl(url, this.testOrigins);
    if (this.active || this.pausedSession) throw new Error("Un parcours navigateur est déjà actif ou en attente.");
    return { offers: [], note: "Découverte navigateur non prise en charge ; utilisez une page carrière publique compatible." };
  }

  async run(input: BrowserRunInput): Promise<RunResult> {
    if (this.active) return result("blocked", "Un autre parcours navigateur est déjà actif.");
    this.active = true;
    if (this.pausedSession) {
      if (this.isLive(this.pausedSession)) {
        this.active = false;
        return result("blocked", "Une candidature attend une intervention. Reprenez-la ou arrêtez le navigateur avant d’en lancer une autre.");
      }
      await this.close();
    }
    let session: BrowserSession | undefined;
    try {
      const start = safeUrl(input.job.url, this.testOrigins);
      await assertPublic(start, this.testOrigins);
      this.browser = await chromium.launch({ headless: this.options.headless ?? false });
      this.context = await this.browser.newContext({ acceptDownloads: false, viewport: { width: 1365, height: 900 } });
      this.context.setDefaultTimeout(10_000);
      this.context.setDefaultNavigationTimeout(20_000);
      const page = await this.context.newPage();
      session = { input, page, flowOrigin: start.origin, initialNavigation: true, seen: new Set(), loggedIn: false, resumeCount: 0, initialValues: new Map(), submittedClick: false };
      await this.context.route("**/*", async route => {
        const request = route.request();
        let url: URL;
        try { url = new URL(request.url()); } catch { return route.abort(); }
        if (request.isNavigationRequest() && session!.pendingAtsOrigin === REMOTE_OK_APPLY_REDIRECT
          && isRemoteOkApplyRedirectorUrl(url.href, this.testOrigins)) {
          try {
            const response = await route.fetch({ maxRedirects: 0 });
            const location = response.headers()["location"];
            if (response.status() < 300 || response.status() >= 400 || !location) {
              await response.dispose();
              return route.abort();
            }
            const target = new URL(location, url);
            const targetAts = careerAtsForUrl(target.href);
            const approvedTarget = (target.protocol === "https:" && targetAts !== null) || this.testOrigins.has(target.origin);
            if (!approvedTarget) {
              await response.dispose();
              return route.abort();
            }
            await assertPublic(target, this.testOrigins);
            session!.flowOrigin = target.origin;
            session!.pendingAtsOrigin = target.origin;
            return route.fulfill({ response });
          } catch { return route.abort(); }
        }
        if (url.origin !== session!.flowOrigin) {
          const redirectedFrom = request.redirectedFrom();
          const remoteOkApplyRedirect = session!.pendingAtsOrigin === REMOTE_OK_APPLY_REDIRECT
            && Boolean(redirectedFrom && isRemoteOkApplyRedirectorUrl(redirectedFrom.url(), this.testOrigins));
          if (request.isNavigationRequest() && session!.initialNavigation && redirectedFrom
            && !session!.pendingAtsOrigin && !remoteOkApplyRedirect) {
            const fromAts = careerAtsForUrl(redirectedFrom.url());
            const toAts = careerAtsForUrl(url.href);
            if (!fromAts || fromAts !== toAts) return route.abort();
          }
          const allowedAtsNavigation = request.isNavigationRequest() && allowsCareerAtsNavigation({
            from: session!.flowOrigin, to: url.href, pendingAtsOrigin: session!.pendingAtsOrigin,
            initialNavigation: session!.initialNavigation, redirected: Boolean(redirectedFrom), remoteOkApplyRedirect, testOrigins: this.testOrigins,
          });
          if (allowedAtsNavigation) {
            try {
              await assertPublic(url, this.testOrigins);
              session!.flowOrigin = url.origin;
              session!.pendingAtsOrigin = url.origin;
            } catch { return route.abort(); }
          } else if (allowsCareerAtsResource({ from: session!.flowOrigin, to: url.href, method: request.method(), kind: request.resourceType() as Parameters<typeof allowsCareerAtsResource>[0]["kind"] })) {
            return route.continue();
          } else return route.abort();
        }
        return route.continue();
      });
      await page.goto(start.href, { waitUntil: "domcontentloaded" });
      const landed = new URL(page.url());
      const startAts = careerAtsForUrl(start.href);
      const landedAts = careerAtsForUrl(landed.href);
      if (landed.origin !== start.origin && (!startAts || landedAts !== startAts)) {
        return await this.finish(session, result("blocked", "Redirection initiale vers un autre site refusée. Ouvrez la fiche et sélectionnez son lien Apply visible."));
      }
      session.initialNavigation = false;
      session.flowOrigin = landed.origin;
      return await this.finish(session, await this.drive(session));
    } catch {
      const outcome = result(session?.submittedClick ? "uncertain" : input.signal?.aborted ? "failed" : "blocked", session?.submittedClick ? "L’envoi a peut-être eu lieu ; vérifiez manuellement avant toute nouvelle tentative." : input.signal?.aborted ? "Parcours interrompu avant l’envoi." : "Le navigateur n’a pas pu terminer ce formulaire.");
      if (session) return await this.finish(session, outcome);
      await this.close();
      return outcome;
    } finally { this.active = false; }
  }

  async resume(input: BrowserRunInput): Promise<RunResult> {
    if (this.active) return result("blocked", "Un parcours navigateur est déjà actif.");
    const session = this.pausedSession;
    if (!session || !this.isLive(session)) {
      await this.close();
      return result("blocked", "La session navigateur n’est plus ouverte. Relancez le parcours depuis l’offre.");
    }
    this.pausedSession = undefined;
    this.active = true;
    session.input = input;
    session.resumeCount++;
    try { return await this.finish(session, await this.drive(session)); }
    catch {
      const outcome = result(session.submittedClick ? "uncertain" : input.signal?.aborted ? "failed" : "blocked", session.submittedClick ? "L’envoi a peut-être eu lieu ; vérifiez manuellement avant toute nouvelle tentative." : input.signal?.aborted ? "Parcours interrompu avant l’envoi." : "La reprise du formulaire a échoué.");
      return await this.finish(session, outcome);
    } finally { this.active = false; }
  }

  private async drive(session: BrowserSession): Promise<RunResult> {
    const page = session.page;
    const input = session.input;
    for (let step = 0; step < 10; step++) {
      if (input.signal?.aborted) return result("failed", "Parcours interrompu avant l’envoi.");
      if (new URL(page.url()).origin !== session.flowOrigin) return result("blocked", "Redirection vers une autre origine : action manuelle requise.");
      const body = await page.locator("body").innerText().catch(() => "");
      if (session.resumeCount > 0) {
        const proof = await receipt(page, session.pausedPageBody || "");
        if (proof) {
          // A user may have submitted manually while solving an intervention; record the proof without replaying the form.
          session.submittedClick = true;
          input.beforeSubmit();
          return result("submitted", "Candidature confirmée dans le navigateur.", [], proof);
        }
      }
      const challenge = await interventionSignature(page, body);
      if (challenge) {
        return result("blocked", "Vérification CAPTCHA ou MFA : effectuez-la dans le navigateur, puis reprenez la candidature.");
      }
      const cs = await controls(page);
      const onSupportedAts = careerAtsForUrl(session.flowOrigin) !== null;
      const onExplicitTestOrigin = this.testOrigins.has(session.flowOrigin);
      if (!onSupportedAts && !onExplicitTestOrigin) {
        // Never populate personal data on an arbitrary career-site form. We may only follow an
        // explicit, visible Apply link to one of the named public ATS hosts above.
        if (cs.length === 0) {
          const apply = await findApplyLink(page, this.testOrigins);
          if (apply === "ambiguous") return result("blocked", "Plusieurs liens de candidature sont possibles : sélectionnez le parcours manuellement.");
          if (apply) {
            if (session.seen.has(apply.href)) return result("blocked", "Le lien de candidature forme une boucle.");
            session.seen.add(apply.href);
            session.pendingAtsOrigin = apply.vendor === "remoteok" ? REMOTE_OK_APPLY_REDIRECT : new URL(apply.href).origin;
            await advance(page, page.locator("a[href]").nth(apply.index));
            continue;
          }
        }
        return result("blocked", "Ce site carrière n’est pas pris en charge. Les données personnelles ne seront pas transmises à cette origine.");
      }
      const pageSignature = page.url() + "|" + cs.map(c => c.name + ":" + c.key).join("|");
      for (const c of cs) {
        const initialKey = pageSignature + "|" + c.index + "|" + c.type + "|" + (c.name || c.key);
        if (!session.initialValues.has(initialKey)) session.initialValues.set(initialKey, controlValue(c));
      }
      const changedByUser = (c: Control) => {
        const initialKey = pageSignature + "|" + c.index + "|" + c.type + "|" + (c.name || c.key);
        return session.resumeCount > 0 && session.initialValues.get(initialKey) !== controlValue(c);
      };
      if (cs.some(c => c.type === "password")) {
        if (session.loggedIn) return result("blocked", "Connexion non terminée ; intervention manuelle requise.");
        if (!onSupportedAts && !onExplicitTestOrigin) return result("blocked", "Le coffre n’est accessible que pour un ATS explicitement pris en charge.");
        const credential = input.getCredential(session.flowOrigin);
        if (!credential) return result("blocked", "Compte requis pour cette origine ; enregistrez ses identifiants dans le coffre.");
        const user = cs.find(loginField);
        const pass = cs.find(c => c.type === "password");
        const action = (await buttons(page)).filter(b => !b.disabled && loginButton(b.text));
        if (!user || !pass || action.length !== 1) return result("blocked", "Formulaire de connexion ambigu.");
        const loginControl = page.locator("input, select, textarea").nth(pass.index);
        if (!await sameOriginForm(page, loginControl, session.flowOrigin)) return result("blocked", "Connexion vers une origine différente interdite.");
        await page.locator("input, select, textarea").nth(user.index).fill(credential.username);
        await page.locator("input, select, textarea").nth(pass.index).fill(credential.password);
        await advance(page, page.locator('button, input[type="submit"]').nth(action[0].index));
        session.loggedIn = true;
        continue;
      }
      const missing: MissingField[] = [];
      const explicitFor = (...labels: string[]) => {
        for (const answers of [input.application.answers, input.profile.answers]) {
          const match = Object.entries(answers).find(([answerKey]) => labels.some(label => tidy(answerKey) === tidy(label)));
          if (match) return match[1];
        }
        return undefined;
      };
      const profileValues = profileValuesFor(cs, input.profile);
      const radioGroups = new Map<string, Control[]>();
      for (const c of cs.filter(c => c.type === "radio")) {
        const groupKey = tidy(c.name || c.key);
        radioGroups.set(groupKey, [...(radioGroups.get(groupKey) || []), c]);
      }
      for (const [key, group] of radioGroups) {
        const required = group.some(c => c.required);
        const label = group[0].name || group[0].label || group[0].key;
        const options = group.map(c => c.value || c.label).filter(Boolean);
        const answer = explicitFor(group[0].name || group[0].key);
        if (group.some(changedByUser)) {
          if ((required || answer !== undefined) && !group.some(c => c.checked)) missing.push({ key, label, required, type: "select", options });
          continue;
        }
        const desired = typeof answer === "boolean" ? (answer ? "yes" : "no") : typeof answer === "string" ? tidy(answer) : "";
        const selected = desired ? group.find(c => tidy(c.value) === desired || tidy(c.label) === desired) : undefined;
        if (selected) await page.locator("input, select, textarea").nth(selected.index).check();
        else if ((required || answer !== undefined) && !group.some(c => c.checked && changedByUser(c))) missing.push({ key, label, required, type: "select", options });
        else if (!required && answer === undefined && !group.some(changedByUser)) {
          for (const c of group) await page.locator("input, select, textarea").nth(c.index).evaluate(el => { (el as HTMLInputElement).checked = false; (el as HTMLInputElement).disabled = true; });
        }
      }
      for (const c of cs) {
        if (c.type === "radio") continue;
        const key = tidy(c.name || c.key);
        if (!key || /honeypot|website hidden|do not fill|leave blank/i.test(key)) continue;
        const loc = page.locator("input, select, textarea").nth(c.index);
        if (c.type === "file") {
          if (resumeField(c) || (input.fileFieldKey && tidy(input.fileFieldKey) === key)) await loc.setInputFiles({ name: input.resume.meta.filename, mimeType: input.resume.meta.mime, buffer: input.resume.bytes });
          else if (c.required && !c.uploaded && !changedByUser(c)) missing.push({ key, label: c.label || c.key, required: true, type: "file" });
          continue;
        }
        if (changedByUser(c)) {
          if (c.required && ((c.type === "checkbox" && !c.checked) || (c.type !== "checkbox" && !c.value))) missing.push({ key, label: c.label || c.key, required: true, type: missingType(c), ...(c.tag === "select" ? { options: c.options } : {}) });
          continue;
        }
        const aliases = new Set([key, tidy(c.label), tidy(c.key)]);
        const explicit = explicitFor(...aliases);
        const value = explicit === undefined ? profileValues.get(c.index) ?? knownValue(tidy(c.label || c.key), input.profile) : explicit;
        if (c.type === "checkbox") {
          if (typeof value === "boolean") {
            if (value) await loc.check();
            else {
              await loc.uncheck().catch(() => {});
              if (c.required) missing.push({ key, label: c.label || c.key, required: true, type: "boolean" });
            }
          }
          else if (c.required && !(c.checked && changedByUser(c))) missing.push({ key, label: c.label || c.key, required: true, type: "boolean" });
          else if (!changedByUser(c)) await loc.uncheck().catch(() => {});
          continue;
        }
        if (c.tag === "select") {
          const desired = typeof value === "boolean" ? (value ? "yes" : "no") : typeof value === "string" ? tidy(value) : "";
          if (desired) {
            const match = c.options.find(o => tidy(o) === desired);
            if (match) await loc.selectOption({ label: match });
            else missing.push({ key, label: c.label || c.key, required: c.required, type: "select", options: c.options });
          } else if (c.required && !changedByUser(c)) missing.push({ key, label: c.label || c.key, required: true, type: "select", options: c.options });
          else if (!c.required && !changedByUser(c)) {
            const blank = c.options.find(o => !tidy(o));
            if (blank !== undefined) await loc.selectOption({ label: blank });
            else await loc.evaluate(el => { (el as HTMLSelectElement).disabled = true; });
          }
          continue;
        }
        if (typeof value === "string" && value) await loc.fill(value);
        else if (c.required && !changedByUser(c)) missing.push({ key, label: c.label || c.key, required: true, type: missingType(c) });
        else if (!c.required && c.value && !changedByUser(c)) await loc.fill("");
      }
      if (missing.length) return result("needs_input", "Renseignez les champs requis dans l’application ou dans le navigateur, puis reprenez la candidature.", missing);
      // Public ATS job details usually expose an Apply link before they render the application
      // form. Follow exactly one visible link; never guess a button action or leave the vendor.
      if ((onSupportedAts || onExplicitTestOrigin) && cs.length === 0) {
        const apply = await findApplyLink(page, this.testOrigins);
        if (apply === "ambiguous") return result("blocked", "Plusieurs liens de candidature sont possibles : sélectionnez le parcours manuellement.");
        if (apply) {
          if (apply.vendor === "remoteok") {
            if (onSupportedAts || !isRemoteOkApplyRedirectorUrl(apply.href, this.testOrigins)) return result("blocked", "Le lien de redirection Remote OK ne peut pas être vérifié.");
            if (session.seen.has(apply.href)) return result("blocked", "Le lien de candidature forme une boucle.");
            session.seen.add(apply.href);
            session.pendingAtsOrigin = REMOTE_OK_APPLY_REDIRECT;
            await advance(page, page.locator("a[href]").nth(apply.index));
            continue;
          }
          const targetAts = careerAtsForUrl(apply.href);
          const currentAts = careerAtsForUrl(session.flowOrigin);
          if (apply.vendor !== "test" && targetAts !== currentAts) return result("blocked", "Le lien de candidature sort du fournisseur ATS pris en charge.");
          if (session.seen.has(apply.href)) return result("blocked", "Le lien de candidature forme une boucle.");
          session.seen.add(apply.href);
          session.pendingAtsOrigin = new URL(apply.href).origin;
          await advance(page, page.locator("a[href]").nth(apply.index));
          continue;
        }
      }
      const actions = (await buttons(page)).filter(b => !b.disabled);
      const finals = actions.filter(b => finalButton(b.text));
      const nexts = actions.filter(b => nextButton(b.text));
      if (finals.length > 1 || nexts.length > 1 || (finals.length && nexts.length)) return result("blocked", "Plusieurs actions possibles : sélection manuelle requise.");
      if (nexts.length === 1) {
        const nextControl = page.locator('button, input[type="submit"]').nth(nexts[0].index);
        if (!await sameOriginForm(page, nextControl, session.flowOrigin)) return result("blocked", "Étape suivante vers une origine différente interdite.");
        const fingerprint = page.url() + "|" + cs.map(c => c.key).join("|");
        if (session.seen.has(fingerprint)) return result("blocked", "Le formulaire tourne en boucle.");
        session.seen.add(fingerprint);
        await advance(page, nextControl);
        continue;
      }
      if (finals.length !== 1) return result("blocked", "Bouton final de candidature introuvable ou ambigu.");
      const finalControl = page.locator('button, input[type="submit"]').nth(finals[0].index);
      if (!await sameOriginForm(page, finalControl, session.flowOrigin)) return result("blocked", "Envoi vers une origine différente interdite.");
      if (input.mode === "prepare") return result("ready", "Formulaire prêt à être envoyé.");
      if (input.signal?.aborted) return result("failed", "Parcours interrompu avant l’envoi.");
      const beforeText = await page.locator("body").innerText().catch(() => "");
      // Persist the submitting marker before any final click so a retry cannot duplicate an uncertain send.
      input.beforeSubmit();
      session.submittedClick = true;
      await finalControl.click();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      for (let retry = 0; retry < 10; retry++) {
        const proof = await receipt(page, beforeText);
        if (proof) return result("submitted", "Candidature confirmée.", [], proof);
        await page.waitForTimeout(250);
      }
      return result("uncertain", "Le clic a eu lieu mais aucun reçu vérifiable n’est apparu.");
    }
    return result("blocked", "Le formulaire dépasse dix étapes.");
  }
}

