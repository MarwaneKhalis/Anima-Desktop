import type { Page } from "playwright";

export type CareerAts = "greenhouse" | "lever" | "ashby" | "recruitee" | "workable" | "smartrecruiters";
export type ResourceKind = "document" | "stylesheet" | "image" | "media" | "font" | "script" | "texttrack" | "xhr" | "fetch" | "eventsource" | "websocket" | "manifest" | "other";

const GREENHOUSE_PAGES = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io", "boards.eu.greenhouse.io"]);
const LEVER_PAGES = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);
const ASHBY_PAGES = new Set(["jobs.ashbyhq.com"]);
const GREENHOUSE_STATIC = new Set(["static.greenhouse.io"]);
const SMARTRECRUITERS_PAGES = new Set(["jobs.smartrecruiters.com", "careers.smartrecruiters.com"]);
const RECRUITEE_TENANT = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.s)?\.recruitee\.com$/;
const WORKABLE_ACCOUNT = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.workable\.com$/;

export function careerAtsForHostname(hostname: string): CareerAts | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (SMARTRECRUITERS_PAGES.has(host)) return "smartrecruiters";
  if (GREENHOUSE_PAGES.has(host)) return "greenhouse";
  if (LEVER_PAGES.has(host)) return "lever";
  if (ASHBY_PAGES.has(host)) return "ashby";
  const recruiteeTenant = RECRUITEE_TENANT.exec(host)?.[1];
  if (recruiteeTenant && recruiteeTenant !== "s") return "recruitee";
  if (host === "apply.workable.com" || WORKABLE_ACCOUNT.test(host)) return "workable";
  return null;
}

/** Only the named public job-board hosts are form destinations. Never infer vendor trust from a suffix. */
export function careerAtsForUrl(value: string): CareerAts | null {
  try { return careerAtsForHostname(new URL(value).hostname); } catch { return null; }
}

/** A cross-origin document is accepted only for an exact explicit Apply target, or a
 * public ATS redirect within the same vendor family. Redirects to ordinary domains fail closed. */
export function allowsCareerAtsNavigation(input: {
  from: string; to: string; pendingAtsOrigin?: string; initialNavigation: boolean;
  redirected: boolean; testOrigins: ReadonlySet<string>;
}): boolean {
  let from: URL; let to: URL;
  try { from = new URL(input.from); to = new URL(input.to); } catch { return false; }
  // A test fixture may model a visible cross-origin Apply link, but it must still
  // be selected explicitly as the pending destination before navigation is allowed.
  if (input.testOrigins.has(to.origin)) return input.pendingAtsOrigin === to.origin
    || (input.initialNavigation && input.redirected);
  if (to.protocol !== "https:") return false;
  const fromAts = careerAtsForUrl(from.href);
  const toAts = careerAtsForUrl(to.href);
  if (!toAts) return false;
  if (fromAts === "smartrecruiters" && toAts === "smartrecruiters" && from.hostname !== to.hostname
    && (input.redirected || input.pendingAtsOrigin !== to.origin)) return false;
  return input.pendingAtsOrigin === to.origin
    || (input.initialNavigation && input.redirected && (!fromAts || fromAts === toAts))
    || (input.redirected && fromAts !== null && fromAts === toAts);
}

/** Permit cross-origin bytes only for explicitly enumerated, passive vendor assets. */
export function allowsCareerAtsResource(input: {
  from: string; to: string; method: string; kind: ResourceKind;
}): boolean {
  let from: URL; let to: URL;
  try { from = new URL(input.from); to = new URL(input.to); } catch { return false; }
  if (to.protocol !== "https:" || input.method.toUpperCase() !== "GET") return false;
  const ats = careerAtsForUrl(from.href);
  if ((ats === "workable" || ats === "smartrecruiters") && from.origin !== to.origin) return false;
  if (!ats || careerAtsForUrl(to.href) !== ats) {
    if (ats !== "greenhouse" || !GREENHOUSE_STATIC.has(to.hostname.toLowerCase())) return false;
    // Static Greenhouse is only for stylesheet/font bytes, never scripts, pixels, or data.
    // Query strings and non-assets are denied so it cannot be used as a beacon endpoint.
    if (to.search || !/^\/assets\/[A-Za-z0-9_./-]+\.(?:css|woff2?|ttf|otf)$/i.test(to.pathname)) return false;
    return input.kind === "stylesheet" || input.kind === "font";
  }
  // Pages and data-bearing requests are never third-party resources.
  return ["stylesheet", "image", "media", "font", "script"].includes(input.kind);
}

export type ApplyLink = { href: string; vendor: CareerAts | "test"; index: number };

/**
 * Find one unambiguous visible Apply link. We inspect anchors only; no guessed form action,
 * hidden link, script URL, or arbitrary external redirect is followed.
 */
export async function findApplyLink(page: Page, testOrigins: ReadonlySet<string>): Promise<ApplyLink | null | "ambiguous"> {
  const links = await page.locator("a[href]").evaluateAll(nodes => nodes.flatMap((node, index) => {
    const a = node as HTMLAnchorElement;
    const text = `${a.innerText || ""} ${a.getAttribute("aria-label") || ""} ${a.title || ""}`.trim();
    if (!/\b(apply|apply now|apply for this job|postuler|candidater|postulez|i['’]?m interested|interested in this job)\b/i.test(text)) return [];
    const style = getComputedStyle(a);
    if (style.display === "none" || style.visibility === "hidden" || !a.getClientRects().length) return [];
    return [{ href: a.href, index }];
  }));
  if (links.length > 1) return "ambiguous";
  const allowed: ApplyLink[] = links.flatMap<ApplyLink>(({ href, index }) => {
    try {
      const url = new URL(href);
      if (url.protocol !== "https:" && !testOrigins.has(url.origin)) return [];
      const vendor = careerAtsForUrl(url.href);
      if (vendor) return [{ href: url.href, vendor, index }];
      if (testOrigins.has(url.origin)) return [{ href: url.href, vendor: "test", index }];
      return [];
    } catch { return []; }
  });
  if (allowed.length > 1) return "ambiguous";
  return allowed[0] || null;
}

