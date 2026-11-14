// Account statement PDF (A4) — same content as the statement the app attaches to reminder emails.
'use strict';
const PDFDocument = require('pdfkit');
const path = require('path');
const { fmt, fd, drcr, socAddrLine, socContactParts } = require('./reminders.js');
const F = { r: path.join(__dirname, 'fonts', 'DejaVuSans.ttf'), b: path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf') };

function statementPdf(meta, st) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 40, left: 36, right: 36 }, info: { Title: 'Account statement', Author: meta.name || '' } });
    const out = []; doc.on('data', b => out.push(b)); doc.on('end', () => resolve(Buffer.concat(out))); doc.on('error', reject);
    doc.registerFont('r', F.r); doc.registerFont('b', F.b);
    const W = doc.page.width - 72, X = 36;
    // letterhead
    doc.font('b').fontSize(15).text(meta.name || '', X, 36, { width: W, align: 'center' });
    doc.font('r').fontSize(8.5).fillColor('#333');
    if (meta.regNo) doc.text('Regn. No. ' + meta.regNo, { width: W, align: 'center' });
    const addr = socAddrLine(meta); if (addr) doc.text(addr, { width: W, align: 'center' });
    const ct = socContactParts(meta); if (ct.length) doc.text(ct.join(' · '), { width: W, align: 'center' });
    doc.moveDown(0.4); doc.moveTo(X, doc.y).lineTo(X + W, doc.y).lineWidth(1).strokeColor('#333').stroke();
    doc.moveDown(0.6); doc.fillColor('#000').font('b').fontSize(12).text('ACCOUNT STATEMENT', X, doc.y, { width: W, align: 'center' });
    doc.font('r').fontSize(9).fillColor('#555').text(`${st.member} · FY ${st.fy} · as on ${fd(st.asOf)}`, { width: W, align: 'center' });
    doc.moveDown(0.6); doc.fillColor('#000');
    // table
    const C = [{ h: 'Date', w: 58 }, { h: 'Particulars', w: W - 58 - 3 * 78 }, { h: 'Debit', w: 78, n: 1 }, { h: 'Credit', w: 78, n: 1 }, { h: 'Balance', w: 78, n: 1 }];
    const row = (cells, o = {}) => {
      doc.font(o.bold ? 'b' : 'r').fontSize(8.5);
      const hs = cells.map((c, i) => doc.heightOfString(String(c.t || ''), { width: C[i].w - 8 }) + (c.sub ? doc.font('r').fontSize(7.5).heightOfString(c.sub, { width: C[i].w - 8 }) + 1 : 0));
      doc.font(o.bold ? 'b' : 'r').fontSize(8.5);
      const h = Math.max(...hs) + 6;
      if (doc.y + h > doc.page.height - 50) { doc.addPage(); if (!o.head) row(C.map(c => ({ t: c.h })), { bold: true, head: true, fill: '#eee' }); }
      const y = doc.y; let x = X;
      if (o.fill) doc.rect(X, y, W, h).fill(o.fill).fillColor('#000');
      cells.forEach((c, i) => { doc.font(o.bold ? 'b' : 'r').fontSize(8.5).fillColor('#000').text(String(c.t || ''), x + 4, y + 3, { width: C[i].w - 8, align: C[i].n ? 'right' : 'left' });
        if (c.sub) doc.font('r').fontSize(7.5).fillColor('#555').text(c.sub, x + 4, doc.y + 1, { width: C[i].w - 8 }); x += C[i].w; });
      doc.fillColor('#000'); doc.rect(X, y, W, h).lineWidth(0.4).strokeColor('#999').stroke();
      let cx = X; for (let i = 0; i < C.length - 1; i++) { cx += C[i].w; doc.moveTo(cx, y).lineTo(cx, y + h).lineWidth(0.4).strokeColor('#bbb').stroke(); }
      doc.x = X; doc.y = y + h;
    };
    row(C.map(c => ({ t: c.h })), { bold: true, head: true, fill: '#eee' });
    for (const r of st.rows) row([{ t: fd(r.d) }, { t: r.p, sub: r.nar || '' }, { t: r.dr ? fmt(r.dr) : '' }, { t: r.cr ? fmt(r.cr) : '' }, { t: drcr(r.b) }]);
    const bal = st.bal; row([{ t: '' }, { t: bal > 0 ? 'Outstanding' : bal < 0 ? 'Advance' : 'Balance' }, { t: '' }, { t: '' }, { t: fmt(Math.abs(bal)) }], { bold: true, fill: '#f4f4f4' });
    doc.moveDown(1).font('r').fontSize(7.5).fillColor('#777').text('This statement is generated from the books of account and sent automatically. Please contact the society office for any query.', X, doc.y, { width: W, align: 'center' });
    doc.end();
  });
}
module.exports = { statementPdf };
