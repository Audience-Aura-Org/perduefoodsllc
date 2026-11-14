/** In-memory full-text search over the page manifest. */

const TYPE_WEIGHT = { Product: 4, Recipe: 3, Category: 2, 'Recipe collection': 1, Page: 1 };

/** @param {string} s */
function normalize(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** @param {string} q */
export function tokenize(q) {
  return normalize(q).split(/[^a-z0-9]+/).filter((t) => t.length > 1 || /\d/.test(t));
}

export class SearchIndex {
  /** @param {import('./pages.js').PageEntry[]} pages */
  constructor(pages) {
    this.docs = pages
      .filter((p) => p.route !== '/' && !/^Page not found/i.test(p.title))
      .map((p) => ({ page: p, title: normalize(p.title), text: normalize(`${p.title} ${p.description}`) }));
  }

  /**
   * Rank pages whose title or description contain every query term.
   * @param {string} query
   * @param {{ type?: string, limit?: number }} [opts]
   * @returns {import('./pages.js').PageEntry[]}
   */
  search(query, { type, limit = 60 } = {}) {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const scored = [];
    for (const d of this.docs) {
      if (type && d.page.type !== type) continue;
      if (!terms.every((t) => d.text.includes(t))) continue;
      let score = TYPE_WEIGHT[d.page.type] || 0;
      for (const t of terms) if (d.title.includes(t)) score += 5;
      if (d.title.startsWith(terms[0])) score += 3;
      scored.push([score, d.page]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title));
    return scored.slice(0, limit).map(([, p]) => p);
  }

  /** Distinct page types present in a result set, in display order. */
  static typesOf(results) {
    const order = ['Product', 'Recipe', 'Category', 'Recipe collection', 'Page'];
    const present = new Set(results.map((r) => r.type));
    return order.filter((t) => present.has(t));
  }
}
