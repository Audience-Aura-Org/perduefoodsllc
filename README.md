# perduefoodsllc — Perdue Farms Node.js site

A self-contained Node.js (Express + EJS) version of the perduefarms.com storefront, captured
2026-11-14. It serves 698 pages (products, recipes, categories, brand, farming and content pages,
plus contact and login) with every image, stylesheet, script and font stored locally.
Category filters, sorting, a working cart and guest checkout are included, and orders and the
site's forms send email notifications through Titan Email.

## Quick start

```bash
npm install
cp .env.example .env     # then fill in your Titan mailbox details
npm start                # http://127.0.0.1:3000
```

| Command | What it does |
| --- | --- |
| `npm start` | Production mode: templates compiled once and cached |
| `npm run dev` | Development mode: template edits show on refresh; restarts when `src/` changes |
| `npm test` | Test suite, including a crawl of every page and every asset and link it references (about 1 minute) |
| `npm run mail:test` | Checks the Titan SMTP login and sends one test email to `MAIL_TO` |

Requires Node 20.12 or later (the `.nvmrc` pins 24).

## Configuration (`.env`)

All settings live in `.env`, which git ignores. `.env.example` documents every variable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where the server listens. Use `HOST=0.0.0.0` on a server. |
| `NODE_ENV` | `production` | `development` disables template caching |
| `PUBLIC_URL` | (request host) | Absolute site URL used in `sitemap.xml` and `robots.txt` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | `smtp.titan.email` / `465` / `true` | Titan SMTP. Port 587 with `SMTP_SECURE=false` also works. |
| `SMTP_USER` / `SMTP_PASS` | — | Full Titan mailbox address and its password |
| `MAIL_FROM` | `SMTP_USER` | Sender address |
| `MAIL_TO` | `SMTP_USER` | Who receives notifications (comma-separate several) |
| `MAIL_SEND_CONFIRMATIONS` | `true` | Also email the person who submitted the form |
| `SUBMISSIONS_FILE` | `storage/submissions.jsonl` | Every submission is also logged here |
| `FORM_RATE_LIMIT` | `5` | Max submissions per minute per visitor, per form |

## Ordering

1. **Add to cart** on any product page, category tile or recipe "shop the ingredients" link.
   The header cart badge and mini-cart update immediately.
2. **Cart** (`/en-US/cart/`): change quantities, remove items, and see the subtotal, shipping and
   free-shipping progress.
3. **Checkout** (`/checkout`): one page with three steps (contact, delivery address, delivery
   options). Fields use standard autofill tokens so browsers and password managers can fill
   everything at once. Phone and ZIP show numeric keypads on phones, the phone number formats
   itself, and state is a dropdown. Billing details and the gift message appear only when needed.
   Server-side validation catches invalid email, phone and ZIP, missing fields, P.O. boxes
   (frozen goods) and past delivery dates. Errors are listed at the top, shown next to each field,
   and everything typed is kept.
4. **Order placed:** saved to `storage/orders.jsonl` with an order number like `PF-261114-347148`.
   **You** get a full order email (Reply-To = customer) and **the customer** gets a branded
   confirmation with the same summary. The cart is emptied and a confirmation page is shown;
   only the browser that placed the order can view it.

No card details are collected: the checkout states how payment is arranged (`PAYMENT_NOTE`). To
take payments online, integrate a hosted payment provider (Stripe Checkout, Square, PayPal);
don't add card fields to this form.

| Setting | Default | Purpose |
| --- | --- | --- |
| `FREE_SHIPPING_MIN` | `159.99` | Subtotal at or above which shipping is free |
| `SHIPPING_FLAT_RATE` | `19.99` | Shipping charged below that |
| `MAX_QTY_PER_ITEM` | `20` | Quantity cap per product |
| `PAYMENT_NOTE` | (see `.env.example`) | Payment wording at checkout and in emails |
| `ORDERS_FILE` / `CARTS_FILE` | `storage/…` | Order log and saved carts |

Prices come from the captured product pages; edit a product's template to change its price.

## Email notifications (Titan)

| Event | You receive | Customer receives |
| --- | --- | --- |
| Order placed | Full order with customer, address, delivery options, items and totals | Order confirmation with the same summary |

| Form | Where | You receive | Visitor receives |
| --- | --- | --- | --- |
| Checkout | `/checkout` | New order | Order confirmation |
| Newsletter sign-up | Footer of every page | New subscriber's address | Confirmation |
| Contact Us | `/en-US/contact-us/` | Full message (Reply-To = visitor) | Confirmation |
| Ambassador program | `/en-US/ambassador-program/` | Full application (Reply-To = applicant) | Confirmation |
| Data-collection opt-out | `/en-US/optout-data-collection/` | Opt-out request | — |

Submissions are validated, rate-limited and written to `storage/submissions.jsonl` before any
email is sent, so nothing is lost if SMTP is down or not configured yet. Form input is
HTML-escaped in emails. Mail failures are logged and never break the form for the visitor.

