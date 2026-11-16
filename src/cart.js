import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COOKIE = 'pf_cart';
const TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * Per-visitor carts keyed by an opaque random id in an HttpOnly cookie. Carts live in memory
 * and are persisted to a JSON file (debounced) so they survive restarts.
 */
export class CartStore {
  /** @param {{ file: string, maxQty: number }} opts */
  constructor({ file, maxQty }) {
    this.file = file;
    this.maxQty = maxQty;
    /** @type {Map<string, { items: { pid: string, qty: number }[], updated: number }>} */
    this.carts = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const now = Date.now();
      for (const [id, c] of Object.entries(raw)) if (now - c.updated < TTL_MS) this.carts.set(id, c);
    } catch { /* no saved carts yet */ }
  }

  #save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.carts)));
      } catch (err) { console.error('[cart] save failed:', err.message); }
    }, 500);
    this.timer.unref?.();
  }

  /** Cart id from the request cookie, creating (and setting) one when `create` is true. */
  idFor(req, res, create = false) {
    const m = /(?:^|;\s*)pf_cart=([a-f0-9]{32})/.exec(req.headers.cookie || '');
    if (m) return m[1];
    if (!create) return null;
    const id = crypto.randomBytes(16).toString('hex');
    res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', maxAge: TTL_MS, path: '/', secure: req.secure });
    return id;
  }

  items(id) { return id && this.carts.has(id) ? this.carts.get(id).items : []; }
  count(id) { return this.items(id).reduce((n, i) => n + i.qty, 0); }

  add(id, pid, qty) {
    const cart = this.carts.get(id) || { items: [], updated: 0 };
    const line = cart.items.find((i) => i.pid === pid);
    if (line) line.qty = Math.min(this.maxQty, line.qty + qty);
    else cart.items.push({ pid, qty: Math.min(this.maxQty, qty) });
    cart.updated = Date.now();
    this.carts.set(id, cart);
    this.#save();
  }

  set(id, pid, qty) {
    const cart = this.carts.get(id);
    if (!cart) return;
    cart.items = qty > 0
      ? cart.items.map((i) => (i.pid === pid ? { pid, qty: Math.min(this.maxQty, qty) } : i))
      : cart.items.filter((i) => i.pid !== pid);
    cart.updated = Date.now();
    this.#save();
  }

  clear(id) { if (id) { this.carts.delete(id); this.#save(); } }
}

/** Price a cart: lines with product data, subtotal, shipping and total. */
export function priceCart(items, catalog, shop) {
  const lines = items
    .map((i) => ({ ...i, product: catalog.get(i.pid) }))
    .filter((l) => l.product)
    .map((l) => ({ ...l, total: round(l.product.price * l.qty) }));
  const subtotal = round(lines.reduce((s, l) => s + l.total, 0));
  const shipping = !lines.length || subtotal >= shop.freeShippingMin ? 0 : shop.flatShipping;
  return {
    lines, subtotal, shipping, total: round(subtotal + shipping),
    count: lines.reduce((n, l) => n + l.qty, 0),
    toFreeShipping: lines.length && subtotal < shop.freeShippingMin ? round(shop.freeShippingMin - subtotal) : 0,
  };
}

export const round = (n) => Math.round(n * 100) / 100;
export const money = (n) => '$' + Number(n).toFixed(2);
