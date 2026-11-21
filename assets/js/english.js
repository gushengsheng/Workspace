/**
 * English-only coach for the entry editor.
 *
 * Two layers, deliberately split by cost:
 *   the CJK detector is local and runs on every keystroke;
 *   the model is only asked after a pause, or when the user presses 检查与优化.
 *
 * Every model call goes through bridge.call('ai.*'), so the API key never
 * reaches this file and the page still never touches the disk.
 */

const RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const ANY = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** How many Chinese characters the text holds. */
export function cjkCount(text) {
  const found = String(text || '').match(RUN);
  return found ? found.reduce((n, run) => n + run.length, 0) : 0;
}

export function hasChinese(text) { return ANY.test(String(text || '')); }

/** Chinese runs worth replacing: one-character particles are not. */
export function cjkRuns(text) {
  const source = String(text || '');
  const runs = [];
  RUN.lastIndex = 0;
  let match;
  while ((match = RUN.exec(source)) !== null) {
    if (match[0].length < 2) continue;
    runs.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return runs;
}

/** Entries that still have Chinese in them. */
export function chineseEntries(entries) {
  return (entries || []).filter((entry) => hasChinese(entry && entry.body));
}

/** Underline Chinese inside rendered markdown, without touching code spans. */
export function markChinese(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !ANY.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('pre, code, .zhmark, .katex')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const runs = cjkRuns(text);
    if (!runs.length) continue;
    const frag = document.createDocumentFragment();
    let from = 0;
    for (const run of runs) {
      if (run.start > from) frag.append(text.slice(from, run.start));
      const span = document.createElement('span');
      span.className = 'zhmark';
      span.textContent = run.text;
      span.title = '中文：可以换成英文';
      frag.append(span);
      from = run.end;
    }
    if (from < text.length) frag.append(text.slice(from));
    node.parentNode.replaceChild(frag, node);
  }
}

// ---------------------------------------------------------------- reply cache
// The same fragment comes back every time the inspector re-renders; ten minutes
// of memory keeps that free, exactly like the DSH plugin.
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) { cache.delete(key); return null; }
  return hit.value;
}

function cachePut(key, value) {
  if (cache.size > 120) cache.clear();
  cache.set(key, { at: Date.now(), value });
}

/**
 * One coach per open entry.
 * opts: { h, call, toast, editor, getSettings, onChange, ensureSource }
 */
