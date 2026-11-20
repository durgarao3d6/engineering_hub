'use strict';
// Turns Azure DevOps rich text into plain text for the model: no markup, no addresses, bounded size.
const ENT = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&#x27;': "'", '&ndash;': '-', '&mdash;': '-', '&hellip;': '...' };

function htmlToText(html) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<img\b[^>]*>/gi, ' [image] ');
  s = s.replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/ul|\/ol|\/table|\/blockquote)\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m) => {
    if (ENT[m.toLowerCase()] !== undefined) return ENT[m.toLowerCase()];
    const n = /^&#x([0-9a-f]+);$/i.exec(m) ? parseInt(RegExp.$1, 16) : /^&#(\d+);$/.exec(m) ? Number(RegExp.$1) : NaN;
    return Number.isFinite(n) && n > 31 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
  });
  return s.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const maskEmails = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, Math.max(0, n - 3)) + '...' : t; };
// Plain, masked and bounded: what may go into a prompt.
const forModel = (html, n) => clip(maskEmails(htmlToText(html)), n);

module.exports = { htmlToText, maskEmails, clip, forModel };
