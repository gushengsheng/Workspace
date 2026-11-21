import { call, onHostEvent } from './bridge.js';
import { Canvas, fmtAgo, fmtSize } from './canvas.js';
import { renderMd, excerpt } from './md.js';
import { createCoach, cjkCount, hasChinese, markChinese } from './english.js';

window.__booted = 'app.js loaded';

/* ------------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Anything that explodes in here must be visible: the page has no console by default.
function reportError(where, err) {
  const text = where + ': ' + (err && (err.stack || err.message) || err);
  try { call('log', { msg: 'JSERR ' + text }); } catch { }
  const box = document.getElementById('boot-error');
  if (box) { box.classList.remove('hidden'); box.textContent = text; }
}
window.addEventListener('error', (e) => reportError('error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason));

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;

function bytes(n) { return fmtSize(n); }

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p2 = (x) => String(x).padStart(2, '0');
  return hh > 0 ? `${hh}:${p2(mm)}:${p2(ss)}` : `${p2(mm)}:${p2(ss)}`;
}

function dueText(ts) {
  if (!ts) return '无死线';
  const d = ts - Date.now();
  if (d < 0) return '已逾期 ' + fmtAgo(ts);
  const mins = Math.floor(d / 60000);
  if (mins < 60) return mins + ' 分钟后';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' 小时后';
  return Math.floor(hours / 24) + ' 天后';
}

/* -------------------------------------------------------------------- state */
const S = {
  settings: {},
  libraries: [],
  projects: [],
  project: null,
  runs: [],
  view: 'canvas',
  sel: [],
  selBlock: null,
  insp: { mode: 'empty' },
  mdMode: 'render',
  dataDir: ''
};

let canvas = null;
let saveTimer = null;

/** The English-only philosophy: one switch, nothing else asks twice. */
const englishOn = () => S.settings.englishOnly !== false;

/* --------------------------------------------------------------- persistence */
function save(immediate = false) {
  if (!S.project) return;
  S.project.updatedAt = Date.now();
  clearTimeout(saveTimer);
  const go = async () => {
    try { await call('proj.save', { project: S.project }); }
    catch (e) { toast('保存失败：' + e.message, 'err'); }
  };
  if (immediate) go(); else saveTimer = setTimeout(go, 420);
}

async function saveSettings() {
  try { await call('app.saveSettings', { settings: S.settings }); } catch { }
}

/* --------------------------------------------------------------------- toast */
function toast(text, kind = '', actions = []) {
  const host = $('#toast-host');
  const node = h('div', { class: 'toast ' + kind },
    h('div', {}, text),
    actions.length ? h('div', { class: 't-actions' }, ...actions.map((a) =>
      h('button', { onclick: () => { a.fn(); node.remove(); } }, a.label))) : null
  );
  host.append(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transform = 'translateY(6px)'; node.style.transition = 'all .25s'; setTimeout(() => node.remove(), 260); }, kind === 'err' ? 6000 : 3600);
}

/* -------------------------------------------------------------------- modals */
function modal({ title, sub, body, buttons = [], wide = false }) {
  const host = $('#modal-host');
  host.classList.remove('hidden');
  const close = () => { host.classList.add('hidden'); host.innerHTML = ''; };
  const card = h('div', { class: 'modal', style: wide ? { width: '680px' } : {} },
    h('div', { class: 'modal-head' },
      h('h2', {}, title),
      sub ? h('p', {}, sub) : null),
    h('div', { class: 'modal-body' }, body),
    h('div', { class: 'modal-foot' },
      ...buttons.map((b) => h('button', {
        class: b.primary ? 'primary-btn' : 'ghost-btn',
        onclick: () => b.fn ? b.fn(close) : close()
      }, b.label)))
  );
  host.innerHTML = '';
  host.append(card);
  host.onclick = (e) => { if (e.target === host) close(); };
  return { close, card };
}

function promptModal(title, label, value, onSubmit) {
  const input = h('input', { class: 'field', value: value || '', style: { width: '100%', height: '34px' } });
  const m = modal({
    title, sub: label,
    body: h('div', { style: { padding: '4px 0 10px' } }, input),
    buttons: [
      { label: '取消', fn: (c) => c() },
      { label: '确定', primary: true, fn: (c) => { onSubmit(input.value); c(); } }
    ]
  });
  setTimeout(() => { input.focus(); input.select(); }, 30);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { onSubmit(input.value); m.close(); }
    if (e.key === 'Escape') m.close();
  });
}

/* ------------------------------------------------------------------- context */
function contextMenu(items, x, y) {
  $('.ctx-menu')?.remove();
  const menu = h('div', { class: 'ctx-menu' },
    ...items.map((it) => it === '-'
      ? h('div', { class: 'sep' })
      : h('button', { onclick: () => { menu.remove(); it.fn(); } },
        h('span', {}, it.label),
        it.kbd ? h('span', { class: 'kbd' }, it.kbd) : null))
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  const off = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); }
  };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
}

const APP_EXT = /\.(exe|lnk|bat|cmd|msc|ps1)$/i;
const isAppPath = (p) => APP_EXT.test(String(p || ''));

/* ------------------------------------------------------------------ entities */
const libOf = (id) => S.libraries.find((l) => l.id === id);
const entryOf = (id) => S.project?.entries.find((e) => e.id === id);
const envOf = (id) => S.project?.envs.find((e) => e.id === id);
const blockOfRef = (kind, refId) => S.project?.blocks.find((b) => b.kind === kind && b.refId === refId);

function newEntry(title = '新条目', at = null) {
  if (!S.project) return null;
  const e = { id: uid('e'), title, body: '', tags: [], createdAt: Date.now(), updatedAt: Date.now() };
  S.project.entries.push(e);
  const b = canvas.addBlock('entry', e.id, at ? at.x : 140 + Math.random() * 90, at ? at.y : 140 + Math.random() * 90);
  save();
  renderSidebar();
  return { entry: e, block: b };
}

/* ------------------------------------------------------------------ sidebar */
function renderSidebar() {
  const root = $('#sidebar');
  root.innerHTML = '';

  // ---- projects
  root.append(h('div', { class: 'side-label' }, '项目',
    h('span', { class: 'count' }, String(S.projects.length))));
  if (!S.projects.length) root.append(h('div', { class: 'empty-hint' }, '还没有项目'));
  for (const p of S.projects) {
    const active = S.project && S.project.id === p.id;
    root.append(h('div', {
      class: 'row' + (active ? ' active' : ''),
      onclick: () => openProject(p.id),
      oncontextmenu: (e) => {
        e.preventDefault();
        contextMenu([
          { label: '重命名', fn: () => promptModal('重命名项目', '', p.name, async (v) => {
            if (!v.trim()) return;
            await call('proj.rename', { id: p.id, name: v.trim() });
            await refreshProjects();
            if (S.project && S.project.id === p.id) { S.project.name = v.trim(); renderStageTitle(); }
          }) },
          '-',
          { label: '删除项目', fn: () => confirmDeleteProject(p) }
        ], e.clientX, e.clientY);
      }
    },
      h('span', { class: 'glyph' }, '▤'),
      h('span', { class: 'label' }, p.name),
      h('span', { class: 'sub' }, String(p.blocks || 0))
    ));
  }

  // ---- libraries (child libraries live under their parent, not here)
  const topLibs = S.libraries.filter((l) => !l.parentId);
  root.append(h('div', { class: 'side-label' }, '文库',
    h('span', { class: 'add', title: '新建文库', onclick: () => createLibrary() }, '＋'),
    h('span', { class: 'count' }, String(topLibs.length))));
  if (!topLibs.length) root.append(h('div', { class: 'empty-hint' }, '拖个文件夹进来'));
  for (const l of topLibs) {
    const active = S.insp.mode === 'library' && S.insp.id === l.id;
    root.append(h('div', {
      class: 'row draggable' + (active ? ' active' : ''),
      dataset: { dragKind: 'library', dragRef: l.id, dragLabel: l.name },
      onclick: () => { S.insp = { mode: 'library', id: l.id }; renderInspector(); renderSidebar(); },
      oncontextmenu: (e) => {
        e.preventDefault();
        contextMenu([
          { label: '添加文件…', fn: () => addFilesToLibrary(l) },
          { label: '添加文件夹…', fn: () => addFolderToLibrary(l) },
          '-',
          { label: '重命名', fn: () => promptModal('重命名文库', '', l.name, async (v) => {
            if (!v.trim()) return;
            const nl = await call('lib.rename', { libId: l.id, name: v.trim() });
            Object.assign(l, nl); renderSidebar(); renderInspector();
          }) },
          { label: '删除文库', fn: () => deleteLibrary(l) }
        ], e.clientX, e.clientY);
      }
    },
      h('span', { class: 'glyph' }, '◫'),
      h('span', { class: 'label' }, l.name),
      h('span', { class: 'sub' }, String((l.items || []).length))
    ));
  }

  // ---- entries
  if (S.project) {
    const entries = [...S.project.entries].sort((a, b) => b.updatedAt - a.updatedAt);
    root.append(h('div', { class: 'side-label' }, '条目',
      h('span', { class: 'add', title: '新建条目', onclick: () => { newEntry(); renderSidebar(); } }, '＋'),
      h('span', { class: 'count' }, String(entries.length))));
    for (const e of entries.slice(0, 60)) {
      const active = S.insp.mode === 'entry' && S.insp.id === e.id;
      root.append(h('div', {
        class: 'row draggable' + (active ? ' active' : ''),
        dataset: { dragKind: 'entry', dragRef: e.id, dragLabel: e.title || '未命名' },
        onclick: () => {
          S.insp = { mode: 'entry', id: e.id };
          const b = blockOfRef('entry', e.id);
          if (b) canvas.centerOn(b.id);
          renderInspector(); renderSidebar();
        }
      },
        h('span', { class: 'glyph' }, '✎'),
        h('span', { class: 'label' }, e.title || '未命名'),
        (englishOn() && hasChinese(e.body)) ? h('span', { class: 'zh-dot', title: cjkCount(e.body) + ' 个中文字' }, '中') : null,
        h('span', { class: 'sub' }, fmtAgo(e.updatedAt))
      ));
    }

    // ---- environments
    root.append(h('div', { class: 'side-label' }, '工作环境',
      h('span', { class: 'add', title: '新建环境', onclick: () => newEnv() }, '＋'),
      h('span', { class: 'count' }, String((S.project.envs || []).length))));
    for (const env of S.project.envs || []) {
      const active = S.insp.mode === 'env' && S.insp.id === env.id;
      root.append(h('div', {
        class: 'row draggable' + (active ? ' active' : ''),
        dataset: { dragKind: 'environment', dragRef: env.id, dragLabel: env.name || '未命名环境' },
        onclick: () => { S.insp = { mode: 'env', id: env.id }; renderInspector(); renderSidebar(); },
        ondblclick: () => runEnv(env.id)
      },
        h('span', { class: 'glyph' }, '⌘'),
        h('span', { class: 'label' }, env.name || '未命名环境'),
        h('span', { class: 'sub' }, (env.funcs || []).length + ' 步')
      ));
    }

    // ---- urgent tasks: three levels, nothing else
    const tasks = sortTasks((S.project.tasks || []).filter((t) => !t.done));
    root.append(h('div', { class: 'side-label' }, '紧急',
      h('span', { class: 'count' }, String(tasks.length))));
    if (!tasks.length) root.append(h('div', { class: 'empty-hint' }, '在条目上点 ⚡ 就能把它排进来。'));
    for (const t of tasks) {
      root.append(h('div', {
        class: 'task-row lvl-' + t.level,
        onclick: () => { t.done = true; save(); renderSidebar(); },
        title: '点一下标记完成',
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu([
            ...['A', 'B', 'C'].map((lv) => ({
              label: '设为 ' + lv + ' 级' + (t.level === lv ? ' ✓' : ''),
              fn: () => { t.level = lv; save(); renderSidebar(); }
            })),
            '-',
            { label: '删除', fn: () => { S.project.tasks = S.project.tasks.filter((x) => x.id !== t.id); save(); renderSidebar(); } }
          ], e.clientX, e.clientY);
        }
      },
        h('span', { class: 'lvl-badge' }, t.level),
        h('span', { class: 'ttl' }, t.title)
      ));
    }

    // Pushing forward is reversible: finished ones stay reachable in a fold.
    const doneTasks = sortTasks((S.project.tasks || []).filter((t) => t.done));
    if (doneTasks.length) {
      root.append(h('div', {
        class: 'side-label done-label',
        onclick: () => { S.showDone = !S.showDone; renderSidebar(); }
      },
        h('span', {}, (S.showDone ? '▾' : '▸') + ' 已完成'),
        h('span', { class: 'count' }, String(doneTasks.length))
      ));
      if (S.showDone) {
        for (const t of doneTasks) {
          root.append(h('div', {
            class: 'task-row done lvl-' + t.level,
            onclick: () => { t.done = false; save(); renderSidebar(); },
            title: '点一下放回未完成'
          },
            h('span', { class: 'lvl-badge' }, t.level),
            h('span', { class: 'ttl' }, t.title)
          ));
        }
      }
    }
  }

  if (S.project) renderStageTitle();
}