export function createCoach(opts) {
  const { h, call, toast, editor, getSettings, onChange, ensureSource } = opts;

  const stat = h('span', { class: 'en-stat' }, '');
  const tokens = h('span', { class: 'en-tok' }, '');
  const checkBtn = h('button', { class: 'en-btn', onclick: () => runCheck() }, '检查与优化');
  const note = h('div', { class: 'en-note' });
  const body = h('div', { class: 'en-body' });
  const strip = h('div', { class: 'en-coach' },
    h('div', { class: 'en-head' },
      h('span', { class: 'en-badge' }, 'EN'),
      stat,
      h('span', { class: 'en-grow' }),
      tokens,
      checkBtn
    ),
    note, body
  );

  let status = { hasKey: false, tokens: 0, checked: false };
  let resolved = false;
  let sugg = null;        // { frag, start, end, options, hint }
  let issues = null;      // { mode, issues, corrected, summary }
  let busy = false;
  let hint = '';
  let error = '';
  let timer = 0;
  let lastAsked = '';

  const ready = call('ai.status')
    .then((s) => { status = { ...status, ...s, checked: true }; resolved = true; paint(); })
    .catch(() => { status.checked = true; resolved = true; paint(); });

  // ------------------------------------------------------------- caret window
  function fragAt() {
    const text = editor.value || '';
    const caret = editor.selectionStart == null ? text.length : editor.selectionStart;
    const all = cjkRuns(text);
    if (!all.length) return null;

    // The paragraph is the unit sent to the model: it carries the tone and the
    // terms the English has to fit into.
    let from = text.lastIndexOf('\n\n', Math.max(0, caret - 1));
    from = from < 0 ? 0 : from + 2;
    let to = text.indexOf('\n\n', caret);
    to = to < 0 ? text.length : to;

    const local = all.filter((r) => r.end > from && r.start < to);
    const run = local.find((r) => caret >= r.start && caret <= r.end)
      || [...local].reverse().find((r) => r.start < caret)
      || local[0]
      || [...all].filter((r) => r.end <= caret).pop()
      || all[0];
    if (!run) return null;

    return {
      run,
      paragraph: text.slice(Math.max(0, from), to),
      left: text.slice(Math.max(from, run.start - 80), run.start),
      right: text.slice(run.end, Math.min(to, run.end + 80))
    };
  }

  // ------------------------------------------------------------------- render
  function paint() {
    const text = editor.value || '';
    const count = cjkCount(text);
    stat.textContent = count ? '中文 ' + count + ' 字' : '没有中文';
    stat.classList.toggle('ok', count === 0);
    stat.classList.toggle('warn', count > 0);
    tokens.textContent = status.tokens ? String(status.tokens) + ' tok' : '';
    checkBtn.disabled = busy;

    note.className = 'en-note' + (error ? ' err' : '');
    note.textContent = error
      || (busy ? '正在问模型…'
        : !status.hasKey && status.checked ? '在 设置 → English 里填模型 key，才会有建议。'
        : hint);
    note.classList.toggle('hidden', note.textContent === '');

    body.innerHTML = '';
    if (sugg) body.append(optionView());
    if (issues) body.append(issueView());
  }

  function optionView() {
    const wrap = h('div', { class: 'en-sugg' },
      h('div', { class: 'en-frag' },
        h('span', { class: 'en-zh' }, sugg.frag),
        sugg.hint ? h('span', { class: 'en-hint' }, sugg.hint) : null
      )
    );
    for (const option of sugg.options) {
      wrap.append(h('button', {
        class: 'en-opt',
        onclick: () => applyOption(option),
        title: '只替换这一段中文'
      },
        h('span', { class: 'en-reg' }, option.register === 'concise' ? '简洁' : '自然'),
        h('span', { class: 'en-en' }, option.en)
      ));
    }
    wrap.append(h('div', { class: 'en-tools' },
      h('button', { class: 'en-link', onclick: () => { sugg = null; hint = ''; paint(); } }, '忽略')
    ));
    return wrap;
  }

  function tagOf(issue) {
    if (issue.type === 'translate') return '译';
    return issue.severity === 'error' ? '错' : '改';
  }

  function issueView() {
    const wrap = h('div', { class: 'en-issues' },
      h('div', { class: 'en-issues-head' },
        h('span', {}, issues.mode === 'revise' ? '译成英文' : '可以改的地方'),
        h('span', { class: 'en-count' }, String(issues.issues.length))
      )
    );
    if (!issues.issues.length) wrap.append(h('div', { class: 'en-empty' }, issues.summary || '没有问题'));
    for (const issue of issues.issues) {
      wrap.append(h('div', { class: 'en-issue ' + issue.severity + (issue.type === 'translate' ? ' translate' : '') },
        h('div', { class: 'en-line' },
          h('span', { class: 'en-tag' }, tagOf(issue)),
          h('span', { class: 'en-diff' },
            h('del', {}, issue.original),
            h('span', { class: 'en-arrow' }, '→'),
            h('ins', {}, issue.replacement)
          ),
          h('button', { class: 'en-apply', onclick: () => applyIssue(issue) }, '应用')
        ),
        issue.message ? h('div', { class: 'en-msg' }, issue.message) : null
      ));
    }
    wrap.append(h('div', { class: 'en-tools' },
      issues.issues.length ? h('button', { class: 'en-btn primary', onclick: applyAll }, '全部应用') : null,
      h('button', { class: 'en-btn', onclick: () => { issues = null; paint(); } }, '关掉')
    ));
    return wrap;
  }

  // ------------------------------------------------------------------- actions
  function applyOption(option) {
    const current = editor.value || '';
    let start = sugg.start;
    let end = sugg.end;
    if (current.slice(start, end) !== sugg.frag) {
      const at = current.indexOf(sugg.frag);
      if (at < 0) { error = '文字已经变了，等一条新建议'; paint(); return; }
      start = at; end = at + sugg.frag.length;
    }
    if (ensureSource) ensureSource();
    editor.focus();
    editor.setSelectionRange(start, end);
    editor.setRangeText(option.en, start, end, 'end');
    sugg = null;
    error = '';
    hint = '已替换中文片段';
    onChange(editor.value);
    paint();
  }

  function replaceWhole(next, message) {
    if (ensureSource) ensureSource();
    editor.focus();
    editor.setSelectionRange(0, editor.value.length);
    editor.setRangeText(next, 0, editor.value.length, 'end');
    error = '';
    hint = message;
    onChange(editor.value);
    paint();
  }

  function applyIssue(issue) {
    const current = editor.value || '';
    const at = current.indexOf(issue.original);
    if (at < 0) { error = '这一处已经不在文里了'; paint(); return; }
    if (ensureSource) ensureSource();
    editor.focus();
    editor.setSelectionRange(at, at + issue.original.length);
    editor.setRangeText(issue.replacement, at, at + issue.original.length, 'end');
    issues.issues = issues.issues.filter((x) => x !== issue);
    error = '';
    hint = '已应用 1 处';
    onChange(editor.value);
    paint();
  }

  function applyAll() {
    if (!issues) return;
    const corrected = issues.corrected;
    const same = !corrected || corrected === editor.value;
    if (!same) {
      issues = null;
      replaceWhole(corrected, '已全部应用');
      return;
    }
    // No single corrected text: walk the issues in order.
    let next = editor.value || '';
    let applied = 0;
    for (const issue of issues.issues) {
      const at = next.indexOf(issue.original);
      if (at < 0) continue;
      next = next.slice(0, at) + issue.replacement + next.slice(at + issue.original.length);
      applied++;
    }
    if (!applied) { error = '没有可自动替换的修改'; paint(); return; }
    issues = null;
    replaceWhole(next, '已应用 ' + applied + ' 处');
  }

  // ------------------------------------------------------------------ requests
  function schedule() {
    clearTimeout(timer);
    const settings = getSettings() || {};
    if (settings.englishOnly === false || settings.aiAutoSuggest === false) { paint(); return; }
    // The first keystrokes can land before ai.status has come back; asking then
    // would look like "no key configured" and silently never suggest.
    if (!resolved) { ready.then(() => { if (status.hasKey) schedule(); }); return; }
    if (!status.hasKey) { paint(); return; }
    const delay = Math.max(300, Number(settings.aiDelayMs) || 900);
    timer = setTimeout(() => ask(), delay);
  }

  async function ask(force) {
    if (busy || !status.hasKey) return;
    if (!editor.isConnected) return;
    const frag = fragAt();
    if (!frag) { sugg = null; hint = ''; paint(); return; }

    const cacheKey = [frag.run.text, frag.left, frag.right].join('\u0001');
    const cached = cacheGet(cacheKey);
    if (cached) {
      sugg = { frag: frag.run.text, start: frag.run.start, end: frag.run.end, options: (cached.options || []).filter((o) => o && o.en), hint: cached.note || '' };
      hint = '';
      error = '';
      paint();
      return;
    }
    if (!force && lastAsked === cacheKey) return;
    lastAsked = cacheKey;

    busy = true;
    error = '';
    paint();
    try {
      const reply = await call('ai.suggest', {
        draft: frag.paragraph,
        fragment: frag.run.text,
        left: frag.left,
        right: frag.right
      });
      cachePut(cacheKey, reply);
      if (!editor.isConnected) return;
      busy = false;
      if (typeof reply.tokens === 'number' && reply.tokens > 0) status.tokens = reply.tokens;

      // The caret may have walked off while the reply was in flight.
      const now = fragAt();
      const options = (reply.options || []).filter((o) => o && o.en);
      if (!now || now.run.text !== frag.run.text || !options.length) { paint(); return; }
      sugg = { frag: frag.run.text, start: frag.run.start, end: frag.run.end, options, hint: reply.note || '' };
      paint();
    } catch (e) {
      busy = false;
      error = e.message || '建议失败';
      paint();
    }
  }

  async function runCheck() {
    if (busy) return;
    const text = editor.value || '';
    if (!text.trim()) { toast && toast('条目是空的'); return; }
    if (!status.hasKey) { error = '先设置模型 key 才能检查'; paint(); return; }
    busy = true;
    error = '';
    hint = '';
    sugg = null;
    paint();
    try {
      const reply = await call('ai.check', { text });
      busy = false;
      if (typeof reply.tokens === 'number' && reply.tokens > 0) status.tokens = reply.tokens;
      issues = {
        mode: reply.mode || 'check',
        issues: Array.isArray(reply.issues) ? reply.issues : [],
        corrected: reply.corrected || text,
        summary: reply.summary || ''
      };
      paint();
    } catch (e) {
      busy = false;
      error = e.message || '检查失败';
      paint();
    }
  }

  // ------------------------------------------------------------------- events
  const onInput = () => {
    if (sugg && editor.value.slice(sugg.start, sugg.end) !== sugg.frag) sugg = null;
    if (issues) issues = null;
    error = '';
    hint = '';
    paint();
    schedule();
  };
  const onCaret = () => {
    if (busy) return;
    const text = editor.value || '';
    const count = cjkCount(text);
    stat.textContent = count ? '中文 ' + count + ' 字' : '没有中文';
  };

  editor.addEventListener('input', onInput);
  editor.addEventListener('keyup', onCaret);
  editor.addEventListener('click', onCaret);
  editor.addEventListener('select', onCaret);

  paint();

  return {
    strip,
    refresh: () => { call('ai.status').then((s) => { status = { ...status, ...s, checked: true }; paint(); }).catch(() => { }); },
    dispose: () => clearTimeout(timer)
  };
}
