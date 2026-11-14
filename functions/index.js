// Solutions4Society backend — Cloud Functions (2nd gen), same region as the database (Singapore).
// Deployed automatically by .github/workflows/backend.yml when anything in functions/ changes.
'use strict';
const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const { runSociety, dueSocieties, makeMailer, ROLE_OK } = require('./runner.js');

setGlobalOptions({ region: 'asia-southeast1', maxInstances: 2, memory: '256MiB' });
admin.initializeApp();
const rtdb = () => admin.database();
const DB = {
  get: async p => (await rtdb().ref(p).get()).val(),
  update: o => rtdb().ref().update(o),
  lock: async (p, ms) => { const r = await rtdb().ref(p).transaction(v => (v && Date.now() - v < ms ? undefined : Date.now())); return r.committed; },
  unlock: p => rtdb().ref(p).remove()
};
const ORIGINS = [/^https:\/\/([a-z0-9-]+\.)*shreedeepsolutions\.com$/, /^https:\/\/shreedeep-solutions\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

// Health check: https://asia-southeast1-mysocietybooks.cloudfunctions.net/health
exports.health = onRequest({ cors: true }, (req, res) => { res.json({ ok: true, service: 'S4S backend', version: '1.1.0', time: new Date().toISOString() }); });

// App → server. Every call: signed-in user who is admin / accountant of that society.
exports.remApi = onRequest({ cors: ORIGINS, memory: '512MiB', timeoutSeconds: 300 }, async (req, res) => {
  const fail = (code, msg) => res.status(code).json({ ok: false, err: msg });
  try {
    if (req.method !== 'POST') return fail(405, 'POST only');
    const tok = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!tok) return fail(401, 'Please sign in again');
    let user; try { user = await admin.auth().verifyIdToken(tok); } catch (e) { return fail(401, 'Your sign-in has expired — reload the page'); }
    const b = req.body || {}; const sid = String(b.sid || '');
    if (!/^[\w-]{4,40}$/.test(sid)) return fail(400, 'Society missing');
    const role = await DB.get(`societies/${sid}/meta/access/${user.uid}/r`);
    if (!ROLE_OK.includes(role)) return fail(403, 'Only the society admin or accountant can do this');
    const res_ = await api(b.action, sid, b, user);
    res.json({ ok: true, ...res_ });
  } catch (e) { console.error('remApi', e); fail(400, e.message || String(e)); }
});

async function api(action, sid, b, user) {
  if (action === 'info') {
    const c = await DB.get(`mailSecrets/${sid}`); const idx = await DB.get(`rsIndex/${sid}`);
    return { cred: c ? { user: c.user, at: c.at } : null, idx: idx || null };
  }
  if (action === 'cred') {
    const u = String(b.user || '').trim().toLowerCase(); const p = String(b.pass || '').replace(/\s+/g, '');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(u)) throw new Error('Enter the Gmail address');
    if (!/^[a-z]{16}$/i.test(p)) throw new Error('A Gmail app password is 16 letters (Google shows it in 4 groups of 4) — not your normal Gmail password');
    try { await makeMailer({ user: u, pass: p }).verify(); } catch (e) { throw new Error('Gmail did not accept this login. Check the address and create a new app password. (' + String(e.message || e).slice(0, 120) + ')'); }
    await DB.update({ [`mailSecrets/${sid}`]: { user: u, pass: p, at: Date.now(), by: user.uid } });
    return { cred: { user: u, at: Date.now() } };
  }
  if (action === 'credDel') { await DB.update({ [`mailSecrets/${sid}`]: null }); return { cred: null }; }
  if (action === 'sched') {
    const day = Math.round(+b.day); if (b.on && !(day >= 1 && day <= 28)) throw new Error('Day must be 1 to 28');
    const v = b.on ? { on: true, auto: !!b.auto, day, min: Math.max(1, +b.min || 1), at: Date.now() } : null;
    await DB.update({ [`rsIndex/${sid}`]: v }); return { idx: v };
  }
  if (action === 'test') return runSociety(DB, sid, { mode: 'test', to: String(b.to || user.email || '').trim() });
  if (action === 'now') return runSociety(DB, sid, { mode: 'now', budgetMs: 250e3 });
  throw new Error('Unknown action');
}

// Every hour 9 AM – 7 PM (India): societies whose reminder day has come and that are not done for this month.
exports.remRun = onSchedule({ schedule: '15 9-19 * * *', timeZone: 'Asia/Kolkata', timeoutSeconds: 540, memory: '512MiB', retryCount: 0 }, async () => {
  const t0 = Date.now(); const list = await dueSocieties(DB);
  for (const sid of list) {
    const left = 500e3 - (Date.now() - t0); if (left < 30e3) break;
    try { const r = await runSociety(DB, sid, { mode: 'auto', budgetMs: left - 20e3 }); console.log('reminders', sid, JSON.stringify(r).slice(0, 300)); } catch (e) { console.error('reminders', sid, e.message); }
  }
});
