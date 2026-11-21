// Remaps the captured storefront palette (Perdue navy + gold) to the site's own
// "farmhouse" palette (forest green + amber on cream). Idempotent: run it again after
// re-capturing pages. Usage: node scripts/apply-theme.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');

/** old colour (lower-case) -> new colour. rgb triplets cover rgba() variants. */
const HEX = {
  '#003b71': '#1f4d3a', // navy -> forest (primary)
  '#002a52': '#163a2b',
  '#2d79b2': '#2f6b52', // link blue -> mid green
  '#00a1e0': '#1f4d3a', // bootstrap primary
  '#0070d2': '#2f6b52',
  '#94e1ff': '#cfe3d8',
  '#fcc629': '#e0913a', // gold -> amber (accent)
  '#ffc629': '#e0913a',
  '#edd134': '#e0913a',
  '#e6e7e8': '#efe6d6', // nav grey -> sand
  '#f9f9f9': '#faf6ef', // page background -> cream
  '#f8f8f8': '#f6f0e4',
};
const RGB = {
  '0,59,113': '31,77,58',
  '0,161,224': '31,77,58',
};

const hexRe = new RegExp(`(${Object.keys(HEX).join('|')})(?![0-9a-f])`, 'gi');
const rgbRe = new RegExp(`rgba?\\(\\s*(${Object.keys(RGB).map((k) => k.replace(/,/g, '\\s*,\\s*')).join('|')})`, 'gi');

const files = [
  ...fs.readdirSync(path.join(root, 'public/css')).filter((f) => f.endsWith('.css') && !f.endsWith('.min.css')).map((f) => `public/css/${f}`),
  ...['header.ejs', 'header-variant-1.ejs', 'footer.ejs', 'minicart.ejs', 'document-start.ejs'].map((f) => `views/partials/${f}`),
  'public/site.webmanifest',
];

let changed = 0;
for (const rel of files) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  const after = before
    .replace(hexRe, (m) => HEX[m.toLowerCase()])
    .replace(rgbRe, (m, triplet) => m.replace(triplet, RGB[triplet.replace(/\s/g, '')]));
  if (after !== before) { fs.writeFileSync(file, after); changed++; console.log('themed', rel); }
}
console.log(`${changed} file(s) updated`);