const LEVEL_ORDER = { A: 0, B: 1, C: 2 };
function sortTasks(list) {
  return [...list].sort((a, b) => (LEVEL_ORDER[a.level] ?? 1) - (LEVEL_ORDER[b.level] ?? 1) || a.createdAt - b.createdAt);
}

/* ---------------------------------------------------------------- stage title */
function renderStageTitle() {
  const el = $('#stage-title');
  el.innerHTML = '';
  el.append(document.createTextNode(S.project ? S.project.name : '未打开项目'));
  if (S.project && englishOn()) {
    const left = (S.project.entries || []).filter((e) => hasChinese(e.body)).length;
    if (left) el.append(h('span', { class: 'zh-count', title: '还有中文的条目，点开可以逐个改' }, '中 ' + left));
  }
  $('#canvas-empty').classList.toggle('show', !S.project);
}

/* ------------------------------------------------------------ project loading */
async function refreshProjects() {
  S.projects = await call('proj.list');
}

async function openProject(id) {
  try {
    const data = await call('proj.load', { id });
    S.project = data.project;
    S.libraries = data.libraries || S.libraries;
    S.runs = data.runs || [];
    S.sel = []; S.selBlock = null;
    S.insp = { mode: 'project' };
    document.querySelector('.shell')?.classList.remove('show-inspector');
    S.settings.lastProjectId = id;
    saveSettings();
    canvas.setProject(S.project);
    renderStageTitle();
    renderSidebar();
    renderInspector();
    renderLedger();
  } catch (e) { toast('打开项目失败：' + e.message, 'err'); }
}

async function newProject() {
  promptModal('新建项目', '一个项目就是一张画布', '未命名项目', async (name) => {
    if (!name.trim()) return;
    const p = await call('proj.create', { name: name.trim() });
    await refreshProjects();
    await openProject(p.id);
    toast('项目已建好', 'ok');
  });
}

function confirmDeleteProject(p) {
  modal({
    title: '删除项目？',
    sub: `「${p.name}」的条目、画布和环境都会删掉。磁盘上的文件不受影响。`,
    body: h('div'),
    buttons: [
      { label: '取消', fn: (c) => c() },
      { label: '删除', primary: true, fn: async (c) => {
        await call('proj.delete', { id: p.id });
        await refreshProjects();
        if (S.project && S.project.id === p.id) { S.project = null; canvas.setProject(null); renderStageTitle(); renderSidebar(); renderInspector(); }
        c(); toast('已删除');
      } }
    ]
  });
}

/* ---------------------------------------------------------------- libraries */
async function createLibraryFromPath(path) {
  const lib = await call('lib.create', { name: baseName(path), root: path });
  S.libraries = await call('lib.list');
  S.insp = { mode: 'library', id: lib.id };
  renderSidebar(); renderInspector();
  return lib;
}

async function createLibrary() {
  promptModal('新建文库', '先起个名字，文件以后再导进来', '新文库', async (name) => {
    if (!name || !name.trim()) return;
    const lib = await call('lib.create', { name: name.trim(), root: '' });
    S.libraries = await call('lib.list');
    S.insp = { mode: 'library', id: lib.id };
    renderSidebar(); renderInspector();
    toast('文库建好了，往里加文件吧', 'ok');
  });
}

async function addFilesToLibrary(lib) {
  const paths = await call('pick.files');
  if (!paths || !paths.length) return;
  const r = await call('lib.addPaths', { libId: lib.id, paths });
  Object.assign(lib, r.library);
  renderSidebar(); renderInspector();
  toast(`收了 ${r.added} 个文件`);
}

async function addFolderToLibrary(lib) {
  const path = await call('pick.folder');
  if (!path) return;
  const r = await call('lib.addPaths', { libId: lib.id, paths: [path] });
  Object.assign(lib, r.library);
  renderSidebar(); renderInspector();
  toast('已加入文件夹');
}

/* ------------------------------------------------------------ child libraries */
const childLibsOf = (id) => S.libraries.filter((l) => l.parentId === id);

/** Drops paths already covered by another selected path, so a parent folder plus
 *  its own subfolder is not collected twice. */
function topOnly(paths) {
  const norm = paths.map((p) => String(p).replace(/[\\/]+$/, ''));
  const under = (a, b) => a.toLowerCase().startsWith(b.toLowerCase() + '\\') || a.toLowerCase().startsWith(b.toLowerCase() + '/');
  return norm.filter((p) => !norm.some((q) => q !== p && under(p, q)));
}

function deleteLibrary(lib) {
  const doomed = new Set([lib.id, ...childLibsOf(lib.id).map((l) => l.id)]);
  const goneBlocks = (S.project?.blocks || []).filter((b) => b.kind === 'library' && doomed.has(b.refId));
  const subCount = doomed.size - 1;

  modal({
    title: '删除文库？',
    sub: `「${lib.name}」只删索引，磁盘上的文件不受影响。` +
      (subCount ? `它的 ${subCount} 个子文库也会一起删掉。` : '') +
      (goneBlocks.length ? `画布上 ${goneBlocks.length} 个引用它的块和连线会一起清掉。` : ''),
    body: h('div'),
    buttons: [
      { label: '取消', fn: (c) => c() },
      { label: '删除', primary: true, fn: async (c) => {
        c();
        try {
          await call('lib.remove', { libId: lib.id });
          S.libraries = await call('lib.list');
          if (S.project && goneBlocks.length) {
            const ids = new Set(goneBlocks.map((b) => b.id));
            S.project.blocks = S.project.blocks.filter((b) => !ids.has(b.id));
            S.project.edges = (S.project.edges || []).filter((e) => !ids.has(e.fromBlock) && !ids.has(e.toBlock));
            for (const id of ids) canvas.selection.delete(id);
            save(true);
            canvas.render();
            canvas.refreshSelection();
          }
          if (S.insp.mode === 'library' && doomed.has(S.insp.id)) S.insp = { mode: 'empty' };
          envFileCache.clear();
          renderSidebar(); renderInspector();
          toast('已删除文库');
        } catch (e) { toast(e.message, 'err'); }
      } }
    ]
  });
}

