'use strict';
// Reads a Playwright spec file as text (never runs it): header comment, requirement ids, test titles, step titles, expectations, imports, skips.
// Good enough for flow documents because the platform specs are written in one style: a header comment, covers(...), test(title, ...), test.step(title, ...).
const STR = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`; // a quoted string: group 1 the quote, group 2 the text

const unq = (s) => s.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, ' ');
const plainTemplate = (s) => s.replace(/\$\{([^}]*)\}/g, (m, e) => '<' + e.trim().replace(/\s+/g, ' ') + '>');

// The header: the first block comment that comes before the first test, as plain paragraphs.
function headerOf(text) {
  const m = /\/\*\*([\s\S]*?)\*\//.exec(text);
  if (!m) return '';
  const firstTest = text.search(/\btest\s*\(/);
  if (firstTest >= 0 && m.index > firstTest) return '';
  const lines = m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, '').trimEnd());
  const paras = []; let cur = [];
  for (const l of lines) { if (!l.trim()) { if (cur.length) { paras.push(cur.join(' ')); cur = []; } } else cur.push(l.trim()); }
  if (cur.length) paras.push(cur.join(' '));
  return paras.join('\n\n').trim();
}
function importsOf(text) {
  const out = [];
  for (const m of text.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+(['"])([^'"]+)\2;?/gm)) out.push({ names: m[1].split(',').map((x) => x.trim()).filter(Boolean), from: m[3], raw: m[0] });
  for (const m of text.matchAll(/^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2;?/gm)) out.push({ names: [m[1]], from: m[3], raw: m[0], isDefault: true });
  return out;
}
// Human wording for the most common assertions; the assertion's own message wins when the author wrote one.
const MATCHERS = { toBe: 'is', toEqual: 'equals', toStrictEqual: 'equals', toContain: 'contains', toMatch: 'matches', toBeTruthy: 'is set', toBeFalsy: 'is empty or false', toBeDefined: 'is present', toBeUndefined: 'is absent', toBeNull: 'is null',
  toBeGreaterThan: 'is greater than', toBeGreaterThanOrEqual: 'is at least', toBeLessThan: 'is less than', toBeLessThanOrEqual: 'is at most', toHaveLength: 'has length', toHaveProperty: 'has the property', toContainEqual: 'contains' };
function expectationsOf(segment) {
  const out = [];
  for (const m of segment.matchAll(/expect\(\s*((?:[^()]|\([^()]*\))*?)\s*(?:,\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2\s*)?\)\s*(\.not)?\.(\w+)\(([^;]*?)\)\s*;/g)) {
    const [, actual, , message, not, matcher, arg] = m;
    if (message) { out.push(plainTemplate(unq(message))); continue; }
    const verb = MATCHERS[matcher]; if (!verb) continue;
    out.push(clean(actual) + ' ' + (not ? 'is not / does not: ' : '') + verb + (arg.trim() ? ' ' + clean(arg) : ''));
  }
  return out;
}
const clean = (s) => String(s).replace(/\s+/g, ' ').replace(/^(['"`])(.*)\1$/, '"$2"').trim();

function parse(text, filename) {
  const name = String(filename || '').replace(/^.*[\\/]/, '');
  const imports = importsOf(text);
  const libs = [...new Set(imports.map((i) => /^\.\.\/lib\/([\w-]+)$/.exec(i.from)).filter(Boolean).map((m) => m[1]))];
  // test titles with their covers(...) and the steps between this test and the next
  const testRe = new RegExp('^\\s*test(?:\\.(?:fail|slow|fixme))?\\(\\s*' + STR, 'gm');
  const starts = [...text.matchAll(testRe)].map((m) => ({ index: m.index, title: plainTemplate(unq(m[2])) }));
  const tests = starts.map((s, i) => {
    const seg = text.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : text.length);
    const cov = /covers\(\s*(?:TAGS\s*,\s*)?(['"`])((?:\\.|(?!\1)[^\\])*)\1((?:\s*,\s*(['"`])[^'"`]*\4)*)/.exec(seg);
    const stepRe = new RegExp('test\\.step\\(\\s*' + STR, 'g');
    const sm = [...seg.matchAll(stepRe)];
    const steps = sm.map((m, k) => ({ title: plainTemplate(unq(m[2])), expects: expectationsOf(seg.slice(m.index, k + 1 < sm.length ? sm[k + 1].index : seg.length)) }));
    const skips = [...seg.matchAll(new RegExp('test\\.skip\\(\\s*[^,]+,\\s*' + STR, 'g'))].map((m) => plainTemplate(unq(m[2])));
    const issues = [...seg.matchAll(new RegExp('productIssue\\(\\s*' + STR + '\\s*\\)', 'g'))].map((m) => plainTemplate(unq(m[2])));
    const ids = cov ? [...cov[3].matchAll(/(['"`])([^'"`]*)\1/g)].map((x) => x[2]) : (/^\[([^\]]+)\]/.exec(s.title) || [, ''])[1].split(/\s+/).filter(Boolean);
    return { title: s.title, source: cov ? unq(cov[2]) : '', requirementIds: ids, steps, skips, productIssues: issues };
  });
  const bug = /^bug-(\d+)/i.exec(name);
  return { name, header: headerOf(text), imports, libs, usesGremlin: libs.includes('gremlin'), usesRouting: libs.includes('routing'), isUi: /\.ui\.spec\.ts$/.test(name), bugId: bug ? Number(bug[1]) : null, tests };
}

module.exports = { parse, headerOf, importsOf, expectationsOf, plainTemplate };