## Project layout

```
server.js               Entry point: starts the server, logs mail status, handles graceful shutdown
src/
  config.js             Loads .env and exposes typed settings
  app.js                Express app: middleware, static files, routes, sitemap, 404/500 handling
  pages.js              Page registry: route → view lookups and redirects
  search.js             In-memory search over page titles and descriptions
  refinements.js        Category filters (attributes, price) applied to captured product grids
  product-grid.js       Splitting and sorting product tiles
  store-api.js          Local answers for the commerce endpoints the site's JavaScript calls
  forms.js              Newsletter, contact, ambassador and opt-out form handlers
  shop.js               Cart, checkout validation, orders and order emails
  cart.js               Per-visitor carts (cookie + storage/carts.json) and pricing
  catalog.js            Product name, price, image and availability from product pages
  mailer.js             Titan SMTP transport and email templates
views/
  partials/             Shared header, mega menu and footer, plus the page shell for app pages
  pages/…               One template per page (path mirrors the URL)
  cart.ejs, checkout.ejs, order-confirmation.ejs, partials/minicart.ejs
  search.ejs, offline.ejs, not-found.ejs, error.ejs
data/
  pages.json            Page manifest: route, view, type, title, description, thumbnail, ids
  redirects.json        Old URL → current URL (301)
  refinements.json      Which product ids carry each filter value (Organic, Course: Dinner, …)
  dead-links.json       Links that are broken on the live site too (they show the 404 page)
public/                 css/, js/, fonts/, images/, files/
scripts/mail-test.js    SMTP check
test/app.test.js        node:test suite
```

## Features

- **Same URLs as the live site.** Old aliases, `…/index.html` and controller-style links
  (`…/ContactUs-Show`, `…/Search-Show?cgid=…`) redirect to the right page.
- **Category filters:** subcategory, price range and attributes (Organic, Gluten-free, brand,
  recipe course, cuisine, technique, …). Values within one filter are OR-ed and different filters
  are AND-ed, as on the live store. Counts, checkboxes and the address bar update, and filtered URLs
  can be shared or refreshed.
- **Sorting:** price low→high, high→low and name, respecting active filters.
- **Search:** search-as-you-type in the header, plus `/search?q=` results filterable by type,
  and a JSON API at `/api/search?q=`.
- **Shopping:** working cart and guest checkout with email notifications (see Ordering). Accounts
  and sign-in aren't available; the login page explains that visitors can check out as guests.
- **SEO:** `/sitemap.xml`, `/robots.txt`, and the original canonical tags and meta descriptions.

## Editing content

- **One page:** edit `views/pages/<url path>.ejs` (`/en-US/we-care.html` →
  `views/pages/en-US/we-care.ejs`; `/en-US/recipes/` → `views/pages/en-US/recipes/index.ejs`).
- **Header, mega menu or footer on every page:** `views/partials/header.ejs` and `footer.ejs`.
  Four grilling pages use `header-variant-1.ejs`, so mirror menu changes there too.
- **Styles and scripts:** `public/css/` (`global.css` is the main stylesheet) and `public/js/`.
  `public/js/offline-app.js` holds this app's own small client-side fixes.
- **New page:** add `views/pages/<path>.ejs` and an entry in `data/pages.json`.
- **Search titles and descriptions** come from `data/pages.json`.

In production mode, restart the server after editing templates.

## Notes

- `id="shareUrl"` inputs and `<link rel="canonical">` keep the public perduefarms.com URLs on
  purpose: share buttons and search engines need the real address.
- YouTube and Facebook video embeds need the internet to play.
- Images that are broken on the live site show `public/images/missing.svg`.
- Some hero images are full-resolution originals (up to 15 MB), because the live site's resizer
  refused those sizes. Compressing them would speed up those pages.

## Performance

- **Page cache:** in production each page is rendered once, kept in memory pre-compressed
  (Brotli and gzip), and served with an `ETag`, so repeat visits get `304 Not Modified`. The most
  visited pages are warmed in the background at startup. Restart the server after editing templates.
- **Browser/CDN caching:** pages are cacheable for 5 minutes (CDN 10 minutes, stale-while-revalidate),
  CSS/JS for 1 day, and images, fonts and files for 30 days. Cart, checkout, search and order
  pages are never cached.
- **Images:** `npm run images:optimize` shrinks anything over 2000 px and recompresses JPEG/PNG
  in place (same file names). Run it after adding new images. Use `-- --dry` to preview savings.

## Contact details

Phone and WhatsApp: **+1 (208) 818-1707**; email: **info@perduefoodsllc.com**. They appear in the
footer of every page, on the Contact Us, Help, FAQ, privacy, terms and accessibility pages, and
in the floating WhatsApp button (`views/partials/footer.ejs`).
