// Solutions4Society — automatic payment reminders (server side).
// Uses the SAME accounting engine as the app (engine.js is copied from the app at build time),
// and the same dues rule, wording and statement lines as Dues → 📧 Email reminders.
'use strict';
const ENG = require('./engine.js');

const r2 = ENG.r2;
// ── formatting: copied from the app (core.js, vouchers.js, masters.js, mail.js, print.js) ──
const fmt = (n, d = 2) => { n = +n || 0; const s = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }); return (n < -0.0049 ? '-' : '') + s; };
const fd = s => { if (!s) return ''; const [y, m, d] = String(s).split('-'); return `${d}-${m}-${y}`; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monLbl = s => { const [y, m] = String(s).split('-'); return MON[(+m || 1) - 1] + '-' + y; };
const perLbl = (f, t) => (f && t && f.slice(0, 7) !== t.slice(0, 7) ? monLbl(f) + ' to ' + monLbl(t) : monLbl(f));
const flatLbl = m => (m ? (m.wing ? m.wing + '-' : '') + (m.flat || '') : '');
const memLbl = m => (m ? flatLbl(m) + ' · ' + (m.name || '') : '');
const drcr = n => (Math.abs(n) < 0.005 ? '0.00' : fmt(Math.abs(n)) + (n > 0 ? ' Dr' : ' Cr'));
const TNAME = { R: 'Receipt', P: 'Payment', C: 'Contra', J: 'Journal', B: 'Bill', S: 'Supp. Bill' };
const chqDesc = v => { if (!v) return ''; const c = v.chq || {}; const b = []; if (c.no) b.push('Chq ' + c.no); else if (v.ref) b.push('Ref ' + v.ref); if (c.d) b.push('dt ' + fd(c.d)); if (c.bank) b.push(c.bank); return b.join(' · '); };
const fillT = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (v[k] == null ? '' : String(v[k]))).replace(/\n{3,}/g, '\n\n').trim();
const bankParts = st => { st = st || {}; if (!st.bankAc) return []; return [st.bankName, 'A/c No.: ' + st.bankAc, st.bankBranch && 'Branch: ' + st.bankBranch, st.bankType && 'Account type: ' + st.bankType, st.bankIfsc && 'IFSC: ' + st.bankIfsc].filter(Boolean); };
const socAddrLine = s => { s = s || {}; const a = [s.address, s.city].filter(Boolean).join(', '); return a + (s.pin ? (a ? ' - ' : '') + s.pin : ''); };
const socContactParts = s => { s = s || {}; return [s.phone && 'Mobile: ' + s.phone, s.email && 'Email ID: ' + s.email, s.pan && 'PAN: ' + s.pan, s.gstin && 'GSTIN: ' + s.gstin].filter(Boolean); };
const MAIL_DEF = {
  remSubj: 'Payment reminder — {society} — Flat {flat}',
  remBody: 'Dear {name},\n\nAs per the books of account of {society}, an amount of ₹ {amount} is outstanding against your flat {flat} as on {asof}.\n\nKindly pay the dues at the earliest to avoid further interest. Your account statement is attached for reference.\n\n{paydetails}\n\nIf you have already paid, please ignore this mail and share the payment details with the society office.\n\nRegards,\n{signatory}\n{society}',
  remPdf: true
};
const APP_URL = 'https://sas.shreedeepsolutions.com/';

// ── today in India ──
const todayIST = (now = Date.now()) => new Date(now + 5.5 * 3600e3).toISOString().slice(0, 10);

// ── load one society (only what the dues and statements need) ──
async function loadSociety(db, sid, today) {
  const g = async p => (await db.get(`societies/${sid}/${p}`)) || {};
  const [meta, fys, heads, members, bcfg] = await Promise.all(['meta', 'fys', 'heads', 'members', 'bcfg'].map(g));
  const keys = Object.keys(fys).sort(); if (!keys.length) throw new Error('No financial year in the books');
  const id = keys.find(k => fys[k].start <= today && fys[k].end >= today) || keys.filter(k => fys[k].start <= today).pop() || keys[keys.length - 1];
  const [ob, vch, bills, runs] = await Promise.all(['ob', 'vch', 'bills', 'runs'].map(k => g(`${k}/${id}`)));
  return { sid, meta, heads, members, bcfg, fy: { id, ...fys[id] }, vch, bills, runs, ob: { heads: ob.heads || {}, members: ob.members || {}, py: ob.py || {} } };
}

