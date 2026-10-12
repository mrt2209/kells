# Kells Advisory

The detailed v3 website for Kells Advisory, a new founder-led financial performance firm for owner-led construction and service businesses. The original editorial layout and financial argument are preserved, including the $43,200 labor-overrun example, six profit levers, 13-week cash planning scenario, improvement worklist, founder introduction and FAQs. All example numbers are fictional and labeled; there are no invented client results or testimonials.

## Website

`index.html` and the adjacent assets contain the website, favicon, privacy notice, confirmation page and assets. The site uses plain HTML, CSS and JavaScript with no framework, tracking scripts, external fonts or build dependencies. The contact address is **tom@categorii.com**.

## Cloudflare Pages deployment

1. In Cloudflare **Workers & Pages**, create a **Pages** project and connect `mrt2209/kells`.
2. Use production branch `main`, framework preset **None**, build command **`node build.mjs`**, build output directory **`dist`**, root directory left blank.
3. Create a D1 database named `kells-inquiries`. Run `schema.sql` in its console (or `npx wrangler d1 execute kells-inquiries --remote --file schema.sql` after configuring the database).
4. Under the Pages project's **Settings → Bindings**, add a D1 binding named **`INQUIRIES`** to that database for **production only**. Keep previews unbound, or give them a separate test database; the handler also rejects non-main Pages branches.
5. Redeploy after adding the binding. The contact form fails safely with an email fallback until storage is configured.
6. Test the live form and verify the row in D1; do not assume a deployed HTML page proves delivery. Connect the selected custom domain only when available.

The repository's `_worker.js` implements `/api/contact` using Pages advanced mode. The build copies it and `_routes.json` into `dist/`; `_routes.json` restricts function invocation to API routes. `_headers` applies security headers to static files; API responses set their own headers.

Cloudflare Pages uses dashboard configuration. The root `wrangler.jsonc` is deliberately a **Workers** configuration for the existing `kells` Worker, not a Pages configuration.

## Existing Cloudflare Worker

The existing `kells` Worker can deploy the same site without blocking Pages setup. It uses `_worker.js` and built `dist/` assets. Its build command is `node build.mjs` and deploy command is `npx wrangler deploy`. Add `INQUIRIES` to `d1_databases` in `wrangler.jsonc` using the real database ID before deployment. Do not deploy placeholder IDs. Keep Worker and Pages preview databases isolated from production.

## Contact form and email delivery

Valid inquiries are stored privately in D1. The form validates required fields and contact permission on the server, limits body size, rejects duplicate fields and cross-origin submissions, checks a honeypot, and applies atomic per-address and global hourly submission limits. It never displays success if saving fails. Raw IP addresses are not stored; short-lived hourly hashes are used for rate limits. There is no public inquiry-reading endpoint, and no credentials belong in this repository.

Review inquiries in the database console:

```sql
SELECT created_at, name, email, company, focus, message, notification_status
FROM inquiries ORDER BY created_at DESC LIMIT 50;
```

Email notifications require an email delivery service. The shared handler supports Resend. In Cloudflare runtime configuration set:

- `RESEND_API_KEY`: **secret**, supplied by the user; never commit it.
- `CONTACT_FROM`: a sender address on a domain verified in Resend.
- `CONTACT_EMAIL`: `tom@categorii.com` (this is also the default).

After enabling notifications, submit an explicitly labeled test inquiry and confirm both the D1 row and receipt in the destination inbox. Provider failure does not lose an inquiry: it remains in D1 with `notification_status='failed'`. Until a provider is configured, rows have `not_configured` and must be reviewed in D1. A provider accepting an email is not proof of inbox delivery.

Periodic cleanup removes records older than 90 days when a new inquiry is received; review retention manually during quiet periods. No financial records, account numbers or confidential customer information should be collected in this form. The privacy notice describes this limited inquiry collection.

## Local verification

Use Node.js 22.13+ (with `node:sqlite`) or Node.js 24+:

```text
npm test
npm run build
npm run dev
```

Tests use a real in-memory SQLite database for persistence and atomic submission limits, and cover validation, cross-site rejection, unavailable storage, oversized bodies, notification failure and confirmation routing. Local development uses Wrangler; no production credentials are needed. A static preview can show the layout but cannot receive inquiries.

## Launch accuracy

The founder biography is retained from the supplied v3 artifact. Confirm that its statements about strategic finance, forecasting, manufacturing operations, procurement and cost management are accurate before promoting the site. No profit improvement is guaranteed. The site promises a defined assessment and agreed fixed fee before paid work begins.
