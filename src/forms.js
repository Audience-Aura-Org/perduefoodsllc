import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { sendMail, templates } from './mailer.js';

const EMAIL_RE = /^[^\s@<>()[\],;:"]{1,64}@[^\s@<>()[\],;:"]{1,255}\.[a-z]{2,}$/i;
const clean = (v, max = 500) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

/** Append a submission to the local JSONL log so nothing is lost if mail is down. */
export function record(type, data) {
  try {
    fs.mkdirSync(path.dirname(config.submissionsFile), { recursive: true });
    fs.appendFileSync(config.submissionsFile, JSON.stringify({ type, at: new Date().toISOString(), ...data }) + '\n');
  } catch (err) {
    console.error('[forms] could not record submission:', err.message);
  }
}

/** Fixed-window rate limit per client IP. */
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ success: false, msg: 'Too many requests. Please try again in a minute.' });
    next();
  };
}

/**
 * Form handlers mounted on the commerce controller paths the site's JavaScript posts to.
 * Responses use the `{ success, msg }` shape main.js / ambassadorProgram.js display.
 */
export function formHandlers() {
  const router = express.Router();
  const parse = express.urlencoded({ extended: false, limit: '20kb' });
  // One limiter per form so a busy form can't lock visitors out of the others.
  const limit = () => rateLimit({ windowMs: 60_000, max: config.formRateLimit });

  router.post('/EmailSubscribe-Subscribe', limit(), parse, async (req, res) => {
    const email = clean(req.body.emailId, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) return res.json({ success: false, msg: 'Please enter a valid email address.' });
    const page = clean(req.get('referer'), 300);
    record('newsletter', { email, page, ip: req.ip });
    const results = [await sendMail({ to: config.mail.to, replyTo: email, ...templates.newsletterAdmin({ email, page, ip: req.ip }) })];
    if (config.mail.sendConfirmations) results.push(await sendMail({ to: email, ...templates.newsletterConfirmation() }));
    res.json({ success: true, msg: 'Thanks for signing up! Check your inbox for a confirmation.', emailed: results[0].sent });
  });

  router.post('/AmbassadorProgram-SubmitRequest', limit(), parse, async (req, res) => {
    const b = req.body;
    const f = {
      firstName: clean(b.contactFirstName, 80), lastName: clean(b.contactLastName, 80), email: clean(b.contactEmail, 254).toLowerCase(),
      roles: [['iamaJournalist', 'Journalist'], ['iamaFreelancer', 'Freelancer'], ['iamaBlogger', 'Blogger'], ['iamaInfluencer', 'Influencer'], ['iamaOther', 'Other']].filter(([k]) => b[k]).map(([, l]) => l),
      interests: [['ambassadorInterest', 'Ambassador'], ['influencerInterest', 'Influencer'], ['affiliateInterest', 'Affiliate'], ['otherInterest', 'Other']].filter(([k]) => b[k]).map(([, l]) => l),
      brand: clean(b.ambassadorBrand, 200), website: clean(b.ambassadorWebsite, 300), facebook: clean(b.ambassadorFacebook, 300), twitter: clean(b.ambassadorTwitter, 300),
      instagram: clean(b.ambassadorInstagram, 300), pinterest: clean(b.ambassadorPinterest, 300), tiktok: clean(b.ambassadorTikTok, 300), about: clean(b.ambassadorOtherInfo, 5000),
    };
    if (!f.firstName || !f.lastName || !EMAIL_RE.test(f.email) || !f.about) {
      return res.json({ success: false, msg: 'Please fill in your first name, last name, a valid email and tell us about yourself.' });
    }
    record('ambassador', { ...f, ip: req.ip });
    await sendMail({ to: config.mail.to, replyTo: f.email, ...templates.ambassadorAdmin(f) });
    if (config.mail.sendConfirmations) await sendMail({ to: f.email, ...templates.ambassadorConfirmation(f) });
    res.json({ success: true, msg: 'Thank you! Your application has been submitted.' });
  });

  router.post('/ContactUs-SubmitRequest', limit(), parse, async (req, res) => {
    const b = req.body;
    const f = {
      firstName: clean(b.contactFirstName, 80), lastName: clean(b.contactLastName, 80), email: clean(b.contactEmail, 254).toLowerCase(),
      phone: clean(b.contactPhone, 40), address: clean(b.contactAddress, 200), address2: clean(b.contactAddressTwo, 200), city: clean(b.contactCity, 100),
      state: clean(b.contactState, 40), zip: clean(b.contactZipCode, 20), orderNumber: clean(b.contactOrderNumber, 60), topic: clean(b.contactTopic, 120),
      comments: clean(b.contactComments, 5000),
    };
    if (!f.firstName || !f.lastName || !EMAIL_RE.test(f.email) || !f.comments) {
      return res.json({ success: false, msg: 'Please fill in your name, a valid email and your message.' });
    }
    record('contact', { ...f, ip: req.ip });
    await sendMail({ to: config.mail.to, replyTo: f.email, ...templates.contactAdmin(f) });
    if (config.mail.sendConfirmations) await sendMail({ to: f.email, ...templates.contactConfirmation(f) });
    res.json({ success: true, msg: 'Thank you! Your message has been sent. We’ll be in touch soon.' });
  });

  router.post('/OptoutDataCollection-SubmitRequest', limit(), parse, async (req, res) => {
    const b = req.body;
    const f = {
      firstName: clean(b.optoutDataCollectionFirstName, 80), lastName: clean(b.optoutDataCollectionLastName, 80),
      email: clean(b.optoutDataCollectionEmail, 254).toLowerCase(), optout: Boolean(b.optoutDataCollection), caNv: Boolean(b.optoutDataCollectionCaNvConsumer),
    };
    if (!f.firstName || !f.lastName || !EMAIL_RE.test(f.email)) return res.json({ success: false, msg: 'Please fill in your name and a valid email.' });
    record('optout', { ...f, ip: req.ip });
    await sendMail({ to: config.mail.to, replyTo: f.email, ...templates.optoutAdmin(f) });
    res.json({ success: true, msg: 'Thank you. Your opt-out request has been received.' });
  });

  return router;
}
