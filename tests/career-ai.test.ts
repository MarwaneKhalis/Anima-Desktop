import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CareerAI, isPublicAIAddress, resolveAllAIAddresses, type AIHTTPSender, type AIResolver, type PinnedHTTPSOptions, type ResolvedAddress, validateAIBaseUrl } from '../server/career-ai.ts';
import { CareerError, CareerStore } from '../server/career-store.ts';
import { Vault } from '../server/vault.ts';
import { handleCareerApi } from '../server/career-api.ts';

function setup(options: { resolver?: AIResolver; sender?: AIHTTPSender; timeoutMs?: number } = {}) {
  const db = new DatabaseSync(':memory:');
  const store = new CareerStore(db);
  const vault = new Vault(db);
  vault.initialize('phrase privée de test assez longue');
  const job = store.saveJob({ url: 'https://careers.example.org/jobs/42', title: 'Développeuse TypeScript', company: 'Atelier Horizon', location: 'Paris', description: 'Construire des services web avec TypeScript et React.' });
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
  const resume = store.saveResume({ name: 'CV principal', filename: 'cv.pdf', mime: 'application/pdf', bytes: pdf });
  store.saveProfile({ firstName: 'Camille', lastName: 'Martin', email: 'camille@example.org', phone: '0600000000', city: 'Paris', country: 'France', address: '1 rue privée', postalCode: '75001', headline: 'Développeuse full stack', summary: 'Cinq ans de développement de services TypeScript.', skills: ['TypeScript', 'React'], languages: ['français'], experiences: [{ company: 'Exemple', title: 'Développeuse', start: '2021', end: '2025', description: 'Développement de produits web.' }], education: [{ school: 'Université', degree: 'Master informatique', start: '2019', end: '2021' }], preferences: { titles: [], locations: [], remote: false, contract: '' }, answers: {} });
  const application = store.createApplication({ jobId: job.id, resumeId: resume.id });
  store.updateApplication(application.id, { answers: { 'Pourquoi ce poste ?': 'Le produit correspond à mon expérience.', 'Question sensible: téléphone': '0600000000' } });
  const ai = new CareerAI(store, vault, {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    sender: async () => fakeResponse('OK'),
    ...options,
  });
  return { db, store, vault, ai, job, application: store.getApplication(application.id) };
}

function fakeResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { 'Content-Type': 'application/json' } });
}

test('AI provider URLs must use public HTTPS and exclude credentials, query and fragments', () => {
  assert.equal(validateAIBaseUrl('https://api.example.org/v1/'), 'https://api.example.org/v1');
  for (const value of ['http://api.example.org/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://user:pass@example.org/v1', 'https://api.example.org/v1?token=x', 'https://api.example.org/v1#frag']) {
    assert.throws(() => validateAIBaseUrl(value), CareerError, value);
  }
});

test('DNS address policy rejects reserved IPv4 and non-global IPv6, including mapped private IPv4', () => {
  for (const address of ['10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.2', '172.31.0.1', '192.168.1.1', '198.18.0.1', '203.0.113.9', '224.0.0.1', '240.0.0.1']) assert.equal(isPublicAIAddress(address, 4), false, address);
  for (const address of ['::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002::1', '::ffff:10.0.0.1']) assert.equal(isPublicAIAddress(address, 6), false, address);
  assert.equal(isPublicAIAddress('93.184.216.34', 4), true);
  assert.equal(isPublicAIAddress('2606:4700:4700::1111', 6), true);
  assert.equal(isPublicAIAddress('::ffff:93.184.216.34', 6), true);
});

test('a mixed public/private DNS answer is rejected before any HTTPS request', async () => {
  let requests = 0;
  const ctx = setup({
    resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: 'fd00::12', family: 6 }],
    sender: async () => { requests++; return fakeResponse('OK'); },
  });
  try {
    ctx.ai.configure({ baseUrl: 'https://api.example.org/v1', model: 'model', apiKey: 'secret' });
    await assert.rejects(ctx.ai.testConnection(), (e: unknown) => e instanceof CareerError && e.code === 'ai_unsafe_address');
    assert.equal(requests, 0, 'private DNS answer must prevent opening a socket');
  } finally { ctx.db.close(); }
});

