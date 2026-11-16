import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Tests must never send real email or touch the real submissions log: blank the SMTP
// settings (process.loadEnvFile does not override variables that are already set).
const SUBMISSIONS = path.join(os.tmpdir(), `perdue-test-submissions-${process.pid}.jsonl`);
const ORDERS = path.join(os.tmpdir(), `perdue-test-orders-${process.pid}.jsonl`);
const CARTS = path.join(os.tmpdir(), `perdue-test-carts-${process.pid}.json`);
Object.assign(process.env, { SMTP_USER: '', SMTP_PASS: '', MAIL_TO: '', SUBMISSIONS_FILE: SUBMISSIONS, ORDERS_FILE: ORDERS, CARTS_FILE: CARTS, FORM_RATE_LIMIT: '100' });
const { createApp } = await import('../src/app.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pages.json'), 'utf8'));
const redirects = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'redirects.json'), 'utf8'));

let server, base;
before(async () => {
  const app = createApp({ production: true });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => { for (const f of [SUBMISSIONS, ORDERS, CARTS]) fs.rmSync(f, { force: true }); server.close(resolve); }));

const get = (p, opts) => fetch(base + p, { redirect: 'manual', ...opts });

test('home page renders with shared header and footer', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Buy Chicken, Pork, Steaks/);
  assert.match(html, /<header>/);
  assert.match(html, /id="footercontent"/);
  assert.doesNotMatch(html, /<%/, 'no unrendered EJS');
});

test('legacy and alias URLs redirect permanently', async () => {
  for (const [from, to] of [['/index.html', '/'], ['/en-US/', '/'], ['/en-US/farm-fresh-chicken', '/en-US/farm-fresh-chicken/'], ['/en-US/farm-fresh-chicken/index.html', '/en-US/farm-fresh-chicken/'], ['/search.html?q=ham', '/search?q=ham'], ...Object.entries(redirects).slice(0, 5)]) {
    const res = await get(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
  }
});

test('unknown pages return a branded 404', async () => {
  const res = await get('/en-US/does-not-exist.html');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /couldn’t find that page/);
  const api = await get('/nope', { headers: { accept: 'application/json' } });
  assert.equal(api.status, 404);
});

