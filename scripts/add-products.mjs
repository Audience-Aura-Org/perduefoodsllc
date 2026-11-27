// Build hand-added products (data/added-products.json) into the site.
//   npm run products:add
//
// For every product this:
//  - makes its images (public/images/products/<pid>_<slug>.jpg plus a 500x500 tile image),
//    downloading the source photo once if the output images don't exist yet;
//  - writes a product page cloned from a captured product page (TEMPLATE_PDP) with the
//    name, price, images, breadcrumb and description swapped in;
//  - registers the page in data/pages.json (so routing, search, sitemap and cart work);
//  - adds a product tile, cloned from a captured tile, to each listed category grid and
//    updates that page's result count.
// Safe to re-run: earlier output for the same product ids is replaced, not duplicated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { parseGrid, matchingDivEnd } from '../src/product-grid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const VIEWS = path.join(ROOT, 'views');
const IMAGES = path.join(ROOT, 'public', 'images', 'products');

// Captured product page and category tile the new products are cloned from.
const TEMPLATE = {
  pid: '60625',
  slug: 'perdue-bone-in-chicken-thighs-pack',
  name: 'Bone-In Skin-On Chicken Thighs',
  title: 'Perdue Bone-In Chicken Thighs Pack',
  short: 'Approx. 3-lb. pack of meaty, delicious thighs ― portioned in three 1-lb. pouches',
  price: '23.99',
  cgid: 'thighs-and-legs',
  cgName: 'Thighs and Legs',
};
const TEMPLATE_PDP = path.join(VIEWS, 'pages/en-US', TEMPLATE.slug, TEMPLATE.pid + '.ejs');

