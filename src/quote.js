import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { sendMail, templates } from './mailer.js';
import { record } from './forms.js';

export const QUOTE_ROUTE = '/en-US/request-quote/';

const EMAIL_RE = /^[^\s@<>()[\],;:"]{1,64}@[^\s@<>()[\],;:"]{1,255}\.[a-z]{2,}$/i;
const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMultiline = (v, max = 2000) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);

/**
 * Products sold by quote (no online price): the hand-added products in
 * data/added-products.json that have no `price`.
 * @param {string} dataDir
 * @param {import('./pages.js').PageRegistry} registry
 */
export function quoteProducts(dataDir, registry) {
  const file = path.join(dataDir, 'added-products.json');
  const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).products || [] : [];
  /** @type {Map<string, { pid: string, name: string, short: string, url: string, image: string }>} */
  const map = new Map();
  for (const p of list) {
    if (p.price != null) continue;
    const page = registry.byProduct.get(p.pid);
    if (page) map.set(p.pid, { pid: p.pid, name: p.name, short: p.short, url: page.route, image: page.image });
  }
  return map;
}

/** Validate a quote request. @returns {{ values: Record<string, string>, errors: Record<string, string> }} */
export function validateQuote(body) {
  const v = {
    pid: clean(body.pid, 40), firstName: clean(body.firstName, 60), lastName: clean(body.lastName, 60), company: clean(body.company, 100),
    email: clean(body.email, 254).toLowerCase(), phone: clean(body.phone, 30), quantity: clean(body.quantity, 100), zip: clean(body.zip, 10),
    message: cleanMultiline(body.message, 2000),
  };
  const e = {};
  if (!v.firstName) e.firstName = 'Enter your first name.';
  if (!v.lastName) e.lastName = 'Enter your last name.';
  if (!EMAIL_RE.test(v.email)) e.email = 'Enter a valid email address, like name@example.com.';
  const digits = v.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length !== 10) e.phone = 'Enter a 10-digit US phone number.';
  else v.phone = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (!v.quantity) e.quantity = 'Tell us how much you need, for example “40 lb” or “10 cases”.';
  if (!/^\d{5}(-\d{4})?$/.test(v.zip)) e.zip = 'Enter the 5-digit delivery ZIP code.';
  return { values: v, errors: e };
}

/**
 * Request-a-quote page: GET shows the form (optionally for one product), POST validates,
 * logs the request, emails the sales inbox and the customer, then shows a thank-you.
 * @param {{ products: ReturnType<typeof quoteProducts> }} deps
 */
export function quoteRoutes({ products }) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  // Per-IP limit; answered with the form page, not JSON, since this is a plain HTML form.
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  const limited = (ip) => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > config.formRateLimit; };

  const render = (res, { product, values = {}, errors = {}, sent = false, status = 200 }) =>
    res.status(status).render('quote', { title: product ? `Request a Quote: ${product.name}` : 'Request a Quote', product, products: [...products.values()], values, errors, sent });

  router.get([QUOTE_ROUTE, '/request-quote'], noStore, (req, res) => {
    const product = products.get(String(req.query.pid || '')) || null;
    render(res, { product, values: { pid: product ? product.pid : '' }, sent: req.query.sent === '1' });
  });

  router.post([QUOTE_ROUTE, '/request-quote'], form, async (req, res, next) => {
    try {
      if (req.body.website) return res.redirect(303, QUOTE_ROUTE + '?sent=1'); // honeypot: bots fill hidden fields
      const { values, errors } = validateQuote(req.body);
      const product = products.get(values.pid) || null;
      if (!product) values.pid = '';
      if (limited(req.ip)) errors.form = 'Too many requests from your connection. Please wait a minute and try again.';
      if (Object.keys(errors).length) return render(res, { product, values, errors, status: 422 });

      const origin = config.publicUrl || `${req.protocol}://${req.get('host')}`;
      const quote = { ...values, product: product && { ...product, pageUrl: origin + product.url } };
      record('quote', { ...values, product: product ? product.name : '', ip: req.ip });
      await sendMail({ to: config.mail.to, replyTo: values.email, ...templates.quoteAdmin(quote) });
      if (config.mail.sendConfirmations) await sendMail({ to: values.email, ...templates.quoteConfirmation(quote) });
      res.redirect(303, `${QUOTE_ROUTE}?sent=1${product ? `&pid=${encodeURIComponent(product.pid)}` : ''}`);
    } catch (err) { next(err); }
  });

  return router;
}
