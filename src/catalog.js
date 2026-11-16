import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} Product
 * @property {string} pid
 * @property {string} name
 * @property {number} price          Current (sale) price in USD.
 * @property {number|null} listPrice Original price when on sale.
 * @property {string} image          Root-relative image path.
 * @property {string} url            Product page route.
 * @property {boolean} orderable
 */

/** Product lookup built from the captured product pages (name, price, image, availability). */
export class Catalog {
  /** @param {import('./pages.js').PageRegistry} registry @param {string} viewsDir */
  constructor(registry, viewsDir) {
    this.registry = registry;
    this.viewsDir = viewsDir;
    /** @type {Map<string, Product|null>} */
    this.cache = new Map();
  }

  /** @param {string} pid @returns {Product|null} */
  get(pid) {
    pid = String(pid || '');
    if (this.cache.has(pid)) return this.cache.get(pid);
    const page = this.registry.byProduct.get(pid);
    let product = null;
    if (page && page.type === 'Product') {
      const html = fs.readFileSync(path.join(this.viewsDir, page.view + '.ejs'), 'utf8');
      const start = html.indexOf('class="container product-detail');
      const detail = start >= 0 ? html.slice(start, start + 60000) : html;
      const price = Number((detail.match(/class="sales"[\s\S]*?class="value" content="([\d.]+)"/) || [])[1]);
      const list = Number((detail.match(/class="strike-through list"[\s\S]*?class="value" content="([\d.]+)"/) || [])[1]);
      const image = (detail.match(/<img\b[^>]*\ssrc="(\/images\/products\/[^"]+)"/) || [])[1] || page.image || '/images/missing.svg';
      const available = !/data-available="false"/.test(detail.slice(0, 2000));
      // The on-page product heading reads better than the SEO <title>.
      const heading = ((detail.match(/class="product-name[^"]*"[^>]*>([\s\S]*?)<\//) || [])[1] || '')
        .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
      if (Number.isFinite(price) && price > 0) {
        product = { pid, name: heading || page.title, price, listPrice: Number.isFinite(list) && list > price ? list : null, image, url: page.route, orderable: available };
      }
    }
    this.cache.set(pid, product);
    return product;
  }
}
