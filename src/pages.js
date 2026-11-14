import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} PageEntry
 * @property {string} route        Public URL path, e.g. "/en-US/farm-fresh-chicken/".
 * @property {string} view         EJS view name relative to /views, e.g. "pages/en-US/farm-fresh-chicken/index".
 * @property {'Product'|'Recipe'|'Category'|'Recipe collection'|'Page'} type
 * @property {string} title
 * @property {string} description
 * @property {string} image        Root-relative thumbnail path, or "".
 * @property {string} [cgid]       Commerce category id (category pages).
 * @property {string} [pid]        Commerce product id (product and recipe pages).
 */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', trade: '™', reg: '®', copy: '©', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', frac12: '½', frac14: '¼', frac34: '¾', eacute: 'é', egrave: 'è', ntilde: 'ñ', times: '×' };

/**
 * Titles and descriptions come from HTML attributes and are entity-encoded. Decode them
 * once here so templates can escape them exactly once.
 * @param {string} s
 */
export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Loads the page manifest and redirect table and answers route lookups. */
export class PageRegistry {
  /** @param {string} dataDir */
  constructor(dataDir) {
    /** @type {PageEntry[]} */
    this.pages = JSON.parse(fs.readFileSync(path.join(dataDir, 'pages.json'), 'utf8'))
      .map((p) => ({ ...p, title: decodeEntities(p.title), description: decodeEntities(p.description) }));
    /** @type {Record<string, string>} */
    this.redirects = JSON.parse(fs.readFileSync(path.join(dataDir, 'redirects.json'), 'utf8'));
    this.byRoute = new Map(this.pages.map((p) => [p.route, p]));
    this.byCategory = new Map(this.pages.filter((p) => p.cgid).map((p) => [p.cgid, p]));
    this.byProduct = new Map(this.pages.filter((p) => p.pid).map((p) => [p.pid, p]));
  }

  /** @param {string} route */
  find(route) {
    return this.byRoute.get(route);
  }

  /**
   * Where a request for `pathname` should be redirected, or null when no redirect applies.
   * Handles crawl-time aliases, legacy `.html` index files and missing trailing slashes.
   * @param {string} pathname
   */
  redirectFor(pathname) {
    if (this.redirects[pathname]) return this.redirects[pathname];
    if (pathname === '/en-US' || pathname === '/en-US/' || pathname === '/index.html') return '/';
    if (pathname.endsWith('/index.html')) {
      const dir = pathname.slice(0, -'index.html'.length);
      if (this.byRoute.has(dir)) return dir;
    }
    if (!pathname.endsWith('/') && !path.extname(pathname) && this.byRoute.has(pathname + '/')) return pathname + '/';
    if (pathname === '/offline.html') return '/offline';
    if (pathname === '/search.html') return '/search';
    return null;
  }
}
