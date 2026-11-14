/**
 * Server-side sorting for captured category grids.
 *
 * Category pages were captured with every product on one page, so the product tiles already
 * exist in the rendered HTML. For a sort request we take those tiles, order them by the
 * requested rule and return them in the same markup the commerce back end would
 * (`Search-UpdateGrid`), which the client drops into `.product-grid`.
 */

const TILE_START = /<div class="grid-col\b/g;
const GRID_OPEN = /<div class="row product-grid\b[^>]*>/;

/**
 * Index of the `</div>` that closes the `<div` starting at `start`.
 * @param {string} html
 * @param {number} start
 */
export function matchingDivEnd(html, start) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m; (m = re.exec(html));) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/**
 * @typedef {{ html: string, pid: string, price: number, name: string, order: number }} Tile
 * @typedef {{ lead: string, tiles: Tile[], footer: string, start: number, end: number, openTag: string }} Grid
 *   start/end delimit the whole `.product-grid` element inside the page it was parsed from.
 */

/**
 * Split a rendered category page into its product tiles.
 * @param {string} pageHtml
 * @returns {Grid | null}
 */
export function parseGrid(pageHtml) {
  const open = GRID_OPEN.exec(pageHtml);
  if (!open) return null;
  const gridStart = open.index;
  const gridEnd = matchingDivEnd(pageHtml, gridStart);
  const inner = pageHtml.slice(gridStart + open[0].length, gridEnd - '</div>'.length);

  const footerAt = inner.search(/<div class="col-12 grid-footer"/);
  const tilesPart = footerAt >= 0 ? inner.slice(0, footerAt) : inner;
  const footer = footerAt >= 0 ? inner.slice(footerAt) : '';

  const where = { start: gridStart, end: gridEnd, openTag: open[0] };
  const starts = [...tilesPart.matchAll(TILE_START)].map((m) => m.index);
  if (!starts.length) return { lead: tilesPart, tiles: [], footer, ...where };
  const tiles = starts.map((s, i) => {
    const html = tilesPart.slice(s, starts[i + 1] ?? tilesPart.length);
    const pid = (html.match(/<div class="product\b[^"]*"\s+data-pid="([^"]+)"/) || [])[1] || '';
    const price = Number((html.match(/class="sales"[\s\S]*?class="value" content="([\d.]+)"/) || [])[1]);
    const name = ((html.match(/class="pdp-link"[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '')
      .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return { html, pid, price: Number.isFinite(price) ? price : NaN, name, order: i };
  });
  return { lead: tilesPart.slice(0, starts[0]), tiles, footer, ...where };
}

/** Sort tiles by a sorting rule id; unknown rules keep the captured order. */
export function sortTiles(tiles, srule) {
  return [...tiles].sort(SORTS[srule] || byOrder);
}

const byOrder = (a, b) => a.order - b.order;
/** Tiles without a price (content tiles, sold-out items without a price) sink to the end. */
const byPrice = (dir) => (a, b) => {
  const pa = Number.isNaN(a.price), pb = Number.isNaN(b.price);
  if (pa || pb) return pa - pb || byOrder(a, b);
  return dir * (a.price - b.price) || byOrder(a, b);
};
const SORTS = {
  'price-low-to-high': byPrice(1),
  'price-high-to-low': byPrice(-1),
  brand: (a, b) => a.name.localeCompare(b.name) || byOrder(a, b),
};

/**
 * @param {Grid} grid
 * @param {string} srule  Sorting rule id from the sort <select>, e.g. "price-low-to-high".
 */
export function renderSortedGrid(grid, srule, tiles = grid.tiles) {
  return grid.lead + sortTiles(tiles, srule).map((t) => t.html).join('') + grid.footer;
}
