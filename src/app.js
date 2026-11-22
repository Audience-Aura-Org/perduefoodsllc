import path from 'node:path';
import express from 'express';
import compression from 'compression';
import { ROOT, config } from './config.js';
import { PageRegistry } from './pages.js';
import { SearchIndex } from './search.js';
import { storeApi } from './store-api.js';
import { formHandlers } from './forms.js';
import { RefinementEngine, parseState, hasFilters } from './refinements.js';
import { Catalog } from './catalog.js';
import { shop } from './shop.js';
import { PageCache } from './page-cache.js';
const SEARCH_TYPES = ['Product', 'Recipe', 'Category', 'Recipe collection', 'Page'];

// Browser / CDN caching. Captured pages are the same for every visitor (the cart badge is
// fetched from /api/cart), so the CDN may cache them briefly and serve stale while refreshing.
const CACHE_PAGE = 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400';
// CSS/JS URLs aren't versioned, so browsers revalidate every load (cheap 304 via ETag)
// and design changes show up immediately instead of after a day.
const CACHE_CSS_JS = 'public, no-cache';
const CACHE_MEDIA = 'public, max-age=2592000, stale-while-revalidate=604800';

/**
 * Build the Express application.
 * @param {{ root?: string, production?: boolean }} [opts]
 */
export function createApp({ root = ROOT, production = config.production } = {}) {
  const viewsDir = path.join(root, 'views');
  const registry = new PageRegistry(path.join(root, 'data'));
  const search = new SearchIndex(registry.pages);
  const refinements = new RefinementEngine(path.join(root, 'data'));
  const catalog = new Catalog(registry, viewsDir);
  const commerce = shop({ catalog });

  const app = express();
  const renderView = (view) => new Promise((resolve, reject) => app.render(view, (err, html) => (err ? reject(err) : resolve(html))));

  // Raw HTML of category pages is the input for filtering and sorting. Keep a small LRU of
  // them in production (each is ~1 MB uncompressed).
  /** @type {Map<string, Promise<string>>} */
  const rendered = new Map();
  const RENDERED_MAX = 40;
  const renderPage = (req, page) => {
    if (production && rendered.has(page.route)) {
      const hit = rendered.get(page.route);
      rendered.delete(page.route); rendered.set(page.route, hit); // refresh LRU position
      return hit;
    }
    const p = renderView(page.view);
    if (production) {
      rendered.set(page.route, p);
      p.catch(() => rendered.delete(page.route));
      if (rendered.size > RENDERED_MAX) rendered.delete(rendered.keys().next().value);
    }
    return p;
  };

  // Fully rendered, pre-compressed pages (production only).
  const pageCache = new PageCache();
  app.locals.pageCache = pageCache;
  if (production) {
    // Warm the most visited pages in the background so first visits are fast too.
    const hot = registry.pages.filter((p) => p.route === '/' || p.type === 'Category' || /^\/en-US\/(recipes|contact-us|our-farms)\//.test(p.route)).map((p) => p.route);
    setTimeout(() => pageCache.warm(hot, (route) => renderView(registry.find(route).view)), 2000).unref();
  }
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.set('view engine', 'ejs');
  app.set('views', viewsDir);
  // Absolute includes (`include('/partials/header')`) resolve from /views.
  app.set('view options', { root: viewsDir });
  // Page templates are large; compile each once. Disabled in dev so edits show on refresh.
  app.set('view cache', production);
  app.locals.registry = registry;

  app.use(compression());
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });

  // Static assets: images, fonts and files for 30 days; CSS/JS for a day (edits reach
  // visitors within a day; browsers serve the cached copy instantly in between).
  app.use(express.static(path.join(root, 'public'), {
    index: false,
    redirect: false,
    setHeaders(res, filePath) {
      res.set('Cache-Control', /[\\/](images|fonts|files)[\\/]/.test(filePath) ? CACHE_MEDIA : CACHE_CSS_JS);
    },
  }));

  // Commerce controller paths called by the site's JavaScript: real form handling (email via
  // Titan SMTP) first, then offline stand-ins for everything else.
  const STORE = '/on/demandware.store/Sites-Perdue_US-Site/en_US';
  app.use(STORE, commerce.store);   // cart: add to cart, mini cart
  app.use(STORE, formHandlers());   // newsletter, contact, ambassador, opt-out
  app.use(STORE, storeApi({ registry, search, refinements, renderPage }));

  // Cart, checkout and order confirmation pages.
  app.use(commerce.site);

  app.get('/health', (req, res) => res.json({ ok: true, pages: registry.pages.length }));

  // SEO: robots.txt and an XML sitemap of every page. Absolute URLs use PUBLIC_URL when set,
  // otherwise the host the request came in on.
  const origin = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;
  app.get('/robots.txt', (req, res) => {
    res.type('text').send(`User-agent: *\nDisallow: /on/demandware.store/\nDisallow: /offline\nDisallow: /search\nDisallow: /api/\n\nSitemap: ${origin(req)}/sitemap.xml\n`);
  });
  app.get(['/sitemap.xml', '/sitemap_0.xml', '/sitemap_index.xml'], (req, res) => {
    const base = origin(req);
    const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const urls = registry.pages
      .filter((p) => !/^\/en-US\/(login|cart|optout-data-collection)\/$/.test(p.route))
      .map((p) => `  <url><loc>${xmlEsc(base + p.route)}</loc></url>`).join('\n');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  app.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    const type = SEARCH_TYPES.includes(String(req.query.type)) ? String(req.query.type) : '';
    const all = q ? search.search(q, { limit: 500 }) : [];
    const results = type ? all.filter((r) => r.type === type) : all;
    res.set('Cache-Control', 'no-cache');
    res.render('search', { title: q ? `Search results for "${q}"` : 'Search', q, type, results, types: SearchIndex.typesOf(all), total: all.length, action: 'Search-Show' });
  });

  app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    res.json({ q, results: q ? search.search(q, { limit: Math.min(Number(req.query.limit) || 20, 100) }) : [] });
  });

  app.get('/offline', (req, res) => {
    const from = String(req.query.from || '').slice(0, 300);
    res.status(200).render('offline', { title: 'Not available offline', from });
  });

  // Captured pages.
  app.get('*', async (req, res, next) => {
    const page = registry.find(req.path);
    if (page) {
      // Category URLs with filter/sort parameters (shared links, refresh, back button).
      if (page.cgid) {
        const state = parseState(req.query, page.cgid);
        if (hasFilters(state) || state.srule) {
          res.set('Cache-Control', 'no-cache');
          try { return res.type('html').send(refinements.apply(await renderPage(req, page), state, page.route)); } catch (err) { return next(err); }
        }
      }
      if (!production) { res.set('Cache-Control', 'no-cache'); return res.render(page.view); }
      res.set('Cache-Control', CACHE_PAGE);
      try { return await pageCache.send(req, res, await pageCache.get(page.route, () => renderView(page.view))); } catch (err) { return next(err); }
    }
    const target = registry.redirectFor(req.path);
    if (target) {
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(301, target + qs);
    }
    next();
  });

  app.use((req, res) => {
    res.status(404);
    if (req.accepts(['html', 'json']) === 'json') return res.json({ error: 'Not found' });
    res.render('not-found', { title: 'Page not found', path: req.path });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500);
    try {
      res.render('error', { title: 'Something went wrong', message: production ? '' : String(err && err.stack || err) });
    } catch {
      res.type('text').send('Internal Server Error');
    }
  });

  return app;
}
