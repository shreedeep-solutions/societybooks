// Runs the payment reminders of one society: find members who owe, email each one (with statement PDF), keep a log.
'use strict';
const nodemailer = require('nodemailer');
const R = require('./reminders.js');
const { statementPdf } = require('./pdf.js');

const ROLE_OK = ['admin', 'accountant'];
const DAY_CAP = 450;               // Gmail allows ~500 a day per account; keep a margin
const makeMailer = c => nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: c.user, pass: c.pass }, pool: true, maxConnections: 1, maxMessages: 80 });

// societies whose day has come this month (from the small index the app keeps), not yet done
async function dueSocieties(db, today = R.todayIST()) {
  const idx = (await db.get('rsIndex')) || {}; const ym = today.slice(0, 7); const d = +today.slice(8, 10); const out = [];
  for (const [sid, x] of Object.entries(idx)) {
    if (!x || !x.on || !x.auto || !(d >= +x.day)) continue;
    const last = await db.get(`societies/${sid}/bcfg/_rs/last`); if (last === ym) continue;
    const done = await db.get(`societies/${sid}/rslog/${ym}/done`); if (done) continue;
    out.push(sid);
  }
  return out;
}

async function runSociety(db, sid, o = {}) {
  const today = o.today || R.todayIST(); const ym = today.slice(0, 7); const t0 = Date.now();
  const cred = await db.get(`mailSecrets/${sid}`);
  const logP = `societies/${sid}/rslog/${ym}`;
  if (!cred || !cred.user || !cred.pass) { if (o.mode !== 'test') await db.update({ [`${logP}/err`]: 'Gmail is not set up for automatic reminders', [`${logP}/at`]: Date.now() }); throw new Error('Set up the society Gmail first (Dues → ⏰ Schedule)'); }
  const S = await R.loadSociety(db, sid, today); const rs = (S.bcfg || {})._rs || {};
  const asOf = R.asOfFor(S, today); const L = R.ENG.ledger(S); const D = R.duesList(S, L, asOf, +rs.min || 1);
  const mailer = o.mailer || makeMailer(cred); const from = { name: String(S.meta.name || 'Housing Society').slice(0, 80), address: cred.user };
  const send = async (rem, to, subjPrefix) => {
    const msg = { from, to, subject: (subjPrefix || '') + rem.subject, text: rem.text, replyTo: rem.replyTo || undefined, cc: subjPrefix ? undefined : (rem.cc || undefined) };
    if (rem.stmt) msg.attachments = [{ filename: rem.pdfName, content: await statementPdf(S.meta, rem.stmt), contentType: 'application/pdf' }];
    return mailer.sendMail(msg);
  };
  try {
    if (o.mode === 'test') {
      const x = D.find(y => y.m.email) || D[0]; if (!x) return { test: true, msg: `Nobody owes ₹${+rs.min || 1} or more as on ${R.fd(asOf)} — nothing to test with.` };
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(o.to)) throw new Error('No email to send the test to');
      const rem = R.buildReminder(S, L, x, asOf); await send(rem, o.to, '[TEST] ');
      return { test: true, msg: `Test sent to ${o.to} — sample for flat ${R.flatLbl(x.m)} (₹${R.fmt(x.bal)}), from ${cred.user}.`, owing: D.length };
    }
    // one run at a time per society
    if (!(await db.lock(`${logP}/lock`, 12 * 60e3))) return { busy: true, msg: 'Reminders are already being sent — try again in a few minutes.' };
    try {
      const prev = (await db.get(`${logP}/items`)) || {};
      const sentToday = Object.values(prev).filter(v => v && v.ok && R.todayIST(v.at) === today).length;
      let sent = 0, failed = 0, skipped = 0, noEmail = 0, stopped = '';
      for (const x of D) {
        if (prev[x.mid] && prev[x.mid].ok) { skipped++; continue; }
        const rem = R.buildReminder(S, L, x, asOf);
        if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(rem.to)) { noEmail++; await db.update({ [`${logP}/items/${x.mid}`]: { ok: false, noEmail: true, amt: x.bal, at: Date.now() } }); continue; }
        if (sentToday + sent >= DAY_CAP) { stopped = 'Gmail daily limit — the rest go tomorrow'; break; }
        if (o.budgetMs && Date.now() - t0 > o.budgetMs) { stopped = 'time — the rest go in the next hourly run'; break; }
        try { await send(rem, rem.to); sent++; await db.update({ [`${logP}/items/${x.mid}`]: { ok: true, to: rem.to, amt: x.bal, at: Date.now() } }); }
        catch (e) { failed++; await db.update({ [`${logP}/items/${x.mid}`]: { ok: false, to: rem.to, amt: x.bal, at: Date.now(), err: String(e.message || e).slice(0, 160) } });
          if (/Invalid login|Username and Password not accepted|auth/i.test(String(e.message))) { stopped = 'Gmail refused the login — set the app password again'; break; } }
      }
      const finished = !stopped; const up = { [`${logP}/at`]: Date.now(), [`${logP}/mode`]: o.mode || 'auto', [`${logP}/asOf`]: asOf, [`${logP}/owing`]: D.length, [`${logP}/err`]: stopped || null };
      if (finished) { up[`${logP}/done`] = Date.now(); up[`societies/${sid}/bcfg/_rs/last`] = ym; }
      await db.update(up);
      return { sent, failed, skipped, noEmail, owing: D.length, finished, stopped, msg: `${sent} reminder(s) sent${failed ? `, ${failed} failed` : ''}${noEmail ? `, ${noEmail} without email` : ''}${skipped ? `, ${skipped} already sent this month` : ''}${stopped ? ` — stopped: ${stopped}` : ''}.` };
    } finally { await db.unlock(`${logP}/lock`); }
  } finally { if (!o.mailer) try { mailer.close(); } catch (e) { } }
}

module.exports = { runSociety, dueSocieties, makeMailer, ROLE_OK, DAY_CAP };