/** Pick folders/files out of a library and put them in a child library. */
async function splitLibrary(lib) {
  const picks = new Set();
  const tree = h('div', { class: 'enum-box', style: { maxHeight: '330px', overflow: 'auto', marginTop: '10px' } },
    h('div', { class: 'empty-hint' }, '读取中…'));
  const nameInput = h('input', {
    class: 'field', style: { width: '100%', height: '32px' },
    placeholder: '名字（留空就用文件夹名）'
  });

  modal({
    title: '拆分子文库',
    sub: `从「${lib.name}」里勾出文件夹或文件。子文库不会出现在左栏「文库」里，只在父文库下面找得到。`,
    wide: true,
    body: h('div', {},
      h('div', { style: { fontSize: '11px', color: 'var(--ink3)', marginBottom: '4px' } }, '名字'),
      nameInput, tree),
    buttons: [
      { label: '取消', fn: (c) => c() },
      { label: '创建', primary: true, fn: async (c) => {
        const paths = topOnly([...picks]);
        if (!paths.length) return toast('先勾点东西', 'err');
        const name = nameInput.value.trim() ||
          (paths.length === 1 ? baseName(paths[0]) : lib.name + ' · ' + paths.length + ' 项');
        try {
          const sub = await call('lib.createSub', { parentId: lib.id, name, paths });
          S.libraries = await call('lib.list');
          envFileCache.clear();
          c();
          S.insp = { mode: 'library', id: sub.id };
          renderSidebar(); renderInspector();
          toast('子文库已创建 · ' + sub.items.length + ' 个收录', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      } }
    ]
  });

  let entries = [];
  try { entries = await envFiles(lib.id); } catch { entries = []; }
  tree.innerHTML = '';
  if (!entries.length) {
    tree.append(h('div', { class: 'empty-hint' }, '这个文库还没有可以展开的内容'));
    return;
  }

  const groups = new Map();
  for (const e of entries) {
    const dir = e.rel.includes('/') ? e.rel.slice(0, e.rel.lastIndexOf('/')) : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(e);
  }
  for (const [dir, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
    tree.append(h('div', { class: 'enum-group' }, dir || '（文库根目录）'));
    for (const e of list) {
      const isDir = e.kind === 'dir';
      tree.append(h('div', { class: 'enum-row' },
        h('input', {
          type: 'checkbox',
          onchange: (ev) => { if (ev.target.checked) picks.add(e.path); else picks.delete(e.path); }
        }),
        h('span', { class: 'enum-name' + (isDir ? ' dir' : ''), title: e.path },
          (isDir ? '📁 ' : '') + e.name)
      ));
    }
  }
}

/* ---------------------------------------------------------------- inspector */
function renderInspector() {
  const box = $('#inspector');
  box.innerHTML = '';
  const m = S.insp;

  // On a narrow window the inspector is a drawer, so selecting something has
  // to actually pull it out — otherwise it looks like clicking did nothing.
  const shell = document.querySelector('.shell');
  if (window.innerWidth <= 1060) {
    shell.classList.toggle('show-inspector', !(m.mode === 'empty' || m.mode === 'project'));
  }
  if (window.innerWidth <= 1060) {
    box.append(h('div', { class: 'insp-close' },
      h('button', { title: '收起', onclick: () => shell.classList.remove('show-inspector') }, '✕')));
  }

  if (m.mode === 'entry') return renderEntryInspector(box, entryOf(m.id));
  if (m.mode === 'env') return renderEnvInspector(box, envOf(m.id));
  if (m.mode === 'library') return renderLibraryInspector(box, libOf(m.id));
  if (m.mode === 'block') {
    const b = S.project?.blocks.find((x) => x.id === m.id);
    if (b) return renderBlockInspector(box, b);
  }
  if (m.mode === 'project' || !S.project) return renderProjectInspector(box);
  box.append(h('div', { class: 'insp-empty' }, '在画布上选一个东西'));
}

function sec(title, ...kids) {
  return h('div', { class: 'insp-sec' }, title ? h('h3', {}, title) : null, ...kids);
}

function renderProjectInspector(box) {
  if (!S.project) {
    box.append(h('div', { class: 'insp-empty' },
      '左边新建一个项目，然后把文件夹或文件拖到画布上。'));
    return;
  }
  const p = S.project;
  box.append(sec(null,
    h('div', { style: { fontSize: '17px', fontWeight: '650', letterSpacing: '-.015em', marginBottom: '4px' } }, p.name),
    h('div', { style: { color: 'var(--ink3)', fontSize: '11.5px' } }, '创建于 ' + new Date(p.createdAt).toLocaleString('zh-CN'))
  ));
  box.append(sec('概览',
    h('div', { class: 'kv' },
      h('span', { class: 'k' }, '条目'), h('span', { class: 'v' }, String(p.entries.length)),
      h('span', { class: 'k' }, '画布块'), h('span', { class: 'v' }, String(p.blocks.length)),
      h('span', { class: 'k' }, '连接'), h('span', { class: 'v' }, String((p.edges || []).length)),
      h('span', { class: 'k' }, '环境'), h('span', { class: 'v' }, String((p.envs || []).length))
    )
  ));
  box.append(sec('动作',
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h('button', { class: 'ghost-btn sm', onclick: () => { newEntry(); renderSidebar(); } }, '＋ 新条目'),
      h('button', { class: 'ghost-btn sm', onclick: () => newEnv() }, '＋ 新环境'),
      h('button', { class: 'ghost-btn sm', onclick: () => canvas.fit() }, '适配画布'),
      h('button', { class: 'ghost-btn sm', onclick: exportProject }, '导出为 Markdown')
    )
  ));
  if (S.runs.length) {
    box.append(sec('最近的运行',
      ...S.runs.slice(0, 8).map((r) => h('div', { class: 'run-row' },
        h('span', { class: 'run-when' }, new Date(r.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })),
        h('span', { class: 'run-name' }, r.envName || '环境'),
        h('span', { class: 'run-steps' }, (r.ok ? '✓' : '✕') + ' ' + (r.steps || []).length + ' 步 ' + (r.durationMs / 1000).toFixed(1) + 's')
      ))));
  }
}

function renderBlockInspector(box, b) {
  if (b.kind === 'entry') { S.insp = { mode: 'entry', id: b.refId }; return renderEntryInspector(box, entryOf(b.refId)); }
  if (b.kind === 'library') { S.insp = { mode: 'library', id: b.refId }; return renderLibraryInspector(box, libOf(b.refId)); }
  if (b.kind === 'environment') { S.insp = { mode: 'env', id: b.refId }; return renderEnvInspector(box, envOf(b.refId)); }

  const isDir = b.kind === 'dir';
  const isApp = b.kind === 'app';
  box.append(sec(isDir ? '文件夹' : isApp ? '程序' : '文件',
    h('div', { style: { fontSize: '15px', fontWeight: '600', marginBottom: '10px', wordBreak: 'break-all' } }, baseName(b.refId)),
    h('button', {
      class: 'primary-btn', style: { width: '100%', marginBottom: '8px' },
      onclick: () => isDir ? call('open.dir', { path: b.refId }).catch((e) => toast(e.message, 'err'))
        : call('open.file', { path: b.refId }).catch((e) => toast(e.message, 'err'))
    }, isDir ? '打开文件夹' : isApp ? '启动' : '打开文件'),
    h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
      h('button', { class: 'ghost-btn sm', onclick: () => call('open.reveal', { path: b.refId }).catch((e) => toast(e.message, 'err')) }, '在资源管理器中显示'),
      !isDir ? h('button', {
        class: 'ghost-btn sm',
        onclick: () => call('open.file', { path: b.refId, opener: 'system' }).catch((e) => toast(e.message, 'err'))
      }, '用默认程序开') : null
    )
  ));
  box.append(sec('路径', h('div', { class: 'path-box' }, b.refId)));
  box.append(sec('块',
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h('button', { class: 'ghost-btn sm', onclick: () => { canvas.duplicateSelected(); renderSidebar(); } }, '复制块'),
      h('button', { class: 'ghost-btn sm danger-btn', onclick: () => { canvas.deleteSelected(); renderInspector(); } }, '删除块')
    )
  ));
}

function renderLibraryInspector(box, lib) {
  if (!lib) { box.append(h('div', { class: 'insp-empty' }, '文库不存在')); return; }
  const isSub = !!lib.parentId;
  const parent = isSub ? libOf(lib.parentId) : null;
  const kids = isSub ? [] : childLibsOf(lib.id);

  box.append(sec(null,
    h('div', { style: { display: 'flex', alignItems: 'baseline' } },
      h('div', { style: { fontSize: '17px', fontWeight: '650', letterSpacing: '-.015em' } }, lib.name),
      isSub ? h('span', { class: 'pill library', style: { marginLeft: '6px' } }, '子') : null),
    h('div', { style: { color: 'var(--ink3)', fontSize: '11.5px', marginTop: '2px' } },
      (isSub ? '来自「' + (parent ? parent.name : '已删除的文库') + '」 · ' : '') +
      (lib.items || []).length + ' 个收录 · ' +
      (lib.root ? baseName(lib.root) : isSub ? '父库的子集' : '松散文库'))
  ));
  box.append(sec('收录项',
    ...(lib.items || []).map((it) => h('div', {
      class: 'row', style: { marginBottom: '2px' },
      ondblclick: () => it.kind === 'dir' ? call('open.dir', { path: it.path }) : call('open.file', { path: it.path }),
      oncontextmenu: async (e) => {
        e.preventDefault();
        contextMenu([
          { label: it.kind === 'app' ? '启动' : '加入画布', fn: () => it.kind === 'app'
            ? call('open.file', { path: it.path }).catch((err) => toast(err.message, 'err'))
            : canvas.addBlock(it.kind === 'dir' ? 'dir' : 'file', it.path, 160, 160) },
          { label: '放到画布上', fn: () => canvas.addBlock(it.kind, it.path, 200, 200) },
          { label: it.kind === 'dir' ? '打开文件夹' : it.kind === 'app' ? '启动' : '打开',
            fn: () => it.kind === 'dir' ? call('open.dir', { path: it.path }) : call('open.file', { path: it.path }).catch((err) => toast(err.message, 'err')) },
          '-',
          { label: isSub ? '从子文库移除' : '从文库移除', fn: async () => {
            await call('lib.removeItem', { libId: lib.id, itemId: it.id });
            S.libraries = await call('lib.list');
            envFileCache.clear();
            renderSidebar(); renderInspector();
          } }
        ], e.clientX, e.clientY);
      }
    },
      h('span', { class: 'glyph' }, it.kind === 'dir' ? '▸' : it.kind === 'app' ? '▶' : '·'),
      h('span', { class: 'label' }, it.name),
      h('span', { class: 'sub' }, it.kind === 'dir' ? '文件夹' : it.kind === 'app' ? '程序' : bytes(it.size))
    )),
    !(lib.items || []).length ? h('div', { class: 'empty-hint' },
      isSub ? '空的。父文库那边可以把东西再拆进来。' : '空的。把文件拖到下面的方块里，或点「＋ 文件」。') : null
  ));
  if (!isSub) {
    box.append(sec('导入',
      h('div', { class: 'lib-drop', dataset: { libDrop: lib.id } },
        h('div', { class: 'lib-drop-title' }, '把文件或文件夹拖到这里'),
        h('div', { class: 'lib-drop-sub' }, '也可以点下面的按钮选择')))
    );
  }

  const actions = [];
  if (!isSub) {
    actions.push(h('button', { class: 'ghost-btn sm', onclick: () => addFilesToLibrary(lib) }, '＋ 文件'));
    actions.push(h('button', { class: 'ghost-btn sm', onclick: () => addFolderToLibrary(lib) }, '＋ 文件夹'));
  }
  actions.push(h('button', { class: 'ghost-btn sm', onclick: () => canvas.addBlock('library', lib.id, 160, 160) }, '放到画布'));
  if (!isSub) {
    actions.push(h('button', {
      class: 'ghost-btn sm',
      onclick: async () => {
        const nl = await call('lib.refresh', { libId: lib.id });
        Object.assign(lib, nl);
        S.libraries = await call('lib.list');
        envFileCache.clear();
        renderSidebar(); renderInspector();
        toast('已刷新');
      }
    }, '刷新'));
    actions.push(h('button', { class: 'ghost-btn sm', onclick: () => splitLibrary(lib) }, '拆分子文库'));
  }
  if (lib.root) actions.push(h('button', { class: 'ghost-btn sm', onclick: () => call('open.dir', { path: lib.root }) }, '打开根目录'));
  actions.push(h('button', {
    class: 'ghost-btn sm danger-btn',
    onclick: () => deleteLibrary(lib)
  }, isSub ? '删除子文库' : '删除文库'));

  box.append(sec('动作',
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, ...actions)
  ));

  if (kids.length) {
    box.append(sec('子文库',
      h('div', { style: { fontSize: '11px', color: 'var(--ink3)', marginBottom: '4px' } }, '只在这里出现，左栏「文库」不列。'),
      ...kids.map((k) => h('div', {
        class: 'row', style: { cursor: 'pointer', marginBottom: '2px' },
        onclick: () => { S.insp = { mode: 'library', id: k.id }; renderInspector(); renderSidebar(); }
      },
        h('span', { class: 'glyph' }, '⑂'),
        h('span', { class: 'label' }, k.name),
        h('span', { class: 'sub' }, (k.items || []).length + ' 个')
      ))
    ));
  }

  if (isSub && parent) {
    box.append(sec('父文库',
      h('div', {
        class: 'row', style: { cursor: 'pointer' },
        onclick: () => { S.insp = { mode: 'library', id: parent.id }; renderInspector(); renderSidebar(); }
      },
        h('span', { class: 'glyph' }, '◫'),
        h('span', { class: 'label' }, parent.name),
        h('span', { class: 'sub' }, (parent.items || []).length + ' 个')
      )
    ));
  }
}

