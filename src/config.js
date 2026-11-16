import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env (Node >= 20.12 built-in). Real environment variables take precedence.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  production: process.env.NODE_ENV !== 'development',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  mail: {
    // Titan Email (titan.email): SMTP over SSL on 465, or STARTTLS on 587.
    host: process.env.SMTP_HOST || 'smtp.titan.email',
    port: int(process.env.SMTP_PORT, 465),
    secure: bool(process.env.SMTP_SECURE, int(process.env.SMTP_PORT, 465) === 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    to: process.env.MAIL_TO || process.env.SMTP_USER || '',
    sendConfirmations: bool(process.env.MAIL_SEND_CONFIRMATIONS, true),
  },
  submissionsFile: path.resolve(ROOT, process.env.SUBMISSIONS_FILE || 'storage/submissions.jsonl'),
  // Max form submissions per minute per visitor IP, per form.
  formRateLimit: int(process.env.FORM_RATE_LIMIT, 5),
  shop: {
    // Matches the live site's banner: "Free Shipping on orders over $159.99".
    freeShippingMin: Number(process.env.FREE_SHIPPING_MIN ?? 159.99),
    flatShipping: Number(process.env.SHIPPING_FLAT_RATE ?? 19.99),
    maxQtyPerItem: int(process.env.MAX_QTY_PER_ITEM, 20),
    cartsFile: path.resolve(ROOT, process.env.CARTS_FILE || 'storage/carts.json'),
    ordersFile: path.resolve(ROOT, process.env.ORDERS_FILE || 'storage/orders.jsonl'),
    // Shown at checkout and in emails: how payment is arranged (no card data is collected online).
    paymentNote: process.env.PAYMENT_NOTE || 'No payment is taken online. Our customer care team will contact you within one business day to confirm your order and arrange payment.',
  },
};

export const mailConfigured = () => Boolean(config.mail.user && config.mail.pass && config.mail.to);
