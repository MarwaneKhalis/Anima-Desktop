import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  Application, CareerProfile, JobOffer, MissingField, Receipt, Resume, RunMode, RunResult,
} from "../src/shared/career.ts";
import { allowsCareerAtsNavigation, allowsCareerAtsResource, careerAtsForUrl, findApplyLink } from "./career-ats.ts";

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
  })) throw new Error("Destination rÃ©seau privÃ©e interdite.");
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
const missingType = (c: Control): MissingField["type"] => c.type === "file" ? "file" : c.tag === "select" ? "select" : ["checkbox", "radio"].includes(c.type) ? "boolean" : ["text", "email", "tel", "url", "textarea"].includes(c.type) ? "text" : "unknown";
const loginButton = (s: string) => /^(log in|login|sign in|connexion|se connecter|connecter|submit)$/i.test(s.trim());
const loginField = (c: Control) => c.type === "email" || [c.name, c.label, c.key].some(value => /(^| )(username|user name|email|e mail|identifiant|login)( |$)/i.test(tidy(value)));
const nextButton = (s: string) => /^(next|continue|suivant|suivante|continuer|prochaine etape)$/i.test(tidy(s));
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
const receiptPattern = /(?:application (?:received|submitted)|thank you for (?:applying|your application)|candidature (?:recue|reÃ§ue|envoyee|envoyÃ©e)|merci pour votre candidature)/i;
async function receipt(page: Page, previousText: string): Promise<Receipt | null> {
  const full = await page.locator("body").innerText().catch(() => "");
  const body = safeText(full);
  const matches = receiptPattern.test(full);
  if (!matches || (await buttons(page)).some(b => !b.disabled && finalButton(b.text))) return null;
  const reference = full.match(/(?:reference|rÃ©fÃ©rence|confirmation|receipt|reÃ§u)\s*(?:number|no|nÂ°|#|:)?\s*([A-Z0-9-]{4,})/i)?.[1] || "";
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
    if (this.active || this.pausedSession) throw new Error("Un parcours navigateur est-|ïKh‘éì¶»§q«^vöÇ2‡vR“°Ð¢6öç7Böå7W÷'FVDG2Ò6&VW$G4f÷%W&Â‡6W76–öâæfÆ÷t÷&–v–â’ÓÒçVÆÃ°Ð¢6öç7BöäW‡Æ–6—EFW7D÷&–v–âÒF†—2çFW7D÷&–v–ç2æ†2‡6W76–öâæfÆ÷t÷&–v–â“°Ð¢–b‚öå7W÷'FVDG2bböäW‡Æ–6—EFW7D÷&–v–â’°Ð¢òòæWfW"÷VÆFRW'6öæÂFFöââ&&—G&'’6&VW"×6—FRf÷&ÒâvRÖ’öæÇ’föÆÆ÷ràÐ¢òòW‡Æ–6—BÂf—6–&ÆRÇ’Æ–æ²FòöæRöbF†RæÖVBV&Æ–2E2†÷7G2&÷fRàÐ¢–b†72æÆVæwF‚ÓÓÒ’°Ð¢6öç7BÇ’Òv—Bf–æDÇ”Æ–æ²‡vRÂF†—2çFW7D÷&–v–ç2“°Ð¢–b†Ç’ÓÓÒ&Ö&–wV÷W2"’&WGW&â&W7VÇB‚&&Æö6¶VB"Â%ÇW6–WW'2Æ–Vç2FR6æF–FGW&R6öçB÷76–&ÆW2¢<:–ÆV7F–öææW¢ÆR&6÷W'2ÖçVVÆÆVÖVçBâ"“°Ð¢–b†Ç’’°Ð¢–b‡6W76–öâç6VVâæ†2†Ç’æ‡&Vb’’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$ÆRÆ–VâFR6æF–FGW&Rf÷&ÖRVæR&÷V6ÆRâ"“°Ð¢6W76–öâç6VVâæFB†Ç’æ‡&Vb“°Ð¢–b†Ç’çfVæF÷"ÓÒ'FW7B"’6W76–öâçVæF–ætG4÷&–v–âÒæWrU$Â†Ç’æ‡&Vb’æ÷&–v–ã°Ð¢v—BGfæ6R‡vRÂvRæÆö6F÷"‚&¶‡&VeÒ"’æçF‚†Ç’æ–æFW‚’“°Ð¢6öçF–çVS°Ð¢ÐÐ¢ÐÐ¢&WGW&â&W7VÇB‚&&Æö6¶VB"Â$6R6—FR6'&œ:‡&Rî(	–W7B2&—2Vâ6†&vRâÆW2Föæì:–W2W'6öææVÆÆW2æR6W&öçB2G&ç6Ö—6W2:6WGFR÷&–v–æRâ"“°Ð¢ÐÐ¢6öç7BvU6–væGW&RÒvRçW&Â‚’²'Â"²72æÖ†2Óâ2ææÖR²#¢"²2æ¶W’’æ¦ö–â‚'Â"“°Ð¢f÷"†6öç7B2öb72’°Ð¢6öç7B–æ—F–Ä¶W’ÒvU6–væGW&R²'Â"²2æ–æFW‚²'Â"²2çG—R²'Â"²†2ææÖRÇÂ2æ¶W’“°Ð¢–b‚6W76–öâæ–æ—F–ÅfÇVW2æ†2†–æ—F–Ä¶W’’’6W76–öâæ–æ—F–ÅfÇVW2ç6WB†–æ—F–Ä¶W’Â6öçG&öÅfÇVR†2’“°Ð¢ÐÐ¢6öç7B6†ævVD'•W6W"Ò†3¢6öçG&öÂ’Óâ°Ð¢6öç7B–æ—F–Ä¶W’ÒvU6–væGW&R²'Â"²2æ–æFW‚²'Â"²2çG—R²'Â"²†2ææÖRÇÂ2æ¶W’“°Ð¢&WGW&â6W76–öâç&W7VÖT6÷VçBâbb6W76–öâæ–æ—F–ÅfÇVW2ævWB†–æ—F–Ä¶W’’ÓÒ6öçG&öÅfÇVR†2“°Ð¢Ó°Ð¢–b†72ç6öÖR†2Óâ2çG—RÓÓÒ'77v÷&B"’’°Ð¢–b‡6W76–öâæÆövvVD–â’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$6öææW†–öâæöâFW&Ö–ì:–R²–çFW'fVçF–öâÖçVVÆÆR&WV—6Râ"“°Ð¢–b‚öå7W÷'FVDG2bböäW‡Æ–6—EFW7D÷&–v–â’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$ÆR6öfg&Rî(	–W7B66W76–&ÆRVR÷W"VâE2W‡Æ–6—FVÖVçB&—2Vâ6†&vRâ"“°Ð¢6öç7B7&VFVçF–ÂÒ–çWBævWD7&VFVçF–Â‡6W76–öâæfÆ÷t÷&–v–â“°Ð¢–b‚7&VFVçF–Â’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$6ö×FR&WV—2÷W"6WGFR÷&–v–æR²Vç&Vv—7G&W¢6W2–FVçF–f–çG2Fç2ÆR6öfg&Râ"“°Ð¢6öç7BW6W"Ò72æf–æB†Æöv–äf–VÆB“°Ð¢6öç7B72Ò72æf–æB†2Óâ2çG—RÓÓÒ'77v÷&B"“°Ð¢6öç7B7F–öâÒ†v—B'WGFöç2‡vR’’æf–ÇFW"†"Óâ"æF—6&ÆVBbbÆöv–ä'WGFöâ†"çFW‡B’“°Ð¢–b‚W6W"ÇÂ72ÇÂ7F–öâæÆVæwF‚ÓÒ’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$f÷&×VÆ—&RFR6öææW†–öâÖ&–wRâ"“°Ð¢6öç7BÆöv–ä6öçG&öÂÒvRæÆö6F÷"‚&–çWBÂ6VÆV7BÂFW‡F&V"’æçF‚‡72æ–æFW‚“°Ð¢–b‚v—B6ÖT÷&–v–äf÷&Ò‡vRÂÆöv–ä6öçG&öÂÂ6W76–öâæfÆ÷t÷&–v–â’’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$6öææW†–öâfW'2VæR÷&–v–æRF–fl:—&VçFR–çFW&F—FRâ"“°Ð¢v—BvRæÆö6F÷"‚&–çWBÂ6VÆV7BÂFW‡F&V"’æçF‚‡W6W"æ–æFW‚’æf–ÆÂ†7&VFVçF–ÂçW6W&æÖR“°Ð¢v—BvRæÆö6F÷"‚&–çWBÂ6VÆV7BÂFW‡F&V"’æçF‚‡72æ–æFW‚’æf–ÆÂ†7&VFVçF–Âç77v÷&B“°Ð¢v—BGfæ6R‡vRÂvRæÆö6F÷"‚v'WGFöâÂ–çWE·G—SÒ'7V&Ö—B%Òr’æçF‚†7F–öå³Òæ–æFW‚’“°Ð¢6W76–öâæÆövvVD–âÒG'VS°Ð¢6öçF–çVS°Ð¢ÐÐ¢6öç7BÖ—76–æs¢Ö—76–ætf–VÆEµÒÒµÓ°Ð¢6öç7BW‡Æ–6—Df÷"Ò‚ââæÆ&VÇ3¢7G&–æuµÒ’Óâ°Ð¢f÷"†6öç7Bç7vW'2öb¶–çWBæÆ–6F–öâæç7vW'2Â–çWBç&öf–ÆRæç7vW'5Ò’°Ð¢6öç7BÖF6‚Òö&¦V7BæVçG&–W2†ç7vW'2’æf–æB‚…¶ç7vW$¶W•Ò’ÓâÆ&VÇ2ç6öÖR†Æ&VÂÓâF–G’†ç7vW$¶W’’ÓÓÒF–G’†Æ&VÂ’’“°Ð¢–b†ÖF6‚’&WGW&âÖF6…³Ó°Ð¢ÐÐ¢&WGW&âVæFVf–æVC°Ð¢Ó°Ð¢6öç7B&F–ôw&÷W2ÒæWrÖÇ7G&–ærÂ6öçG&öÅµÓâ‚“°Ð¢f÷"†6öç7B2öb72æf–ÇFW"†2Óâ2çG—RÓÓÒ'&F–ò"’’°Ð¢6öç7Bw&÷W¶W’ÒF–G’†2ææÖRÇÂ2æ¶W’“°Ð¢&F–ôw&÷W2ç6WB†w&÷W¶W’Â²âââ‡&F–ôw&÷W2ævWB†w&÷W¶W’’ÇÂµÒ’Â5Ò“°Ð¢ÐÐ¢f÷"†6öç7B¶¶W’Âw&÷WÒöb&F–ôw&÷W2’°Ð¢6öç7B&WV—&VBÒw&÷Wç6öÖR†2Óâ2ç&WV—&VB“°Ð¢6öç7BÆ&VÂÒw&÷W³ÒææÖRÇÂw&÷W³ÒæÆ&VÂÇÂw&÷W³Òæ¶W“°Ð¢6öç7B÷F–öç2Òw&÷WæÖ†2Óâ2çfÇVRÇÂ2æÆ&VÂ’æf–ÇFW"„&ööÆVâ“°Ð¢6öç7Bç7vW"ÒW‡Æ–6—Df÷"†w&÷W³ÒææÖRÇÂw&÷W³Òæ¶W’“°Ð¢–b†w&÷Wç6öÖR†6†ævVD'•W6W"’’°Ð¢–b‚‡&WV—&VBÇÂç7vW"ÓÒVæFVf–æVB’bbw&÷Wç6öÖR†2Óâ2æ6†V6¶VB’’Ö—76–ærçW6‚‡²¶W’ÂÆ&VÂÂ&WV—&VBÂG—S¢'6VÆV7B"Â÷F–öç2Ò“°Ð¢6öçF–çVS°Ð¢ÐÐ¢6öç7BFW6—&VBÒG—Vöbç7vW"ÓÓÒ&&ööÆVâ"ò†ç7vW"ò'–W2"¢&æò"’¢G—Vöbç7vW"ÓÓÒ'7G&–ær"òF–G’†ç7vW"’¢"#°Ð¢6öç7B6VÆV7FVBÒFW6—&VBòw&÷Wæf–æB†2ÓâF–G’†2çfÇVR’ÓÓÒFW6—&VBÇÂF–G’†2æÆ&VÂ’ÓÓÒFW6—&VB’¢VæFVf–æVC°Ð¢–b‡6VÆV7FVB’v—BvRæÆö6F÷"‚&–çWBÂ6VÆV7BÂFW‡F&V"’æçF‚‡6VÆV7FVBæ–æFW‚’æ6†V6²‚“°Ð¢VÇ6R–b‚‡&WV—&VBÇÂç7vW"ÓÒVæFVf–æVB’bbw&÷Wç6öÖR†2Óâ2æ6†V6¶VBbb6†ævVD'•W6W"†2’’’Ö—76–ærçW6‚‡²¶W’ÂÆ&VÂÂ&WV—&VBÂG—S¢'6VÆV7B"Â÷F–öç2Ò“°Ð¢VÇ6R–b‚&WV—&VBbbç7vW"ÓÓÒVæFVf–æVBbbw&÷Wç6öÖR†6†ævVD'•W6W"’’°Ð¢f÷"†6öç7B2öbw&÷W’v—BvRæÆö6F÷"‚&–çWBÂ6VÆV7BÂFW‡F&V"’æçF‚†2æ–æFW‚’æWfÇVFR†VÂÓâ²†VÂ2…DÔÄ–çWDVÆVÖVçB’æ6†V6¶VBÒfÇ6S²†VÂ2…DÔÄ–çWDVÆVÖVçB’æF—6&ÆVBÒG'VS²Ò“°Ð¢ÐÐ¢ÐÐ¢f÷"†6öç7B2öb72’°Ð¢–b†2çG—RÓÓÒ'&F–ò"’6öçF–çVS°Ð¢6öç7B¶W’ÒF–G’†2ææÖRÇÂ2æ¶W’“°Ð¢–b‚¶W’ÇÂö†öæW—÷GÇvV'6—FR†–FFVçÆFòæ÷Bf–ÆÇÆÆVfR&Ææ²ö’çFW7B†¶W’’’6öçF–çVS°Ð¢6öç7BÆö2ÒvRæÆö6F÷"‚&–çWBÂ6VÆV7BÂFW‡F&V"’æçF‚†2æ–æFW‚“°Ð¢–b†2çG—RÓÓÒ&f–ÆR"’°Ð¢–b‡&W7VÖTf–VÆB†2’ÇÂ†–çWBæf–ÆTf–VÆD¶W’bbF–G’†–çWBæf–ÆTf–VÆD¶W’’ÓÓÒ¶W’’’v—BÆö2ç6WD–çWDf–ÆW2‡²æÖS¢–çWBç&W7VÖRæÖWFæf–ÆVæÖRÂÖ–ÖUG—S¢–çWBç&W7VÖRæÖWFæÖ–ÖRÂ'VffW#¢–çWBç&W7VÖRæ'—FW2Ò“°Ð¢VÇ6R–b†2ç&WV—&VBbb2çWÆöFVBbb6†ævVD'•W6W"†2’’Ö—76–ærçW6‚‡²¶W’ÂÆ&VÃ¢2æÆ&VÂÇÂ2æ¶W’Â&WV—&VC¢G'VRÂG—S¢&f–ÆR"Ò“°Ð¢6öçF–çVS°Ð¢ÐÐ¢–b†6†ævVD'•W6W"†2’’°Ð¢–b†2ç&WV—&VBbb‚†2çG—RÓÓÒ&6†V6¶&÷‚"bb2æ6†V6¶VB’ÇÂ†2çG—RÓÒ&6†V6¶&÷‚"bb2çfÇVR’’’Ö—76–ærçW6‚‡²¶W’ÂÆ&VÃ¢2æÆ&VÂÇÂ2æ¶W’Â&WV—&VC¢G'VRÂG—S¢Ö—76–æuG—R†2’Ââââ†2çFrÓÓÒ'6VÆV7B"ò²÷F–öç3¢2æ÷F–öç2Ò¢·Ò’Ò“°Ð¢6öçF–çVS°Ð¢ÐÐ¢6öç7BÆ–6W2ÒæWr6WB…¶¶W’ÂF–G’†2æÆ&VÂ’ÂF–G’†2æ¶W’•Ò“°Ð¢6öç7BW‡Æ–6—BÒW‡Æ–6—Df÷"‚ââæÆ–6W2“°Ð¢6öç7BfÇVRÒW‡Æ–6—BÓÓÒVæFVf–æVBò¶æ÷våfÇVR‡F–G’†2æÆ&VÂÇÂ2æ¶W’’Â–çWBç&öf–ÆR’¢W‡Æ–6—C°Ð¢–b†2çG—RÓÓÒ&6†V6¶&÷‚"’°Ð¢–b‡G—VöbfÇVRÓÓÒ&&ööÆVâ"’°Ð¢–b‡fÇVR’v—BÆö2æ6†V6²‚“°Ð¢VÇ6R°Ð¢v—BÆö2çVæ6†V6²‚’æ6F6‚‚‚’Óâ·Ò“°Ð¢–b†2ç&WV—&VB’Ö—76–ærçW6‚‡²¶W’ÂÆ&VÃ¢2æÆ&VÂÇÂ2æ¶W’Â&WV—&VC¢G'VRÂG—S¢&&ööÆVâ"Ò“°Ð¢ÐÐ¢ÐÐ¢VÇ6R–b†2ç&WV—&VBbb†2æ6†V6¶VBbb6†ævVD'•W6W"†2’’’Ö—76–ærçW6‚‡²¶W’ÂÆ&VÃ¢2æÆ&VÂÇÂ2æ¶W’Â&WV—&VC¢G'VRÂG—S¢&&ööÆVâ"Ò“°Ð¢VÇ6R–b‚6†ævVD'•W6W"†2’’v—BÆö2çVæ6†V6²‚’æ6F6‚‚‚’Óâ·Ò“°Ð¢6öçF–çVS°Ð¢ÐÐ¢–b†2çFrÓÓÒ'6VÆV7B"’°Ð¢6öç7BFW6—&VBÒG—VöbfÇVRÓÓÒ&&ööÆVâ"ò‡fÇVRò'–W2"¢&æò"’¢G—VöbfÇVRÓÓÒ'7G&–ær"òF–G’‡fÇVR’¢"#°Ð¢–b†FW6—&VB’°Ð¢6öç7BÖF6‚Ò2æ÷F–öç2æf–æB†òÓâF–G’†ò’ÓÓÒFW6—&VB“°Ð¢–b†ÖF6‚’v—BÆö2ç6VÆV7D÷F–öâ‡²Æ&VÃ¢ÖF6‚Ò“°Ð¢VÇ6RÖ—76–ærçW6‚‡²¶W’ÂÆ&VÃ¢2æÆ&VÂÇÂ2æ¶W’Â&WV—&VC¢2ç&WV—&VBÂG—S¢'6VÆV7B"Â÷F–öç3¢2æ÷F–öç2Ò“°Ð¢ÒVÇ6R–b†2ç&WV—&VBbb6†ævVD'•W6W"†2’’Ö—76–ærçW6‚‡²¶W’ÂÆ&VÃ¢2æÆ&VÂÇÂ2æ¶W’Â&WV—&VC¢G'VRÂG—S¢'6VÆV7B"Â÷F–öç3¢2æ÷F–öç2Ò“°Ð¢VÇ6R–b‚2ç&WV—&VBbb6†ævVD'•W6W"†2’’°Ð¢6öç7B&Ææ²Ò2æ÷F–öç2æf–æB†òÓâF–G’†ò’“°Ð¢–b†&Ææ²ÓÒVæFVf–æVB’v—BÆö2ç6VÆV7D÷F–öâ‡²Æ&VÃ¢&Ææ²Ò“°Ð¢VÇ6Rv—BÆö2æWfÇVFR†VÂÓâ²†VÂ2…DÔÅ6VÆV7DVÆVÖVçB’æF—6&ÆVBÒG'VS²Ò“°Ð¢ÐÐ¢6öçF–çVS°Ð¢ÐÐ¢–b‡G—VöbfÇVRÓÓÒ'7G&–ær"bbfÇVR’v—BÆö2æf–ÆÂ‡fÇVR“°Ð¢VÇ6R–b†2ç&WV—&VBbb6†ævVD'•W6W"†2’’Ö—76–ærçW6‚‡²¶W’ÂÆ&VÃ¢2æÆ&VÂÇÂ2æ¶W’Â&WV—&VC¢G'VRÂG—S¢Ö—76–æuG—R†2’Ò“°Ð¢VÇ6R–b‚2ç&WV—&VBbb2çfÇVRbb6†ævVD'•W6W"†2’’v—BÆö2æf–ÆÂ‚""“°Ð¢ÐÐ¢–b†Ö—76–æræÆVæwF‚’&WGW&â&W7VÇB‚&æVVG5ö–çWB"Â%&Vç6V–væW¢ÆW26†×2&WV—2Fç2Î(	–Æ–6F–öâ÷RFç2ÆRæf–vFWW"ÂV—2&W&VæW¢Æ6æF–FGW&Râ"ÂÖ—76–ær“°Ð¢òòV&Æ–2E2¦ö"FWF–Ç2W7VÆÇ’W‡÷6RâÇ’Æ–æ²&Vf÷&RF†W’&VæFW"F†RÆ–6F–öàÐ¢òòf÷&ÒâföÆÆ÷rW†7FÇ’öæRf—6–&ÆRÆ–æ³²æWfW"wVW72'WGFöâ7F–öâ÷"ÆVfRF†RfVæF÷"àÐ¢–b‚†öå7W÷'FVDG2ÇÂöäW‡Æ–6—EFW7D÷&–v–â’bb72æÆVæwF‚ÓÓÒ’°Ð¢6öç7BÇ’Òv—Bf–æDÇ”Æ–æ²‡vRÂF†—2çFW7D÷&–v–ç2“°Ð¢–b†Ç’ÓÓÒ&Ö&–wV÷W2"’&WGW&â&W7VÇB‚&&Æö6¶VB"Â%ÇW6–WW'2Æ–Vç2FR6æF–FGW&R6öçB÷76–&ÆW2¢<:–ÆV7F–öææW¢ÆR&6÷W'2ÖçVVÆÆVÖVçBâ"“°Ð¢–b†Ç’’°Ð¢6öç7BF&vWDG2Ò6&VW$G4f÷%W&Â†Ç’æ‡&Vb“°Ð¢6öç7B7W'&VçDG2Ò6&VW$G4f÷%W&Â‡6W76–öâæfÆ÷t÷&–v–â“°Ð¢–b†Ç’çfVæF÷"ÓÒ'FW7B"bbF&vWDG2ÓÒ7W'&VçDG2’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$ÆRÆ–VâFR6æF–FGW&R6÷'BGRf÷W&æ—76WW"E2&—2Vâ6†&vRâ"“°Ð¢–b‡6W76–öâç6VVâæ†2†Ç’æ‡&Vb’’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$ÆRÆ–VâFR6æF–FGW&Rf÷&ÖRVæR&÷V6ÆRâ"“°Ð¢6W76–öâç6VVâæFB†Ç’æ‡&Vb“°Ð¢–b†Ç’çfVæF÷"ÓÒ'FW7B"’6W76–öâçVæF–ætG4÷&–v–âÒæWrU$Â†Ç’æ‡&Vb’æ÷&–v–ã°Ð¢v—BGfæ6R‡vRÂvRæÆö6F÷"‚&¶‡&VeÒ"’æçF‚†Ç’æ–æFW‚’“°Ð¢6öçF–çVS°Ð¢ÐÐ¢ÐÐ¢6öç7B7F–öç2Ò†v—B'WGFöç2‡vR’’æf–ÇFW"†"Óâ"æF—6&ÆVB“°Ð¢6öç7Bf–æÇ2Ò7F–öç2æf–ÇFW"†"Óâf–æÄ'WGFöâ†"çFW‡B’“°Ð¢6öç7BæW‡G2Ò7F–öç2æf–ÇFW"†"ÓâæW‡D'WGFöâ†"çFW‡B’“°Ð¢–b†f–æÇ2æÆVæwF‚âÇÂæW‡G2æÆVæwF‚âÇÂ†f–æÇ2æÆVæwF‚bbæW‡G2æÆVæwF‚’’&WGW&â&W7VÇB‚&&Æö6¶VB"Â%ÇW6–WW'27F–öç2÷76–&ÆW2¢<:–ÆV7F–öâÖçVVÆÆR&WV—6Râ"“°Ð¢–b†æW‡G2æÆVæwF‚ÓÓÒ’°Ð¢6öç7BæW‡D6öçG&öÂÒvRæÆö6F÷"‚v'WGFöâÂ–çWE·G—SÒ'7V&Ö—B%Òr’æçF‚†æW‡G5³Òæ–æFW‚“°Ð¢–b‚v—B6ÖT÷&–v–äf÷&Ò‡vRÂæW‡D6öçG&öÂÂ6W76–öâæfÆ÷t÷&–v–â’’&WGW&â&W7VÇB‚&&Æö6¶VB"Â,8—FR7V—fçFRfW'2VæR÷&–v–æRF–fl:—&VçFR–çFW&F—FRâ"“°Ð¢6öç7Bf–ævW'&–çBÒvRçW&Â‚’²'Â"²72æÖ†2Óâ2æ¶W’’æ¦ö–â‚'Â"“°Ð¢–b‡6W76–öâç6VVâæ†2†f–ævW'&–çB’’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$ÆRf÷&×VÆ—&RF÷W&æRVâ&÷V6ÆRâ"“°Ð¢6W76–öâç6VVâæFB†f–ævW'&–çB“°Ð¢v—BGfæ6R‡vRÂæW‡D6öçG&öÂ“°Ð¢6öçF–çVS°Ð¢ÐÐ¢–b†f–æÇ2æÆVæwF‚ÓÒ’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$&÷WFöâf–æÂFR6æF–FGW&R–çG&÷Wf&ÆR÷RÖ&–wRâ"“°Ð¢6öç7Bf–æÄ6öçG&öÂÒvRæÆö6F÷"‚v'WGFöâÂ–çWE·G—SÒ'7V&Ö—B%Òr’æçF‚†f–æÇ5³Òæ–æFW‚“°Ð¢–b‚v—B6ÖT÷&–v–äf÷&Ò‡vRÂf–æÄ6öçG&öÂÂ6W76–öâæfÆ÷t÷&–v–â’’&WGW&â&W7VÇB‚&&Æö6¶VB"Â$Vçfö’fW'2VæR÷&–v–æRF–fl:—&VçFR–çFW&F—FRâ"“°Ð¢–b†–çWBæÖöFRÓÓÒ'&W&R"’&WGW&â&W7VÇB‚'&VG’"Â$f÷&×VÆ—&R,:§B::§G&RVçf÷œ:’â"“°Ð¢–b†–çWBç6–væÃòæ&÷'FVB’&WGW&â&W7VÇB‚&f–ÆVB"Â%&6÷W'2–çFW'&ö×RfçBÎ(	–Vçfö’â"“°Ð¢6öç7B&Vf÷&UFW‡BÒv—BvRæÆö6F÷"‚&&öG’"’æ–ææW%FW‡B‚’æ6F6‚‚‚’Óâ""“°Ð¢òòW'6—7BF†R7V&Ö—GF–ærÖ&¶W"&Vf÷&Rç’f–æÂ6Æ–6²6ò&WG'’6ææ÷BGWÆ–6FRâVæ6W'F–â6VæBàÐ¢–çWBæ&Vf÷&U7V&Ö—B‚“°Ð¢6W76–öâç7V&Ö—GFVD6Æ–6²ÒG'VS°Ð¢v—Bf–æÄ6öçG&öÂæ6Æ–6²‚“°Ð¢v—BvRçv—Df÷$ÆöE7FFR‚&FöÖ6öçFVçFÆöFVB"’æ6F6‚‚‚’Óâ·Ò“°Ð¢f÷"†ÆWB&WG'’Ò²&WG'’Â²&WG'’²²’°Ð¢6öç7B&ööbÒv—B&V6V—B‡vRÂ&Vf÷&UFW‡B“°Ð¢–b‡&ööb’&WGW&â&W7VÇB‚'7V&Ö—GFVB"Â$6æF–FGW&R6öæf—&Ü:–Râ"ÂµÒÂ&ööb“°Ð¢v—BvRçv—Df÷%F–ÖV÷WBƒ#S“°Ð¢ÐÐ¢&WGW&â&W7VÇB‚'Væ6W'F–â"Â$ÆR6Æ–2WRÆ–WRÖ—2V7Vâ&\:wRl:—&–f–&ÆRî(	–W7B'Râ"“°Ð¢ÐÐ¢&WGW&â&W7VÇB‚&&Æö6¶VB"Â$ÆRf÷&×VÆ—&RL:—76RF—‚:—FW2â"“°Ð¢ÐÐ§ÐÐ