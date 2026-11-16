import nodemailer from 'nodemailer';
import { config, mailConfigured } from './config.js';

/** Escape untrusted form input before putting it into an HTML email. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let transport;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: { user: config.mail.user, pass: config.mail.pass },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return transport;
}

/**
 * Send an email through Titan SMTP. Never throws: returns { sent, error? } so a mail outage
 * never breaks the form the visitor submitted.
 * @param {{ to: string, subject: string, html: string, text: string, replyTo?: string }} msg
 */
export async function sendMail({ to, subject, html, text, replyTo }) {
  if (!mailConfigured()) return { sent: false, error: 'SMTP not configured (set SMTP_USER, SMTP_PASS, MAIL_TO in .env)' };
  try {
    const info = await getTransport().sendMail({ from: `"Perdue Farms" <${config.mail.from}>`, to, subject, html, text, replyTo });
    return { sent: true, id: info.messageId };
  } catch (err) {
    console.error('[mail] send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

/** Check the SMTP login without sending anything. */
export async function verifyMail() {
  if (!mailConfigured()) return { ok: false, error: 'SMTP not configured' };
  try { await getTransport().verify(); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
}

const layout = (title, body) => `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;max-width:600px">
<tr><td style="background:#003b71;color:#fff;padding:16px 24px;font-size:18px;letter-spacing:.08em;font-weight:bold">PERDUE FARMS</td></tr>
<tr><td style="padding:24px"><h1 style="font-size:20px;color:#003b71;margin:0 0 16px">${esc(title)}</h1>${body}</td></tr>
</table></td></tr></table></body></html>`;

const rows = (fields) => `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px">${fields
  .filter(([, v]) => v !== undefined && v !== '')
  .map(([k, v]) => `<tr><td style="border-bottom:1px solid #eee;color:#5b6770;width:180px;vertical-align:top">${esc(k)}</td><td style="border-bottom:1px solid #eee;white-space:pre-wrap">${esc(v)}</td></tr>`)
  .join('')}</table>`;

const usd = (n) => '$' + Number(n).toFixed(2);
const orderItems = (o) => `<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;margin:8px 0 16px">
<tr style="background:#f4f5f7;text-align:left"><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr>
${o.items.map((i) => `<tr><td style="border-bottom:1px solid #eee">${esc(i.name)}<br><span style="color:#5b6770;font-size:12px">Item ${esc(i.pid)}</span></td><td style="border-bottom:1px solid #eee;text-align:center">${i.qty}</td><td style="border-bottom:1px solid #eee;text-align:right">${usd(i.price)}</td><td style="border-bottom:1px solid #eee;text-align:right">${usd(i.total)}</td></tr>`).join('')}
<tr><td colspan="3" style="text-align:right">Subtotal</td><td style="text-align:right">${usd(o.subtotal)}</td></tr>
<tr><td colspan="3" style="text-align:right">Shipping</td><td style="text-align:right">${o.shippingCost ? usd(o.shippingCost) : 'FREE'}</td></tr>
<tr><td colspan="3" style="text-align:right;font-weight:bold">Total</td><td style="text-align:right;font-weight:bold">${usd(o.total)}</td></tr></table>`;
const addressLines = (a) => [a.company, `${a.firstName} ${a.lastName}`, a.address1, a.address2, `${a.city}, ${a.state} ${a.zip}`].filter(Boolean).join('\n');
const orderText = (o) => `${o.items.map((i) => `${i.qty} x ${i.name} (${i.pid}) @ ${usd(i.price)} = ${usd(i.total)}`).join('\n')}\nSubtotal ${usd(o.subtotal)}\nShipping ${o.shippingCost ? usd(o.shippingCost) : 'FREE'}\nTotal ${usd(o.total)}`;

export const templates = {
  orderAdmin: (o) => ({
    subject: `New order ${o.id} — ${usd(o.total)} from ${o.customer.firstName} ${o.customer.lastName}`,
    html: layout(`New order ${o.id}`, `${orderItems(o)}${rows([
      ['Customer', `${o.customer.firstName} ${o.customer.lastName}`], ['Email', o.customer.email], ['Phone', o.customer.phone],
      ['Ship to', addressLines(o.shipping)], ['Bill to', typeof o.billing === 'string' ? o.billing : addressLines(o.billing)],
      ['Delivery date', o.delivery.date], ['Delivery instructions', o.delivery.instructions], ['Gift message', o.gift ? o.gift.message || '(gift, no message)' : ''],
      ['Marketing opt-in', o.marketingOptIn ? 'Yes' : 'No'], ['Placed', o.createdAt],
    ])}<p style="color:#5b6770;font-size:13px">Payment: ${esc(o.payment)}</p>`),
    text: `New order ${o.id}\n${o.customer.firstName} ${o.customer.lastName} <${o.customer.email}> ${o.customer.phone}\n\nShip to:\n${addressLines(o.shipping)}\n\n${orderText(o)}\n\nDelivery: ${o.delivery.date}\n${o.delivery.instructions}`,
  }),
  orderCustomer: (o) => ({
    subject: `Your Perdue Farms order ${o.id} is confirmed`,
    html: layout(`Thank you for your order, ${o.customer.firstName}!`, `<p style="line-height:1.6">We received your order <strong>${esc(o.id)}</strong>. Here’s a summary:</p>${orderItems(o)}
<p style="line-height:1.6"><strong>Shipping to</strong><br>${esc(addressLines(o.shipping)).replace(/\n/g, '<br>')}</p>
<p style="line-height:1.6"><strong>Delivery</strong><br>${esc(o.delivery.date)}${o.delivery.instructions ? '<br>' + esc(o.delivery.instructions) : ''}</p>
<p style="line-height:1.6;background:#f4f5f7;padding:12px"><strong>Payment</strong><br>${esc(o.payment)}</p>
<p style="line-height:1.6;color:#5b6770">Questions? Just reply to this email and quote your order number.</p>`),
    text: `Thank you for your order ${o.id}!\n\n${orderText(o)}\n\nShipping to:\n${addressLines(o.shipping)}\n\nDelivery: ${o.delivery.date}\n\n${o.payment}`,
  }),

  newsletterAdmin: ({ email, page, ip }) => ({
    subject: `New newsletter sign-up: ${email}`,
    html: layout('New newsletter subscriber', rows([['Email', email], ['Signed up on', page], ['IP', ip], ['Time', new Date().toISOString()]])),
    text: `New newsletter subscriber\nEmail: ${email}\nPage: ${page}\nTime: ${new Date().toISOString()}`,
  }),
  newsletterConfirmation: () => ({
    subject: 'Thanks for signing up for Perdue Farms emails',
    html: layout('You’re on the list!', '<p style="line-height:1.6">Thanks for signing up. You’ll be the first to know about exclusive offers, new products, recipes and more from Perdue Farms.</p>'),
    text: 'Thanks for signing up. You’ll be the first to know about exclusive offers, new products, recipes and more from Perdue Farms.',
  }),
  ambassadorAdmin: (f) => ({
    subject: `New ambassador application: ${f.firstName} ${f.lastName}`,
    html: layout('New ambassador program application', rows([
      ['Name', `${f.firstName} ${f.lastName}`], ['Email', f.email], ['I am a', f.roles.join(', ')], ['Interested in', f.interests.join(', ')],
      ['Brand / business', f.brand], ['Website', f.website], ['Facebook', f.facebook], ['Twitter', f.twitter], ['Instagram', f.instagram],
      ['Pinterest', f.pinterest], ['TikTok', f.tiktok], ['About', f.about], ['Time', new Date().toISOString()],
    ])),
    text: `New ambassador application\n${f.firstName} ${f.lastName} <${f.email}>\nRoles: ${f.roles.join(', ')}\nInterests: ${f.interests.join(', ')}\n\n${f.about}`,
  }),
  contactAdmin: (f) => ({
    subject: `Contact form: ${f.topic || 'New message'} from ${f.firstName} ${f.lastName}`,
    html: layout('New contact form message', rows([
      ['Name', `${f.firstName} ${f.lastName}`], ['Email', f.email], ['Phone', f.phone], ['Topic', f.topic], ['Order number', f.orderNumber],
      ['Address', [f.address, f.address2, `${f.city}, ${f.state} ${f.zip}`].filter((x) => x && x.trim() !== ',').join('\n')], ['Message', f.comments], ['Time', new Date().toISOString()],
    ])),
    text: `Contact form message\n${f.firstName} ${f.lastName} <${f.email}> ${f.phone}\nTopic: ${f.topic}\nOrder: ${f.orderNumber}\n\n${f.comments}`,
  }),
  contactConfirmation: (f) => ({
    subject: 'We received your message — Perdue Farms',
    html: layout(`Thanks, ${f.firstName}!`, '<p style="line-height:1.6">We received your message and a member of our customer care team will get back to you as soon as possible.</p>'),
    text: `Thanks, ${f.firstName}! We received your message and will get back to you as soon as possible.`,
  }),
  optoutAdmin: (f) => ({
    subject: `Data collection opt-out request: ${f.email}`,
    html: layout('Data collection opt-out request', rows([
      ['Name', `${f.firstName} ${f.lastName}`], ['Email', f.email], ['Opt out of data collection', f.optout ? 'Yes' : 'No'],
      ['California / Nevada consumer', f.caNv ? 'Yes' : 'No'], ['Time', new Date().toISOString()],
    ])),
    text: `Data collection opt-out request\n${f.firstName} ${f.lastName} <${f.email}>\nOpt out: ${f.optout ? 'yes' : 'no'}\nCA/NV consumer: ${f.caNv ? 'yes' : 'no'}`,
  }),
  ambassadorConfirmation: (f) => ({
    subject: 'We received your Perdue Farms ambassador application',
    html: layout(`Thanks, ${f.firstName}!`, '<p style="line-height:1.6">We received your application to the Perdue Farms ambassador program. Our team reviews every application and will be in touch if it’s a good fit.</p>'),
    text: `Thanks, ${f.firstName}! We received your application to the Perdue Farms ambassador program and will be in touch.`,
  }),
};