let mdRenderTimer = null;
function renderEntryInspector(box, e) {
  if (!e) { box.append(h('div', { class: 'insp-empty' }, '条目不存在')); return; }

  const titleInput = h('input', {
    class: 'insp-title', value: e.title || '', placeholder: '标题',
    oninput: () => { e.title = titleInput.value; e.updatedAt = Date.now(); save(); canvas.touchAll(); renderSidebarSoon(); }
  });
  box.append(sec(null, titleInput));

  // --- markdown body with a render/source switch
  const editor = h('textarea', {
    class: 'md-editor', spellcheck: 'false',
    oninput: () => {
      e.body = editor.value; e.updatedAt = Date.now();
      save(); renderSidebarSoon();
      clearTimeout(mdRenderTimer);
      mdRenderTimer = setTimeout(() => {
        if (S.mdMode !== 'render') return;
        viewBox.innerHTML = renderMd(e.body);
        if (englishOn()) markChinese(viewBox);
      }, 260);
      canvas.touchAll();
    }
  });
  editor.value = e.body || '';

  const viewBox = h('div', { class: 'md-view md', html: renderMd(e.body || '') });
  if (englishOn()) markChinese(viewBox);
  const srcBtn = h('button', { class: 'active' }, '源码');
  const renBtn = h('button', {}, '渲染');
  const setMode = (mode) => {
    S.mdMode = mode;
    srcBtn.classList.toggle('active', mode === 'source');
    renBtn.classList.toggle('active', mode === 'render');
    editor.classList.toggle('hidden', mode !== 'source');
    viewBox.classList.toggle('hidden', mode !== 'render');
    if (mode === 'render') {
      viewBox.innerHTML = renderMd(e.body || '');
      if (englishOn()) markChinese(viewBox);
    }
  };
  srcBtn.onclick = () => setMode('source');
  renBtn.onclick = () => setMode('render');
  setMode(S.mdMode);

  // The coach rewrites whole values, so the entry has to be written back here —
  // the textarea keeps its native undo, the model only proposes.
  const commitBody = (next) => {
    e.body = next; e.updatedAt = Date.now();
    save(); renderSidebarSoon();
    viewBox.innerHTML = renderMd(e.body || '');
    if (englishOn()) markChinese(viewBox);
    canvas.touchAll();
  };

  const coach = createCoach({
    h, call, toast, editor,
    getSettings: () => S.settings,
    onChange: commitBody,
    ensureSource: () => setMode('source')
  });

  box.append(sec('正文',
    h('div', { class: 'md-bar' }, h('div', { class: 'md-mode' }, srcBtn, renBtn)),
    editor, viewBox, coach.strip
  ));

  // --- urgent
  const task = (S.project.tasks || []).find((t) => t.title === (e.title || '') && !t.done);
  const taskBox = task ? renderTaskControl(task) : h('button', {
    class: 'primary-btn', style: { width: '100%' },
    onclick: () => makeUrgent(e)
  }, '⚡ 设为紧急');

  box.append(sec('紧急', taskBox));

  box.append(sec('动作',
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h('button', { class: 'ghost-btn sm', onclick: () => { const b = blockOfRef('entry', e.id) || canvas.addBlock('entry', e.id, 200, 200); canvas.centerOn(b.id); } }, '在画布上定位'),
      h('button', { class: 'ghost-btn sm', onclick: () => { canvas.addBlock('entry', e.id, 240, 240); save(); } }, '复制一块到画布'),
      h('button', { class: 'ghost-btn sm', onclick: () => exportEntry(e) }, '导出 md'),
      h('button', {
        class: 'ghost-btn sm danger-btn',
        onclick: () => {
          modal({
            title: '删除条目？', sub: '画布上引用它的块也会被删掉。',
            body: h('div'),
            buttons: [
              { label: '取消', fn: (c) => c() },
              { label: '删除', primary: true, fn: (c) => {
                const ids = S.project.blocks.filter((b) => b.kind === 'entry' && b.refId === e.id).map((b) => b.id);
                S.project.blocks = S.project.blocks.filter((b) => !ids.includes(b.id));
                S.project.edges = (S.project.edges || []).filter((x) => !ids.includes(x.fromBlock) && !ids.includes(x.toBlock));
                S.project.entries = S.project.entries.filter((x) => x.id !== e.id);
                S.project.tasks = (S.project.tasks || []).filter((t) => t.entryId !== e.id);
                save(true); canvas.setProject(S.project); renderSidebar(); S.insp = { mode: 'project' }; renderInspector(); c();
              } }
            ]
          });
        }
      }, '删除')
    )
  ));
  box.append(sec('信息',
    h('div', { class: 'kv' },
      h('span', { class: 'k' }, '创建'), h('span', { class: 'v' }, new Date(e.createdAt).toLocaleString('zh-CN')),
      h('span', { class: 'k' }, '修改'), h('span', { class: 'v' }, new Date(e.updatedAt).toLocaleString('zh-CN'))
    )
  ));
}

let sidebarTimer = null;
function renderSidebarSoon() {
  clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(renderSidebar, 500);
}



/* ------------------------------------------------------------------- tasks */
/** A line drawn to/from an environment block creates its "作用项". */
function syncEnvFromEdge(edge) {
  if (!S.project) return;
  const from = blockById(edge.fromBlock), to = blockById(edge.toBlock);
  if (!from || !to) return;
  const envBlock = from.kind === 'environment' ? from : to.kind === 'environment' ? to : null;
  if (!envBlock) return;
  const other = envBlock === from ? to : from;
  if (other.kind === 'environment') return;
  const env = envOf(envBlock.refId);
  if (!env) return;
  env.funcs = env.funcs || [];
  if (!env.funcs.some((f) => f.kind === 'block' && f.blockId === other.id)) {
    env.funcs.push({
      id: uid('f'), kind: 'block', blockId: other.id, on: true, opener: '',
      mode: 'selector', selector: '', picks: {}, openers: {}, command: '', label: ''
    });
    save();
    if (S.insp.mode === 'env' && S.insp.id === env.id) renderInspector();
    renderSidebarSoon();
  }
}

function dropEnvFuncForEdge(edge) {
  if (!S.project) return;
  const from = blockById(edge.fromBlock), to = blockById(edge.toBlock);
  const envBlock = from?.kind === 'environment' ? from : to?.kind === 'environment' ? to : null;
  if (!envBlock) return;
  const other = envBlock === from ? to : from;
  if (!other) return;
  const env = envOf(envBlock.refId);
  if (!env) return;
  const before = (env.funcs || []).length;
  env.funcs = (env.funcs || []).filter((f) => !(f.kind === 'block' && f.blockId === other.id));
  if (env.funcs.length !== before) {
    save();
    if (S.insp.mode === 'env' && S.insp.id === env.id) renderInspector();
  }
}

function dropEnvFuncsForBlocks(ids) {
  if (!S.project) return;
  let changed = false;
  for (const env of S.project.envs || []) {
    const before = (env.funcs || []).length;
    env.funcs = (env.funcs || []).filter((f) => !ids.includes(f.blockId));
    if (env.funcs.length !== before) changed = true;
  }
  if (changed) { save(); if (S.insp.mode === 'env') renderInspector(); }
}
/* ------------------------------------------------------------------- tasks */
// No links, no timer, no deadline: a task is a title and how urgent it is.
function makeUrgent(e) {
  const t = { id: uid('t'), title: e.title || '未命名', level: 'B', done: false, createdAt: Date.now() };
  S.project.tasks.push(t);
  save(true); renderSidebar(); renderInspector();
  toast('已排进紧急 · B 级', 'ok');
}

function renderTaskControl(t) {
  return h('div', {},
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
      h('div', { class: 'seg' },
        ...['A', 'B', 'C'].map((lv) => h('button', {
          class: 'seg-item' + (t.level === lv ? ' active' : ''),
          onclick: () => { t.level = lv; save(); renderSidebar(); renderInspector(); }
        }, lv))
      ),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'ghost-btn sm', onclick: () => { t.done = true; save(); renderSidebar(); renderInspector(); } }, '完成')
    )
  );
}
/* -------------------------------------------------------------- environments */
function newEnv() {
  if (!S.project) return;
  const env = { id: uid('env'), name: '新环境', description: '', funcs: [], lastRunAt: 0 };
  S.project.envs.push(env);
  save(); S.insp = { mode: 'env', id: env.id };
  renderSidebar(); renderInspector();
}

/**
 * Removing an environment removes the thing itself, plus every block on the
 * canvas that pointed at it and the lines to those blocks. Without this the
 * env sat in `project.envs` forever: no inspector button, no sidebar action.
 */
function deleteEnv(envId) {
  if (!S.project) return;
  const env = envOf(envId);
  if (!env) return;
  const name = env.name || '未命名环境';
  const steps = (env.funcs || []).length;
  const onCanvas = (S.project.blocks || []).filter((b) => b.kind === 'environment' && b.refId === envId).length;
  modal({
    title: '删除环境？',
    sub: `「${name}」的 ${steps} 个作用项会一起删掉` +
      (onCanvas ? `，画布上 ${onCanvas} 个环境块和它们的连线也会清掉` : '') +
      '。磁盘上的文件不受影响。',
    body: h('div'),
    buttons: [
      { label: '取消', fn: (c) => c() },
      { label: '删除', primary: true, fn: (c) => {
        const doomed = new Set((S.project.blocks || [])
          .filter((b) => b.kind === 'environment' && b.refId === envId).map((b) => b.id));
        S.project.envs = (S.project.envs || []).filter((e) => e.id !== envId);
        if (doomed.size) {
          S.project.blocks = (S.project.blocks || []).filter((b) => !doomed.has(b.id));
          S.project.edges = (S.project.edges || []).filter((e) => !doomed.has(e.fromBlock) && !doomed.has(e.toBlock));
          for (const id of doomed) canvas.selection.delete(id);
        }
        if (S.insp.mode === 'env' && S.insp.id === envId) S.insp = { mode: 'empty' };
        save(true);
        canvas.render();   // drop the orphaned block elements, redraw the lines
        canvas.refreshSelection();
        renderSidebar(); renderInspector();
        c(); toast('环境已删除');
      } }
    ]
  });
}

