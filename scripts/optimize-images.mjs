// Optimize images in public/images in place (same file names and formats, so no page changes).
//   npm run images:optimize            optimize everything
//   npm run images:optimize -- --dry   report savings without writing
// - Anything larger than MAX_SIDE px is scaled down.
// - JPEG: MozJPEG quality 80, progressive.
// - PNG: palette quantization (quality 85) with max zlib effort; photos become far smaller.
// A result is kept only when it saves at least 10%, so already-optimal files are untouched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'images');
const MAX_SIDE = 2000;
const DRY = process.argv.includes('--dry');
sharp.concurrency(2);

const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(jpe?g|png)$/i.test(e.name)) files.push(p); } })(ROOT);

let before = 0, after = 0, changed = 0, failed = 0;
for (const [i, f] of files.entries()) {
  const input = fs.readFileSync(f);
  before += input.length;
  try {
    const img = sharp(input, { failOn: 'none' });
    const meta = await img.metadata();
    let pipeline = img.rotate();
    if ((meta.width || 0) > MAX_SIDE || (meta.height || 0) > MAX_SIDE) pipeline = pipeline.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    const out = /\.png$/i.test(f)
      ? await pipeline.png({ palette: true, quality: 85, effort: 10, compressionLevel: 9 }).toBuffer()
      : await pipeline.jpeg({ quality: 80, mozjpeg: true, progressive: true }).toBuffer();
    if (out.length < input.length * 0.9) {
      if (!DRY) fs.writeFileSync(f, out);
      after += out.length; changed++;
    } else after += input.length;
  } catch (err) {
    after += input.length; failed++;
    console.warn('skip', path.relative(ROOT, f), err.message);
  }
  if ((i + 1) % 200 === 0) console.log(`${i + 1}/${files.length}  ${(before / 1048576).toFixed(0)} MB -> ${(after / 1048576).toFixed(0)} MB`);
}
console.log(`${DRY ? '[dry run] ' : ''}${files.length} images, ${changed} optimized, ${failed} skipped: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB (${Math.round((1 - after / before) * 100)}% smaller)`);
