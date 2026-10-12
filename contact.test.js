import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleContact } from './_worker.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      const statement = (values = []) => ({ async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; } });
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