const OPENERS = [
  ['', '跟扩展名'],
  ['dual-pdf', 'Dual PDF'],
  ['system', '默认程序'],
  ['notepad', '记事本'],
  ['vscode', 'VS Code'],
  ['terminal', '终端']
];

const blockById = (id) => (S.project?.blocks || []).find((b) => b.id === id);

function blockLabel(b) {
  if (!b) return '（块已删除）';
  if (b.kind === 'library') return libOf(b.refId)?.name || '文库';
  if (b.kind === 'environment') return envOf(b.refId)?.name || '环境';
  if (b.kind === 'entry') return entryOf(b.refId)?.title || '条目';
  const name = String(b.refId || '').split(/[\\/]/).pop();
  return name || b.refId;
}

/** Entries are created by drawing a line; this keeps both sides in sync. */
function envFuncFor(env, blockId) {
  return (env.funcs || []).find((f) => f.kind === 'block' && f.blockId === blockId);
}

function syncEnvFunc(env, block) {
  if (!env || !block) return;
  if (block.kind === 'environment') return;
  if (envFuncFor(env, block.id)) return;
  env.funcs.push({
    id: uid('f'), kind: 'block', blockId: block.id, on: true, opener: '',
    mode: 'selector', selector: '', picks: {}, openers: {}, command: '', label: ''
  });
}

// Cached file lists for "enumerate" mode.
const envFileCache = new Map();
async function envFiles(libId) {
  if (envFileCache.has(libId)) return envFileCache.get(libId);
  let files = [];
  try { files = await call('env.files', { libId }); } catch { files = []; }
  envFileCache.set(libId, files);
  return files;
}

function renderEnvInspector(box, env) {
  if (!env) { box.append(h('div', { class: 'insp-empty' }, '环境不存在')); return; }
  env.funcs = env.funcs || [];

  const nameInput = h('input', {
    class: 'insp-title', value: env.name, placeholder: '环境名字',
    oninput: () => { env.name = nameInput.value; save(); renderSidebarSoon(); }
  });
  box.append(sec(null, nameInput));

  // ---------------------------------------------------------- 作用项
  const list = h('div', {});
  box.append(sec('作用项', list,
    h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
      h('button', { class: 'ghost-btn sm', onclick: () => { addScriptFunc(env); } }, '＋ 脚本项')
    )));

  const drawFuncs = () => {
    list.innerHTML = '';
    if (!env.funcs.length) {
      list.append(h('div', { class: 'empty-hint', style: { padding: '4px 0 6px' } },
        '把画布上的块连过来，就会出现在这里。'));
    }
    for (const f of env.funcs) {
      if (f.kind === 'script') {
        list.append(h('div', { class: 'act-row', style: { display: 'block' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' } },
            h('span', { class: 'k' }, '脚本'),
            h('span', { class: 't' }, f.label || '自定义命令'),
            h('span', { class: 'x', style: { cursor: 'pointer' }, onclick: () => { env.funcs = env.funcs.filter((x) => x !== f); save(); drawFuncs(); } }, '×')
          ),
          h('textarea', {
            class: 'field area mono', placeholder: '例如：mineru parse "{root}\\paper.pdf" -p all -o out.md',
            oninput: (e) => { f.command = e.target.value; save(); }
          }, f.command || '')
        ));
        continue;
      }

      const b = blockById(f.blockId);
      const isLib = b && b.kind === 'library';
      const row = h('div', { class: 'act-row', style: { display: 'block' } });

      row.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h('span', { class: 'dot ' + (b ? b.kind : 'file'), style: { width: '7px', height: '7px', borderRadius: '50%' } }),
        h('span', { class: 't', title: b ? b.refId : '' }, blockLabel(b)),
        !isLib ? h('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--ink2)' } },
          h('input', {
            type: 'checkbox', checked: f.on !== false,
            onchange: (e) => { f.on = e.target.checked; save(); }
          }), '开')
          : null,
        h('span', { class: 'x', style: { cursor: 'pointer' }, onclick: () => {
          env.funcs = env.funcs.filter((x) => x !== f);
          // Only the line between this block and THIS environment goes away:
          // the same block can feed several environments, and matching on the
          // block alone used to kill the first line it found — sometimes the
          // wrong one.
          if (b) {
            const envBlockIds = new Set((S.project.blocks || [])
              .filter((eb) => eb.kind === 'environment' && eb.refId === env.id).map((eb) => eb.id));
            const ed = (S.project.edges || []).find((e2) =>
              (e2.fromBlock === b.id && envBlockIds.has(e2.toBlock)) ||
              (e2.toBlock === b.id && envBlockIds.has(e2.fromBlock)));
            if (ed) canvas.removeEdge(ed.id, true);
          }
          save(); drawFuncs();
        } }, '×')
      ));

      if (!b) {
        row.append(h('div', { style: { fontSize: '11px', color: 'var(--danger)', marginTop: '4px' } }, '它指向的块已经删掉了'));
        list.append(row);
        continue;
      }

      if (isLib) {
        const lib = libOf(b.refId);
        const modeBar = h('div', { class: 'seg', style: { marginTop: '6px' } });
        const mk = (mode, text) => h('button', {
          class: 'seg-item' + (f.mode === mode ? ' active' : ''),
          onclick: () => { f.mode = mode; save(); drawFuncs(); }
        }, text);
        modeBar.append(mk('selector', '选择器'), mk('enumerate', '枚举'));
        row.append(modeBar);

        if (f.mode === 'enumerate') {
          const box2 = h('div', { class: 'enum-box' },
            h('div', { class: 'empty-hint' }, '读取中…'));
          row.append(box2);
          envFiles(b.refId).then((entries) => {
            box2.innerHTML = '';
            if (!entries.length) { box2.append(h('div', { class: 'empty-hint' }, '这个文库还没有文件')); return; }

            // Group by folder so a subfolder and its contents stay together.
            const groups = new Map();
            for (const e of entries) {
              const dir = e.rel.includes('/') ? e.rel.slice(0, e.rel.lastIndexOf('/')) : '';
              if (!groups.has(dir)) groups.set(dir, []);
              groups.get(dir).push(e);
            }

            for (const [dir, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
              box2.append(h('div', { class: 'enum-group' }, dir || '（文库根目录）'));
              for (const e of list) {
                const isDir = e.kind === 'dir';
                const on = !!f.picks?.[e.path];
                const kids = [
                  h('input', {
                    type: 'checkbox', checked: on,
                    onchange: (ev) => {
                      f.picks = f.picks || {};
                      f.picks[e.path] = ev.target.checked;
                      if (ev.target.checked && isDir) toast('这个文件夹会整个打开');
                      save();
                    }
                  }),
                  h('span', {
                    class: 'enum-name' + (isDir ? ' dir' : ''),
                    title: e.path
                  }, (isDir ? '📁 ' : '') + e.name)
                ];
                if (!isDir) {
                  kids.push(h('select', {
                    class: 'field', style: { height: '24px', flex: '0 0 108px', fontSize: '11px' },
                    onchange: (ev) => { f.openers = f.openers || {}; f.openers[e.path] = ev.target.value; save(); }
                  }, ...OPENERS.map(([v, t]) => h('option', { value: v, selected: (f.openers?.[e.path] || '') === v }, t))));
                } else {
                  kids.push(h('span', { class: 'enum-hint' }, '开文件夹'));
                }
                box2.append(h('div', { class: 'enum-row' }, ...kids));
              }
            }
          });
        } else {
          row.append(h('input', {
            class: 'field mono', style: { marginTop: '6px' }, value: f.selector || '',
            placeholder: '空 = 整个文库；或 09_论文撰写；或 *.pdf',
            oninput: (e) => { f.selector = e.target.value; save(); }
          }));
        }
      } else {
        const sel = h('select', {
          class: 'field', style: { height: '26px', marginTop: '6px' },
          onchange: (e) => { f.opener = e.target.value; save(); }
        }, ...OPENERS.map(([v, t]) => h('option', { value: v, selected: (f.opener || '') === v }, t)));
        row.append(sel);
      }

      list.append(row);
    }
  };
  drawFuncs();

  // ------------------------------------------------------------- 运行
  box.append(sec('运行',
    h('div', { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'primary-btn', style: { flex: '1' }, onclick: () => runEnv(env.id) }, '▶ 运行'),
      h('button', { class: 'ghost-btn sm', onclick: () => { canvas.addBlock('environment', env.id, 200, 200); save(); } }, '放到画布')
    ),
    env.lastRunAt ? h('div', { style: { fontSize: '11px', color: 'var(--ink3)', marginTop: '8px' } }, '上次运行 ' + fmtAgo(env.lastRunAt)) : null
  ));

  // ------------------------------------------------------------- 删除
  box.append(sec('删除',
    h('button', {
      class: 'ghost-btn sm', style: { color: 'var(--danger)' },
      onclick: () => deleteEnv(env.id)
    }, '删除这个环境')
  ));

  if (S.runs.length) {
    const mine = S.runs.filter((r) => r.envId === env.id).slice(0, 5);
    if (mine.length) {
      box.append(sec('运行记录', ...mine.map((r) => h('div', { class: 'run-row' },
        h('span', { class: 'run-when' }, new Date(r.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })),
        h('span', { class: 'run-name' }, (r.ok ? '✓ ' : '✕ ') + (r.steps || []).filter((s) => s.ok).length + '/' + (r.steps || []).length),
        h('span', { class: 'run-steps' }, (r.durationMs / 1000).toFixed(1) + 's')
      ))));
    }
  }
}

function addScriptFunc(env) {
  env.funcs.push({
    id: uid('f'), kind: 'script', blockId: '', on: true, opener: '',
    mode: 'selector', selector: '', picks: {}, openers: {}, command: '', label: '脚本'
  });
  save(); renderInspector();
}

