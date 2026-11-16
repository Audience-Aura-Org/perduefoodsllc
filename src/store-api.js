import express from 'express';
import { parseGrid, renderSortedGrid } from './product-grid.js';
import { parseState, hasFilters } from './refinements.js';

/**
 * Offline stand-ins for the Salesforce Commerce Cloud controller endpoints that the
 * site's client JavaScript (main.js, productDetail.js, search.js) calls.
 *
 * Read-only features (search suggestions, category filters and sorting) are answered from
 * local data. The cart lives in shop.js and form posts in forms.js; both are mounted before
 * this router.
 */

const SIGN_IN_MESSAGE = 'Accounts aren’t available on this site. You can check out as a guest: add items to your cart and choose Checkout.';

/** @param {string} s */
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * @param {{
 *   registry: import('./pages.js').PageRegistry,
 *   search: import('./search.js').SearchIndex,
 *   refinements: import('./refinements.js').RefinementEngine,
 *   renderPage: (req: import('express').Request, page: import('./pages.js').PageEntry) => Promise<string>,
 * }} deps
 */
export function storeApi({ registry, search, refinements, renderPage }) {
  const router = express.Router();

  // Header search-as-you-type dropdown.
  router.get('/SearchServices-GetSuggestions', (req, res) => {
    const q = String(req.query.q || '').trim();
    const results = q.length >= 2 ? search.search(q, { limit: 8 }) : [];
    if (!results.length) return res.type('html').send('');
    const groups = ['Product', 'Recipe', 'Category', 'Recipe collection', 'Page']
      .map((type) => [type, results.filter((r) => r.type === type)])
      .filter(([, items]) => items.length);
    const html = `<div class="suggestions offline-suggestions"><div class="container">${groups.map(([type, items]) => `
      <div class="row justify-content-end header"><div class="col-12">${escapeHtml(type === 'Recipe collection' ? 'Recipe collections' : type + 's')}</div></div>
      <div class="row items">${items.map((p) => `
        <div class="col-12 item"><a href="${escapeHtml(p.route)}">${p.image ? `<img class="swatch-circle" src="${escapeHtml(p.image)}" alt="" loading="lazy" width="40" height="40">` : ''}<span class="name">${escapeHtml(p.title)}</span></a></div>`).join('')}
      </div>`).join('')}
      <div class="row items"><div class="col-12 item more-below-link"><a href="/search?q=${encodeURIComponent(q)}">See all results for "${escapeHtml(q)}"</a></div></div>
    </div></div>`;
    res.type('html').send(html);
  });

  // Category filters: the client swaps the returned page's result sections into the page.
  router.get('/Search-ShowAjax', async (req, res, next) => {
    const page = registry.byCategory.get(String(req.query.cgid || ''));
    if (!page) return res.status(404).type('html').send('');
    try {
      const html = await renderPage(req, page);
      const state = parseState(req.query, page.cgid);
      res.type('html').send(hasFilters(state) || state.srule ? refinements.apply(html, state, page.route) : html);
    } catch (err) { next(err); }
  });

  // Sorting (the sort <select>) and "show more" pagination. Every product is already on the
  // page, so pagination adds nothing; sorting re-orders the (filtered) tiles.
  router.get('/Search-UpdateGrid', async (req, res, next) => {
    const start = Number(req.query.start) || 0;
    const page = registry.byCategory.get(String(req.query.cgid || ''));
    if (!page || start > 0) return res.type('html').send('');
    try {
      const grid = parseGrid(await renderPage(req, page));
      if (!grid) return res.type('html').send('');
      const state = parseState(req.query, page.cgid);
      res.type('html').send(renderSortedGrid(grid, state.srule, refinements.filterTiles(grid.tiles, state)));
    } catch (err) { next(err); }
  });

  // Variant/quantity re-pricing needs the commerce back end. Answer with an error status so
  // the client takes its error path (stops the spinner, keeps the server-rendered product).
  router.all('/Product-Variation', (req, res) => res.status(503).json({ error: true, offline: true, message: 'Live price updates are not available; the listed price applies.' }));
  // Login / account forms post here; there is no account system offline.
  router.post(/^\/(Account-Login|Account-SubmitRegistration|Account-PasswordResetDialogForm)$/, (req, res) =>
    res.json({ success: false, error: [SIGN_IN_MESSAGE], msg: SIGN_IN_MESSAGE }));
  router.post('/Order-Track', (req, res) => res.redirect(303, '/offline?from=' + encodeURIComponent('Order tracking')));

  // Links that use controller URLs instead of page URLs (e.g. …/ContactUs-Show): redirect to
  // the local page so navigation never dead-ends.
  const SHOW_ROUTES = {
    'Login-Show': '/en-US/login/', 'Account-Show': '/en-US/login/', 'Order-History': '/en-US/login/',
    'ContactUs-Show': '/en-US/contact-us/', 'Farms-Show': '/en-US/our-farms/', 'Cart-Show': '/en-US/cart/',
    'AmbassadorProgram-Show': '/en-US/ambassador-program/', 'OptoutDataCollection-Show': '/en-US/optout-data-collection/',
  };
  router.get('/:action', (req, res, next) => {
    const { action } = req.params;
    const exists = (route) => route && (route === '/en-US/cart/' || registry.find(route.split('?')[0]));
    if (SHOW_ROUTES[action] && exists(SHOW_ROUTES[action])) return res.redirect(302, SHOW_ROUTES[action]);
    if (action === 'Search-Show') {
      if (req.query.q) return res.redirect(302, '/search?q=' + encodeURIComponent(String(req.query.q)));
      const page = registry.byCategory.get(String(req.query.cgid || ''));
      if (page) {
        const qs = new URLSearchParams(Object.entries(req.query).filter(([k]) => /^(prefn\d+|prefv\d+|pmin|pmax|srule)$/.test(k)).map(([k, v]) => [k, String(v)])).toString();
        return res.redirect(302, page.route + (qs ? '?' + qs : ''));
      }
    }
    if (action === 'Product-Show' || action === 'Cart-AddProductToCartFromContentAsset') {
      const page = registry.byProduct.get(String(req.query.pid || ''));
      if (page) return res.redirect(302, page.route);
    }
    next();
  });

  router.all('*', (req, res) => {
    // A browser navigating to an unsupported store page gets the offline notice; scripts get JSON.
    if (req.method === 'GET' && req.accepts(['json', 'html']) === 'html') return res.redirect(302, '/offline?from=' + encodeURIComponent(req.path.replace(/^\//, '')));
    res.status(404).json({ error: true, offline: true, message: 'This store feature is not available offline.' });
  });
  return router;
}
