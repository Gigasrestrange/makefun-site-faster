// A faster drop-in for makefun-site 1.0.0: run(input) returns the same output tree, byte for byte.
// Dependency-free ES module. The rules are those of makefun-site's README; this code is written for speed:
// code-unit scans in place of per-character regex calls, chunked escaping, first-character dispatch in the block
// lexer, and a per-build cache of the template includes that depend on nothing but site, tags and recent.

// ------------------------------------------------------------------ text

const NEEDS_ESC = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;
const entityOf = (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');

function esc(s) {
  return NEEDS_ESC.test(s) ? s.replace(ESC_ALL, entityOf) : s;
}

const NON_ASCII = /[^\x00-\x7f]/;
const MARKS = /\p{M}/gu;

function slugify(text) {
  let plain = text;
  if (NON_ASCII.test(plain)) plain = plain.normalize('NFKD').replace(MARKS, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let ch;
    if (c >= 97 && c <= 122) ch = plain[i];
    else if (c >= 48 && c <= 57) ch = plain[i];
    else if (c >= 65 && c <= 90) ch = String.fromCharCode(c + 32);
    else {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += ch;
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const p = date.split('-');
  return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] + ' ' + p[0];
}

// \S in JavaScript: everything but these.
const WS = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS[c] = 1;
function isSpaceCode(c) {
  if (c < 128) return WS[c] === 1;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
function wordCount(s) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    if (isSpaceCode(s.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ front matter

const KEY_LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const BLANK_RE = /^[ \t]*$/;
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmString(key, raw) {
  if (raw.charCodeAt(0) === 34) {
    const last = raw.length - 1;
    if (raw.length < 2 || raw.charCodeAt(last) !== 34) return { error: `key "${key}": a quoted string is not closed` };
    let out = '';
    for (let i = 1; i < last; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === last) return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
        out += n;
        i++;
      } else if (c === '"') return { error: `key "${key}": a quoted string holds a stray quote` };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return fmString(key, raw);
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? +m[1] : 0;
      const mo = m ? +m[2] : 0;
      const d = m ? +m[3] : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

// Returns { data, body } or { error }.
function parseSource(text) {
  if (!text.startsWith('---') || (text.length > 3 && text.charCodeAt(3) !== 10)) return { error: 'no front matter' };
  // find the closing "---" line
  let pos = text.length > 3 ? 4 : -1;
  let closeAt = -1;
  let bodyAt = text.length;
  if (pos !== -1) {
    while (pos <= text.length) {
      let nl = text.indexOf('\n', pos);
      if (nl === -1) nl = text.length;
      if (nl - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
        closeAt = pos;
        bodyAt = nl >= text.length ? text.length : nl + 1;
        break;
      }
      if (nl >= text.length) break;
      pos = nl + 1;
    }
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let has = 0; // bitmask of KEYS given
  let lineNo = 2;
  let p = 4;
  while (p < closeAt) {
    let nl = text.indexOf('\n', p);
    const line = text.slice(p, nl);
    p = nl + 1;
    const ln = lineNo++;
    if (line.length === 0 || line.charCodeAt(0) === 35 || BLANK_RE.test(line)) continue;
    const m = KEY_LINE.exec(line);
    if (m === null) return { error: `line ${ln} is not "key: value"` };
    const key = m[1];
    let raw = m[2] === undefined ? '' : m[2];
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e !== raw.length) raw = raw.slice(0, e);
    const ki = KEYS.indexOf(key);
    if (ki === -1) return { error: `unknown key "${key}"` };
    if (has & (1 << ki)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if (v.error !== undefined) return v;
    has |= 1 << ki;
    data[key] = v.value;
  }
  if (!(has & 1)) return { error: 'no title' };
  return { data, body: bodyAt >= text.length ? '' : text.slice(bodyAt) };
}

// ------------------------------------------------------------------ markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A heading's { depth, text }, or null.
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c !== c) return true;
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

function lex(src) {
  const lines = src.split('\n');
  const n = lines.length;
  const tokens = [];
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c = line.charCodeAt(0);
    if (c !== c || ((c === 32 || c === 9) && isBlank(line))) {
      i++;
      continue;
    }
    if (c === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        tokens.push({ type: 0, lang: fence[1], lines: body });
        continue;
      }
    } else if (c === 35) {
      const h = headingOf(line);
      if (h !== null) {
        tokens.push({ type: 1, depth: h.depth, text: h.text });
        i++;
        continue;
      }
    } else if (c === 45 || c === 42) {
      if (HR.test(line)) {
        tokens.push({ type: 2 });
        i++;
        continue;
      }
    } else if (c === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') body.push(t);
      }
      tokens.push({ type: 3, lines: body });
      continue;
    }
    let ordered = null;
    let bullet = null;
    if (c === 45 || c === 42) bullet = BULLET.exec(line);
    else if (c >= 48 && c <= 57) ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const l = lines[i];
        const m = marker.exec(l);
        if (m !== null) {
          items.push(trimLine(isOrdered ? m[2] : m[1]));
          i++;
        } else if (CONTINUED.test(l)) {
          items[items.length - 1] += '\n' + trimLine(l);
          i++;
        } else break;
      }
      tokens.push({ type: 4, ordered: isOrdered, start: isOrdered ? Number(ordered[1]) : 1, items });
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) text += '\n' + trimLine(lines[i++]);
    tokens.push({ type: 5, text });
  }
  return tokens;
}

// Character classes for the inline scanner: 1 = needs attention (\ ` * [ & < > " ').
const SPECIAL = new Uint8Array(128);
for (const ch of '\\`*[&<>"\'') SPECIAL[ch.charCodeAt(0)] = 1;
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (c) => c < 128 && ESCAPABLE[c] === 1;

// First index >= from of the char code `code` (or the pair `**` when pair is true) outside a backslash escape.
function findUnescaped(s, code, pair, from) {
  const len = s.length;
  const last = pair ? len - 2 : len - 1;
  for (let j = from; j <= last; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < len && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === code && (!pair || s.charCodeAt(j + 1) === code)) return j;
  }
  return -1;
}

