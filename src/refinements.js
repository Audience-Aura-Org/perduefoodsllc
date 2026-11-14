import fs from 'node:fs';
import path from 'node:path';
import { parseGrid, sortTiles } from './product-grid.js';

/**
 * Category filtering ("refinements") without the commerce back end.
 *
 * Category pages contain every product tile. Price filters use the price in each tile;
 * attribute filters (Organic, Gluten-free, Course: Dinner, …) use data/refinements.json,
 * which records which product ids carry each attribute value. Values of one attribute are
 * OR-ed, different attributes are AND-ed — the same semantics as the live store.
 *
 * The response is the category page with the grid, result count, checkbox states, filter
 * chips and permalink updated; the site's search.js swaps those sections into the page.
 */

const AJAX = '/on/demandware.store/Sites-Perdue_US-Site/en_US/Search-ShowAjax';
const FILTER_KEYS = /^(prefn\d+|prefv\d+|pmin|pmax|srule)$/;

/**
 * @typedef {{ cgid: string, prefs: Map<string, string[]>, pmin: string, pmax: string, srule: string }} FilterState
 */

/** @param {URLSearchParams | Record<string, any>} query */
export function parseState(query, cgid) {
  const q = query instanceof URLSearchParams ? query : new URLSearchParams(Object.entries(query).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, String(v)]])));
  const prefs = new Map();
  for (let i = 1; q.has('prefn' + i); i++) {
    const name = q.get('prefn' + i), values = String(q.get('prefv' + i) || '').split('|').filter(Boolean);
    if (name && values.length) prefs.set(name, [...new Set([...(prefs.get(name) || []), ...values])]);
  }
  return { cgid: cgid || q.get('cgid') || '', prefs, pmin: q.get('pmin') || '', pmax: q.get('pmax') || '', srule: q.get('srule') || '' };
}

export const hasFilters = (s) => s.prefs.size > 0 || Boolean(s.pmin || s.pmax);

/** Query string (without cgid) for a state; stable ordering so URLs are canonical. */
export function filterQuery(s, { includeSort = true } = {}) {
  const q = new URLSearchParams();
  [...s.prefs.keys()].sort().forEach((name, i) => { q.set('prefn' + (i + 1), name); q.set('prefv' + (i + 1), s.prefs.get(name).join('|')); });
  if (s.pmin) q.set('pmin', s.pmin);
  if (s.pmax) q.set('pmax', s.pmax);
  if (includeSort && s.srule) q.set('srule', s.srule);
  return q.toString();
}