test('the production resolver checks both A and AAAA answers and rejects a private answer in either family', async () => {
  const queried: number[] = [];
  const publicAddresses = await resolveAllAIAddresses('api.example.org', async (_hostname, family) => {
    queried.push(family);
    return family === 4 ? ['93.184.216.34'] : ['2606:4700:4700::1111'];
  });
  assert.deepEqual(queried.sort(), [4, 6]);
  assert.deepEqual(publicAddresses, [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]);
  await assert.rejects(resolveAllAIAddresses('api.example.org', async (_hostname, family) => family === 4 ? ['93.184.216.34'] : ['fe80::1']), (e: unknown) => e instanceof CareerError && e.code === 'ai_unsafe_address');
});

test('pinned HTTPS lookup returns only the validated IP and keeps the configured hostname for TLS', async () => {
  let requestOptions: PinnedHTTPSOptions | undefined;
  let resolvedHostname = '';
  const ctx = setup({
    resolver: async (hostname) => {
      resolvedHostname = hostname;
      return [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
    },
    sender: async (options) => { requestOptions = options; return fakeResponse('OK'); },
  });
  try {
    ctx.ai.configure({ baseUrl: 'https://api.example.org/v1', model: 'model', apiKey: 'secret' });
    await ctx.ai.testConnection();
    assert.equal(resolvedHostname, 'api.example.org');
    assert.equal(requestOptions?.hostname, 'api.example.org');
    assert.equal(requestOptions?.servername, 'api.example.org');
    assert.equal(requestOptions?.rejectUnauthorized, true);
    const lookup = requestOptions?.lookup as unknown as (hostname: string, options: { all?: boolean }, callback: (error: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void) => void;
    const one = await new Promise<{ address: string; family?: number }>((resolve, reject) => lookup('api.example.org', {}, (error, address, family) => error ? reject(error) : resolve({ address: String(address), family })));
    assert.deepEqual(one, { address: '93.184.216.34', family: 4 });
    const all = await new Promise<{ address: string; family: number }[]>((resolve, reject) => lookup('api.example.org', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses as { address: string; family: number }[])));
    assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);
  } finally { ctx.db.close(); }
});

test('API key is encrypted in the vault and configuration summary never returns it', async () => {
  const ctx = setup();
  try {
    const key = 'sk-test-secret-key-value';
    const summary = ctx.ai.configure({ baseUrl: 'https://api.example.org/v1', model: 'model-fr', apiKey: key });
    assert.equal(summary.model, 'model-fr');
    assert.equal(ctx.ai.config().settings?.baseUrl, 'https://api.example.org/v1');
    const stored = ctx.db.prepare('SELECT ciphertext FROM career_ai_settings WHERE id=1').get() as { ciphertext: Uint8Array };
    assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from(key)), false);
    assert.equal(JSON.stringify(ctx.ai.config()).includes(key), false);
    ctx.vault.lock();
    await assert.rejects(ctx.ai.testConnection(), (e: unknown) => e instanceof CareerError && e.code === 'vault_locked');
  } finally { ctx.db.close(); }
});

