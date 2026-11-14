import path from 'node:path';
import express from 'express';
import compression from 'compression';
import { ROOT, config } from './config.js';
import { PageRegistry } from './pages.js';
import { SearchIndex } from './search.js';
import { storeApi } from './store-api.js';
import { formHandlers } from './forms.js';
import { RefinementEngine, parseState, hasFilters } from './refinements.js';
const SEARCH_TYPES = ['Product', 'Recipe', 'Category', 'Recipe collection', 'Page'];

/**
 * Build the Express application.
 * @param {{ root?: string, production?: boolean }} [opts]
 */
export function createApp({ root = ROOT, production = config.production } = {}) {
  const viewsDir = path.join(root, 'views');
  const registry = new PageRegistry(path.join(root, 'data'));
  const search = new SearchIndex(registry.pages);
  const refinements = new RefinementEngine(path.join(root, 'data'));

  // Rendered category pages are the input for filtering and sorting; cache them in production.
  /** @type {Map<string, Promise<string>>} */
  const rendered = new Map();
  const renderPage = (req, page) => {
    if (production && rendered.has(page.route)) return rendered.get(page.route);
    const p = new Promise((resolve, reject) => req.app.render(page.view, (err, html) => (err ? reject(err) : resolve(html))));
    if (production) { rendered.set(page.route, p); p.catch(() => rendered.delete(page.route)); }
    return p;
  };

  const app = express();
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

  // Static assets. Images, fonts and files never change in place, so cache them for a week;
  // CSS/JS are edited by hand, so let browsers revalidate them.
  app.use(express.static(path.join(root, 'public'), {
    index: false,
    redirect: false,
    setHeaders(res, filePath) {
      const long = /[\\/](images|fonts|files)[\\/]/.test(filePath);
      res.set('Cache-Control', long ? 'public, max-age=604800' : 'no-cache');
    },
  }));

  // Commerce controller paths called by the site's JavaScript: real form handling (email via
  // Titan SMTP) first, then offline stand-ins for everything else.
  const STORE = '/on/demandware.store/Sites-Perdue_US-Site/en_US';
  app.use(STORE, formHandlers());
  app.use(STORE, storeApi({ registry, search, refinements, renderPage }));

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
      res.set('Cache-Control', 'no-cache');
      // Category URLs with filter/sort parameters (shared links, refresh, back button).
      if (page.cgid) {
        const state = parseState(req.query, page.cgid);
        if (hasFilters(state) || state.srule) {
          try { return res.type('html').send(refinements.apply(await renderPage(req, page), state, page.route)); } catch (err) { return next(err); }
        }
      }
      return res.render(page.view);
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
