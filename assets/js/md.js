// A small Markdown renderer. The subset is deliberate: headings, lists,
// quotes, fenced code, tables, rules, and the inline marks a note actually
// uses. Formulas go through KaTeX, so $...$ and $$...$$ come out typeset.

const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function mathHtml(tex, display) {
  const src = String(tex).trim();
  if (window.katex) {
    try {
      return window.katex.renderToString(src, {
        displayMode: !!display,
        throwOnError: false,
        strict: false,
        output: 'html'
      });
    } catch (e) { /* fall through */ }
  }
  return '<code>' + esc(src) + '</code>';
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+/;

function inline(s) {
  let t = s;
  // Images stay as a label chip: the app never reads file contents.
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => '<span class="tag">🖼 ' + esc(alt || src) + '</span>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  return t;
}

export function renderMd(src) {
  if (!src) return '';
  const store = [];
  const hold = (html) => { store.push(html); return '\u0001' + (store.length - 1) + '\u0001'; };

  let text = String(src).replace(/\r\n/g, '\n');

  // Protect verbatim regions first so inline rules never touch them.
  text = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const cls = lang ? ' class="language-' + esc(lang.trim()) + '"' : '';
    return hold('<pre><code' + cls + '>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
  });
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => hold('<div class="math-block">' + mathHtml(tex, true) + '</div>'));
  text = text.replace(/`([^`\n]+)`/g, (m, code) => hold('<code>' + esc(code) + '</code>'));
  text = text.replace(/\$([^$\n]+?)\$/g, (m, tex) => hold(mathHtml(tex, false)));

  const lines = text.split('\n');
  const out = [];
  let i = 0;

  const isBlockStart = (ln, next) => {
    if (/^\s*$/.test(ln)) return true;
    if (/^#{1,6}\s+/.test(ln)) return true;
    if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) return true;
    if (/^>\s?/.test(ln)) return true;
    if (LIST_RE.test(ln)) return true;
    if (/^\s*\|/.test(ln) && next && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next)) return true;
    return false;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push('<h' + h[1].length + '>' + inline(esc(h[2].trim())) + '</h' + h[1].length + '>'); i++; continue; }

    // rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // fenced block already replaced, but a leftover fence line is skipped
    if (/^```/.test(line)) { i++; continue; }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote>' + renderMd(buf.join('\n')) + '</blockquote>');
      continue;
    }

    // table
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => {
        const left = c.startsWith(':'), right = c.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { body.push(cells(lines[i])); i++; }
      let html = '<table><thead><tr>' + head.map((c, k) =>
        '<th' + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(esc(c)) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of body) {
        html += '<tr>' + head.map((_, k) => '<td>' + inline(esc(r[k] || '')) + '</td>').join('') + '</tr>';
      }
      out.push(html + '</tbody></table>');
      continue;
    }

    // lists (nested by indentation)
    if (LIST_RE.test(line)) {
      const items = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const m = lines[i].match(LIST_RE);
        items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: lines[i].slice(m[0].length) });
        i++;
      }
      out.push(buildList(items));
      continue;
    }

    // paragraph
    const para = [];
    while (i < lines.length && !isBlockStart(lines[i], lines[i + 1])) { para.push(lines[i]); i++; }
    if (para.length) out.push('<p>' + inline(esc(para.join('\n'))).replace(/\n/g, '<br>') + '</p>');
    else i++;
  }

  let html = out.join('\n');
  html = html.replace(/\u0001(\d+)\u0001/g, (m, n) => store[Number(n)] ?? '');
  return html;
}

function buildList(items) {
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) {
      html += '</li></' + stack.pop().tag + '>';
    }
    const tag = it.ordered ? 'ol' : 'ul';
    if (!stack.length || it.indent > stack[stack.length - 1].indent) {
      if (stack.length) html += '';
      html += '<' + tag + '>';
      stack.push({ indent: it.indent, tag });
    } else if (stack[stack.length - 1].tag !== tag) {
      html += '</li></' + stack.pop().tag + '><' + tag + '>';
      stack.push({ indent: it.indent, tag });
    } else {
      html += '</li>';
    }
    html += '<li>' + inline(esc(it.text));
  }
  while (stack.length) html += '</li></' + stack.pop().tag + '>';
  return html;
}

/** Plain text preview for canvas cards — markdown syntax stripped, no HTML. */
export function excerpt(src, max = 240) {
  if (!src) return '';
  let t = String(src)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]+?\$/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\|/g, ' ')
    .replace(/^-{3,}\s*$/gm, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (t.length > max) t = t.slice(0, max).trimEnd() + '…';
  return t;
}
