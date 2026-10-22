import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleContact, handleInquiryList, signInquiry } from './_worker.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      const statement = (values = []) => ({ async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; }, async all() { return { success: true, results: sqlite.prepare(sql).all(...values) }; } });
      return { ...statement(), bind(...values) { return statement(values); } };
    },
    async batch(statements) { sqlite.exec('BEGIN'); try { const out = []; for (const statement of statements) out.push(await statement.run()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }
  };
  return { db, sqlite };
}
const valid = { name: 'Test owner', email: 'owner@example.com', company: 'Example service company', focus: 'Job margin and profitability', message: 'Local automated test only.', consent: 'yes' };
function request(fields = valid, headers = {}, method = 'POST') {
  return new Request('https://kells.example/api/contact', { method, headers: { origin: 'https://kells.example', accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '192.0.2.1', ...headers }, ...(method === 'POST' ? { body: new URLSearchParams(fields) } : {}) });
}
test('valid submission persists exactly one inquiry before reporting success', async () => {
  const { db, sqlite } = database(); const response = await handleContact(request(), { INQUIRIES: db });
  assert.equal(response.status, 200); const payload = await response.json(); assert.equal(payload.ok, true);
  assert.equal(sqlite.prepare('SELECT email FROM inquiries WHERE id=?').get(payload.id).email, valid.email);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('missing storage never reports success', async () => { assert.equal((await handleContact(request(), {})).status,503); });
test('database failure never reports success', async () => { assert.equal((await handleContact(request(), { INQUIRIES: { prepare() { throw new Error('offline'); } } })).status,503); });
test('cross-site requests and non-POST requests are rejected', async () => {
  assert.equal((await handleContact(request(valid,{origin:'https://other.example'}), {})).status,403);
  assert.equal((await handleContact(request(valid,{},'GET'), {})).status,405);
});
test('invalid email, missing permission, honeypot and duplicate fields are rejected', async () => {
  const { db, sqlite } = database();
  for (const fields of [{...valid,email:'bad'}, {...valid,consent:''}, {...valid,website:'bot'}]) {
    assert.equal((await handleContact(request(fields), { INQUIRIES: db })).status,400);
  }
  const dup = request(); const text = await dup.text();
  assert.equal((await handleContact(new Request(dup.url,{method:'POST',headers:dup.headers,body:text+'&name=second'}),{INQUIRIES:db})).status,400);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM inquiries').get().n,0);
});
test('body-size limits hold even without a content-length header', async () => {
  const { db } = database(); assert.equal((await handleContact(request({...valid,message:'x'.repeat(20000)}),{INQUIRIES:db})).status,413);
});
test('atomic hourly limit allows five inquiries and rejects the sixth', async () => {
  const { db, sqlite } = database(); for (let i=0;i<5;i++) assert.equal((await handleContact(request(),{INQUIRIES:db})).status,200);
  assert.equal((await handleContact(request(),{INQUIRIES:db})).status,429);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM inquiries').get().n,5);
  assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM contact_rate_limits').all()).includes('192.0.2.1'),false);
});
test('email failure preserves inquiry and records failed notification', async () => {
  const { db, sqlite } = database();
  const response = await handleContact(request(),{INQUIRIES:db,RESEND_API_KEY:'local-test-key',CONTACT_FROM:'test@example.com'}, { fetch: async () => new Response(null,{status:500}) });
  assert.equal(response.status,200); assert.equal(sqlite.prepare('SELECT notification_status FROM inquiries').get().notification_status,'failed');
});
test('plain HTML submission redirects only after persistence; preview writes are disabled', async () => {
  const { db, sqlite } = database(); const result = await handleContact(request(valid,{accept:'text/html'}),{INQUIRIES:db});
  assert.equal(result.status,303); assert.equal(result.headers.get('location'),'/thank-you?received=1');
  assert.equal((await handleContact(request(),{INQUIRIES:db,CF_PAGES_BRANCH:'preview'})).status,503);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM inquiries').get().n,1);
});

// Delivery to the CRM and the CRM's pull endpoint.
const SECRET = 'local-test-secret';
test('signatures match the shared test vector the CRM checks too', async () => {
  assert.equal(await signInquiry('test-secret', 'push', '1700000000', '{"id":"x"}'), '07f020345b1df1e87a24886456fab90cb40e177fcb3982e8b210a847a6495996');
  assert.equal(await signInquiry('test-secret', 'pull', '1700000000', '2026-10-01T00:00:00Z'), 'de6fd826701e99babb64fc669fff42d906b0f2de9dd8a15b0fe7ee0263a1d7a5');
});
test('a saved inquiry is pushed to the CRM, signed, off the response path', async () => {
  const { db, sqlite } = database(); const calls = []; const pending = [];
  const response = await handleContact(request(), { INQUIRIES: db, SITE_INQUIRY_SECRET: SECRET, CRM_INQUIRY_URL: 'https://crm.example/hook' },
    { fetch: async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); }, waitUntil: promise => pending.push(promise) });
  assert.equal(response.status, 200); assert.equal(pending.length, 1); assert.equal(await pending[0], 'delivered');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://crm.example/hook');
  const sent = JSON.parse(calls[0].init.body); const row = sqlite.prepare('SELECT * FROM inquiries').get();
  assert.match(sent.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual({ id: sent.id, created_at: sent.created_at, email: sent.email, focus: sent.focus }, { id: row.id, created_at: row.created_at, email: row.email, focus: row.focus });
  const timestamp = calls[0].init.headers['X-Kells-Timestamp'];
  assert.equal(calls[0].init.headers['X-Kells-Signature'], 'v1=' + await signInquiry(SECRET, 'push', timestamp, calls[0].init.body));
});
test('without a secret nothing is pushed, and a CRM failure never fails the visitor', async () => {
  const { db } = database(); let called = 0;
  assert.equal((await handleContact(request(), { INQUIRIES: db }, { fetch: async () => { called++; return new Response(null, { status: 200 }); } })).status, 200);
  assert.equal(called, 0);
  const failing = await handleContact(request(), { INQUIRIES: db, SITE_INQUIRY_SECRET: SECRET }, { fetch: async () => { throw new Error('crm asleep'); } });
  assert.equal(failing.status, 200);
});
async function pull(env, { since = '', timestamp = String(Math.floor(Date.now() / 1000)), secret = SECRET, method = 'GET' } = {}) {
  const signature = 'v1=' + await signInquiry(secret, 'pull', timestamp, since);
  const url = 'https://kells.example/api/inquiries' + (since ? '?since=' + encodeURIComponent(since) : '');
  return handleInquiryList(new Request(url, { method, headers: { 'x-kells-timestamp': timestamp, 'x-kells-signature': signature } }), env);
}
test('the pull endpoint is hidden without a secret and refuses unsigned, stale or wrongly signed requests', async () => {
  const { db } = database();
  assert.equal((await pull({ INQUIRIES: db })).status, 404);
  const env = { INQUIRIES: db, SITE_INQUIRY_SECRET: SECRET };
  assert.equal((await handleInquiryList(new Request('https://kells.example/api/inquiries'), env)).status, 401);
  assert.equal((await pull(env, { secret: 'wrong-secret' })).status, 401);
  assert.equal((await pull(env, { timestamp: String(Math.floor(Date.now() / 1000) - 600) })).status, 401);
  assert.equal((await pull(env, { since: '2026-10-01T00:00:00Z', timestamp: '1700000000' })).status, 401);
  assert.equal((await pull(env, { method: 'POST' })).status, 405);
  assert.equal((await pull({ ...env, CF_PAGES_BRANCH: 'preview' })).status, 404);
});
test('a signed pull returns inquiries since the given time, newest first', async () => {
  const { db, sqlite } = database();
  const insert = sqlite.prepare('INSERT INTO inquiries (id, created_at, name, email, company, focus, message) VALUES (?,?,?,?,?,?,?)');
  insert.run('old', '2026-09-01T10:00:00Z', 'Old', 'old@example.com', 'Old Co', 'Not sure yet', '');
  insert.run('a', '2026-10-02T10:00:00Z', 'A', 'a@example.com', 'A Co', 'Not sure yet', 'first');
  insert.run('b', '2026-10-03T10:00:00Z', 'B', 'b@example.com', 'B Co', 'Pricing or estimating', 'second');
  const response = await pull({ INQUIRIES: db, SITE_INQUIRY_SECRET: SECRET }, { since: '2026-10-01T00:00:00Z' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.deepEqual(payload.inquiries.map(row => row.id), ['b', 'a']);
  assert.equal('notification_status' in payload.inquiries[0], false);
  assert.equal((await pull({ INQUIRIES: db, SITE_INQUIRY_SECRET: SECRET }, { since: 'yesterday' })).status, 400);
});
test('a secret pasted with stray whitespace still signs like the trimmed one the CRM uses', async () => {
  const { db } = database(); const calls = [];
  await handleContact(request(), { INQUIRIES: db, SITE_INQUIRY_SECRET: '  ' + SECRET + '\n' }, { fetch: async (url, init) => { calls.push(init); return new Response('{}', { status: 200 }); } });
  assert.equal(calls[0].headers['X-Kells-Signature'], 'v1=' + await signInquiry(SECRET, 'push', calls[0].headers['X-Kells-Timestamp'], calls[0].body));
  assert.equal((await pull({ INQUIRIES: db, SITE_INQUIRY_SECRET: SECRET + '\n' })).status, 200);
});