const ajaxUrl = (s) => `${AJAX}?cgid=${encodeURIComponent(s.cgid)}${filterQuery(s, { includeSort: false }) ? '&' + filterQuery(s, { includeSort: false }) : ''}`;
const clone = (s) => ({ ...s, prefs: new Map([...s.prefs].map(([k, v]) => [k, [...v]])) });
const priceNum = (v) => Number(String(v).replace(/%2e/gi, '.'));
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export class RefinementEngine {
  /** @param {string} dataDir */
  constructor(dataDir) {
    const file = path.join(dataDir, 'refinements.json');
    const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).values || {} : {};
    /** @type {Map<string, Set<string>>} "name=value" -> product ids */
    this.index = new Map(Object.entries(raw).map(([k, v]) => [k, new Set(v.pids)]));
  }

  /** Does this attribute value have captured data? */
  knows(name, value) { return this.index.has(`${name}=${value}`); }

  /** @param {import('./product-grid.js').Tile[]} tiles @param {FilterState} s */
  filterTiles(tiles, s) {
    let out = tiles;
    for (const [name, values] of s.prefs) {
      const known = values.filter((v) => this.knows(name, v));
      if (!known.length) continue; // no data for this attribute: don't hide everything
      const allowed = new Set(known.flatMap((v) => [...this.index.get(`${name}=${v}`)]));
      out = out.filter((t) => allowed.has(t.pid));
    }
    if (s.pmin || s.pmax) {
      const lo = s.pmin ? priceNum(s.pmin) : 0, hi = s.pmax ? priceNum(s.pmax) : Infinity;
      out = out.filter((t) => !Number.isNaN(t.price) && t.price >= lo && t.price < hi);
    }
    return out;
  }

  /**
   * Apply a filter state to a rendered category page.
   * @param {string} pageHtml  rendered category page (unfiltered)
   * @param {FilterState} s
   * @param {string} route     public route of the category page (for the permalink)
   */
  apply(pageHtml, s, route) {
    const grid = parseGrid(pageHtml);
    if (!grid) return pageHtml;
    const tiles = sortTiles(this.filterTiles(grid.tiles, s), s.srule);
    const empty = tiles.length ? '' : '<div class="col-12 offline-no-results"><p>No products match these filters. <button class="btn-unstyled reset" data-href="' + escAttr(ajaxUrl({ ...s, prefs: new Map(), pmin: '', pmax: '' })) + '"><u>Clear filters</u></button></p></div>';
    let html = pageHtml.slice(0, grid.start) + grid.openTag + grid.lead + empty + tiles.map((t) => t.html).join('') + grid.footer + '</div>' + pageHtml.slice(grid.end);

    // result count
    html = html.replace(/(<span class="results-count">\s*)\d+(\s+Results?)/g, (m, a, b) => `${a}${tiles.length}${tiles.length === 1 ? ' Result' : ' Results'}`);

    // refinement buttons: checkbox state + toggle URL
    const chips = [];
    html = html.replace(/<button class="btn-unstyled"(\s+)data-href="([^"]*Search-ShowAjax\?[^"]*)"([\s\S]*?)<\/button>/g, (all, ws, href, rest) => {
      const q = new URLSearchParams(href.replace(/&amp;/g, '&').split('?')[1]);
      const label = ((rest.match(/<span[^>]*aria-hidden="true"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      let selected, next;
      if (q.get('prefn1') && q.get('prefv1') && !q.get('prefn2')) {
        const name = q.get('prefn1'), value = q.get('prefv1');
        const cur = s.prefs.get(name) || [];
        selected = cur.includes(value);
        next = clone(s);
        const vals = selected ? cur.filter((v) => v !== value) : [...cur, value];
        if (vals.length) next.prefs.set(name, vals); else next.prefs.delete(name);
      } else if (q.get('pmin') || q.get('pmax')) {
        selected = priceNum(q.get('pmin') || 0) === priceNum(s.pmin || -1) && priceNum(q.get('pmax') || 0) === priceNum(s.pmax || -1);
        next = { ...clone(s), pmin: selected ? '' : q.get('pmin') || '', pmax: selected ? '' : q.get('pmax') || '' };
      } else {
        return all; // category links and anything else stay as captured
      }
      if (selected) chips.push({ label, href: ajaxUrl(next) });
      const body = rest
        .replace(/fa-square-o|fa-check-square/, selected ? 'fa-check-square' : 'fa-square-o')
        .replace(/(<span\b[^>]*?class=")([^"]*)("[^>]*aria-hidden="true")/, (m, a, cls, b) => a + (selected ? `${cls.replace(/\bselected\b/g, '').trim()} selected`.trim() : cls.replace(/\bselected\b/g, '').trim()) + b)
        .replace(/(<span\b[^>]*aria-hidden="true"[^>]*class=")([^"]*)(")/, (m, a, cls, b) => a + (selected ? `${cls.replace(/\bselected\b/g, '').trim()} selected`.trim() : cls.replace(/\bselected\b/g, '').trim()) + b)
        .replace(/(Currently Refined|Refine) by /, selected ? 'Currently Refined by ' : 'Refine by ');
      return `<button class="btn-unstyled"${ws}data-href="${escAttr(ajaxUrl(next))}"${body}</button>`;
    });

    // selected-filter chips (mobile filter bar): keep the category chip, add one per active value
    if (chips.length) {
      const chipHtml = chips.map((c) => `
            <li class="filter-value">
                <button class="btn" data-href="${escAttr(c.href)}">
                    <span aria-hidden="true">${c.label}</span>
                    <span class="sr-only">Remove filter ${c.label}</span>
                </button>
            </li>`).join('');
      html = html.replace(/(<div class="row filter-bar d-lg-none">\s*<ul>)([\s\S]*?)(<\/ul>)/, (m, a, inner, b) => a + inner + chipHtml + b);
    }

    // sort options: carry the active filters so re-sorting keeps them
    const fq = filterQuery({ ...s, srule: '' }, { includeSort: false });
    html = html.replace(/(<option\b[^>]*\svalue=")([^"]*Search-UpdateGrid\?[^"]*)(")/g, (all, a, url, b) => {
      const [base, query] = url.replace(/&amp;/g, '&').split('?');
      const q = new URLSearchParams(query);
      for (const k of [...q.keys()]) if (/^(prefn\d+|prefv\d+|pmin|pmax)$/.test(k)) q.delete(k);
      return a + escAttr(`${base}?${q.toString()}${fq ? '&' + fq : ''}`) + b;
    });

    // permalink: lets refresh / back restore the filtered view
    const qs = filterQuery(s);
    html = html.replace(/(class="permalink" value=")[^"]*"/, `$1${escAttr(route + (qs ? '?' + qs : ''))}"`);
    return html;
  }
}

/** Keep only filter-related parameters of a query object. */
export const pickFilterParams = (query) => Object.fromEntries(Object.entries(query).filter(([k]) => FILTER_KEYS.test(k)));
