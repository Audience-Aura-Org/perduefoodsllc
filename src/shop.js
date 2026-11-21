import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { CartStore, priceCart, money } from './cart.js';
import { sendMail, templates } from './mailer.js';

export const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'],
  ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
  ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'],
  ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];
const STATE_CODES = new Set(US_STATES.map(([c]) => c));
const EMAIL_RE = /^[^\s@<>()[\],;:"]{1,64}@[^\s@<>()[\],;:"]{1,255}\.[a-z]{2,}$/i;
const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMultiline = (v, max = 1000) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const isoDay = (d) => d.toISOString().slice(0, 10);

/** Earliest delivery date we offer: two days out (frozen shipments need prep + transit). */
export const earliestDelivery = () => isoDay(new Date(Date.now() + 2 * 86400000));

/**
 * Validate and normalize the checkout form.
 * @returns {{ values: Record<string, any>, errors: Record<string, string> }}
 */
export function validateCheckout(body) {
  const v = {
    email: clean(body.email, 254).toLowerCase(),
    phone: clean(body.phone, 30),
    firstName: clean(body.firstName, 60), lastName: clean(body.lastName, 60), company: clean(body.company, 100),
    address1: clean(body.address1, 120), address2: clean(body.address2, 120), city: clean(body.city, 80),
    state: clean(body.state, 2).toUpperCase(), zip: clean(body.zip, 10),
    billingSame: body.billingSame === 'on' || body.billingSame === 'true' || body.billingSame === undefined && !body.billingAddress1,
    billingFirstName: clean(body.billingFirstName, 60), billingLastName: clean(body.billingLastName, 60),
    billingAddress1: clean(body.billingAddress1, 120), billingAddress2: clean(body.billingAddress2, 120), billingCity: clean(body.billingCity, 80),
    billingState: clean(body.billingState, 2).toUpperCase(), billingZip: clean(body.billingZip, 10),
    deliveryDate: clean(body.deliveryDate, 10), instructions: cleanMultiline(body.instructions, 500),
    isGift: body.isGift === 'on' || body.isGift === 'true', giftMessage: cleanMultiline(body.giftMessage, 300),
    marketing: body.marketing === 'on' || body.marketing === 'true',
  };
  const digits = v.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const e = {};
  if (!EMAIL_RE.test(v.email)) e.email = 'Enter a valid email address, like name@example.com.';
  if (digits.length !== 10) e.phone = 'Enter a 10-digit US phone number.';
  else v.phone = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (!v.firstName) e.firstName = 'Enter your first name.';
  if (!v.lastName) e.lastName = 'Enter your last name.';
  if (!v.address1) e.address1 = 'Enter your street address.';
  if (/\bP\.?\s*O\.?\s*Box\b/i.test(`${v.address1} ${v.address2}`)) e.address1 = 'We can’t deliver frozen orders to P.O. boxes. Please use a street address.';
  if (!v.city) e.city = 'Enter your city.';
  if (!STATE_CODES.has(v.state)) e.state = 'Choose your state.';
  if (!/^\d{5}(-\d{4})?$/.test(v.zip)) e.zip = 'Enter a 5-digit ZIP code.';
  if (!v.billingSame) {
    if (!v.billingFirstName) e.billingFirstName = 'Enter the billing first name.';
    if (!v.billingLastName) e.billingLastName = 'Enter the billing last name.';
    if (!v.billingAddress1) e.billingAddress1 = 'Enter the billing street address.';
    if (!v.billingCity) e.billingCity = 'Enter the billing city.';
    if (!STATE_CODES.has(v.billingState)) e.billingState = 'Choose the billing state.';
    if (!/^\d{5}(-\d{4})?$/.test(v.billingZip)) e.billingZip = 'Enter a 5-digit billing ZIP code.';
  }
  if (v.deliveryDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.deliveryDate) || v.deliveryDate < earliestDelivery()) e.deliveryDate = `Choose a date on or after ${earliestDelivery()}, or leave it blank for the earliest delivery.`;
  }
  return { values: v, errors: e };
}

