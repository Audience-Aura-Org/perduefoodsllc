# perduefoodsllc — Perdue Farms Node.js site

A self-contained Node.js (Express + EJS) version of the perduefarms.com storefront, captured
2026-11-14. It serves 698 pages (products, recipes, categories, brand, farming and content pages,
plus contact, login and cart) with every image, stylesheet, script and font stored locally.
Category filters and sorting work, and the site's forms send email notifications through
Titan Email.

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

## Email notifications (Titan)

| Form | Where | You receive | Visitor receives |
| --- | --- | --- | --- |
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
  mailer.js             Titan SMTP transport and email templates
views/
  partials/             Shared header, mega menu and footer, plus the page shell for app pages
  pages/…               One template per page (path mirrors the URL)
  search.ejs, offline.ejs, not-found.ejs, error.ejs
data/
  pages.json            Page manifest: route, view, type, title, description, thumbnail, ids
  redirects.json        Old URL → current URL (301)
  refinements.json      Which product ids carry each filter value (Organic, Course: Dinner, …)
  dead-links.json       Links that are broken on the live site too (they show the 404 page)
public/                 css/, js/, fonts/, images/, files/, api/
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
- **Shopping:** product pages, cart, login and account pages display. Add to cart, sign-in and
  checkout show a clear "not available" message, because ordering needs the commerce back end.
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