test('test call sends no profile data; cover letter call sends a minimized profile and answers only by opt-in', async () => {
  const calls: { options: PinnedHTTPSOptions; body: Record<string, unknown> }[] = [];
  const sender: AIHTTPSender = async (options, rawBody) => {
    calls.push({ options, body: JSON.parse(rawBody) as Record<string, unknown> });
    return fakeResponse(calls.length === 1 ? 'OK' : 'Madame, Monsieur, je souhaite rejoindre votre équipe TypeScript.');
  };
  const ctx = setup({ sender });
  try {
    ctx.ai.configure({ baseUrl: 'https://api.example.org/v1', model: 'model-fr', apiKey: 'sk-test-secret-key-value' });
    assert.deepEqual(await ctx.ai.testConnection(), { ok: true, model: 'model-fr', message: 'Connexion réussie.' });
    const testBody = JSON.stringify(calls[0].body);
    assert.equal(calls[0].options.hostname, 'api.example.org');
    assert.equal(calls[0].options.path, '/v1/chat/completions');
    assert.match(String((calls[0].options.headers as Record<string, string>).Authorization), /^Bearer sk-test-secret-key-value$/);
    assert.equal(testBody.includes('Camille'), false);
    assert.equal(testBody.includes('careers.example.org'), false);

    const defaultDraft = await ctx.ai.draftCoverLetter(ctx.application.id);
    assert.match(defaultDraft.draft, /Madame/);
    const defaultPrompt = JSON.stringify(calls[1].body);
    assert.match(defaultPrompt, /TypeScript/);
    assert.equal(defaultPrompt.includes('Camille'), false);
    assert.equal(defaultPrompt.includes('camille@example.org'), false);
    assert.equal(defaultPrompt.includes('0600000000'), false);
    assert.equal(defaultPrompt.includes('cv.pdf'), false);
    assert.equal(defaultPrompt.includes('Question sensible'), false);

    await ctx.ai.draftCoverLetter(ctx.application.id, true);
    const optedInPrompt = JSON.stringify(calls[2].body);
    assert.match(optedInPrompt, /Question sensible: téléphone/);
    assert.match(optedInPrompt, /0600000000/);
    assert.equal(optedInPrompt.includes('camille@example.org'), false);
    assert.equal(optedInPrompt.includes('cv.pdf'), false);
  } finally { ctx.db.close(); }
});

test('provider failures and oversized response bodies produce sanitized errors', async () => {
  const auth = setup({ sender: async () => new Response(JSON.stringify({ error: 'bad key sk-test-secret-key-value' }), { status: 401, headers: { 'Content-Type': 'application/json' } }) });
  try {
    auth.ai.configure({ baseUrl: 'https://api.example.org/v1', model: 'model', apiKey: 'sk-test-secret-key-value' });
    await assert.rejects(auth.ai.testConnection(), (e: unknown) => e instanceof CareerError && e.code === 'ai_auth' && !e.message.includes('sk-test-secret-key-value'));
  } finally { auth.db.close(); }
  const large = setup({ sender: async () => new Response(' '.repeat(128 * 1024 + 1), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(128 * 1024 + 1) } }) });
  try {
    large.ai.configure({ baseUrl: 'https://api.example.org/v1', model: 'model', apiKey: 'secret' });
    await assert.rejects(large.ai.testConnection(), (e: unknown) => e instanceof CareerError && e.code === 'ai_response_too_large');
  } finally { large.db.close(); }
});

test('provider request has a bounded timeout', async () => {
  const ctx = setup();
  try {
    const timed = new CareerAI(ctx.store, ctx.vault, { resolver: async () => [{ address: '93.184.216.34', family: 4 }], sender: (_options, _body) => new Promise<Response>((_resolve, reject) => {
      _options.signal?.addEventListener('abort', () => reject(new Error('request timed out')), { once: true });
    }), timeoutMs: 20 });
    timed.configure({ baseUrl: 'https://api.example.org/v1', model: 'model', apiKey: 'secret' });
    await assert.rejects(timed.testConnection(), (e: unknown) => e instanceof CareerError && e.code === 'ai_unavailable');
  } finally { ctx.db.close(); }
});

test('the complete provider request body is capped before DNS or HTTPS work', async () => {
  let lookups = 0;
  let requests = 0;
  const ctx = setup({
    resolver: async () => { lookups++; return [{ address: '93.184.216.34', family: 4 }]; },
    sender: async () => { requests++; return fakeResponse('OK'); },
  });
  try {
    ctx.store.saveJob({ url: ctx.job.url, title: ctx.job.title, company: ctx.job.company, location: ctx.job.location, description: 'O'.repeat(12_000) });
    const answers = Object.fromEntries(Array.from({ length: 37 }, (_, index) => [`Question ${index}`, 'R'.repeat(500)]));
    ctx.store.updateApplication(ctx.application.id, { answers });
    ctx.ai.configure({ baseUrl: 'https://api.example.org/v1', model: 'model', apiKey: 'secret' });
    await assert.rejects(ctx.ai.draftCoverLetter(ctx.application.id, true), (e: unknown) => e instanceof CareerError && e.code === 'ai_input_too_large' && e.message === 'Requête IA limitée à 32 Kio.');
    assert.equal(lookups, 0);
    assert.equal(requests, 0);
  } finally { ctx.db.close(); }
});

