// Switches every text font on the site to Poppins (self-hosted in public/fonts).
// Idempotent: safe to re-run after re-capturing pages or editing CSS.
//   node scripts/apply-font.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const STACK = 'Poppins, "Helvetica Neue", Arial, sans-serif';
const SKIP_CSS = new Set(['font-awesome.min.css', 'swiper-bundle.min.css']);
// Icon and code fonts keep their own family.
const KEEP = /FontAwesome|swiper-icons|monospace|inherit|initial|unset|var\(/i;

const FACES = `/* Poppins (self-hosted, latin) — site-wide text font */
${[300, 400, 500, 600, 700].map((w) => `@font-face {
  font-family: 'Poppins';
  font-style: normal;
  font-weight: ${w};
  font-display: swap;
  src: url(../fonts/poppins-latin-${w}-normal.woff2) format('woff2');
}`).join('\n')}
@font-face {
  font-family: 'Poppins';
  font-style: italic;
  font-weight: 400;
  font-display: swap;
  src: url(../fonts/poppins-latin-400-italic.woff2) format('woff2');
}
`;

let changed = 0;
const write = (file, before, after) => {
  if (before !== after) { writeFileSync(file, after); changed++; console.log('updated', file.slice(ROOT.length)); }
};

// 1. @font-face rules
const fontsCss = join(ROOT, 'public/css/fonts.css');
const fonts = readFileSync(fontsCss, 'utf8');
write(fontsCss, fonts, fonts.includes("font-family: 'Poppins'") ? fonts : FACES + fonts);

// 2. Every font-family declaration and font token in the stylesheets
const cssDir = join(ROOT, 'public/css');
for (const name of readdirSync(cssDir)) {
  if (!name.endsWith('.css') || SKIP_CSS.has(name) || name === 'fonts.css') continue;
  const file = join(cssDir, name);
  const src = readFileSync(file, 'utf8');
  const out = src
    .replace(/(font-family\s*:\s*)([^;}!]+)/g, (m, p, v) => (KEEP.test(v) || v.trim() === STACK ? m : p + STACK + (/\s$/.test(v) ? ' ' : '')))
    .replace(/(--font-family-sans-serif\s*:\s*)([^;}]+)/g, (m, p) => p + STACK)
    .replace(/(--pf-(?:serif|sans)\s*:\s*)([^;}]+)/g, (m, p) => p + STACK);
  write(file, src, out);
}

// 3. Inline styles in captured pages
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ejs') ? [p] : [];
});
for (const file of walk(join(ROOT, 'views'))) {
  const src = readFileSync(file, 'utf8');
  if (!/font-family/i.test(src)) continue;
  const out = src.replace(/(font-family\s*:\s*)([^;"}!<]*)/gi, (m, p, v) => (KEEP.test(v) || v.includes('Poppins') ? m : p + 'Poppins, sans-serif'));
  write(file, src, out);
}
console.log(`${changed} file(s) changed`);