async function runEnv(envId) {
  if (!S.project) return;
  const env = envOf(envId);
  if (!env) return;
  let plan;
  try { plan = await call('env.plan', { projectId: S.project.id, envId }); }
  catch (e) { return toast(e.message, 'err'); }

  const steps = plan.steps || [];
  if (!steps.length) return toast('这个环境还没有任何作用项', 'err');

  const live = steps.filter((s) => !s.skipped);
  const bad = live.filter((s) => !s.ok);
  const body = h('div', {},
    h('div', { style: { fontSize: '11.5px', color: 'var(--ink3)', marginBottom: '8px' } },
      live.length + ' 个动作' + (steps.length > live.length ? '，跳过 ' + (steps.length - live.length) + ' 个关着的' : '')),
    ...steps.slice(0, 80).map((s) => h('div', { class: 'plan-step', style: s.skipped ? { opacity: 0.45 } : {} },
      h('span', { class: 'st ' + (s.skipped ? '' : s.ok ? 'ok' : 'no') }, s.skipped ? '–' : s.ok ? '✓' : '✕'),
      h('span', { class: 'lb' }, s.label),
      h('span', { class: 'tg' }, s.target || s.message || '')
    )),
    bad.length ? h('div', { style: { marginTop: '10px', fontSize: '11.5px', color: 'var(--danger)' } },
      bad.length + ' 个目标有问题，执行会在那里停下。') : null
  );

  modal({
    title: '▶ ' + (plan.envName || '运行环境'),
    wide: true,
    body,
    buttons: [
      { label: '取消', fn: (c) => c() },
      { label: '执行 ' + live.length + ' 步', primary: true, fn: async (c) => {
        c();
        toast('正在执行…');
        try {
          const rec = await call('env.run', { projectId: S.project.id, envId });
          S.runs.unshift(rec);
          const envObj = envOf(envId); if (envObj) envObj.lastRunAt = Date.now();
          const okCount = (rec.steps || []).filter((s) => s.ok).length;
          if (rec.ok) toast(`完成 ${okCount}/${(rec.steps || []).length} 步，${(rec.durationMs / 1000).toFixed(1)}s`, 'ok');
          else {
            const failed = (rec.steps || []).find((s) => !s.ok);
            toast('停在第 ' + (okCount + 1) + ' 步：' + (failed?.message || failed?.label || '失败'), 'err');
          }
          renderSidebar(); renderInspector(); renderLedger();
        } catch (e) { toast('运行失败：' + e.message, 'err'); }
      } }
    ]
  });
}

/* ------------------------------------------------------------------ ledger */
function renderLedger() {
  const box = $('#view-ledger');
  box.innerHTML = '';
  if (!S.project) {
    box.append(h('div', { class: 'empty-hint' }, '没有打开项目'));
    return;
  }
  const p = S.project;
  box.append(h('div', { class: 'ledger-head' },
    h('div', { class: 'ledger-title' }, '账本'),
    h('div', { class: 'ledger-sub' }, '同一份数据的表格形态'),
    h('div', { style: { flex: '1' } }),
    h('button', { class: 'ghost-btn sm', onclick: () => newEntry() }, '＋ 条目'),
    h('button', { class: 'ghost-btn sm', onclick: () => newEnv() }, '＋ 环境')
  ));

  const refCount = (kind, refId) => (p.edges || []).filter((e) => {
    const a = p.blocks.find((b) => b.id === e.fromBlock);
    const c = p.blocks.find((b) => b.id === e.toBlock);
    return (a && a.kind === kind && a.refId === refId) || (c && c.kind === kind && c.refId === refId);
  }).length;

  function section(title, rows) {
    if (!rows.length) return;
    box.append(h('div', { class: 'ledger-group' },
      h('h4', {}, title + ' · ' + rows.length),
      h('table', { class: 'ledger-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, '名称'), h('th', {}, '类型'), h('th', {}, '引用'), h('th', {}, '最近活动'), h('th', {}, '状态'))),
        h('tbody', {}, ...rows))));
  }

  const entryRows = p.entries.map((e) => h('tr', {
    onclick: () => { S.insp = { mode: 'entry', id: e.id }; renderInspector(); renderSidebar(); },
    style: { cursor: 'pointer' }
  },
    h('td', { class: 'name' }, e.title || '未命名'),
    h('td', {}, h('span', { class: 'pill entry' }, '条目')),
    h('td', { class: 'num' }, String(refCount('entry', e.id))),
    h('td', { class: 'num' }, fmtAgo(e.updatedAt)),
    h('td', {}, (p.tasks || []).some((t) => t.entryId === e.id && t.status !== 'done')
      ? h('span', { class: 'pill urgent' }, '紧急') : '')
  ));
  section('条目', entryRows);

  const fileRows = p.blocks.filter((b) => b.kind === 'file' || b.kind === 'dir' || b.kind === 'app').map((b) => h('tr', {
    onclick: () => { canvas.centerOn(b.id); setView('canvas'); },
    style: { cursor: 'pointer' }
  },
    h('td', { class: 'name' }, baseName(b.refId)),
    h('td', {}, h('span', { class: 'pill ' + b.kind }, b.kind === 'dir' ? '文件夹' : b.kind === 'app' ? '程序' : '文件')),
    h('td', { class: 'num' }, String(refCount(b.kind, b.refId))),
    h('td', { class: 'num' }, '—'),
    h('td', {}, '')
  ));
  section('文件与文件夹', fileRows);

  const libRows = S.libraries.filter((l) => !l.parentId).map((l) => h('tr', {
    onclick: () => { S.insp = { mode: 'library', id: l.id }; renderInspector(); renderSidebar(); },
    style: { cursor: 'pointer' }
  },
    h('td', { class: 'name' }, l.name),
    h('td', {}, h('span', { class: 'pill library' }, '文库')),
    h('td', { class: 'num' }, String((l.items || []).length)),
    h('td', { class: 'num' }, fmtAgo(l.updatedAt)),
    h('td', {}, '')
  ));
  section('文库', libRows);

  const envRows = (p.envs || []).map((env) => h('tr', {
    onclick: () => { S.insp = { mode: 'env', id: env.id }; renderInspector(); renderSidebar(); },
    style: { cursor: 'pointer' }
  },
    h('td', { class: 'name' }, env.name || '未命名'),
    h('td', {}, h('span', { class: 'pill environment' }, '环境')),
    h('td', { class: 'num' }, (env.funcs || []).length + ' 步'),
    h('td', { class: 'num' }, env.lastRunAt ? fmtAgo(env.lastRunAt) : '未运行'),
    h('td', {}, h('button', {
      class: 'ghost-btn sm',
      onclick: (ev) => { ev.stopPropagation(); runEnv(env.id); }
    }, '▶'))
  ));
  section('工作环境', envRows);

  const taskRows = sortTasks((p.tasks || []).filter((t) => !t.done)).map((t) => h('tr', {},
    h('td', { class: 'name' }, t.title),
    h('td', {}, h('span', { class: 'pill lvl-' + t.level }, t.level + ' 级')),
    h('td', { class: 'num' }, fmtAgo(t.createdAt)),
    h('td', {}, h('button', {
      class: 'ghost-btn sm',
      onclick: () => { t.done = true; save(); renderSidebar(); renderLedger(); }
    }, '完成'))
  ));
  section('紧急任务 · 按 A→B→C 排', taskRows);

  if (S.runs.length) {
    box.append(h('div', { class: 'ledger-group' },
      h('h4', {}, '运行记录 · ' + S.runs.length),
      ...S.runs.slice(0, 30).map((r) => h('div', { class: 'run-row' },
        h('span', { class: 'run-when' }, new Date(r.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })),
        h('span', { class: 'run-name' }, (r.ok ? '✓ ' : '✕ ') + (r.envName || '环境')),
        h('span', { class: 'run-steps' }, (r.steps || []).filter((s) => s.ok).length + '/' + (r.steps || []).length + ' 步 · ' + (r.durationMs / 1000).toFixed(1) + 's')
      ))));
  }
}