// Short names used in breadcrumbs and analytics labels.
const CATEGORY_LABELS = {
  chicken: 'Chicken', 'chicken-breast': 'Chicken Breasts', 'thighs-and-legs': 'Thighs and Legs', wings: 'Wings',
  'whole-chickens': 'Whole Chicken', 'value-packs-chicken': 'Value Packs', 'pre-cut-recipe-ready': 'Pre-Cut and Recipe Ready',
  'all-products': 'All Products',
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => n.toFixed(2);
const replaceAll = (s, from, to) => s.split(from).join(to);
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const { imageBase, products, homepageFeatured: featuredPids = [], homepageHeading: featuredHead } = JSON.parse(fs.readFileSync(path.join(DATA, 'added-products.json'), 'utf8'));
const pages = JSON.parse(fs.readFileSync(path.join(DATA, 'pages.json'), 'utf8'));
const ours = new Set(products.map((p) => p.pid));

// ---------- sanity checks ----------
for (const p of products) {
  must(/^[A-Za-z0-9-]+$/.test(p.pid) && /^[a-z0-9-]+$/.test(p.slug), `bad pid/slug: ${p.pid} ${p.slug}`);
  must(p.price == null || (Number.isFinite(p.price) && p.price > 0), `bad price for ${p.pid}`);
  const clash = pages.find((x) => x.pid === p.pid && !x.view.endsWith(`/${p.slug}/${p.pid}`));
  must(!clash, `pid ${p.pid} is already used by ${clash?.route}`);
  for (const c of p.categories) must(pages.some((x) => x.cgid === c), `unknown category ${c} (${p.pid})`);
}

const url = (p) => `/en-US/${p.slug}/${p.pid}.html`;
const img = (p) => `/images/products/${p.pid}_${p.slug}.jpg`;
const tileImg = (p) => `/images/products/${p.pid}_${p.slug}_500x500.jpg`;
// Products without a price are sold by quote: no price, cart or quantity; a Request a Quote button instead.
const isQuote = (p) => p.price == null;
const quoteUrl = (p) => `/en-US/request-quote/?pid=${encodeURIComponent(p.pid)}`;

/** Remove the <div>…</div> found at `marker` (or at `from(index)` when the div starts earlier). */
function cutDiv(html, marker, { from = (i) => i } = {}) {
  const at = html.indexOf(marker);
  if (at < 0) return html;
  const start = from(at);
  return html.slice(0, start) + html.slice(matchingDivEnd(html, start));
}

// ---------- images ----------
async function buildImages(p) {
  const big = path.join(ROOT, 'public', img(p)), small = path.join(ROOT, 'public', tileImg(p));
  if (fs.existsSync(big) && fs.existsSync(small)) return;
  const res = await fetch(imageBase + p.image);
  must(res.ok, `download failed (${res.status}) for ${p.image}`);
  // Source photos sit inside a wide white border; trim it so the photo fills the frame
  // like the captured product photos do.
  let src = await sharp(Buffer.from(await res.arrayBuffer())).flatten({ background: '#ffffff' }).trim({ background: '#ffffff', threshold: 20 }).toBuffer();
  // Photos shot on plain white (no grey backdrop) are now cropped tight to the meat: give them room.
  const { data } = await sharp(src).extract({ left: 0, top: 0, width: 4, height: 4 }).raw().toBuffer({ resolveWithObject: true });
  if (Math.min(...data) > 235) {
    const { width, height } = await sharp(src).metadata();
    const pad = Math.round(Math.max(width, height) * 0.1);
    src = await sharp(src).extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' }).toBuffer();
  }
  const jpeg = { quality: 82, mozjpeg: true, progressive: true };
  await sharp(src).jpeg(jpeg).toFile(big);
  // Keep the photo's own shape; the grid crops tile images to its frame itself.
  await sharp(src).resize({ width: 500, height: 500, fit: 'inside', withoutEnlargement: true }).jpeg(jpeg).toFile(small);
}

// ---------- product page ----------
const templateHtml = fs.readFileSync(TEMPLATE_PDP, 'utf8');
const upsellAt = templateHtml.indexOf('<div class="container pdp-description-banner-wrapper');
const detailsAt = templateHtml.indexOf('<div class="description-and-detail pdp-desc');
must(upsellAt > 0 && detailsAt > upsellAt, 'template page layout changed: upsell/description markers not found');

/** Swap one product's identity into a piece of captured markup. */
function swapIdentity(html, p, { image }) {
  // Template product photos (plain and URL-encoded, e.g. the Pinterest share link) → ours.
  html = html.replace(/\/images\/(?:products|content)\/[^"'\s&]*60625[^"'\s&]*\.(?:png|jpe?g)/g, image);
  html = html.replace(/%2Fimages%2F(?:products|content)%2F[^"'\s&]*60625[^"'\s&]*\.(?:png|jpe?g)/g, encodeURIComponent(image));
  html = html.replace(/([?&](?:amp;)?media=)[^"&]*60625[^"&]*/g, `$1${encodeURIComponent(image)}`);
  html = replaceAll(html, TEMPLATE.slug, p.slug);
  html = replaceAll(html, TEMPLATE.title, esc(p.name));
  html = replaceAll(html, TEMPLATE.name, esc(p.name));
  html = replaceAll(html, TEMPLATE.short, esc(p.short));
  html = replaceAll(html, TEMPLATE.price, isQuote(p) ? '0' : money(p.price));
  return replaceAll(html, TEMPLATE.pid, p.pid);
}

function buildPage(p) {
  const primary = p.primary ? pages.find((x) => x.cgid === p.primary) : null;
  let head = templateHtml.slice(0, upsellAt);
  const upsell = templateHtml.slice(upsellAt, detailsAt); // other products' tiles: keep as captured
  let details = templateHtml.slice(detailsAt);

  // <head> text
  const metaDesc = `${p.short}. ${p.description[0]}`;
  head = head.replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(metaDesc)}"`)
    .replace(/(<meta name="keywords" content=")[^"]*"/, `$1${esc(`${p.name}, ${p.name.toLowerCase()}, frozen chicken, chicken delivery, buy chicken online, Perdue Farms`)}"`);

  // breadcrumb: Chicken › primary category (or just Chicken)
  head = head.replace(/(<ol class="breadcrumb">[\s\S]*?<\/li>)\s*<li class="breadcrumb-item">[\s\S]*?<\/li>(\s*<\/ol>)/, (m, first, close) => {
    if (!primary) return first.replace(' >', " aria-current='page'>") + close;
    return `${first}
                <li class="breadcrumb-item">
                    <a href="${primary.route}" aria-current='page'>
                        ${esc(CATEGORY_LABELS[p.primary] || primary.title)}
                    </a>
                </li>${close}`;
  });

  // image carousel: one photo
  head = head.replace(/(<ol class="carousel-indicators"[^>]*>)[\s\S]*?(<\/ol>)/, `$1
                    <li data-target="#pdpCarousel-${TEMPLATE.pid}" data-slide-to="0" class='active'>
                    </li>
            $2`);
  const inner = head.indexOf('<div class="carousel-inner">');
  must(inner > 0, 'template carousel not found');
  head = head.slice(0, inner) + `<div class="carousel-inner">
                <div class='carousel-item zoom-image active'>
                    <img src="${img(p)}"
                        class="d-block img-fluid pdp-product-tile"
                        alt="${esc(p.name)} image number 0"
                        itemprop="image"
                    />
                </div>
        </div>` + head.slice(matchingDivEnd(head, inner));

  // No social share buttons on product pages.
  head = cutDiv(head, '<div class="col-12 social-container');
  head = cutDiv(head, '<div class="copy-link-message');

  if (isQuote(p)) {
    // Marks the page for the catalog (src/catalog.js) so the product can never be added to a cart.
    const opening = `class="container product-detail product-wrapper "  data-pid="${TEMPLATE.pid}"`;
    must(head.includes(opening), 'template product-detail opening tag changed');
    head = head.replace(opening, `${opening} data-quote-only="true"`);
    head = cutDiv(head, 'col-12 promotions', { from: (i) => head.lastIndexOf('<div class="row"', i) }); // order-value promo
    head = cutDiv(head, '<div class="row attribute quantity');
    const buy = head.indexOf('<div class="prices-add-to-cart-actions">');
    must(buy > 0, 'template buy box not found');
    head = head.slice(0, buy) + `<div class="prices-add-to-cart-actions quote-box">
    <p class="quote-box__label">Price on request</p>
    <p class="quote-box__text">Pricing depends on quantity and delivery location. Tell us what you need and we’ll reply within one business day.</p>
    <a class="btn quote-btn" href="${quoteUrl(p)}">Request a Quote</a>
</div>` + head.slice(matchingDivEnd(head, buy));
  }

  // analytics/category labels that still name the template's category
  head = replaceAll(head, TEMPLATE.cgName, CATEGORY_LABELS[p.primary] || 'Chicken');

  // Description, Quick Facts, Handling, Cook and Prep
  details = details.replace(/(id="collapsible-details-1">)[\s\S]*?(<div class="product-number-rating)/,
    `$1\n        ${p.description.map((t) => `<p>${esc(t)}</p>`).join('\n')}${p.ideas?.length ? `\n<h3>Serving Ideas</h3>\n<ul>\n${p.ideas.map((t) => `<li>${esc(t)}</li>`).join('\n')}\n</ul>` : ''}\n            $2`);
  details = details.replace(/(id="collapsible-details-2">\s*)<ul>[\s\S]*?<\/ul>[\s\S]*?(\s*<\/div>)/,
    `$1<ul>\n${p.facts.map((f) => `<li>${esc(f)}</li>`).join('\n')}\n</ul>$2`);
  details = details.replace(/(id="collapsible-description-3">)[\s\S]*?(<\/div>)/, '$1\n        Keep frozen. Thaw in the refrigerator before cooking.\n    $2');
  details = details.replace(/(id="collapsible-description-4">)[\s\S]*?(<\/div>)/, `$1\n        ${esc(p.cook)}\n    $2`);

  // No verified nutrition data for these products: drop the Nutrition section and its modal.
  const nutritionLabel = details.indexOf('aria-label="Nutritional Information"');
  if (nutritionLabel > 0) {
    const rowStart = details.lastIndexOf('<div class="row details', nutritionLabel);
    details = details.slice(0, rowStart) + details.slice(matchingDivEnd(details, rowStart));
  }
  const modal = details.indexOf('<div id="nutritionModal"');
  if (modal > 0) details = details.slice(0, modal) + details.slice(matchingDivEnd(details, modal));

  const html = swapIdentity(head, p, { image: img(p) }) + upsell + swapIdentity(details, p, { image: img(p) });
  const left = html.match(/.{0,120}(chicken_thighs_pack|nutritionModal).{0,80}/g);
  must(!left, `template leftovers in page ${p.pid}:\n${left?.join('\n')}`);
  if (isQuote(p)) {
    // The product section only: the site-wide promo bar above it mentions "$99.99" on purpose.
    const buyArea = html.slice(html.indexOf('class="container product-detail'), html.indexOf('<div class="container pdp-description-banner-wrapper'));
    must(!/class="sales"|class="add-to-cart\b|custom-qty|\$\d/.test(buyArea), `price or cart controls left on quote page ${p.pid}`);
  }
  const file = path.join(VIEWS, 'pages/en-US', p.slug, p.pid + '.ejs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

// ---------- category tiles ----------
const tilePage = pages.find((x) => x.cgid === TEMPLATE.cgid);
const templateTile = parseGrid(fs.readFileSync(path.join(VIEWS, tilePage.view + '.ejs'), 'utf8')).tiles.find((t) => t.pid === TEMPLATE.pid)?.html;
must(templateTile, 'template tile not found');

function buildTile(p, cgid) {
  let html = templateTile.trimEnd() + '\n';
  const wrap = html.indexOf('<div class="swiper-wrapper">');
  must(wrap > 0, 'template tile swiper not found');
  html = html.slice(0, wrap) + `<div class="swiper-wrapper">
                        <div class="swiper-slide">
                            <a href="${url(p)}"
                                aria-hidden="true"
                                tabindex="-1"
                            >
                                <img src="${tileImg(p)}" class="tile-image" loading="lazy"
                                     alt="${esc(p.name)}"
                                     title="${esc(p.name)}"
                                />
                            </a>
                        </div>
                </div>` + html.slice(matchingDivEnd(html, wrap));
  const label = CATEGORY_LABELS[cgid] || cgid;
  html = replaceAll(html, `"${TEMPLATE.cgid}"`, `"${cgid}"`)
    .replace(/(\\"value\\":\\")thighs-and-legs(\\")/g, `$1${cgid}$2`)
    .replace(/PLP%20-%20Thighs%20and%20Legs/g, 'PLP%20-%20' + encodeURIComponent(label));
  html = replaceAll(html, TEMPLATE.cgName, label);
  if (isQuote(p)) {
    html = cutDiv(html, '<div class="product-tile prices');
    html = html.replace('<div class="tile-content-bottom">', '<div class="tile-content-bottom">\n    <div class="product-tile prices quote-price"><span class="quote-price__text">Price on request</span></div>');
    const cta = html.indexOf('<div class="tile-cta">');
    must(cta > 0, 'template tile CTA not found');
    html = html.slice(0, cta) + `<div class="tile-cta">
    <a class="btn btn-primary quote-btn-pt" href="${quoteUrl(p)}">Request a Quote</a>
</div>` + html.slice(matchingDivEnd(html, cta));
  }
  html = swapIdentity(html, p, { image: tileImg(p) });
  must(!html.includes('chicken_thighs_pack'), `template leftovers in tile ${p.pid}/${cgid}`);
  if (isQuote(p)) must(!/class="sales"|add-to-cart-pt|\$\d/.test(html), `price or cart button left in quote tile ${p.pid}`);
  return html;
}

function updateCategory(cat) {
  const file = path.join(VIEWS, cat.view + '.ejs');
  const page = fs.readFileSync(file, 'utf8');
  const grid = parseGrid(page);
  must(grid, `no product grid on ${cat.route}`);
  const keep = grid.tiles.filter((t) => !ours.has(t.pid));
  const added = products.filter((p) => p.categories.includes(cat.cgid));
  // Our products lead the grid (the default "Best Sellers" order); captured tiles follow.
  const tiles = added.map((p) => buildTile(p, cat.cgid)).join('') + keep.map((t) => t.html).join('');
  let html = page.slice(0, grid.start) + grid.openTag + grid.lead + tiles + grid.footer + '</div>' + page.slice(grid.end);
  const count = keep.filter((t) => t.pid).length + added.length;
  html = html.replace(/(<span class="results-count">\s*)\d+(\s+Results?)/g, (m, a) => `${a}${count}${count === 1 ? ' Result' : ' Results'}`);
  fs.writeFileSync(file, html);
  return { route: cat.route, added: added.length, count };
}

// ---------- run ----------
for (const p of products) {
  await buildImages(p);
  buildPage(p);
}

const entries = products.map((p) => ({
  route: url(p), view: `pages/en-US/${p.slug}/${p.pid}`, type: 'Product', title: p.name,
  description: `${p.short}. ${p.description[0]}`, image: tileImg(p), pid: p.pid,
}));
const kept = pages.filter((x) => !(x.type === 'Product' && ours.has(x.pid)));
fs.writeFileSync(path.join(DATA, 'pages.json'), JSON.stringify([...kept, ...entries], null, 1) + '\n');

// Categories that list (or used to list) one of our products.
const touched = pages.filter((x) => x.type === 'Category' && x.cgid && (
  products.some((p) => p.categories.includes(x.cgid)) || fs.readFileSync(path.join(VIEWS, x.view + '.ejs'), 'utf8').match(new RegExp(`data-pid="(${[...ours].join('|')})"`))));
for (const cat of touched) {
  const r = updateCategory(cat);
  console.log(`${r.route}: +${r.added} (now ${r.count} results)`);
}

// Homepage "featured" section (included by views/partials/home-intro.ejs).
const featured = featuredPids.map((pid) => products.find((p) => p.pid === pid));
must(featured.every(Boolean), 'homepageFeatured lists an unknown pid');
const featuredTiles = featured.map((p) => buildTile(p, 'chicken')
  .replace(/^<div class="grid-col col-12 col-sm-6 col-xl-4 product-gutter">/, '<div class="col-12 col-sm-6 col-lg-3 gutter">')
  .replace(/PLP%20-%20Chicken/g, 'Homepage%20Featured')).join('');
fs.writeFileSync(path.join(VIEWS, 'partials', 'featured-products.ejs'), `<%# Generated by scripts/add-products.mjs from data/added-products.json (homepageFeatured). Do not edit by hand. %>
<section class="hp-featured home-product-tiles" aria-labelledby="hp-featured-title">
  <div class="container homepage">
    <%- include('/partials/components/section-head', { eyebrow: ${JSON.stringify(featuredHead.eyebrow)}, title: ${JSON.stringify(esc(featuredHead.title))}, id: 'hp-featured-title' }) %>
    <div class="hp-product-grid js-swiper-refresh">
      <div class="homepage-product-listing row">
${featuredTiles}      </div>
    </div>
    <p class="hp-featured__more"><a class="pf-btn pf-btn--accent" href="/en-US/farm-fresh-chicken/">${esc(featuredHead.cta)}</a></p>
  </div>
</section>
`);
console.log(`homepage: ${featured.length} featured products`);
console.log(`${products.length} products built.`);
