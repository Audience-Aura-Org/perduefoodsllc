import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * In-memory cache of fully rendered, pre-compressed pages.
 *
 * Captured pages are identical for every visitor (the cart badge is loaded separately from
 * /api/cart), so each page is rendered once, compressed once with Brotli and gzip, and served
 * from memory afterwards. Only compressed copies are kept to bound memory (~100 KB per page).
 */
export class PageCache {
  constructor({ maxEntries = 2000 } = {}) {
    /** @type {Map<string, Promise<{ etag: string, br: Buffer, gz: Buffer }>>} */
    this.entries = new Map();
    this.maxEntries = maxEntries;
  }

  /**
   * @param {string} key
   * @param {() => Promise<string>} render
   */
  get(key, render) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = (async () => {
        const html = Buffer.from(await render());
        const [br, gz] = await Promise.all([
          brotli(html, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: html.length } }),
          gzip(html, { level: 9 }),
        ]);
        return { etag: `"${crypto.createHash('sha1').update(html).digest('base64url').slice(0, 27)}"`, br, gz };
      })();
      entry.catch(() => this.entries.delete(key));
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
      this.entries.set(key, entry);
    }
    return entry;
  }

  /**
   * Send a cached page: 304 when the browser's copy is current, otherwise the best encoding.
   * @param {import('express').Request} req @param {import('express').Response} res
   * @param {{ etag: string, br: Buffer, gz: Buffer }} entry
   */
  async send(req, res, entry) {
    res.set('ETag', entry.etag);
    res.vary('Accept-Encoding');
    res.type('html');
    if (req.fresh) return res.status(304).end();
    const enc = req.acceptsEncodings('br', 'gzip', 'identity');
    // Setting Content-Encoding makes the compression middleware leave the body alone.
    if (enc === 'br') return res.set('Content-Encoding', 'br').send(entry.br);
    if (enc === 'gzip') return res.set('Content-Encoding', 'gzip').send(entry.gz);
    return res.send(await gunzip(entry.gz));
  }

  /** Render pages in the background so first visits are fast too. */
  async warm(keys, renderFor, { concurrency = 2 } = {}) {
    const queue = [...keys];
    const worker = async () => { for (let k; (k = queue.shift());) { try { await this.get(k, () => renderFor(k)); } catch { /* rendered on demand later */ } } };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
}