const newOrderId = () => {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `PF-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

/**
 * Cart, checkout and order routes.
 * @param {{ catalog: import('./catalog.js').Catalog }} deps
 */
export function shop({ catalog }) {
  const carts = new CartStore({ file: config.shop.cartsFile, maxQty: config.shop.maxQtyPerItem });
  /** Recent orders for the confirmation page, keyed by id (owner = cart cookie). */
  const recent = new Map();
  const site = express.Router();
  const store = express.Router();
  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const qtyOf = (v) => Math.max(1, Math.min(config.shop.maxQtyPerItem, parseInt(v, 10) || 1));
  const summary = (id) => priceCart(carts.items(id), catalog, config.shop);
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  // ----- commerce endpoints the site's JavaScript calls -----
  const addResponse = (id, product, qty) => {
    const count = carts.count(id);
    return { error: false, message: `Added ${qty} × ${product.name} to your cart. <a href="/en-US/cart/" class="alert-link">View cart</a>`, quantityTotal: count, minicartCountOfItems: `Cart ${count} item${count === 1 ? '' : 's'}`, cart: { numItems: count } };
  };
  store.post('/Cart-AddProduct', form, (req, res) => {
    const product = catalog.get(req.body.pid);
    if (!product) return res.json({ error: true, message: 'Sorry, this product is no longer available.' });
    if (!product.orderable) return res.json({ error: true, message: 'Sorry, this product is currently sold out.' });
    const id = carts.idFor(req, res, true);
    const qty = qtyOf(req.body.quantity);
    carts.add(id, product.pid, qty);
    res.json(addResponse(id, product, qty));
  });
  // "Add to cart" links inside content blocks (POST via JS, or a plain link without JS).
  store.all('/Cart-AddProductToCartFromContentAsset', form, (req, res) => {
    const pid = req.body?.pid || req.query.pid;
    const product = catalog.get(pid);
    if (!product || !product.orderable) {
      return req.method === 'GET' ? res.redirect(302, product ? product.url : '/en-US/cart/') : res.json({ error: true, message: 'Sorry, this product is not available.' });
    }
    const id = carts.idFor(req, res, true);
    const qty = qtyOf(req.body?.qty || req.query.qty);
    carts.add(id, product.pid, qty);
    if (req.method === 'GET') return res.redirect(303, '/en-US/cart/');
    res.json({ ...addResponse(id, product, qty), redirectUrl: '/en-US/cart/' });
  });
  store.get('/Cart-MiniCartShow', noStore, (req, res) => res.render('partials/minicart', { cart: summary(carts.idFor(req, res)), money }));

  // ----- pages -----
  site.get('/api/cart', noStore, (req, res) => {
    const s = summary(carts.idFor(req, res));
    res.json({ count: s.count, subtotal: s.subtotal, total: s.total });
  });

  site.get(['/en-US/cart/', '/cart'], noStore, (req, res) => {
    res.render('cart', { title: 'Your Cart', cart: summary(carts.idFor(req, res)), money, shop: config.shop, notice: req.query.notice || '' });
  });
  site.post('/cart/update', form, (req, res) => {
    const id = carts.idFor(req, res);
    // `set` comes from the −/+ stepper buttons and wins over the typed quantity field.
    const qty = parseInt(req.body.set ?? req.body.quantity, 10) || 0;
    if (id && req.body.pid) carts.set(id, String(req.body.pid), req.body.remove ? 0 : Math.max(0, Math.min(config.shop.maxQtyPerItem, qty)));
    res.redirect(303, '/en-US/cart/');
  });

  const renderCheckout = (req, res, values, errors, status = 200) => {
    const cart = summary(carts.idFor(req, res));
    if (!cart.count) return res.redirect(303, '/en-US/cart/');
    res.status(status).render('checkout', { title: 'Checkout', cart, money, shop: config.shop, states: US_STATES, values, errors, minDate: earliestDelivery() });
  };
  site.get('/checkout', noStore, (req, res) => renderCheckout(req, res, { billingSame: true }, {}));

  site.post('/checkout', form, async (req, res, next) => {
    try {
      const id = carts.idFor(req, res);
      const cart = summary(id);
      if (!cart.count) return res.redirect(303, '/en-US/cart/');
      if (req.body.website) return res.redirect(303, '/en-US/cart/'); // honeypot: bots fill hidden fields
      const { values, errors } = validateCheckout(req.body);
      if (Object.keys(errors).length) return renderCheckout(req, res, values, errors, 422);

      const order = {
        id: newOrderId(), createdAt: new Date().toISOString(), status: 'received',
        customer: { firstName: values.firstName, lastName: values.lastName, email: values.email, phone: values.phone },
        shipping: { firstName: values.firstName, lastName: values.lastName, company: values.company, address1: values.address1, address2: values.address2, city: values.city, state: values.state, zip: values.zip },
        billing: values.billingSame ? 'same as shipping' : { firstName: values.billingFirstName, lastName: values.billingLastName, address1: values.billingAddress1, address2: values.billingAddress2, city: values.billingCity, state: values.billingState, zip: values.billingZip },
        delivery: { date: values.deliveryDate || 'Earliest available', instructions: values.instructions },
        gift: values.isGift ? { message: values.giftMessage } : null,
        marketingOptIn: values.marketing,
        items: cart.lines.map((l) => ({ pid: l.pid, name: l.product.name, qty: l.qty, price: l.product.price, total: l.total, url: l.product.url })),
        subtotal: cart.subtotal, shippingCost: cart.shipping, total: cart.total,
        payment: config.shop.paymentNote,
      };
      fs.mkdirSync(path.dirname(config.shop.ordersFile), { recursive: true });
      fs.appendFileSync(config.shop.ordersFile, JSON.stringify({ ...order, ip: req.ip }) + '\n');

      const [adminMail, customerMail] = await Promise.all([
        sendMail({ to: config.mail.to, replyTo: order.customer.email, ...templates.orderAdmin(order) }),
        sendMail({ to: order.customer.email, ...templates.orderCustomer(order) }),
      ]);
      order.emailed = { admin: adminMail.sent, customer: customerMail.sent };
      recent.set(order.id, { order, owner: id });
      if (recent.size > 500) recent.delete(recent.keys().next().value);
      carts.clear(id);
      res.redirect(303, `/checkout/confirmation/${order.id}`);
    } catch (err) { next(err); }
  });

  site.get('/checkout/confirmation/:id', noStore, (req, res, next) => {
    const entry = recent.get(req.params.id);
    // Only the browser that placed the order can view it.
    if (!entry || entry.owner !== carts.idFor(req, res)) return next();
    res.render('order-confirmation', { title: `Order ${entry.order.id}`, order: entry.order, money });
  });

  return { site, store, carts };
}
