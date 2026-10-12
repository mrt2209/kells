const EMAIL = 'tom@categorii.com';
const MAX_BODY = 16_384;
const FOCUS = new Set(['Not sure yet', 'Job margin and profitability', 'Pricing or estimating', 'Cash flow and financing scenarios', 'Hiring or growth decisions']);
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function reply(request, status, message, id) {
  if (request.headers.get('accept')?.includes('application/json')) {
    return Response.json({ ok: status < 400, message, ...(id ? { id } : {}) }, { status, headers: HEADERS });
  }
  if (status < 400) return new Response(null, { status: 303, headers: { ...HEADERS, Location: '/thank-you?received=1' } });
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inquiry not sent | Kells Advisory</title><body><h1>Your inquiry has not been sent.</h1><p>${message}</p><p><a href="mailto:${EMAIL}">Email ${EMAIL}</a> or <a href="/#contact">return to the form</a>.</p></body></html>`, { status, headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}

async function boundedBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new Error('too-large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('too-large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function field(form, key, max, required = false) {
  const values = form.getAll(key);
  if (values.length > 1) throw new Error('duplicate-field');
  const value = (values[0] || '').trim();
  if ((required && !value) || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new Error('invalid-field');
  return value;
}

export async function handleContact(request, env, dependencies = {}) {
  const notify = dependencies.fetch || fetch;
  const now = dependencies.now || Date.now;
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...HEADERS, Allow: 'POST' } });
  // Preview deployments must never write into a production inquiry database.
  if (env.CF_PAGES_BRANCH && env.CF_PAGES_BRANCH !== 'main') return reply(request, 503, 'Please use the main Kells website or email us directly.');
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') return reply(request, 403, 'Please submit the inquiry from the Kells website.');
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return reply(request, 415, 'The inquiry format was not accepted. Please try the website form.');
  if (!env.INQUIRIES) return reply(request, 503, 'The contact form is temporarily unavailable. Please email us directly.');

  let data;
  try {
    const form = new URLSearchParams(await boundedBody(request));
    if (field(form, 'website', 200)) return reply(request, 400, 'Please leave the website field blank.');
    const name = field(form, 'name', 120, true);
    const email = field(form, 'email', 200, true);
    const company = field(form, 'company', 180, true);
    const focus = field(form, 'focus', 100, true);
    const message = field(form, 'message', 1800);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\r\n]/.test(email) || !FOCUS.has(focus) || field(form, 'consent', 10, true) !== 'yes') throw new Error('invalid-field');
    const started = field(form, 'started', 20);
    if (started && (!/^\d{13}$/.test(started) || now() - Number(started) < 2000 || now() - Number(started) > 86_400_000)) throw new Error('invalid-time');
    data = { name, email, company, focus, message };
  } catch (error) {
    return reply(request, error.message === 'too-large' ? 413 : 400, error.message === 'too-large' ? 'The inquiry is too long. Please shorten it or email us.' : 'Please check the required fields, email address and contact permission, then try again.');
  }

  const id = crypto.randomUUID();
  try {
    const hour = Math.floor(now() / 3_600_000);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    // Rotate the hash every hour and never persist the raw IP address.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${hour}:${ip}`));
    const bucket = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2,'0')).join('');
    const limitSQL = 'INSERT INTO contact_rate_limits (bucket, count, expires_at) VALUES (?1,1,?2) ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count < ?3';
    const limits = await env.INQUIRIES.batch([
      env.INQUIRIES.prepare(limitSQL).bind(bucket, (hour+2)*3600, 5),
      env.INQUIRIES.prepare(limitSQL).bind(`global:${hour}`, (hour+2)*3600, 100)
    ]);
    if (limits.some(result => !result.success)) throw new Error('database-rate-error');
    if (limits.some(result => result.meta?.changes !== 1)) return reply(request, 429, 'Too many inquiries have been submitted recently. Please try again later or email us directly.');
    const saved = await env.INQUIRIES.prepare('INSERT INTO inquiries (id,name,email,company,focus,message) VALUES (?1,?2,?3,?4,?5,?6)').bind(id, data.name, data.email, data.company, data.focus, data.message).run();
    if (!saved.success || saved.meta?.changes !== 1) throw new Error('database-write-error');
  } catch {
    // Never log inquiry content, personal details or provider credentials.
    console.error('Kells inquiry persistence failed');
    return reply(request, 503, 'We could not save your inquiry. Please try again or email us directly.');
  }

  // Notification is optional. A saved lead survives provider failure.
  if (env.RESEND_API_KEY && env.CONTACT_FROM) {
    let status = 'failed';
    try {
      const result = await notify('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
        body: JSON.stringify({ from: env.CONTACT_FROM, to: [env.CONTACT_EMAIL || EMAIL], reply_to: data.email, subject: 'New Kells Advisory inquiry', text: `Name: ${data.name}\nEmail: ${data.email}\nCompany: ${data.company}\nFocus: ${data.focus}\n\n${data.message}\n\nInquiry reference: ${id}` }),
        signal: AbortSignal.timeout(8000)
      });
      status = result.ok ? 'sent' : 'failed';
    } catch { /* Inquiry is already stored. */ }
    try { await env.INQUIRIES.prepare('UPDATE inquiries SET notification_status=?1 WHERE id=?2').bind(status,id).run(); } catch { console.error('Kells notification status update failed'); }
  }
  try {
    await env.INQUIRIES.batch([
      env.INQUIRIES.prepare('DELETE FROM contact_rate_limits WHERE expires_at < ?1').bind(Math.floor(now()/1000)),
      env.INQUIRIES.prepare("DELETE FROM inquiries WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-90 days')")
    ]);
  } catch { console.error('Kells retention cleanup failed'); }
  return reply(request, 200, 'Your inquiry has been received.', id);
}



export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/api/contact') return handleContact(request, env);
    const response = await env.ASSETS.fetch(request);
    const secured = new Response(response.body, response);
    secured.headers.set('X-Content-Type-Options', 'nosniff');
    secured.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    secured.headers.set('X-Frame-Options', 'DENY');
    return secured;
  }
};