// ── same as the app: asOfNow() and duesData() (all wings) ──
const asOfFor = (S, today) => (today > S.fy.end ? S.fy.end : today < S.fy.start ? S.fy.start : today);
function duesList(S, L, asOf, minAmt) {
  const out = [];
  for (const [mid, m] of Object.entries(S.members || {})) {
    if (!m) continue; const r = ENG.replayMember(S, mid, { lines: L, asOf }); if (r.bal <= 0.005) continue;
    if (r.bal < minAmt) continue;
    out.push({ mid, m, P: r2(r.P + r.N), I: r.I, bal: r.bal });
  }
  return out.sort((a, b) => String(a.m.wing || '').localeCompare(String(b.m.wing || '')) || String(a.m.flat || '').localeCompare(String(b.m.flat || ''), undefined, { numeric: true }));
}

// ── same as the app's ledgerRows(mid) (statement lines for the whole year; transfer notes left out) ──
function ledgerRows(S, L, mid) {
  const r = ENG.replayMember(S, mid, { lines: L }); const ob = r.ob; let b = r2(ob.p + ob.n + ob.i);
  const rows = [{ d: S.fy.start, p: 'Opening balance', dr: b > 0 ? b : 0, cr: b < 0 ? -b : 0, b }];
  for (const t of r.timeline) {
    if (t.kind === 'line') { const v = S.vch[t.id]; b = r2(b + (t.dr || 0) - (t.cr || 0)); const cd = chqDesc(v); rows.push({ d: t.d, p: `${v ? (v.t === 'R' ? 'Received' : v.t === 'J' ? 'Adjustment' : TNAME[v.t]) : ''} ${t.no || ''} ${v && v.mode ? '(' + v.mode + ')' : ''}${cd ? ' – ' + cd : ''}${v && v.bnc ? ' – cheque bounced' : ''}${v && v.rev ? ' – bounce reversal' : ''}`.replace(/\s+/g, ' ').trim(), nar: v && v.nar || '', dr: t.dr || 0, cr: t.cr || 0, b }); }
    else { const bl = S.bills[t.id]; b = r2(b + t.dr); rows.push({ d: t.d, p: `${bl.supp ? 'Supplementary bill' : 'Bill'} ${bl.no} – ${bl.supp ? (bl.desc || '') : perLbl(bl.from, bl.to)}${bl.int ? ` (incl. interest ₹${fmt(bl.int)})` : ''}`, dr: t.dr, cr: 0, b }); }
  }
  return { rows, bal: r.bal };
}

function billSettings(S) { return { sign: 'Hon. Secretary / Treasurer', ...(((S.meta || {}).settings || {}).bill || {}) }; }
function payDetails(S) { const st = billSettings(S); const b = [];
  if (st.upi) b.push(`Pay by UPI: ${st.upi}`); if (st.bankAc) b.push(`Bank transfer (NEFT/RTGS/IMPS): ${bankParts(st).join(', ')}`);
  return b.length ? 'Payment details:\n' + b.join('\n') + '\nPlease mention your flat no. in the payment remarks.' : ''; }
const mailSet = S => ({ ...MAIL_DEF, ...((((S.meta || {}).settings || {}).mail) || {}) });

// one reminder (subject, text, statement data) — mirrors mailReminders() in the app
function buildReminder(S, L, x, asOf) {
  const c = mailSet(S); const st = billSettings(S);
  const link = x.m.tok ? APP_URL + '?l=' + x.m.tok : '';
  const v = { name: x.m.name, flat: flatLbl(x.m), amount: fmt(x.bal), principal: fmt(x.P), interest: fmt(x.I), asof: fd(asOf), paydetails: payDetails(S), ledgerlink: link ? 'View your account statement online: ' + link : '', society: S.meta.name || '', signatory: st.sign || 'Hon. Secretary / Treasurer' };
  const stmt = c.remPdf !== false ? { ...ledgerRows(S, L, x.mid), member: memLbl(x.m), fy: S.fy.label, asOf } : null;
  return { mid: x.mid, to: String(x.m.email || '').trim(), subject: fillT(c.remSubj, v), text: fillT(c.remBody, v), cc: c.cc || '', replyTo: c.replyTo || (S.meta.email || ''), pdfName: `Statement_${flatLbl(x.m)}.pdf`.replace(/[^\w.\-]+/g, '_'), stmt, amount: x.bal };
}

module.exports = { ENG, todayIST, loadSociety, asOfFor, duesList, ledgerRows, buildReminder, payDetails, fmt, fd, drcr, flatLbl, memLbl, socAddrLine, socContactParts, billSettings };
