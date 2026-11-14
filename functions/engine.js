// ═══════════════════════════════════════════════════════════════════════
// ENGINE — pure accounting functions (no DOM, no Firebase). Testable in Node.
// Sign convention everywhere: positive = Debit, negative = Credit.
// ═══════════════════════════════════════════════════════════════════════
const ENG = (() => {
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const PERIODS = {
    Monthly: { m: 1, div: 12, max: 12 },
    'Bi-monthly': { m: 2, div: 6, max: 6 },
    Quarterly: { m: 3, div: 4, max: 4 },
    'Half-yearly': { m: 6, div: 2, max: 2 },
    Yearly: { m: 12, div: 1, max: 1 },
  };
  const periodInfo = p => PERIODS[p] || PERIODS.Monthly;
  const vals = o => (o ? (Array.isArray(o) ? o.filter(Boolean) : Object.keys(o).sort((a, b) => (+a) - (+b)).map(k => o[k]).filter(Boolean)) : []);
  const ents = o => Object.entries(o || {});

  // Interest exactly as the Excel working: ROUND(IF(balance<0,0, principal*rate/divisor),0)
  function calcInterest(P, N, I, rate, period) {
    if (!rate) return 0;
    if (P + N + I < 0) return 0;
    return Math.round(Math.max(P, 0) * rate / 100 / periodInfo(period).div);
  }

  function ids(S) {
    const out = {};
    for (const [id, h] of ents(S.heads)) if (h && h.tag && !out[h.tag]) out[h.tag] = id;
    return out;
  }

  // GST on a member's bill: whole bill taxable once monthly equivalent exceeds the limit
  function gstFor(ch, heads, gs, months) {
    if (!gs || !gs.on) return null;
    let base = 0;
    for (const [hid, a] of ents(ch)) { const h = heads[hid]; if (h && h.bill && h.bill.gst !== false) base += +a || 0; }
    base = r2(base);
    if (base <= 0 || base / (months || 1) <= (+gs.limit || 0)) return null;
    const half = r2(base * (+gs.rate || 18) / 200);
    return { base, c: half, s: half };
  }

  // Ledger lines of a bill (bills are posted directly from the bill record — no separate voucher to drift)
  function billLines(b, I) {
    const L = []; let tot = 0;
    const add = (h, amt) => { amt = r2(amt); if (!amt) return; if (amt > 0) L.push({ h, cr: amt }); else L.push({ h, dr: -amt }); tot += amt; };
    for (const [hid, a] of ents(b.ch)) add(hid, a);
    if (b.int) add(I.int, b.int);
    if (b.gst) { add(I.cgst, b.gst.c); add(I.sgst, b.gst.s); }
    tot = r2(tot);
    if (tot >= 0) L.unshift({ h: I.dues, m: b.mid, dr: tot }); else L.unshift({ h: I.dues, m: b.mid, cr: -tot });
    return { lines: L, total: tot };
  }
  const billTotal = b => billLines(b, { dues: 'D', int: 'I', cgst: 'C', sgst: 'S' }).total;

  // All ledger lines for the loaded FY
  function ledger(S) {
    const I = ids(S); const out = [];
    for (const [id, v] of ents(S.vch)) {
      if (!v) continue;
      vals(v.lines).forEach((l, i) => {
        out.push({ src: 'v', id, t: v.t, no: v.no, d: v.d, nar: v.nar || '', mode: v.mode || '', ref: v.ref || '', h: l.h, m: l.m || null, al: l.al || '', dr: r2(l.dr), cr: r2(l.cr), li: i, bnc: !!v.bnc, rev: v.rev || null, at: v.at || 0 });
      });
    }
    for (const [id, b] of ents(S.bills)) {
      if (!b) continue;
      billLines(b, I).lines.forEach((l, i) => {
        out.push({ src: 'b', id, t: b.supp ? 'S' : 'B', no: b.no, d: b.d, nar: (b.supp ? 'Supplementary bill ' : 'Bill ') + (b.no || '') + (b.desc ? ' – ' + b.desc : ''), mode: '', ref: '', h: l.h, m: l.m || null, al: '', dr: r2(l.dr), cr: r2(l.cr), li: i, bnc: false, rev: null, at: b.at || 0 });
      });
    }
    out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : (a.src === b.src ? 0 : a.src === 'b' ? -1 : 1) || (a.at - b.at) || String(a.no).localeCompare(String(b.no))));
    return out;
  }

  const memberOB = (S, mid) => { const o = ((S.ob || {}).members || {})[mid] || {}; return { p: +o.p || 0, n: +o.n || 0, i: +o.i || 0 }; };
  const sumMemberOB = S => ents(S.members).reduce((s, [mid]) => { const o = memberOB(S, mid); return s + o.p + o.n + o.i; }, 0);

  // Opening balance of a head (dues control head = sum of member openings, never typed)
  function headOB(S, hid, I) {
    I = I || ids(S);
    if (hid === I.dues) return r2(sumMemberOB(S));
    return r2(((S.ob || {}).heads || {})[hid] || 0);
  }

  // Balances per head; asOf (inclusive) optional; from (inclusive) optional for movements
  function balances(S, opt = {}) {
    const I = ids(S); const L = opt.lines || ledger(S); const res = {};
    for (const hid of Object.keys(S.heads || {})) res[hid] = { ob: headOB(S, hid, I), pre: 0, dr: 0, cr: 0, cl: 0 };
    for (const l of L) {
      if (!res[l.h]) res[l.h] = { ob: 0, pre: 0, dr: 0, cr: 0, cl: 0, orphan: true };
      if (opt.asOf && l.d > opt.asOf) continue;
      if (opt.from && l.d < opt.from) { res[l.h].pre += l.dr - l.cr; continue; }
      res[l.h].dr += l.dr; res[l.h].cr += l.cr;
    }
    for (const r of Object.values(res)) { r.pre = r2(r.pre); r.dr = r2(r.dr); r.cr = r2(r.cr); r.cl = r2(r.ob + r.pre + r.dr - r.cr); }
    return res;
  }

  // ── Member replay: principal (P, interest-bearing), N (non-interest), I (interest) ──
  // v12.2 speed: bills and dues-head lines grouped by member ONCE per ledger build (same items, same order as a full scan)
  // cache lives only as long as one ledger build (L) AND the same bills object — any change gives a fresh index
  const MIX_B = new WeakMap(), MIX_L = new WeakMap();
  function billsByMember(bills, L) { if (!bills || typeof bills !== 'object') return {}; const c = L && MIX_B.get(L); if (c && c.bills === bills) return c.x; const x = {};
    for (const [id, b] of ents(bills)) if (b) (x[b.mid] || (x[b.mid] = [])).push([id, b]); if (L) MIX_B.set(L, { bills, x }); return x; }
  function duesLinesByMember(L, dues) { let c = MIX_L.get(L); if (c && c.dues === dues) return c.x; const x = {};
    for (const l of L) if (l.src === 'v' && l.h === dues && l.m != null) (x[l.m] || (x[l.m] = [])).push(l); MIX_L.set(L, { dues, x }); return x; }
  function memberEvents(S, mid, L, I) {
    const ev = [];
    for (const [id, b] of (billsByMember(S.bills, L)[mid] || [])) ev.push({ kind: 'bill', d: b.d, at: b.at || 0, id, b });
    for (const l of (duesLinesByMember(L, I.dues)[mid] || [])) {
      if (l.src !== 'v' || l.h !== I.dues || l.m !== mid) continue;
      ev.push({ kind: 'line', d: l.d, at: l.at, id: l.id, l, skip: l.bnc || !!l.rev });
    }
    ev.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : (a.kind === b.kind ? 0 : a.kind === 'bill' ? -1 : 1) || (a.at - b.at)));
    return ev;
  }

  // ── Due-date interest (methods B, C, D) ───────────────────────────────
  // A: per bill on principal arrears (Excel method)            → rate ÷ periods per year
  // B: if paid after due date, day-wise from BILL date          → rate × days ÷ 365 (bill date = day 1)
  // C: if paid after due date, day-wise from the day after DUE  → rate × days ÷ 365
  // D: if paid after due date, full period                      → rate ÷ periods per year
  // Unpaid amounts keep attracting interest to the end of each bill period. Each part payment is
  // treated separately. Interest is charged on the next regular bill and rounded to the rupee.
  const IM = { A: 'Per bill on arrears', B: 'Late payment – from bill date (day-wise)', C: 'Late payment – from due date (day-wise)', D: 'Late payment – full period' };
  const dn = s => { const [y, m, d] = String(s).split('-').map(Number); return Math.round(Date.UTC(y, (m || 1) - 1, d || 1) / 864e5); };
  const dstr = n => new Date(n * 864e5).toISOString().slice(0, 10);
  const addDays = (s, k) => dstr(dn(s) + k);
  const billSet = S => ((S.meta || {}).settings || {}).billing || {};

  function mkLot(amt, d, due, ob) { return { ob: !!ob, amt: r2(amt), d, due: due || d, ctB: dn(d) - 1, ctC: dn(due || d), pays: [] }; }
  // Interest on lots for the slice [s, e] (inclusive). consume=true advances the lots (real billing).
  function accrue(lots, s, e, sliceDue, rate, per, im, consume, det) {
    let raw = 0; if (!rate || !im || im === 'A') { if (consume) for (const l of lots) { l.pays = []; } return 0; }
    const sN = dn(s), eN = dn(e); if (eN < sN && !lots.some(l => l.pays.length)) return 0;
    const div = periodInfo(per).div;
    for (const l of lots) {
      const parts = l.pays.map(x => ({ amt: x.amt, p: dn(x.d), pd: x.d })); if (l.amt > 0.004) parts.push({ amt: l.amt, p: null });
      const dueN = dn(l.due);
      if (im === 'D') {
        const cut = dn(l.d) >= sN ? dueN : (sliceDue ? dn(sliceDue) : sN - 1);
        for (const x of parts) {
          const late = x.p === null ? eN > cut && eN >= sN : x.p > cut;
          if (late) { const v = x.amt * rate / 100 / div; raw += v; if (det) det.push({ ob: l.ob, lot: l.d, amt: r2(x.amt), from: s, to: x.p === null ? e : x.pd, days: null, int: r2(v), paid: x.p !== null }); }
        }
        if (consume && l.amt > 0.004 && eN >= sN) { l.ctB = Math.max(l.ctB, eN); l.ctC = Math.max(l.ctC, eN); }
      } else {
        const key = im === 'C' ? 'ctC' : 'ctB'; const ct = l[key];
        for (const x of parts) {
          const end = x.p === null ? eN : x.p;
          if (x.p === null ? eN <= dueN : x.p <= dueN) continue; // not late (yet)
          const days = end - ct; if (days <= 0) continue;
          const v = x.amt * rate / 100 * days / 365; raw += v;
          if (det) det.push({ ob: l.ob, lot: l.d, amt: r2(x.amt), from: dstr(ct + 1), to: dstr(end), days, int: r2(v), paid: x.p !== null });
        }
        if (consume && l.amt > 0.004 && eN > dueN && eN > ct) { l.ctB = Math.max(l.ctB, eN); l.ctC = Math.max(l.ctC, eN); }
      }
      if (consume) l.pays = [];
    }
    if (consume) for (let i = lots.length - 1; i >= 0; i--) if (lots[i].amt <= 0.004 && !lots[i].pays.length) lots.splice(i, 1);
    return raw;
  }
  const cloneLots = lots => lots.map(l => ({ ...l, pays: l.pays.map(x => ({ ...x })) }));

  function replayMember(S, mid, opt = {}) {
    const I = ids(S); const L = opt.lines || ledger(S); const heads = S.heads || {};
    const ob = memberOB(S, mid); const bs = billSet(S);
    const fyStart = (S.fy && S.fy.start) || '2000-01-01', fyEnd = (S.fy && S.fy.end) || '2999-12-31';
    let P = ob.p, N = ob.n, Iv = ob.i;
    const bills = {}; const changes = []; const timeline = [];
    // principal lots for due-date interest
    const obFrom = bs.obFrom && bs.obFrom >= fyStart ? bs.obFrom : fyStart;
    const lots = []; if (P > 0) lots.push(mkLot(P, obFrom, addDays(obFrom, -1), true));
    const ai = +((((S.ob || {}).members || {})[mid] || {}).ai) || 0; let firstReg = true;
    let sStart = fyStart, sDue = null, lastRate = +bs.rate || 0, lastPer = bs.per || 'Monthly', lastIm = bs.im || 'A';
    const syncLots = (before, d, due) => {
      const a = Math.max(0, r2(before)), b = Math.max(0, r2(P));
      if (b > a + 0.004) lots.push(mkLot(b - a, d, due));
      else if (b < a - 0.004) { let red = r2(a - b); for (const l of lots) { if (red <= 0) break; const x = Math.min(l.amt, red); if (x > 0) { l.amt = r2(l.amt - x); l.pays.push({ d, amt: r2(x) }); red = r2(red - x); } } }
    };
    const norm = () => {
      if (P < 0 && Iv > 0) { const t = Math.min(-P, Iv); P += t; Iv -= t; }
      if (P < 0 && N > 0) { const t = Math.min(-P, N); P += t; N -= t; }
      P = r2(P); N = r2(N); Iv = r2(Iv);
    };
    for (const e of memberEvents(S, mid, L, I)) {
      if (opt.asOf && e.d > opt.asOf) break;
      if (opt.before && e.d >= opt.before) break;
      const P0 = P;
      if (e.kind === 'bill') {
        const b = e.b; const pre = { P, N, I: Iv, tot: r2(P + N + Iv) };
        let exp = null, int = +b.int || 0, idet = null; const im = b.im || 'A';
        if (!b.supp) {
          idet = [];
          const raw = accrue(lots, sStart, addDays(b.d, -1), sDue, +b.rate || 0, b.per, im, true, idet);
          if (b.rate > 0) exp = im === 'A' ? calcInterest(P, N, Iv, b.rate, b.per) : Math.round(raw + (firstReg ? ai : 0) + 1e-9);
          if (im !== 'A' && firstReg && ai) idet.unshift({ lot: 'b/f', amt: null, from: '', to: '', days: null, int: r2(ai), bf: true });
          firstReg = false; sStart = b.d; sDue = b.due || null; lastRate = +b.rate || 0; lastPer = b.per; lastIm = im;
        }
        if (opt.recalc && exp !== null && !b.intManual && !(opt.lock && b.d <= opt.lock)) {
          if (Math.abs(exp - int) > 0.001) changes.push({ bid: e.id, old: int, new: exp });
          int = exp;
        }
        Iv += int;
        let ch = 0;
        for (const [hid, a] of ents(b.ch)) {
          const amt = +a || 0; ch += amt;
          const h = heads[hid] || {};
          const bearing = (!h.bill || h.bill.int !== false) && !h.noInt && (!b.supp || !!b.suppInt);
          if (bearing) P += amt; else N += amt;
        }
        const g = b.gst ? r2((+b.gst.c || 0) + (+b.gst.s || 0)) : 0;
        N += g; norm(); syncLots(P0, b.d, b.due || b.d);
        bills[e.id] = { arrears: pre.tot, pre, exp, int, ch: r2(ch), gst: g, current: r2(ch + g + int), payable: r2(pre.tot + ch + g + int), post: { P, N, I: Iv }, im, idet };
        timeline.push({ d: e.d, kind: b.supp ? 'supp' : 'bill', id: e.id, no: b.no, dr: r2(ch + g + int), cr: 0, P, N, I: Iv });
      } else {
        const l = e.l;
        if (!e.skip) {
          if (l.cr) {
            let c = l.cr;
            if (l.al === 'I') Iv -= c; else if (l.al === 'N') N -= c; else if (l.al === 'P') P -= c;
            else {
              let x = Math.min(c, Math.max(Iv, 0)); Iv -= x; c -= x;
              x = Math.min(c, Math.max(P, 0)); P -= x; c -= x;
              x = Math.min(c, Math.max(N, 0)); N -= x; c -= x;
              P -= c;
            }
          }
          if (l.dr) { if (l.al === 'I') Iv += l.dr; else if (l.al === 'N') N += l.dr; else P += l.dr; }
          norm(); syncLots(P0, e.d, e.d);
        }
        timeline.push({ d: e.d, kind: 'line', id: e.id, t: l.t, no: l.no, dr: l.dr, cr: l.cr, skip: e.skip, P, N, I: Iv });
      }
    }
    // Interest accrued but not yet billed (due-date methods) – for the next bill / year-end
    const pend = (to, rate, per, im) => { im = im || lastIm; if (im === 'A') return 0; return r2(accrue(cloneLots(lots), sStart, to, sDue, rate == null ? lastRate : rate, per || lastPer, im, false, null) + (firstReg ? ai : 0)); };
    const res = { P: r2(P), N: r2(N), I: r2(Iv), bal: r2(P + N + Iv), bills, changes, timeline, ob, lots, pend, im: lastIm };
    if (opt.planBill) { const pb = opt.planBill; const d = []; res.planDet = d; res.planInt = (pb.im || 'A') === 'A' ? calcInterest(P, N, Iv, pb.rate, pb.per) : Math.round(accrue(cloneLots(lots), sStart, addDays(pb.d, -1), sDue, pb.rate, pb.per, pb.im, false, d) + (firstReg ? ai : 0) + 1e-9); if (pb.im !== 'A' && firstReg && ai) d.unshift({ lot: 'b/f', int: r2(ai), bf: true }); }
    if (!opt.asOf && !opt.before && lastIm !== 'A') res.accrued = pend(fyEnd);
    return res;
  }

  // FIFO: which bills are paid / partly paid; ageing of unpaid amounts
  function fifo(S, mid, opt = {}) {
    const I = ids(S); const L = opt.lines || ledger(S);
    const ob = memberOB(S, mid); const obt = r2(ob.p + ob.n + ob.i);
    const deb = []; let credit = 0;
    if (obt > 0) deb.push({ d: S.fy ? S.fy.start : '', amt: obt, ref: 'OB' }); else credit += -obt;
    for (const [id, b] of (billsByMember(S.bills, L)[mid] || [])) {
      if (!b || b.mid !== mid || (opt.asOf && b.d > opt.asOf)) continue;
      const t = billTotal(b); if (t > 0) deb.push({ d: b.d, amt: t, ref: id }); else credit += -t;
    }
    for (const l of (duesLinesByMember(L, I.dues)[mid] || [])) {
      if (l.src !== 'v' || l.h !== I.dues || l.m !== mid || l.bnc || l.rev) continue;
      if (opt.asOf && l.d > opt.asOf) continue;
      if (l.dr) deb.push({ d: l.d, amt: l.dr, ref: l.id }); if (l.cr) credit += l.cr;
    }
    deb.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const out = {}; const open = [];
    for (const x of deb) {
      const paid = r2(Math.min(x.amt, credit)); credit = r2(credit - paid);
      const bal = r2(x.amt - paid);
      out[x.ref] = { amt: x.amt, paid, bal, status: bal <= 0.005 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid' };
      if (bal > 0.005) open.push({ d: x.d, bal, ref: x.ref });
    }
    return { items: out, open, advance: r2(credit) };
  }

  function ageing(open, asOf) {
    const b = { a: 0, b: 0, c: 0, d: 0 };
    const t = new Date(asOf + 'T00:00:00');
    for (const o of open) {
      const days = Math.floor((t - new Date((o.d || asOf) + 'T00:00:00')) / 86400000);
      if (days <= 90) b.a += o.bal; else if (days <= 180) b.b += o.bal; else if (days <= 365) b.c += o.bal; else b.d += o.bal;
    }
    for (const k in b) b[k] = r2(b[k]);
    return b;
  }

  // ── Final accounts ──────────────────────────────────────────────────
  function memberBalances(S, opt = {}) {
    const L = opt.lines || ledger(S); const out = {};
    for (const mid of Object.keys(S.members || {})) out[mid] = replayMember(S, mid, { lines: L, asOf: opt.asOf });
    return out;
  }

  function trialBalance(S, asOf) {
    const L = ledger(S); const bal = balances(S, { asOf, lines: L });
    const rows = []; let odr = 0, ocr = 0, cdr = 0, ccr = 0, tdr = 0, tcr = 0;
    for (const [hid, b] of ents(bal)) {
      const h = S.heads[hid] || { name: '(deleted head)', grp: '?', code: '' };
      if (!b.ob && !b.dr && !b.cr && !b.pre && !b.cl) continue;
      const op = r2(b.ob + b.pre);
      rows.push({ hid, h, op, dr: b.dr, cr: b.cr, cl: b.cl });
      if (op > 0) odr += op; else ocr -= op;
      tdr += b.dr; tcr += b.cr;
      if (b.cl > 0) cdr += b.cl; else ccr -= b.cl;
    }
    const order = { Liabilities: 1, Assets: 2, Income: 3, Expenses: 4 };
    rows.sort((a, b) => (order[a.h.grp] || 9) - (order[b.h.grp] || 9) || String(a.h.code || '').localeCompare(String(b.h.code || '')));
    return { rows, odr: r2(odr), ocr: r2(ocr), tdr: r2(tdr), tcr: r2(tcr), cdr: r2(cdr), ccr: r2(ccr), diff: r2(cdr - ccr), obDiff: r2(odr - ocr) };
  }

  function incomeExpenditure(S, asOf) {
    const bal = balances(S, { asOf });
    const inc = [], exp = []; let ti = 0, te = 0;
    for (const [hid, b] of ents(bal)) {
      const h = S.heads[hid]; if (!h) continue;
      if (h.grp === 'Income') { const a = r2(-b.cl); if (a) { inc.push({ hid, h, sub: h.sub || 'Other Income', amt: a }); ti += a; } }
      else if (h.grp === 'Expenses') { const a = r2(b.cl); if (a) { exp.push({ hid, h, sub: h.sub || 'Other Expenses', amt: a }); te += a; } }
    }
    const subOrder = s => (s === 'Contribution from Members' ? 0 : 1);
    const sorter = (a, b) => subOrder(a.sub) - subOrder(b.sub) || a.sub.localeCompare(b.sub) || ((a.h.bill && a.h.bill.order) || 0) - ((b.h.bill && b.h.bill.order) || 0) || String(a.h.code).localeCompare(String(b.h.code));
    inc.sort(sorter); exp.sort(sorter);
    return { inc, exp, ti: r2(ti), te: r2(te), surplus: r2(ti - te) };
  }

  function balanceSheet(S, asOf) {
    const I = ids(S); const L = ledger(S); const bal = balances(S, { asOf, lines: L });
    const ie = incomeExpenditure(S, asOf);
    const assets = [], liabs = []; let ta = 0, tl = 0;
    for (const [hid, b] of ents(bal)) {
      const h = S.heads[hid]; if (!h || hid === I.dues || hid === I.ie) continue;
      if (h.grp === 'Assets' && b.cl) { assets.push({ hid, h, sub: h.sub || 'Current Assets', amt: b.cl }); ta += b.cl; }
      if (h.grp === 'Liabilities' && b.cl) { liabs.push({ hid, h, sub: h.sub || 'Current Liabilities', amt: r2(-b.cl) }); tl -= b.cl; }
    }
    const mb = memberBalances(S, { asOf, lines: L });
    const dues = [], adv = []; let td = 0, tadv = 0;
    for (const [mid, r] of ents(mb)) {
      const m = S.members[mid]; if (!m) continue;
      if (r.bal > 0.005) { dues.push({ mid, m, amt: r.bal, P: r.P, N: r.N, I: r.I }); td += r.bal; }
      else if (r.bal < -0.005) { adv.push({ mid, m, amt: r2(-r.bal) }); tadv -= r.bal; }
    }
    // Orphan dues lines (no member) still belong to the control account
    let orphan = 0; for (const l of L) if (l.h === I.dues && !l.m && (!asOf || l.d <= asOf)) orphan += l.dr - l.cr;
    orphan = r2(orphan);
    ta += td + (orphan > 0 ? orphan : 0); tl += tadv + (orphan < 0 ? -orphan : 0);
    const ieOpen = I.ie ? r2(-(bal[I.ie] ? bal[I.ie].cl : 0)) : 0; // credit balance positive
    const ieTotal = r2(ieOpen + ie.surplus);
    if (ieTotal >= 0) tl += ieTotal; else ta += -ieTotal;
    ta = r2(ta); tl = r2(tl);
    const keyOrder = (a, b) => a.sub.localeCompare(b.sub) || String(a.h.code).localeCompare(String(b.h.code));
    assets.sort(keyOrder); liabs.sort(keyOrder);
    const byName = (a, b) => String(a.m.wing || '').localeCompare(String(b.m.wing || '')) || String(a.m.flat || '').localeCompare(String(b.m.flat || ''), undefined, { numeric: true });
    dues.sort(byName); adv.sort(byName);
    return { assets, liabs, dues, adv, td: r2(td), tadv: r2(tadv), orphan, ieOpen, surplus: ie.surplus, ieTotal, ta, tl, diff: r2(ta - tl) };
  }

  // Receipts & Payments: every non-cash line of a voucher touching cash/bank
  function receiptsPayments(S, from, to) {
    const L = ledger(S); const cashIds = new Set(ents(S.heads).filter(([, h]) => h.type === 'cash' || h.type === 'bank').map(([id]) => id));
    const byV = {};
    for (const l of L) { if (l.src !== 'v' || l.d < from || l.d > to) continue; (byV[l.id] = byV[l.id] || []).push(l); }
    const rec = {}, pay = {};
    for (const lines of Object.values(byV)) {
      if (!lines.some(l => cashIds.has(l.h))) continue;
      for (const l of lines) {
        if (cashIds.has(l.h)) continue;
        const net = r2(l.cr - l.dr);
        if (net > 0) rec[l.h] = r2((rec[l.h] || 0) + net); else if (net < 0) pay[l.h] = r2((pay[l.h] || 0) - net);
      }
    }
    const bal = balances(S, { from, asOf: to, lines: L });
    const op = [], cl = []; let to_ = 0, tc = 0;
    for (const id of cashIds) { const b = bal[id]; const o = r2(b.ob + b.pre); const c = b.cl; op.push({ hid: id, h: S.heads[id], amt: o }); cl.push({ hid: id, h: S.heads[id], amt: c }); to_ += o; tc += c; }
    const mk = o => ents(o).map(([hid, amt]) => ({ hid, h: S.heads[hid] || { name: '?' }, sub: (S.heads[hid] || {}).sub || '', amt })).sort((a, b) => String(a.h.grp).localeCompare(String(b.h.grp)) || a.sub.localeCompare(b.sub) || String(a.h.code).localeCompare(String(b.h.code)));
    const R = mk(rec), Pm = mk(pay);
    const tr = r2(R.reduce((s, x) => s + x.amt, 0)), tp = r2(Pm.reduce((s, x) => s + x.amt, 0));
    return { op, cl, rec: R, pay: Pm, tr, tp, to: r2(to_), tc: r2(tc), check: r2(to_ + tr - tp - tc) };
  }

  // Closing balances → next year's openings (year-end)
  function closingForNextYear(S) {
    const I = ids(S); const L = ledger(S); const bal = balances(S, { lines: L });
    const ie = incomeExpenditure(S);
    const heads = {};
    for (const [hid, b] of ents(bal)) {
      const h = S.heads[hid]; if (!h || hid === I.dues) continue;
      if (h.grp === 'Assets' || h.grp === 'Liabilities') { if (b.cl) heads[hid] = b.cl; }
    }
    if (I.ie) heads[I.ie] = r2((heads[I.ie] || 0) - ie.surplus);
    const members = {};
    for (const mid of Object.keys(S.members || {})) {
      const r = replayMember(S, mid, { lines: L });
      const ai = r.accrued || 0;
      if (r.P || r.N || r.I || ai) { members[mid] = { p: r.P, n: r.N, i: r.I }; if (ai) members[mid].ai = ai; }
    }
    const py = {}; for (const x of [...ie.inc, ...ie.exp]) if (x.amt) py[x.hid] = x.amt;
    return { heads, members, surplus: ie.surplus, py };
  }


  // Which dues each receipt / credit settled (FIFO, oldest first). Advance left over is applied to later bills.
  // Returns { vid: [{ kind:'ob'|'bill'|'supp'|'other'|'adv', from, to, desc, d, amt, full, adv }] }
  function receiptAlloc(S, mid, opt = {}) {
    const I = ids(S); const L = opt.lines || ledger(S); const ob = memberOB(S, mid); const obt = r2(ob.p + ob.n + ob.i);
    const ev = [];
    if (obt > 0) ev.push({ d: '0000', o: 0, kind: 'deb', x: { kind: 'ob', amt: obt } });
    let advOB = obt < 0 ? -obt : 0;
    for (const [id, b] of ents(S.bills)) if (b && b.mid === mid) { const t = billTotal(b); if (t > 0) ev.push({ d: b.d, o: 1, at: b.at || 0, kind: 'deb', x: { kind: b.supp ? 'supp' : 'bill', id, from: b.from, to: b.to, desc: b.desc || '', d: b.d, amt: t } }); }
    for (const l of L) {
      if (l.src !== 'v' || l.h !== I.dues || l.m !== mid || l.bnc || l.rev) continue;
      if (l.dr) ev.push({ d: l.d, o: 2, at: l.at, kind: 'deb', x: { kind: 'other', d: l.d, amt: l.dr } });
      if (l.cr) ev.push({ d: l.d, o: 2, at: l.at, kind: 'cr', id: l.id, amt: l.cr });
    }
    ev.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.o - b.o || (a.at || 0) - (b.at || 0)));
    const out = {}; const open = []; const adv = [];
    const lab = d => ({ kind: d.kind, id: d.id, from: d.from, to: d.to, desc: d.desc, d: d.d });
    for (const e of ev) {
      if (e.kind === 'deb') {
        const d = { ...e.x, bal: e.x.amt };
        if (advOB > 0) { const x = Math.min(advOB, d.bal); advOB = r2(advOB - x); d.bal = r2(d.bal - x); }
        while (adv.length && d.bal > 0.004) { const a = adv[0]; const x = r2(Math.min(a.amt, d.bal)); a.amt = r2(a.amt - x); d.bal = r2(d.bal - x); (out[a.id] = out[a.id] || []).push({ ...lab(d), amt: x, full: d.bal <= 0.004, adv: true }); if (a.amt <= 0.004) adv.shift(); }
        if (d.bal > 0.004) open.push(d);
      } else {
        let c = e.amt; const arr = out[e.id] = out[e.id] || [];
        while (open.length && c > 0.004) { const d = open[0]; const x = r2(Math.min(c, d.bal)); d.bal = r2(d.bal - x); c = r2(c - x); arr.push({ ...lab(d), amt: x, full: d.bal <= 0.004 }); if (d.bal <= 0.004) open.shift(); }
        if (c > 0.004) adv.push({ id: e.id, amt: c });
      }
    }
    for (const a of adv) (out[a.id] = out[a.id] || []).push({ kind: 'adv', amt: a.amt });
    return out;
  }

  // Plan a bill run (pure): returns bills to create
  function planRun(S, p) {
    const I = ids(S); const L = ledger(S); const heads = S.heads || {};
    const months = periodInfo(p.per).m;
    const billHeads = ents(heads).filter(([, h]) => h.bill && h.bill.on).map(([id]) => id);
    const out = [];
    for (const [mid, m] of ents(S.members)) {
      if (!m || m.active === false) continue;
      const cfg = (S.bcfg || {})[mid] || {};
      const ch = {};
      const mult = p.mult || 1; // billing setup holds monthly amounts; a quarterly bill charges 3×
      if (!p.supp) { for (const hid of billHeads) { const a = r2((+cfg[hid] || 0) * mult); if (a) ch[hid] = a; } }
      else { for (const [hid, a] of ents(p.ch)) { const v = r2(a); if (v) ch[hid] = v; } }
      const pd = {};
      if (!p.supp && p.withPending !== false) for (const [pid, x] of ents((S.pending || {})[mid])) { if (!x) continue; ch[x.h] = r2((ch[x.h] || 0) + (+x.amt || 0)); pd[pid] = x; }
      const st = replayMember(S, mid, { lines: L, before: p.d, recalc: true, lock: S.fy && S.fy.lock, planBill: p.supp ? null : { d: p.d, rate: p.rate, per: p.per, im: p.im || 'A' } });
      const xo = {}; if (p.adj) p.adj({ mid, m, cfg, ch, pd, st, mult, billHeads, xo }); // optional hook: late fee, pro-rata (billx.js)
      const int = p.supp ? 0 : st.planInt;
      const gst = gstFor(ch, heads, p.gst, p.supp ? 1 : months);
      const cur = r2(Object.values(ch).reduce((s, a) => s + a, 0) + int + (gst ? gst.c + gst.s : 0));
      if (!cur && Math.abs(st.bal) < 0.005) continue;
      if (p.supp && !Object.keys(ch).length) continue;
      out.push({ mid, m, ch, int, gst, pd, arrears: st.bal, current: cur, idet: st.planDet, ...xo });
    }
    const byFlat = (a, b) => String(a.m.wing || '').localeCompare(String(b.m.wing || '')) || String(a.m.flat || '').localeCompare(String(b.m.flat || ''), undefined, { numeric: true });
    return out.sort(byFlat);
  }

  return { r2, PERIODS, IM, dn, addDays, periodInfo, vals, calcInterest, ids, gstFor, billLines, billTotal, ledger, headOB, balances, memberOB, replayMember, fifo, ageing, memberBalances, trialBalance, incomeExpenditure, balanceSheet, receiptsPayments, closingForNextYear, planRun, receiptAlloc };
})();
if (typeof module !== 'undefined') module.exports = ENG;