// First single * from `from`, outside escapes: a run of two stars is skipped whole.
function findSingleStar(s, from) {
  const len = s.length;
  for (let j = from; j < len; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < len && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const HAS_SPACE = /\s/;

function inline(s, link) {
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    let j = i;
    let c = 0;
    while (j < n) {
      c = s.charCodeAt(j);
      if (c < 128 && SPECIAL[c] === 1) break;
      j++;
    }
    if (j > i) {
      out += j === n && i === 0 ? s : s.slice(i, j);
      if (j === n) break;
      i = j;
    }
    switch (c) {
      case 92: {
        if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
          const e = s[i + 1];
          out += e === '>' ? '&gt;' : e;
          i += 2;
        } else {
          out += '\\';
          i++;
        }
        break;
      }
      case 96: {
        const k = s.indexOf('`', i + 1);
        if (k > i + 1) {
          out += '<code>' + esc(s.slice(i + 1, k)) + '</code>';
          i = k + 1;
        } else {
          out += '`';
          i++;
        }
        break;
      }
      case 42: {
        if (s.charCodeAt(i + 1) === 42) {
          const k = findUnescaped(s, 42, true, i + 2);
          if (k > i + 2) {
            out += '<strong>' + inline(s.slice(i + 2, k), link) + '</strong>';
            i = k + 2;
          } else {
            out += '**';
            i += 2;
          }
        } else {
          const k = findSingleStar(s, i + 1);
          if (k > i + 1) {
            out += '<em>' + inline(s.slice(i + 1, k), link) + '</em>';
            i = k + 1;
          } else {
            out += '*';
            i++;
          }
        }
        break;
      }
      case 91: {
        const k = findUnescaped(s, 93, false, i + 1);
        const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
        const target = m === -1 ? '' : s.slice(k + 2, m);
        if (target !== '' && !HAS_SPACE.test(target)) {
          out += '<a href="' + esc(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
          i = m + 1;
        } else {
          out += '[';
          i++;
        }
        break;
      }
      case 38:
        out += '&amp;';
        i++;
        break;
      case 60:
        out += '&lt;';
        i++;
        break;
      case 62:
        out += '&gt;';
        i++;
        break;
      case 34:
        out += '&quot;';
        i++;
        break;
      default:
        out += '&#39;';
        i++;
    }
  }
  return out;
}

// { html, toc, excerpt } of a Markdown body.
function renderMarkdown(src, link) {
  const ids = new Set();
  const toc = [];
  let html = '';
  let excerpt = null;
  const tokens = lex(src);
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    switch (tok.type) {
      case 1: {
        const id = uniqueSlug(slugify(tok.text), ids);
        const h = inline(tok.text, link);
        html += '<h' + tok.depth + ' id="' + id + '">' + h + '</h' + tok.depth + '>\n';
        if (tok.depth === 2 || tok.depth === 3) toc.push({ level: tok.depth, id, html: h });
        break;
      }
      case 0: {
        let body = '';
        for (let k = 0; k < tok.lines.length; k++) body += esc(tok.lines[k]) + '\n';
        html += '<pre><code' + (tok.lang === '' ? '' : ' class="language-' + esc(tok.lang) + '"') + '>' + body + '</code></pre>\n';
        break;
      }
      case 2:
        html += '<hr>\n';
        break;
      case 3:
        html += tok.lines.length === 0 ? '<blockquote>\n</blockquote>\n' : '<blockquote>\n<p>' + inline(tok.lines.join('\n'), link) + '</p>\n</blockquote>\n';
        break;
      case 4: {
        const tag = tok.ordered ? 'ol' : 'ul';
        html += tok.ordered && tok.start !== 1 ? '<ol start="' + tok.start + '">\n' : '<' + tag + '>\n';
        for (let k = 0; k < tok.items.length; k++) html += '<li>' + inline(tok.items[k], link) + '</li>\n';
        html += '</' + tag + '>\n';
        break;
      }
      default: {
        const h = inline(tok.text, link);
        if (excerpt === null) excerpt = h;
        html += '<p>' + h + '</p>\n';
      }
    }
  }
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ------------------------------------------------------------------ templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

// Node kinds
const N_TEXT = 0;
const N_VAR = 1;
const N_RAW = 2;
const N_IF = 3;
const N_FOR = 4;
const N_INC = 5;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function onlyBlank(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function tokenize(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const w = raw ? 3 : 2;
      const close = src.indexOf(raw ? '}}}' : '}}', open + w);
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') toks.push({ t: N_TEXT, text });
      text = '';
      toks.push({ t: raw ? N_RAW : N_VAR, path: pathOf(name, src.slice(open + w, close).trim()) });
      i = close + w;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const alone = onlyBlank(src, lineStart, open) && onlyBlank(src, end, lineEnd);
    if (alone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') toks.push({ t: N_TEXT, text });
    text = '';
    toks.push({ t: -1, tag: src.slice(open + 2, close).trim() });
    i = alone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') toks.push({ t: N_TEXT, text });
  return toks;
}

// A parsed template: { body, free } where free lists the root names it reads from outside its own bindings.
function parseTemplate(name, src) {
  const toks = tokenize(name, src);
  const root = { k: -2, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of toks) {
    if (tok.t === N_TEXT) body.push({ k: N_TEXT, text: tok.text });
    else if (tok.t === N_VAR || tok.t === N_RAW) body.push({ k: tok.t, first: tok.path[0], rest: tok.path.length > 1 ? tok.path.slice(1) : null });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const p = pathOf(name, m[2]);
        const node = { k: N_FOR, name: m[1], first: p[0], rest: p.length > 1 ? p.slice(1) : null, body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const p = pathOf(name, m[2]);
        const node = { k: N_IF, not: m[1] !== undefined, first: p[0], rest: p.length > 1 ? p.slice(1) : null, then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== N_IF || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? N_FOR : N_IF)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === -2 || parent.k === N_FOR ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: N_INC, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === N_FOR ? 'for' : 'if'} is not closed`);
  return root.body;
}

// The root names the nodes read from outside their own for-bindings (including, conservatively, what their includes read).
function freeNames(nodes, bound, templates, seen, out) {
  for (const n of nodes) {
    switch (n.k) {
      case N_VAR:
      case N_RAW:
        if (!bound.includes(n.first)) out.add(n.first);
        break;
      case N_IF:
        if (!bound.includes(n.first)) out.add(n.first);
        freeNames(n.then, bound, templates, seen, out);
        if (n.else !== null) freeNames(n.else, bound, templates, seen, out);
        break;
      case N_FOR:
        if (!bound.includes(n.first)) out.add(n.first);
        freeNames(n.body, bound.concat(n.name, 'loop'), templates, seen, out);
        break;
      case N_INC: {
        const t = templates.get(n.name);
        if (t !== undefined && !seen.has(n.name)) {
          seen.add(n.name);
          freeNames(t, bound, templates, seen, out);
          seen.delete(n.name);
        }
        break;
      }
    }
  }
}

// A scope frame: either the root ({ vars }) or a for-frame ({ n, v, l, p }).
function readFirst(scope, name) {
  let f = scope;
  while (f.vars === undefined) {
    if (name === 'loop') return f.l;
    if (name === f.n) return f.v;
    f = f.p;
  }
  return Object.hasOwn(f.vars, name) ? f.vars[name] : undefined;
}

function readPath(scope, first, rest) {
  let v = readFirst(scope, first);
  if (rest === null) return v;
  for (let k = 0; k < rest.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, rest[k])) return undefined;
    v = v[rest[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) s += (i > 0 ? ', ' : '') + textOf(v[i]);
    return s;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.k) {
      case N_TEXT:
        out += n.text;
        break;
      case N_VAR: {
        const v = readPath(scope, n.first, n.rest);
        out += typeof v === 'string' ? esc(v) : esc(textOf(v));
        break;
      }
      case N_RAW: {
        const v = readPath(scope, n.first, n.rest);
        out += typeof v === 'string' ? v : textOf(v);
        break;
      }
      case N_IF: {
        const branch = truthy(readPath(scope, n.first, n.rest)) !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case N_FOR: {
        const xs = readPath(scope, n.first, n.rest);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const frame = { n: n.name, v: xs[k], l: { index: k + 1, first: k === 0, last: k === len - 1, length: len }, p: scope };
          out += renderNodes(n.body, frame, ctx, depth);
        }
        break;
      }
      case N_INC: {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        if (scope.vars !== undefined && ctx.pure(n.name)) {
          const key = n.name + '@' + depth;
          let s = ctx.cache.get(key);
          if (s === undefined) {
            s = renderNodes(t, scope, ctx, depth + 1);
            ctx.cache.set(key, s);
          }
          out += s;
        } else out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ the build

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function cardOf(s) {
  const d = s.data;
  return {
    title: d.title,
    url: s.url,
    date: d.date === undefined ? '' : d.date,
    date_long: d.date === undefined ? '' : longDate(d.date),
    summary: d.summary === undefined ? '' : d.summary,
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordCount(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function linkOf(s) {
  if (s === null || s === undefined) return null;
  const d = s.data.date;
  return { title: s.data.title, url: s.url, date: d === undefined ? '' : d, date_long: d === undefined ? '' : longDate(d) };
}

export function run(input) {
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const report = [];

  // templates, in code-unit order of name
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // sources and statics
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push(f);
  }

  // front matter and the refusals
  const kept = [];
  for (const s of sources) {
    const fm = parseSource(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/')) {
      report.push(`refused ${s.path}: tags/ is the generator's own`);
      continue;
    }
    if (s.path.startsWith('page/')) {
      report.push(`refused ${s.path}: page/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35 || SCHEME.test(target)) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const hit = bySource.get(path);
        if (hit !== undefined) return hit.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // collections
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const names = s.data.tags;
    const res = [];
    if (names === undefined) return res;
    const seen = new Set();
    for (const name of names) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      res.push({ name, slug });
    }
    return res;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // layouts
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));

  const freeCache = new Map();
  const ctx = {
    templates,
    cache: new Map(),
    pure(name) {
      let r = freeCache.get(name);
      if (r === undefined) {
        const out = new Set();
        const seen = new Set([name]);
        freeNames(templates.get(name), [], templates, seen, out);
        r = true;
        for (const x of out) if (x !== 'site' && x !== 'tags' && x !== 'recent') r = false;
        freeCache.set(name, r);
      }
      return r;
    },
  };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    vars.site = site;
    vars.tags = allTags;
    vars.recent = recent;
    return renderNodes(nodes, { vars }, ctx, 0);
  };

  const output = {};
  for (const s of sources) {
    let card;
    if (s.post) card = cards.get(s);
    else card = cardOf(s);
    const page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer),
      older: linkOf(s.older),
      is_post: s.post,
    };
    output[s.outDir + '/index.html'] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  if (templates.has('tag')) {
    for (const t of tagList) {
      const tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
      output['tags/' + t.slug + '/index.html'] = render('tag', { tag });
    }
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // report
  const lines = report.concat([...broken]).sort(byCodeUnits);
  let pageCount = 0;
  for (const s of sources) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
