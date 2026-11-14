// Check the Titan SMTP login and send one test email to MAIL_TO.
// usage: npm run mail:test
import { config, mailConfigured } from '../src/config.js';
import { verifyMail, sendMail } from '../src/mailer.js';

if (!mailConfigured()) {
  console.error('SMTP is not configured. Set SMTP_USER, SMTP_PASS and MAIL_TO in .env');
  process.exit(1);
}
console.log(`Connecting to ${config.mail.host}:${config.mail.port} (secure=${config.mail.secure}) as ${config.mail.user} ...`);
const v = await verifyMail();
if (!v.ok) { console.error('Login failed:', v.error); process.exit(1); }
console.log('Login OK. Sending test email to', config.mail.to);
const r = await sendMail({ to: config.mail.to, subject: 'Perdue Farms site: test email', text: 'Email notifications are working.', html: '<p>Email notifications are working.</p>' });
if (!r.sent) { console.error('Send failed:', r.error); process.exit(1); }
console.log('Sent:', r.id);