/* ------------------------------------------------------------------ exports */
async function exportEntry(e) {
  const text = `# ${e.title || '未命名'}\n\n${e.body || ''}\n`;
  try {
    const r = await call('export.text', { name: (e.title || 'entry').replace(/[\\/:*?"<>|]/g, '_') + '.md', text, filter: 'Markdown|*.md' });
    if (r.ok) toast('已导出到 ' + r.path, 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function exportProject() {
  if (!S.project) return;
  const p = S.project;
  let text = `# ${p.name}\n\n`;
  for (const e of p.entries) {
    text += `\n## ${e.title || '未命名'}\n\n${e.body || ''}\n`;
  }
  try {
    const r = await call('export.text', { name: p.name.replace(/[\\/:*?"<>|]/g, '_') + '.md', text, filter: 'Markdown|*.md' });
    if (r.ok) toast('已导出到 ' + r.path, 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

/* ------------------------------------------------------------------- search */
function openSearch() {
  if (!S.project) return;
  const items = [];
  for (const e of S.project.entries) items.push({ kind: '条目', name: e.title || '未命名', sub: excerpt(e.body, 60), fn: () => { S.insp = { mode: 'entry', id: e.id }; const b = blockOfRef('entry', e.id); if (b) { setView('canvas'); canvas.centerOn(b.id); } renderInspector(); renderSidebar(); } });
  for (const b of S.project.blocks) if (b.kind === 'file' || b.kind === 'dir') items.push({ kind: b.kind === 'dir' ? '文件夹' : '文件', name: baseName(b.refId), sub: b.refId, fn: () => { setView('canvas'); canvas.centerOn(b.id); } });
  for (const l of S.libraries.filter((x) => !x.parentId)) items.push({ kind: '文库', name: l.name, sub: (l.items || []).length + ' 个收录', fn: () => { S.insp = { mode: 'library', id: l.id }; renderInspector(); renderSidebar(); } });
  for (const env of S.project.envs || []) items.push({ kind: '环境', name: env.name || '未命名', sub: (env.funcs || []).length + ' 步', fn: () => { S.insp = { mode: 'env', id: env.id }; renderInspector(); renderSidebar(); } });

  const results = h('div', { class: 'search-results' });
  const input = h('input', { class: 'field', placeholder: '搜条目、文件、文库、环境…' });
  let active = 0, hits = items;

  const draw = () => {
    results.innerHTML = '';
    const q = input.value.trim().toLowerCase();
    hits = items.filter((i) => !q || (i.name + ' ' + (i.sub || '')).toLowerCase().includes(q)).slice(0, 60);
    active = 0;
    hits.forEach((it, i) => {
      const row = h('div', {
        class: 'search-item' + (i === 0 ? ' active' : ''),
        onclick: () => { it.fn(); c.close(); }
      },
        h('span', { class: 'kind' }, it.kind),
        h('span', { class: 'ttl' }, it.name),
        h('span', { class: 'sub' }, it.sub || '')
      );
      results.append(row);
    });
    if (!hits.length) results.append(h('div', { class: 'empty-hint' }, '没有匹配'));
  };

  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = $$('.search-item', results);
      rows[active]?.classList.remove('active');
      active = Math.max(0, Math.min(rows.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      rows[active]?.classList.add('active');
      rows[active]?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && hits[active]) { hits[active].fn(); c.close(); }
    if (e.key === 'Escape') c.close();
  });

  const c = modal({
    title: '搜索', body: h('div', {}, h('div', { class: 'search-box' }, input), results),
    buttons: []
  });
  draw();
  setTimeout(() => input.focus(), 30);
}

/* ----------------------------------------------------------------- settings */
async function openSettings() {
  const s = S.settings;
  let st = { hasKey: false, tokens: 0 };
  try { st = await call('ai.status'); } catch { }

  const dual = h('input', { class: 'field mono', value: s.dualPdfHome || '', placeholder: 'Dual PDF 的目录（含 local/start.cjs）', style: { width: '100%' } });
  const pdfOpener = h('select', { class: 'field' },
    h('option', { value: 'dual-pdf', selected: s.pdfOpener === 'dual-pdf' }, 'Dual PDF'),
    h('option', { value: 'system', selected: s.pdfOpener !== 'dual-pdf' }, '系统默认程序')
  );
  const textOpener = h('select', { class: 'field' },
    h('option', { value: 'system', selected: s.textOpener === 'system' }, '系统默认程序'),
    h('option', { value: 'notepad', selected: s.textOpener === 'notepad' }, '记事本'),
    h('option', { value: 'vscode', selected: s.textOpener === 'vscode' }, 'VS Code')
  );

  // ---- English-only
  const enChk = h('input', { type: 'checkbox', class: 'chk' });
  enChk.checked = s.englishOnly !== false;
  const autoChk = h('input', { type: 'checkbox', class: 'chk' });
  autoChk.checked = s.aiAutoSuggest !== false;
  const base = h('input', { class: 'field mono', value: s.aiBaseUrl || 'https://api.deepseek.com', placeholder: 'https://api.deepseek.com', style: { width: '100%' } });
  const model = h('input', { class: 'field mono', value: s.aiModel || 'deepseek-chat', placeholder: 'deepseek-chat', style: { width: '100%' } });
  const keyInput = h('input', {
    class: 'field mono', type: 'password', style: { width: '100%' },
    placeholder: st.hasKey ? '已保存（留空则不改）' : 'sk-… 只存在本机，DPAPI 加密'
  });
  const delay = h('input', { class: 'field', type: 'number', min: '300', max: '5000', step: '100', value: String(s.aiDelayMs || 900), style: { width: '110px' } });
  const tokenText = h('span', { class: 'sub' }, (st.tokens || 0) + ' tok');

  const saveAi = async () => {
    s.englishOnly = enChk.checked;
    s.aiAutoSuggest = autoChk.checked;
    s.aiBaseUrl = (base.value || '').trim() || 'https://api.deepseek.com';
    s.aiModel = (model.value || '').trim() || 'deepseek-chat';
    s.aiDelayMs = Math.max(300, Math.min(5000, Number(delay.value) || 900));
    await saveSettings();
    const typed = (keyInput.value || '').trim();
    if (typed) { await call('ai.saveKey', { key: typed }); keyInput.value = ''; }
  };

  const testBtn = h('button', {
    class: 'ghost-btn sm',
    onclick: async () => {
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';
      try {
        await saveAi();
        const r = await call('ai.test');
        toast('模型连通 · ' + (r.text || 'OK'), 'ok');
        st = await call('ai.status');
        tokenText.textContent = (st.tokens || 0) + ' tok';
      } catch (e) { toast('测试失败：' + e.message, 'err'); }
      testBtn.disabled = false;
      testBtn.textContent = '测试连接';
    }
  }, '测试连接');

  const group = (title, ...kids) => h('div', { class: 'set-group' }, h('div', { class: 'set-title' }, title), ...kids);

  modal({
    title: '设置',
    wide: true,
    body: h('div', {},
      group('文件',
        h('div', { class: 'field-label' }, '打开 PDF 用'),
        h('div', { class: 'field-row' }, pdfOpener),
        h('div', { class: 'field-label' }, 'Dual PDF 目录'),
        h('div', { class: 'field-row' }, dual),
        h('button', {
          class: 'ghost-btn sm', style: { marginBottom: '12px' },
          onclick: async () => {
            const p = await call('pick.folder');
            if (p) dual.value = p;
          }
        }, '选择目录…'),
        h('div', { class: 'field-label' }, '打开文本 / 代码用'),
        h('div', { class: 'field-row' }, textOpener)
      ),
      group('English',
        h('label', { class: 'set-row' }, enChk, h('span', {}, 'English-only：在条目里标出中文，并给英文建议')),
        h('label', { class: 'set-row' }, autoChk, h('span', {}, '停手后自动给建议（关掉则只手动检查）')),
        h('div', { class: 'field-label' }, '服务地址（OpenAI 兼容）'),
        h('div', { class: 'field-row' }, base),
        h('div', { class: 'field-label' }, '模型'),
        h('div', { class: 'field-row' }, model),
        h('div', { class: 'field-label' }, 'API Key'),
        h('div', { class: 'field-row' }, keyInput),
        h('div', { class: 'field-row' },
          testBtn,
          st.hasKey ? h('button', {
            class: 'ghost-btn sm',
            onclick: async () => {
              await call('ai.saveKey', { key: '' });
              st = await call('ai.status');
              toast('已删除 key', 'ok');
            }
          }, '删除 key') : null
        ),
        h('div', { class: 'field-label' }, '停手多久后给建议（毫秒）'),
        h('div', { class: 'field-row' }, delay),
        h('div', { class: 'field-row', style: { alignItems: 'center' } },
          h('span', { class: 'sub' }, '已用 '), tokenText,
          h('button', {
            class: 'ghost-btn sm',
            onclick: async () => {
              await call('ai.resetTokens');
              st = await call('ai.status');
              tokenText.textContent = '0 tok';
            }
          }, '清零')
        )
      ),
      group('数据', h('div', { class: 'path-box' }, S.dataDir))
    ),
    buttons: [
      { label: '取消', fn: (c) => c() },
      { label: '保存', primary: true, fn: async (c) => {
          await saveAi();
          c(); toast('已保存', 'ok');
          paintEnglish();
          renderSidebar(); renderInspector();
        } }
    ]
  });
}

/* ------------------------------------------------------------------- themes */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  S.settings.theme = theme;
  saveSettings();
}

/* ------------------------------------------------------------------ en pill */
// The philosophy needs exactly one visible switch; everything else is a nudge.
const enBtn = $('#btn-en');

function paintEnglish() {
  if (!enBtn) return;
  enBtn.classList.toggle('on', englishOn());
  enBtn.title = englishOn() ? 'English-only 已开 · 点一下关掉' : 'English-only 已关 · 点一下打开';
}

function wireEnglish() {
  if (!enBtn) return;
  enBtn.onclick = () => {
    S.settings.englishOnly = !englishOn();
    saveSettings();
    paintEnglish();
    renderSidebar();
    renderInspector();
    toast(englishOn() ? 'English-only 已开' : 'English-only 已关', 'ok');
  };
  paintEnglish();
}

/* --------------------------------------------------------------- native drop */
onHostEvent((msg) => {
  if (msg.event === 'filesDropped' && Array.isArray(msg.paths) && msg.paths.length) {
    handleDroppedPaths(msg.paths, msg.x, msg.y);
  }
});

async function handleDroppedPaths(paths, clientX, clientY) {
  if (!S.project) { toast('先新建一个项目，再往里拖东西', 'err'); return; }

  // Dropped onto the library import box? Then it belongs to that library.
  if (clientX != null && clientY != null) {
    const zone = document.elementFromPoint(clientX, clientY)?.closest('[data-lib-drop]');
    if (zone) {
      const libId = zone.dataset.libDrop;
      const lib = libOf(libId);
      try {
        const r = await call('lib.addPaths', { libId, paths });
        if (lib) Object.assign(lib, r.library);
        S.libraries = await call('lib.list');
        envFileCache.clear();
        renderSidebar(); renderInspector();
        toast(`收进「${lib ? lib.name : '文库'}」：新增 ${r.added} 项`, 'ok');
      } catch (e) { toast('导入失败：' + e.message, 'err'); }
      return;
    }
  }

  const w = clientX != null ? canvas.toWorld(clientX, clientY) : { x: 160, y: 160 };
  const stats = await call('lib.statMany', { paths });
  let i = 0;
  const firstDir = paths.find((p) => stats[p] && stats[p].kind === 'dir');

  for (const p of paths) {
    const st = stats[p];
    const kind = st && st.kind === 'dir' ? 'dir' : isAppPath(p) ? 'app' : 'file';
    canvas.addBlock(kind, p, w.x + i * 34, w.y + i * 34);
    i++;
  }
  save();

  if (firstDir) {
    toast('拖进来 ' + paths.length + ' 项。要把这个文件夹建成文库吗？', '', [
      { label: '建文库', fn: async () => { await createLibraryFromPath(firstDir); toast('文库已建好', 'ok'); } },
      { label: '先不用', fn: () => { } }
    ]);
  } else {
    toast('拖进来 ' + paths.length + ' 项');
  }
}

/* --------------------------------------------------------------- view switch */
function setView(v) {
  S.view = v;
  $$('#view-seg .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('#view-canvas').classList.toggle('hidden', v !== 'canvas');
  $('#view-ledger').classList.toggle('hidden', v !== 'ledger');
  if (v === 'ledger') renderLedger();
}

/* ------------------------------------------------------------------ canvas IO */
function blockContext(payload, x, y) {
  if (payload.type === 'empty') {
    contextMenu([
      { label: '新建条目', fn: () => { const r = newEntry('新条目', { x: payload.x, y: payload.y }); S.insp = { mode: 'entry', id: r.entry.id }; renderInspector(); } },
      '-',
      { label: '新建文件块…', fn: async () => {
        const paths = await call('pick.files');
        if (!paths || !paths.length) return;
        let i = 0;
        for (const p of paths) canvas.addBlock(isAppPath(p) ? 'app' : 'file', p, payload.x + i * 30, payload.y + i * 30), i++;
        save();
      } },
      { label: '新建文件夹块…', fn: async () => {
        const p = await call('pick.folder');
        if (p) { canvas.addBlock('dir', p, payload.x, payload.y); save(); }
      } },
      { label: '新建网页块…', fn: () => promptModal('网页地址', 'https://…', 'https://', (v) => {
        if (!/^https?:\/\//i.test(v)) return toast('要 http 或 https 开头', 'err');
        canvas.addBlock('url', v.trim(), payload.x, payload.y); save();
      }) },
      { label: '粘贴路径…', fn: () => { promptModal('粘贴一个路径', '文件或文件夹的绝对路径', '', (v) => addByPath(v, payload.x, payload.y)); } },
      '-',
      { label: '适配画布', fn: () => canvas.fit() }
    ], x, y);
    return;
  }

  if (payload.type === 'dropItem') {
    const { kind, refId } = payload.item;
    canvas.addBlock(kind, refId, payload.x, payload.y);
    save();
    return;
  }

  if (payload.type === 'edge') {
    contextMenu([{ label: '删除这条连接', fn: () => { canvas.removeEdge(payload.edgeId); toast('已删除连接'); } }], x, y);
    return;
  }

  if (payload.type === 'block') {
    const b = payload.block;
    const items = [];
    if (b.kind === 'entry') items.push({ label: '编辑条目', fn: () => { S.insp = { mode: 'entry', id: b.refId }; renderInspector(); renderSidebar(); } });
    if (b.kind === 'file') items.push({ label: '打开文件', fn: () => call('open.file', { path: b.refId }).catch((e) => toast(e.message, 'err')) });
    if (b.kind === 'dir') items.push({ label: '打开文件夹', fn: () => call('open.dir', { path: b.refId }).catch((e) => toast(e.message, 'err')) });
    if (b.kind === 'library') items.push({ label: '打开文库', fn: () => { S.insp = { mode: 'library', id: b.refId }; renderInspector(); } });
    if (b.kind === 'environment') {
      items.push({ label: '▶ 运行环境', fn: () => runEnv(b.refId) });
      items.push({ label: '删除这个环境', fn: () => deleteEnv(b.refId) });
    }
    items.push('-');
    items.push({ label: '复制这一块', kbd: 'Ctrl+D', fn: () => canvas.duplicateSelected() });
    items.push({ label: '置顶', fn: () => { b.z = 9999; canvas.touchAll(); save(); } });
    items.push({ label: '置底', fn: () => { b.z = 1; canvas.touchAll(); save(); } });
    items.push('-');
    items.push({ label: '删除', kbd: 'Del', fn: () => { canvas.deleteSelected(); renderInspector(); } });
    contextMenu(items, x, y);
  }
}

async function addByPath(path, x, y) {
  if (!path || !path.trim()) return;
  const p = path.trim().replace(/^"|"$/g, '');
  const st = await call('lib.stat', { path: p });
  if (!st.exists) return toast('路径不存在：' + p, 'err');
  canvas.addBlock(st.kind === 'dir' ? 'dir' : 'file', st.path, x ?? 200, y ?? 200);
  save();
}

/* --------------------------------------------------------------------- boot */
async function init() {
  window.__initState = 'start';
  let info;
  try { info = await call('app.init'); }
  catch (e) { document.body.innerHTML = '<div style="padding:40px;font:14px sans-serif">无法连接原生宿主：' + esc(e.message) + '</div>'; return; }
  window.__initState = 'gotInfo';

  S.settings = info.settings || {};
  S.libraries = info.libraries || [];
  S.projects = info.projects || [];
  S.dataDir = info.dataDir || '';
  if (info.dualDetected && !S.settings.dualPdfHome) S.settings.dualPdfHome = info.dualDetected;
  applyTheme(S.settings.theme || 'light');
  wireEnglish();

  canvas = new Canvas({
    viewport: $('#viewport'),
    world: $('#world'),
    edgeLayer: $('#edge-layer'),
    blocks: $('#blocks'),
    getProject: () => S.project,
    getLibraries: () => S.libraries,
    onChange: () => save(),
    onSelect: (ids, block) => {
      S.sel = ids; S.selBlock = block;
      if (ids.length === 1 && block) {
        S.insp = block.kind === 'entry' ? { mode: 'entry', id: block.refId } : { mode: 'block', id: block.id };
        renderInspector();
      } else if (!ids.length) {
        if (S.insp.mode === 'block' || S.insp.mode === 'entry') {
          S.insp = { mode: 'project' };
          renderInspector();
        }
      }
    },
    onOpen: (b) => openBlock(b),
    onContext: blockContext,
    onEdgeAdded: (edge) => syncEnvFromEdge(edge),
    onEdgeRemoved: (edge) => dropEnvFuncForEdge(edge),
    onBlocksDeleted: (ids) => dropEnvFuncsForBlocks(ids),
    onZoom: (s) => { const el = $('#zoom-label'); if (el) el.textContent = Math.round(s * 100) + '%'; }
  });

  renderSidebar();
  renderStageTitle();
  renderInspector();
  window.__initState = 'rendered';

  // restore last project
  if (S.settings.lastProjectId && S.projects.some((p) => p.id === S.settings.lastProjectId)) {
    await openProject(S.settings.lastProjectId);
  }

  // Drag a sidebar row onto the canvas. HTML5 drag-and-drop does not fire
  // reliably inside WebView2, so this tracks the pointer itself.
  $('#sidebar').addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.row[data-drag-kind]');
    if (!row || e.button !== 0) return;
    const payload = { kind: row.dataset.dragKind, refId: row.dataset.dragRef, label: row.dataset.dragLabel || '' };
    const start = { x: e.clientX, y: e.clientY };
    let ghost = null, moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      moved = true;
      if (!ghost) {
        ghost = h('div', { class: 'drag-ghost' }, payload.label || payload.kind);
        document.body.append(ghost);
      }
      ghost.style.left = (ev.clientX + 12) + 'px';
      ghost.style.top = (ev.clientY + 10) + 'px';
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (ghost) ghost.remove();
      if (!moved || !S.project) return;
      const vp = $('#viewport').getBoundingClientRect();
      if (ev.clientX < vp.left || ev.clientX > vp.right || ev.clientY < vp.top || ev.clientY > vp.bottom) return;
      const w = canvas.toWorld(ev.clientX, ev.clientY);
      canvas.addBlock(payload.kind, payload.refId, w.x - 60, w.y - 40);
      save(); renderSidebar();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // wiring
  // The titlebar moves the window and the edge strips resize it: the WebView
  // eats WM_NCHITTEST, so the page has to ask the host for a native drag loop.
  const bar = $('#titlebar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button') || e.target.closest('input')) return;
    call('win.drag').catch(() => { });
  });
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || e.target.closest('input')) return;
    call('win.max').catch(() => { });
  });
  $$('.wr').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      call('win.resize', { edge: el.dataset.edge }).catch(() => { });
    });
  });
  $$('.light').forEach((b) => b.addEventListener('click', () => call(`win.${b.dataset.win}`)));
  $('#btn-theme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  $('#btn-settings').onclick = openSettings;
  $('#btn-sidebar').onclick = () => {
    document.querySelector('.shell')?.classList.toggle('show-sidebar');
  };
  $('#btn-inspector').onclick = () => {
    const shell = document.querySelector('.shell');
    shell.classList.toggle('show-inspector');
    shell.classList.toggle('no-inspector', !shell.classList.contains('show-inspector') && window.innerWidth > 1060);
  };
  $('#btn-search').onclick = openSearch;
  $('#btn-fit').onclick = () => canvas.fit();
  $$('#zoom-ctl button').forEach((b) => {
    b.onclick = () => {
      const z = b.dataset.zoom;
      if (z === 'in') canvas.setZoom(canvas.scale * 1.25);
      else if (z === 'out') canvas.setZoom(canvas.scale / 1.25);
      else if (z === 'reset') canvas.setZoom(1);
      else canvas.fit();
    };
  });
  $('#btn-add-entry').onclick = () => { if (!S.project) return newProject(); const r = newEntry(); S.insp = { mode: 'entry', id: r.entry.id }; renderInspector(); renderSidebar(); };
  $('#btn-new-project').onclick = newProject;
  $('#btn-empty-new').onclick = newProject;
  $$('#view-seg .seg-item').forEach((b) => b.onclick = () => setView(b.dataset.view));

  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(true); toast('已保存'); return; }
    if (typing) return;
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && S.project) { e.preventDefault(); const r = newEntry(); S.insp = { mode: 'entry', id: r.entry.id }; renderInspector(); }
  });

  // The library list follows the disk; the host watches and pings us.
  onHostEvent((msg) => {
    if (msg.event === 'libraryChanged' && S.project) {
      call('lib.list').then((libs) => {
        S.libraries = libs;
        envFileCache.clear();
        renderSidebar();
      }).catch(() => { });
    }
  });

  window.addEventListener('beforeunload', () => { save(true); });
  window.addEventListener('resize', () => {
    if (!canvas) return;
    if (canvas.fitPending) canvas.fit();
    else canvas.applyTransform();   // nudge a repaint after the window changes size
  });

  // Handy for the host self-check and for debugging from the console.
  window.__ws = { get state() { return S; }, canvas, renderInspector, renderSidebar, renderLedger, newEntry, openSettings, call };
}

function openBlock(b) {
  if (b.kind === 'entry') { S.insp = { mode: 'entry', id: b.refId }; renderInspector(); return; }
  if (b.kind === 'url') return call('open.url', { url: b.refId }).catch((e) => toast(e.message, 'err'));
  if (b.kind === 'file' || b.kind === 'app') return call('open.file', { path: b.refId }).catch((e) => toast(e.message, 'err'));
  if (b.kind === 'dir') return call('open.dir', { path: b.refId }).catch((e) => toast(e.message, 'err'));
  if (b.kind === 'library') { S.insp = { mode: 'library', id: b.refId }; renderInspector(); return; }
  if (b.kind === 'environment') return runEnv(b.refId);
}

init().catch((e) => reportError('init', e));

/* ------------------------------------------------------------ file drop
   The page owns the drop now: WebView2 refuses OLE drops at the window level
   (that was the red "forbidden" cursor), but a page drop can hand its
   FileSystemHandles to the host, which reads the real paths off them. */
function dropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const lib = el.closest('[data-lib-drop]');
  if (lib) return { kind: 'library', node: lib, libId: lib.dataset.libDrop };
  if (el.closest('#viewport')) return { kind: 'canvas', node: el.closest('#viewport') };
  return null;
}