test('server-side search ranks products and filters by type', async () => {
  const res = await get('/search?q=chicken+wings');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /class="offline-results"/);
  const recipes = await (await get('/search?q=wings&type=Recipe')).text();
  assert.match(recipes, /offline-type">Recipe</);
  assert.doesNotMatch(recipes, /offline-type">Product</);
  const fryer = await (await get('/search?q=air+fryer+wings')).text();
  assert.doesNotMatch(fryer, /&amp;(trade|ndash|amp);/, 'entities are not double-escaped');
  const xss = await (await get('/search?q=%3Cscript%3Ealert(1)%3C/script%3E')).text();
  assert.doesNotMatch(xss, /<script>alert\(1\)<\/script>/, 'query is escaped');
});

test('JSON search API', async () => {
  const body = await (await get('/api/search?q=ham&limit=3')).json();
  assert.equal(body.q, 'ham');
  assert.ok(body.results.length > 0 && body.results.length <= 3);
  assert.ok(body.results.every((r) => r.route && r.title));
});

test('offline commerce endpoints answer in the shapes the client expects', async () => {
  const store = '/on/demandware.store/Sites-Perdue_US-Site/en_US';
  const sugg = await get(`${store}/SearchServices-GetSuggestions?q=ham`);
  assert.equal(sugg.status, 200);
  assert.match(await sugg.text(), /class="suggestions/);
  const cart = await (await get(`${store}/Cart-AddProduct`, { method: 'POST' })).json();
  assert.equal(cart.error, true);
  assert.match(cart.message, /no longer available/i); // no pid: nothing is added
  const cat = pages.find((p) => p.cgid);
  const grid = await get(`${store}/Search-ShowAjax?cgid=${encodeURIComponent(cat.cgid)}&srule=price-low-to-high`);
  assert.equal(grid.status, 200);
  assert.match(await grid.text(), /product-grid|search-results/);
  assert.equal((await get(`${store}/Product-Variation?pid=1`)).status, 503);
  assert.equal((await get(`${store}/Unknown-Endpoint`)).status, 404);
});

test('category sort re-orders the captured product tiles', async () => {
  const store = '/on/demandware.store/Sites-Perdue_US-Site/en_US';
  const prices = (html) => [...html.matchAll(/class="sales"[\s\S]*?class="value" content="([\d.]+)"/g)].map((m) => Number(m[1]));
  const low = await (await get(`${store}/Search-UpdateGrid?cgid=chicken&srule=price-low-to-high&start=0&sz=51`)).text();
  const high = await (await get(`${store}/Search-UpdateGrid?cgid=chicken&srule=price-high-to-low&start=0&sz=51`)).text();
  const asc = prices(low), desc = prices(high);
  assert.ok(asc.length > 5, 'grid has priced tiles');
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
  assert.equal(asc.length, desc.length);
  // pagination beyond the first page has nothing more to add
  assert.equal(await (await get(`${store}/Search-UpdateGrid?cgid=chicken&start=51&sz=51`)).text(), '');
});

test('no rendered page points the browser at the live site for scripts, styles, images or store calls', async () => {
  for (const route of ['/', '/en-US/farm-fresh-chicken/', '/en-US/niman-ranch-uncured-quarter-ham/25117.html']) {
    const html = await (await get(route)).text();
    // id="shareUrl" deliberately keeps the public URL: it is what social share buttons post.
    const withoutShare = html.replace(/<input type="hidden" id="shareUrl" value="[^"]*"/g, '');
    assert.doesNotMatch(withoutShare, /(src|srcset|value|action)="https:\/\/www\.perduefarms\.com/, route);
    assert.doesNotMatch(html, /<script\b[^>]*\ssrc="https?:\/\//, route);
    // rel="canonical"/"alternate" only describe the public URL; they are never fetched.
    assert.doesNotMatch(html, /<link\b(?![^>]*rel="(canonical|alternate)")[^>]*\shref="https?:\/\//, route);
  }
});

test('category filters: attribute and price refinements narrow the grid and can be combined', async () => {
  const store = '/on/demandware.store/Sites-Perdue_US-Site/en_US';
  // only products inside the result grid (category pages also have recommendation carousels)
  const gridOf = (html) => {
    const start = html.search(/<div class="row product-grid\b/);
    const end = html.indexOf('class="col-12 grid-footer"', start);
    return html.slice(start, end < 0 ? undefined : end);
  };
  const pidsOf = (html) => [...gridOf(html).matchAll(/<div class="product product--[^"]*"\s+data-pid="([^"]+)"/g)].map((m) => m[1]);
  const countOf = (html) => Number((html.match(/<span class="results-count">\s*(\d+)/) || [])[1]);
  const all = await (await get('/en-US/farm-fresh-chicken/')).text();
  const organic = await (await get(`${store}/Search-ShowAjax?cgid=chicken&prefn1=valueAttributes&prefv1=organic`)).text();
  const cheap = await (await get(`${store}/Search-ShowAjax?cgid=chicken&pmin=0%2e00&pmax=15%2e00`)).text();
  const both = await (await get(`${store}/Search-ShowAjax?cgid=chicken&prefn1=valueAttributes&prefv1=organic&pmin=0%2e00&pmax=15%2e00`)).text();
  const nAll = pidsOf(all).length, nOrg = pidsOf(organic).length, nCheap = pidsOf(cheap).length, nBoth = pidsOf(both).length;
  assert.ok(nOrg > 0 && nOrg < nAll, `organic narrows (${nOrg}/${nAll})`);
  assert.ok(nCheap > 0 && nCheap < nAll, `price narrows (${nCheap}/${nAll})`);
  assert.ok(nBoth <= Math.min(nOrg, nCheap), 'combined filters intersect');
  assert.equal(countOf(organic), nOrg, 'result count matches the grid');
  // the selected value shows as checked and its button now removes the filter
  assert.match(organic, /data-href="[^"]*cgid=chicken"[\s\S]{0,600}?fa-check-square[\s\S]{0,200}?Organic/);
  // every price in the price-filtered grid is within range
  for (const m of gridOf(cheap).matchAll(/class="sales"[\s\S]*?class="value" content="([\d.]+)"/g)) assert.ok(Number(m[1]) < 15, `price ${m[1]} in $0-$15 filter`);
  // full-page URL with filters (refresh / shared link) renders the same filtered grid
  const page = await (await get('/en-US/farm-fresh-chicken/?prefn1=valueAttributes&prefv1=organic')).text();
  assert.deepEqual(pidsOf(page), pidsOf(organic));
  // sorting keeps the active filter
  const sorted = await (await get(`${store}/Search-UpdateGrid?cgid=chicken&prefn1=valueAttributes&prefv1=organic&srule=price-high-to-low&start=0&sz=51`)).text();
  // (Search-UpdateGrid returns just the grid's tiles, without the surrounding page)
  const sortedPids = [...sorted.matchAll(/<div class="product product--[^"]*"\s+data-pid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...sortedPids].sort(), [...pidsOf(organic)].sort());
});

test('controller-style links redirect to local pages', async () => {
  const store = '/on/demandware.store/Sites-Perdue_US-Site/en_US';
  for (const [from, to] of [
    [`${store}/ContactUs-Show`, '/en-US/contact-us/'], [`${store}/Login-Show`, '/en-US/login/'], [`${store}/Farms-Show`, '/en-US/our-farms/'],
    [`${store}/Search-Show?cgid=chicken`, '/en-US/farm-fresh-chicken/'], [`${store}/Search-Show?q=ham`, '/search?q=ham'], ['/en-US/account', '/en-US/login/'],
  ]) {
    const res = await get(from, { headers: { accept: 'text/html' } });
    assert.ok([301, 302].includes(res.status), `${from} -> ${res.status}`);
    assert.equal(res.headers.get('location'), to, from);
  }
  for (const route of ['/en-US/contact-us/', '/en-US/login/', '/en-US/cart/', '/en-US/our-farms/', '/en-US/ambassador-program/', '/en-US/optout-data-collection/']) {
    assert.equal((await get(route)).status, 200, route);
  }
});

test('contact and opt-out forms validate and record submissions', async () => {
  const store = '/on/demandware.store/Sites-Perdue_US-Site/en_US';
  const post = (p, body) => get(`${store}/${p}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  assert.equal((await (await post('ContactUs-SubmitRequest', { contactFirstName: 'A' })).json()).success, false);
  assert.equal((await (await post('ContactUs-SubmitRequest', { contactFirstName: 'Ann', contactLastName: 'Lee', contactEmail: 'ann@example.com', contactTopic: 'Order', contactComments: 'Hello' })).json()).success, true);
  assert.equal((await (await post('OptoutDataCollection-SubmitRequest', { optoutDataCollectionFirstName: 'Ann', optoutDataCollectionLastName: 'Lee', optoutDataCollectionEmail: 'ann@example.com', optoutDataCollection: 'true' })).json()).success, true);
  const log = fs.readFileSync(SUBMISSIONS, 'utf8');
  assert.match(log, /"type":"contact"/);
  assert.match(log, /"type":"optout"/);
});

test('no page links to the offline notice for content that exists', async () => {
  const offenders = [];
  for (const p of pages) {
    const view = fs.readFileSync(path.join(ROOT, 'views', p.view + '.ejs'), 'utf8');
    for (const m of view.matchAll(/<a\b[^>]*\shref="\/offline\?from=([^"]*)"/g)) offenders.push(`${p.route} -> ${decodeURIComponent(m[1])}`);
  }
  for (const part of ['header', 'footer']) {
    const view = fs.readFileSync(path.join(ROOT, 'views/partials', part + '.ejs'), 'utf8');
    for (const m of view.matchAll(/<a\b[^>]*\shref="\/offline\?from=([^"]*)"/g)) offenders.push(`${part} -> ${decodeURIComponent(m[1])}`);
  }
  // Only genuinely transactional destinations may remain.
  const bad = offenders.filter((o) => !/checkout|payment|billing|shipping|order/i.test(o));
  assert.deepEqual(bad, []);
});

test('ordering: add to cart, update cart, validate checkout, place order, confirmation', async () => {
  const store = '/on/demandware.store/Sites-Perdue_US-Site/en_US';
  let cookie = '';
  const req = async (p, opts = {}) => {
    const res = await get(p, { ...opts, headers: { ...(opts.headers || {}), cookie } });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return res;
  };
  const form = (body) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

  // unknown product -> error message, no cart
  assert.equal((await (await req(`${store}/Cart-AddProduct`, form({ pid: 'nope', quantity: '1' }))).json()).error, true);
  // add a product twice -> quantities merge; response shape matches the site JS
  const a1 = await (await req(`${store}/Cart-AddProduct`, form({ pid: '25117', quantity: '2' }))).json();
  assert.equal(a1.error, false); assert.equal(a1.quantityTotal, 2); assert.match(a1.message, /Added 2/);
  assert.match(cookie, /^pf_cart=[a-f0-9]{32}$/);
  const a2 = await (await req(`${store}/Cart-AddProduct`, form({ pid: '25117', quantity: '1' }))).json();
  assert.equal(a2.quantityTotal, 3);
  assert.equal((await (await req('/api/cart')).json()).count, 3);
  // quantity is capped and the cart page shows the line
  await req('/cart/update', form({ pid: '25117', quantity: '999' }));
  const cartHtml = await (await req('/en-US/cart/')).text();
  assert.match(cartHtml, /value="20"/);
  await req('/cart/update', form({ pid: '25117', quantity: '1' }));

  // checkout validation keeps values and reports field errors
  const bad = await req('/checkout', form({ email: 'jane@example', phone: '123', firstName: 'Jane', lastName: '', address1: 'PO Box 12', city: 'Salisbury', state: 'ZZ', zip: '1' }));
  assert.equal(bad.status, 422);
  const badHtml = await bad.text();
  for (const msg of ['valid email', '10-digit', 'last name', 'P.O. boxes', 'Choose your state', '5-digit ZIP']) assert.match(badHtml, new RegExp(msg));
  assert.match(badHtml, /value="Salisbury"/);

  // a valid order
  const ok = await req('/checkout', form({ email: 'Jane@Example.com', phone: '410-555-1234', firstName: 'Jane', lastName: 'Doe', address1: '31149 Old Ocean City Rd', city: 'Salisbury', state: 'MD', zip: '21804', billingSame: 'on', instructions: 'Side door' }));
  assert.equal(ok.status, 303);
  const confirmUrl = ok.headers.get('location');
  assert.match(confirmUrl, /^\/checkout\/confirmation\/PF-\d{6}-[0-9A-F]{6}$/);
  const confirm = await (await req(confirmUrl)).text();
  assert.match(confirm, /Thank you, Jane!/);
  const order = JSON.parse(fs.readFileSync(ORDERS, 'utf8').trim().split('\n').pop());
  assert.equal(order.customer.email, 'jane@example.com');
  assert.equal(order.customer.phone, '(410) 555-1234');
  assert.equal(order.items[0].pid, '25117');
  assert.equal(order.total, Math.round((order.subtotal + order.shippingCost) * 100) / 100);
  // cart is emptied and another visitor can't view the confirmation
  assert.equal((await (await req('/api/cart')).json()).count, 0);
  assert.equal((await get(confirmUrl)).status, 404);
  // empty cart -> checkout redirects to the cart
  assert.equal((await req('/checkout')).status, 303);
});

test('newsletter sign-up validates, records the submission and answers { success, msg }', async () => {
  const store = '/on/demandware.store/Sites-Perdue_US-Site/en_US';
  const post = (body) => get(`${store}/EmailSubscribe-Subscribe`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const bad = await (await post({ emailId: 'not-an-email' })).json();
  assert.equal(bad.success, false);
  const ok = await (await post({ emailId: 'Tester@Example.com', csrf_token: '' })).json();
  assert.equal(ok.success, true);
  assert.match(ok.msg, /Thanks/);
  const log = fs.readFileSync(SUBMISSIONS, 'utf8');
  assert.match(log, /"type":"newsletter".*"email":"tester@example.com"/);
});

test('ambassador application requires the mandatory fields', async () => {
  const store = '/on/demandware.store/Sites-Perdue_US-Site/en_US';
  const post = (body) => get(`${store}/AmbassadorProgram-SubmitRequest`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  assert.equal((await (await post({ contactFirstName: 'Ann' })).json()).success, false);
  const ok = await (await post({ contactFirstName: 'Ann', contactLastName: 'Lee', contactEmail: 'ann@example.com', iamaBlogger: 'true', ambassadorOtherInfo: 'Food blogger <b>hi</b>' })).json();
  assert.equal(ok.success, true);
  assert.match(fs.readFileSync(SUBMISSIONS, 'utf8'), /"type":"ambassador".*"roles":\["Blogger"\]/);
});

test('offline notice page shows the requested feature', async () => {
  const html = await (await get('/offline?from=%2Fen-US%2Fcart')).text();
  assert.match(html, /isn’t available offline/);
  assert.match(html, /\/en-US\/cart/);
});

test('robots.txt and sitemap.xml list the site', async () => {
  const robots = await (await get('/robots.txt')).text();
  assert.match(robots, /Sitemap: http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml/);
  const xml = await (await get('/sitemap_0.xml')).text();
  assert.match(xml, /<urlset/);
  assert.ok((xml.match(/<loc>/g) || []).length > 600);
});

test('static assets are served with cache headers', async () => {
  const css = await get('/css/global.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const img = await get('/images/missing.svg');
  assert.equal(img.status, 200);
  assert.match(img.headers.get('cache-control'), /max-age=604800/);
});

// Full crawl: every page renders, and every local asset and internal link it references resolves.
test('every page renders and all of its local assets and links resolve', { timeout: 30 * 60_000 }, async () => {
  const checked = new Map();
  const failures = [];
  const resolveOk = async (url) => {
    if (checked.has(url)) return checked.get(url);
    const p = (async () => {
      let res = await get(url, { method: 'GET' });
      for (let hops = 0; res.status === 301 && hops < 3; hops++) res = await get(res.headers.get('location'));
      await res.arrayBuffer();
      return res.status;
    })();
    checked.set(url, p);
    return p;
  };
  const refsOf = (html) => {
    const out = new Set();
    for (const m of html.matchAll(/\s(?:src|href|data-src|poster)\s*=\s*"(\/[^"/][^"]*|\/)"/g)) out.add(m[1]);
    for (const m of html.matchAll(/\s(?:srcset|data-srcset)\s*=\s*"([^"]+)"/g)) for (const part of m[1].split(/,\s+(?=\S)/)) { const u = part.trim().split(/\s+/)[0]; if (u.startsWith('/')) out.add(u); }
    for (const m of html.matchAll(/url\(\s*['"]?(\/[^)'"]+)['"]?\s*\)/g)) out.add(m[1]);
    return [...out].map((u) => u.replace(/&amp;/g, '&').split('#')[0]).filter((u) => u && !u.startsWith('//') && !u.startsWith('/on/demandware.store/'));
  };

  for (let i = 0; i < pages.length; i += 8) {
    await Promise.all(pages.slice(i, i + 8).map(async (page) => {
      const res = await get(page.route);
      if (res.status !== 200) { failures.push(`${res.status} page ${page.route}`); return; }
      const html = await res.text();
      if (/<%[^%]/.test(html)) failures.push(`unrendered EJS in ${page.route}`);
      for (const ref of refsOf(html)) {
        const status = await resolveOk(ref);
        if (status !== 200) failures.push(`${status} ${ref} (from ${page.route})`);
      }
    }));
  }
  // links that are broken on the live site too are documented in data/dead-links.json
  const dead = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dead-links.json'), 'utf8')).links);
  const unique = [...new Set(failures.map((f) => f.replace(/ \(from .*\)$/, '')))].filter((f) => !dead.has(f.replace(/^\d+ /, '')));
  assert.deepEqual(unique, [], `${unique.length} broken references:\n${unique.slice(0, 40).join('\n')}`);
});