test('DNS resolution shares the request deadline and cannot continue to a socket after timeout', async () => {
  let requests = 0;
  const ctx = setup({ resolver: () => new Promise<ResolvedAddress[]>(() => {}), sender: async () => { requests++; return fakeResponse('OK'); }, timeoutMs: 20 });
  try {
    ctx.ai.configure({ baseUrl: 'https://api.example.org/v1', model: 'model', apiKey: 'secret' });
    await assert.rejects(ctx.ai.testConnection(), (e: unknown) => e instanceof CareerError && e.code === 'ai_unavailable');
    assert.equal(requests, 0);
  } finally { ctx.db.close(); }
});

test('AI API requires explicit actions, keeps the key private, and never submits an application', async () => {
  let providerCalls = 0;
  let runnerCalls = 0;
  const ctx = setup({ sender: async () => { providerCalls++; return fakeResponse(providerCalls === 1 ? 'OK' : 'Brouillon de lettre à vérifier.'); } });
  const server = createServer(async (req, res) => {
    await handleCareerApi(req, res, new URL(req.url || '/', 'http://127.0.0.1'), {
      store: ctx.store, vault: ctx.vault, ai: ctx.ai,
      runner: { start() { runnerCalls++; throw new Error('unexpected application submit'); }, isBusy() { return false; }, async stop() {} },
      discovery: { async discover() { return { offers: [], note: '' }; } }, demo: false,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', csrf = true) => fetch(`${base}/api/career${path}`, { method, headers: { ...(csrf ? { 'X-Anima-Request': '1' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal(providerCalls, 0, 'no AI call occurs when an application is created or read');
    const forbidden = await call('/ai/config', { baseUrl: 'https://api.example.org/v1', model: 'model', apiKey: 'sk-private' }, 'POST', false);
    assert.equal(forbidden.status, 403);
    assert.equal(providerCalls, 0);

    const configured = await call('/ai/config', { baseUrl: 'https://api.example.org/v1', model: 'model', apiKey: 'sk-private' }, 'POST');
    assert.equal(configured.status, 200);
    assert.equal(JSON.stringify(await configured.json()).includes('sk-private'), false);
    const status = await call('/ai/config');
    assert.equal(status.status, 200);
    assert.equal(JSON.stringify(await status.json()).includes('sk-private'), false);
    assert.equal(providerCalls, 0, 'configuration and status do not call the provider');

    const tested = await call('/ai/test', {});
    assert.equal(tested.status, 200);
    assert.equal(providerCalls, 1);
    const drafted = await call('/ai/cover-letter', { applicationId: ctx.application.id });
    assert.equal(drafted.status, 200);
    assert.equal((await drafted.json() as { draft: string }).draft, 'Brouillon de lettre à vérifier.');
    const draftPath = `/applications/${ctx.application.id}/cover-letter-draft`;
    const loadedDraft = await call(draftPath);
    assert.equal((await loadedDraft.json() as { draft: { draft: string } }).draft.draft, 'Brouillon de lettre à vérifier.');
    const edited = await call(draftPath, { draft: 'Version personnelle modifiée.', model: 'model' }, 'PUT');
    assert.equal(edited.status, 200);
    assert.equal((await call(draftPath).then((response) => response.json()) as { draft: { draft: string } }).draft.draft, 'Version personnelle modifiée.');
    assert.equal((await call(draftPath, { draft: 'Écriture sans CSRF.' }, 'PUT', false)).status, 403);
    assert.equal((await call(draftPath, { draft: 'x'.repeat(12001) }, 'PUT')).status, 400);
    assert.equal(providerCalls, 2);
    assert.equal(runnerCalls, 0);
    assert.equal(ctx.store.getApplication(ctx.application.id).state, 'draft');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    ctx.db.close();
  }
});