function clearDropHints() {
  document.querySelectorAll('.drop-hot').forEach((n) => n.classList.remove('drop-hot'));
}

document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  clearDropHints();
  const t = dropTargetAt(e.clientX, e.clientY);
  if (t) t.node.classList.add('drop-hot');
});

document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget) return;
  clearDropHints();
});

document.addEventListener('drop', async (e) => {
  if (!e.dataTransfer) return;
  e.preventDefault();
  clearDropHints();

  // File objects project cleanly to CoreWebView2File on the host (a
  // FileSystemHandle came through as null), and still carry the real path.
  const handles = [];
  for (const item of [...e.dataTransfer.items]) {
    if (item.kind !== 'file') continue;
    try {
      const f = item.getAsFile && item.getAsFile();
      if (f) { handles.push(f); continue; }
      if (item.getAsFileSystemHandle) {
        const h = await item.getAsFileSystemHandle();
        if (h) handles.push(h);
      }
    } catch { /* permission denied: skip this item */ }
  }
  if (!handles.length) { toast('没拿到文件路径', 'err'); return; }

  try {
    window.chrome.webview.postMessageWithAdditionalObjects(
      { method: 'files.dropped', params: { x: e.clientX, y: e.clientY } },
      handles
    );
  } catch (err) {
    reportError('drop', err);
  }
});

// Chromium zooms the whole page on Ctrl+wheel. Only the canvas wants that, and
// it handles it itself. Anywhere else this left the app sitting at 300%, and the
// factor is remembered per origin, so it never came back on its own.
document.addEventListener('wheel', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.target.closest('#viewport')) e.preventDefault();
}, { passive: false });
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (['+', '=', '-', '_', '0'].includes(e.key) && !document.activeElement?.closest('#viewport')) e.preventDefault();
});
