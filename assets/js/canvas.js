// The canvas: an infinite sheet where every card is one of four real things
// (entry, file/folder, library, environment). Coordinates are data, not layout —
// whatever you place here stays where you put it.
import { excerpt } from './md.js';

const MIN_W = 150, MIN_H = 96;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const KIND_DEFAULT = {
  entry: [330, 230],
  file: [270, 160],
  app: [270, 150],
  url: [270, 150],
  dir: [270, 140],
  library: [290, 170],
  environment: [310, 190]
};

export const fmtSize = (n) => {
  if (!n) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
};

export const fmtAgo = (ts) => {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 8640000 * 1000 * 30) return Math.floor(d / 86400000) + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
};

export class Canvas {
  constructor(opts) {
    this.viewport = opts.viewport;
    this.world = opts.world;
    this.edgeLayer = opts.edgeLayer;
    this.blocksEl = opts.blocks;
    this.getProject = opts.getProject;
    this.getLibraries = opts.getLibraries;
    this.onChange = opts.onChange || (() => {});
    this.onSelect = opts.onSelect || (() => {});
    this.onOpen = opts.onOpen || (() => {});
    this.onContext = opts.onContext || (() => {});
    this.onEdgeAdded = opts.onEdgeAdded || (() => {});
    this.onEdgeRemoved = opts.onEdgeRemoved || (() => {});
    this.onBlocksDeleted = opts.onBlocksDeleted || (() => {});
    this.onZoom = opts.onZoom || (() => {});

    this.els = new Map();
    this.selection = new Set();
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.space = false;
    this.raf = 0;

    this.bindViewport();
    this.bindKeys();

    // Fit whenever the viewport settles, until the user pans or zooms by hand.
    // Timing-based retries always lost the race against window maximise + DPI.
    this.fitPending = false;
    if (window.ResizeObserver) {
      new ResizeObserver(() => { if (this.fitPending && this.project) this.fit(); }).observe(this.viewport);
    }
  }

  get project() { return this.getProject(); }
  get blocks() { return this.project ? this.project.blocks : []; }

  // ------------------------------------------------------------- transform
  applyTransform() {
    this.world.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
    this.world.style.backgroundSize = `${24 * this.scale}px ${24 * this.scale}px`;
    this.viewport.style.backgroundSize = `${24 * this.scale}px ${24 * this.scale}px`;
    this.viewport.style.backgroundPosition = `${this.tx}px ${this.ty}px`;
    this.world.classList.toggle('zoom-far', this.scale < 0.40);
    this.world.classList.toggle('zoom-tiny', this.scale < 0.26);
    this.onZoom(this.scale);
  }

  saveView() {
    if (!this.project) return;
    this.project.viewX = this.tx;
    this.project.viewY = this.ty;
    this.project.viewScale = this.scale;
  }

  setProject(project) {
    this.els.clear();
    this.selection.clear();
    this.blocksEl.innerHTML = '';
    this.edgeLayer.innerHTML = '';
    if (!project) { this.applyTransform(); return; }
    this.scale = project.viewScale || 1;
    this.tx = project.viewX || 80;
    this.ty = project.viewY || 80;
    this.render();
    this.applyTransform();
    // Only a project that has never been looked at gets an automatic fit;
    // afterwards the saved view is the truth (position is data).
    this.fitPending = (project.blocks || []).length > 0 && !(project.viewScale > 0.15);
  }

  toWorld(clientX, clientY) {
    const r = this.viewport.getBoundingClientRect();
    return { x: (clientX - r.left - this.tx) / this.scale, y: (clientY - r.top - this.ty) / this.scale };
  }

  zoomAt(factor, clientX, clientY) {
    this.fitPending = false;
    const r = this.viewport.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    const wx = (px - this.tx) / this.scale, wy = (py - this.ty) / this.scale;
    const next = clamp(this.scale * factor, 0.14, 3);
    this.scale = next;
    this.tx = px - wx * next;
    this.ty = py - wy * next;
    this.applyTransform();
    this.saveView();
  }

  setZoom(scale, cx, cy) {
    this.fitPending = false;
    const r = this.viewport.getBoundingClientRect();
    const px = cx === undefined ? r.width / 2 : cx - r.left;
    const py = cy === undefined ? r.height / 2 : cy - r.top;
    const wx = (px - this.tx) / this.scale, wy = (py - this.ty) / this.scale;
    this.scale = clamp(scale, 0.14, 3);
    this.tx = px - wx * this.scale;
    this.ty = py - wy * this.scale;
    this.applyTransform();
    this.saveView();
  }

  fit() {
    const bs = this.blocks;
    if (!bs.length) { this.scale = 1; this.tx = 80; this.ty = 80; this.applyTransform(); this.saveView(); return; }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const b of bs) {
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
    }
    const r = this.viewport.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;   // hidden view (ledger tab): leave the view alone
    const pad = 70;
    const s = clamp(Math.min((r.width - pad * 2) / (x2 - x1 || 1), (r.height - pad * 2) / (y2 - y1 || 1)), 0.14, 1.4);
    this.scale = s;
    this.tx = (r.width - (x2 - x1) * s) / 2 - x1 * s;
    this.ty = (r.height - (y2 - y1) * s) / 2 - y1 * s;
    this.applyTransform();
    this.saveView();
  }

  centerOn(blockId) {
    const b = this.blocks.find((x) => x.id === blockId);
    if (!b) return;
    const r = this.viewport.getBoundingClientRect();
    this.tx = r.width / 2 - (b.x + b.w / 2) * this.scale;
    this.ty = r.height / 2 - (b.y + b.h / 2) * this.scale;
    this.applyTransform();
    this.saveView();
    this.select([blockId]);
    const el = this.els.get(blockId);
    if (el) { el.style.transition = 'box-shadow .1s'; el.animate([{ outline: '2px solid rgba(10,132,255,.55)' }, { outline: '2px solid rgba(10,132,255,0)' }], { duration: 900 }); }
  }

  // ------------------------------------------------------------------ render
  render() {
    if (!this.project) return;
    const alive = new Set();
    for (const b of this.blocks) { alive.add(b.id); this.paintBlock(b); }
    for (const [id, el] of this.els) {
      if (!alive.has(id)) { el.remove(); this.els.delete(id); }
    }
    this.renderEdges();
  }

  blockData(b) {
    const p = this.project;
    if (!p) return null;
    if (b.kind === 'entry') return p.entries.find((e) => e.id === b.refId) || null;
    if (b.kind === 'library') return this.getLibraries().find((l) => l.id === b.refId) || null;
    if (b.kind === 'environment') return p.envs.find((e) => e.id === b.refId) || null;
    return null; // file / dir carry the path in refId
  }

  paintBlock(b) {
    let el = this.els.get(b.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'block';
      el.dataset.id = b.id;
      this.blocksEl.appendChild(el);
      this.els.set(b.id, el);
      this.wireBlock(el, b);
    }
    el.style.left = b.x + 'px';
    el.style.top = b.y + 'px';
    el.style.width = b.w + 'px';
    el.style.height = b.h + 'px';
    el.style.zIndex = String(b.z || 1);
    el.classList.toggle('selected', this.selection.has(b.id));

    const data = this.blockData(b);
    const title = (b.kind === 'url')
      ? (b.refId.replace(/^https?:\/\//, '').split('/')[0] || b.refId)
      : (b.kind === 'file' || b.kind === 'dir' || b.kind === 'app')
        ? (b.refId.split(/[\\/]/).pop() || b.refId)
        : (data && (data.title || data.name)) || '(未命名)';

    let bodyHtml = '';
    let footHtml = '';

    if (b.kind === 'entry') {
      bodyHtml = escapeHtml(excerpt(data ? data.body : '', 220)) || '<span style="color:var(--ink3)">空条目</span>';
      const links = (this.project.edges || []).filter((x) => x.fromBlock === b.id || x.toBlock === b.id).length;
      footHtml = `<span class="tag">${links} 条连线</span><span>${fmtAgo(data && data.updatedAt)}</span>`;
    } else if (b.kind === 'url') {
      bodyHtml = '<span class="tag">网页</span>';
      footHtml = '<span>' + escapeHtml(b.refId) + '</span>';
    } else if (b.kind === 'app') {
      const ext = (b.refId.match(/\.([^.\\/]+)$/) || [, ''])[1].toUpperCase();
      bodyHtml = `<span class="tag">${ext === 'LNK' ? '快捷方式' : '程序'}</span>`;
      footHtml = `<span>双击启动</span>`;
    } else if (b.kind === 'file') {
      const ext = (b.refId.match(/\.([^.\\/]+)$/) || [, ''])[1].toUpperCase();
      bodyHtml = `<span class="tag">${ext || '文件'}</span>`;
      footHtml = `<span>${shortDir(b.refId)}</span>`;
    } else if (b.kind === 'dir') {
      bodyHtml = '<span class="tag">文件夹</span>';
      footHtml = `<span>${escapeHtml(b.refId)}</span>`;
    } else if (b.kind === 'library') {
      const n = data ? (data.items || []).length : 0;
      bodyHtml = `<span class="tag">${n} 个收录</span>`;
      footHtml = `<span>${escapeHtml(data && data.root ? data.root : '松散文库')}</span>`;
    } else if (b.kind === 'environment') {
      const funcs = data ? (data.funcs || []).length : 0;
      const scripts = data ? (data.funcs || []).filter((f) => f.kind === 'script').length : 0;
      bodyHtml = `<span class="tag">${funcs} 个作用项</span>` + (scripts ? ` <span class="tag">${scripts} 个脚本</span>` : '');
      footHtml = `<span>${data && data.lastRunAt ? '上次 ' + fmtAgo(data.lastRunAt) : '还没跑过'}</span>`;
    }

    el.innerHTML = `
      <div class="block-inner">
        <div class="block-head">
          <span class="dot ${b.kind}"></span>
          <span class="block-title">${escapeHtml(title)}</span>
        </div>
        <div class="block-body${b.kind === 'file' ? ' mono' : ''}">${bodyHtml}</div>
        <div class="block-foot">${footHtml}</div>
      </div>
      <div class="anchor-dot l" data-side="l"></div>
      <div class="anchor-dot r" data-side="r"></div>
      <div class="anchor-dot t" data-side="t"></div>
      <div class="anchor-dot b" data-side="b"></div>
      <div class="resize"></div>`;
    this.wireInner(el, b);
  }

  wireInner(el, b) {
    const rz = el.querySelector('.resize');
    rz.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const start = { w: b.w, h: b.h, x: e.clientX, y: e.clientY };
      const move = (ev) => {
        b.w = Math.max(MIN_W, start.w + (ev.clientX - start.x) / this.scale);
        b.h = Math.max(MIN_H, start.h + (ev.clientY - start.y) / this.scale);
        el.style.width = b.w + 'px';
        el.style.height = b.h + 'px';
        this.scheduleEdges();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.onChange();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    el.querySelectorAll('.anchor-dot').forEach((dot) => {
      dot.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.startEdgeDrag(b, dot.dataset.side, e);
      });
    });
  }

  wireBlock(el, b) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      if (e.target.closest('.resize') || e.target.closest('.anchor-dot')) return;
      e.stopPropagation();

      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (additive) {
        if (this.selection.has(b.id)) this.selection.delete(b.id);
        else this.selection.add(b.id);
      } else if (!this.selection.has(b.id)) {
        this.selection.clear();
        this.selection.add(b.id);
      }
      this.bringToFront(b);
      this.refreshSelection();
      this.onSelect([...this.selection], b);

      const start = { x: e.clientX, y: e.clientY };
      const origins = [...this.selection].map((id) => {
        const blk = this.blocks.find((x) => x.id === id);
        return { blk, x: blk.x, y: blk.y };
      });
      let moved = false;
      el.classList.add('dragging');

      const move = (ev) => {
        const dx = (ev.clientX - start.x) / this.scale;
        const dy = (ev.clientY - start.y) / this.scale;
        if (!moved && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 3) return;
        moved = true;
        for (const o of origins) {
          o.blk.x = o.x + dx;
          o.blk.y = o.y + dy;
          const e2 = this.els.get(o.blk.id);
          if (e2) { e2.style.left = o.blk.x + 'px'; e2.style.top = o.blk.y + 'px'; }
        }
        this.scheduleEdges();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        el.classList.remove('dragging');
        if (moved) this.onChange();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.onOpen(b);
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.selection.has(b.id)) { this.selection.clear(); this.selection.add(b.id); this.refreshSelection(); this.onSelect([...this.selection], b); }
      this.onContext({ type: 'block', block: b }, e.clientX, e.clientY);
    });
  }

  bringToFront(b) {
    const maxZ = Math.max(0, ...this.blocks.map((x) => x.z || 1));
    b.z = maxZ + 1;
    const el = this.els.get(b.id);
    if (el) el.style.zIndex = String(b.z);
  }

  refreshSelection() {
    for (const [id, el] of this.els) el.classList.toggle('selected', this.selection.has(id));
  }

  select(ids) {
    this.selection = new Set(ids);
    this.refreshSelection();
    const b = this.blocks.find((x) => x.id === ids[0]);
    this.onSelect([...this.selection], b);
  }

  clearSelection() {
    this.selection.clear();
    this.refreshSelection();
    this.onSelect([], null);
  }

  // ------------------------------------------------------------------- edges
  scheduleEdges() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.renderEdges(); });
  }

  anchorPoint(b, side) {
    switch (side) {
      case 'l': return { x: b.x, y: b.y + b.h / 2 };
      case 'r': return { x: b.x + b.w, y: b.y + b.h / 2 };
      case 't': return { x: b.x + b.w / 2, y: b.y };
      default: return { x: b.x + b.w / 2, y: b.y + b.h };
    }
  }

  pathFor(a, sa, c, sb) {
    const p1 = this.anchorPoint(a, sa);
    const p2 = this.anchorPoint(c, sb);
    const horiz = sa === 'l' || sa === 'r';
    let cp1, cp2;
    if (horiz) {
      const d = Math.max(50, Math.abs(p2.x - p1.x) * 0.45);
      cp1 = { x: p1.x + (sa === 'r' ? d : -d), y: p1.y };
      cp2 = { x: p2.x + (sb === 'l' ? -d : sb === 'r' ? d : 0), y: p2.y };
      if (sb === 't' || sb === 'b') cp2 = { x: p2.x, y: p2.y + (sb === 't' ? -d : d) };
    } else {
      const d = Math.max(50, Math.abs(p2.y - p1.y) * 0.45);
      cp1 = { x: p1.x, y: p1.y + (sa === 'b' ? d : -d) };
      cp2 = { x: p2.x, y: p2.y + (sb === 't' ? -d : sb === 'b' ? d : 0) };
      if (sb === 'l' || sb === 'r') cp2 = { x: p2.x + (sb === 'l' ? -d : d), y: p2.y };
    }
    return `M ${p1.x} ${p1.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${p2.x} ${p2.y}`;
  }

  renderEdges() {
    if (!this.project) return;
    const svg = this.edgeLayer;
    const map = new Map(this.blocks.map((b) => [b.id, b]));
    const parts = [];

    for (const ed of this.project.edges || []) {
      const a = map.get(ed.fromBlock), c = map.get(ed.toBlock);
      if (!a || !c) continue;
      const d = this.pathFor(a, ed.fromSide || 'r', c, ed.toSide || 'l');
      const color = ed.kind === 'works' ? 'rgba(255,159,10,.85)'
        : ed.kind === 'derived' ? 'rgba(94,92,230,.8)'
          : 'rgba(120,120,128,.65)';
      const dash = ed.kind === 'works' ? ' stroke-dasharray="6 5"' : '';
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round"${dash}></path>`);
      parts.push(`<path class="hit" data-edge="${ed.id}" d="${d}" fill="none" stroke="transparent" stroke-width="14"></path>`);
    }

    // preview line while dragging a new edge
    if (this.edgePreview) {
      const { from, side, x, y } = this.edgePreview;
      const p1 = this.anchorPoint(from, side);
      parts.push(`<path d="M ${p1.x} ${p1.y} L ${x} ${y}" fill="none" stroke="rgba(10,132,255,.9)" stroke-width="2" stroke-dasharray="5 4"></path>`);
    }

    svg.innerHTML = parts.join('');
    svg.querySelectorAll('.hit').forEach((p) => {
      p.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onContext({ type: 'edge', edgeId: p.dataset.edge }, e.clientX, e.clientY);
      });
      p.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onContext({ type: 'edge', edgeId: p.dataset.edge }, e.clientX, e.clientY);
      });
    });
  }

  startEdgeDrag(fromBlock, side, e) {
    this.edgePreview = { from: fromBlock, side, x: fromBlock.x, y: fromBlock.y };
    const move = (ev) => {
      const w = this.toWorld(ev.clientX, ev.clientY);
      this.edgePreview.x = w.x;
      this.edgePreview.y = w.y;
      this.scheduleEdges();
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.block');
      this.edgePreview = null;
      if (target && target.dataset.id !== fromBlock.id) {
        const toBlock = this.blocks.find((b) => b.id === target.dataset.id);
        if (toBlock) {
          const xs = [
            { s: 'l', d: Math.abs(toBlock.x - ev.clientX / 1) },
          ];
          const toSide = this.nearestSide(toBlock, ev.clientX, ev.clientY);
          this.addEdge(fromBlock.id, side, toBlock.id, toSide);
        }
      }
      this.scheduleEdges();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  nearestSide(block, clientX, clientY) {
    const w = this.toWorld(clientX, clientY);
    const dl = Math.abs(w.x - block.x), dr = Math.abs(w.x - (block.x + block.w));
    const dt = Math.abs(w.y - block.y), db = Math.abs(w.y - (block.y + block.h));
    const m = Math.min(dl, dr, dt, db);
    return m === dl ? 'l' : m === dr ? 'r' : m === dt ? 't' : 'b';
  }

  addEdge(fromBlock, fromSide, toBlock, toSide) {
    if (!this.project) return;
    const dup = (this.project.edges || []).some((e) => e.fromBlock === fromBlock && e.toBlock === toBlock);
    if (dup) return;
    this.project.edges.push({
      id: 'ed_' + Math.random().toString(36).slice(2, 9),
      fromBlock, fromSide, toBlock, toSide, kind: 'ref', label: ''
    });
    this.renderEdges();
    this.onEdgeAdded(this.project.edges[this.project.edges.length - 1]);
    this.onChange();
  }

  removeEdge(edgeId, silent) {
    if (!this.project) return;
    var gone = this.project.edges.find((e) => e.id === edgeId);
    this.project.edges = this.project.edges.filter((e) => e.id !== edgeId);
    this.renderEdges();
    if (!silent && gone) this.onEdgeRemoved(gone);
    this.onChange();
  }

  // ---------------------------------------------------------------- viewport
  bindViewport() {
    const vp = this.viewport;

    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.fitPending = false;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0022);
        this.zoomAt(factor, e.clientX, e.clientY);
      } else {
        this.tx -= e.deltaX;
        this.ty -= e.deltaY;
        this.applyTransform();
        this.saveView();
      }
    }, { passive: false });

    vp.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.block')) return;
      if (e.button === 2) return;

      const panning = e.button === 1 || this.space || e.altKey;
      if (panning) {
        this.fitPending = false;
        vp.classList.add('panning');
        const sx = e.clientX, sy = e.clientY, ox = this.tx, oy = this.ty;
        const move = (ev) => {
          this.tx = ox + (ev.clientX - sx);
          this.ty = oy + (ev.clientY - sy);
          this.applyTransform();
        };
        const up = () => {
          vp.classList.remove('panning');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          this.saveView();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        return;
      }

      // marquee
      const rect = vp.getBoundingClientRect();
      const start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const box = document.createElement('div');
      box.className = 'marquee';
      box.style.left = start.x + 'px';
      box.style.top = start.y + 'px';
      vp.appendChild(box);
      const additive = e.shiftKey || e.ctrlKey;
      const before = additive ? new Set(this.selection) : new Set();

      const move = (ev) => {
        const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
        const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
        box.style.left = x + 'px'; box.style.top = y + 'px';
        box.style.width = w + 'px'; box.style.height = h + 'px';

        const w1 = this.toWorld(rect.left + x, rect.top + y);
        const w2 = this.toWorld(rect.left + x + w, rect.top + y + h);
        const hit = this.blocks.filter((b) =>
          b.x < w2.x && b.x + b.w > w1.x && b.y < w2.y && b.y + b.h > w1.y).map((b) => b.id);
        this.selection = new Set([...before, ...hit]);
        this.refreshSelection();
      };
      const up = () => {
        box.remove();
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.onSelect([...this.selection], null);
        if (!this.selection.size) this.onSelect([], null);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    vp.addEventListener('dblclick', (e) => {
      if (e.target.closest('.block')) return;
      const w = this.toWorld(e.clientX, e.clientY);
      this.onContext({ type: 'empty', x: w.x, y: w.y }, e.clientX, e.clientY);
    });

    vp.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.block')) return;
      e.preventDefault();
      const w = this.toWorld(e.clientX, e.clientY);
      this.onContext({ type: 'empty', x: w.x, y: w.y }, e.clientX, e.clientY);
    });

    // drop from the sidebar
    vp.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    vp.addEventListener('drop', (e) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData('application/x-ws-item');
      if (!raw) return;
      let payload;
      try { payload = JSON.parse(raw); } catch { return; }
      const w = this.toWorld(e.clientX, e.clientY);
      this.onContext({ type: 'dropItem', item: payload, x: w.x, y: w.y }, e.clientX, e.clientY);
    });
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
      if (e.code === 'Space' && !typing) { this.space = true; this.viewport.classList.add('space'); }
      if (typing) return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.size) {
        e.preventDefault();
        this.deleteSelected();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        this.duplicateSelected();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        if (e.shiftKey) this.fit(); else this.setZoom(1);
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+' || e.key === 'Add')) {
        e.preventDefault();
        this.setZoom(this.scale * 1.25);
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === 'Subtract')) {
        e.preventDefault();
        this.setZoom(this.scale / 1.25);
      }
      if (e.key === 'Escape') this.clearSelection();
      const nudge = e.shiftKey ? 10 : 1;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && this.selection.size) {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -nudge : e.key === 'ArrowRight' ? nudge : 0;
        const dy = e.key === 'ArrowUp' ? -nudge : e.key === 'ArrowDown' ? nudge : 0;
        for (const id of this.selection) {
          const b = this.blocks.find((x) => x.id === id);
          if (!b) continue;
          b.x += dx; b.y += dy;
          const el = this.els.get(id);
          if (el) { el.style.left = b.x + 'px'; el.style.top = b.y + 'px'; }
        }
        this.scheduleEdges();
        clearTimeout(this._nudgeTimer);
        this._nudgeTimer = setTimeout(() => this.onChange(), 300);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { this.space = false; this.viewport.classList.remove('space'); }
    });
  }

  // ------------------------------------------------------------------ edits
  addBlock(kind, refId, x, y, w, h) {
    if (!this.project) return null;
    const [dw, dh] = KIND_DEFAULT[kind] || [280, 180];
    const maxZ = Math.max(0, ...this.blocks.map((b) => b.z || 1));
    const b = {
      id: 'b_' + Math.random().toString(36).slice(2, 9),
      kind, refId,
      x: Math.round(x ?? 120), y: Math.round(y ?? 120),
      w: w || dw, h: h || dh,
      z: maxZ + 1, note: ''
    };
    this.project.blocks.push(b);
    this.paintBlock(b);
    this.select([b.id]);
    this.onChange();
    return b;
  }

  deleteSelected() {
    if (!this.project || !this.selection.size) return;
    const ids = new Set(this.selection);
    this.project.blocks = this.project.blocks.filter((b) => !ids.has(b.id));
    this.project.edges = (this.project.edges || []).filter((e) => !ids.has(e.fromBlock) && !ids.has(e.toBlock));
    for (const id of ids) {
      const el = this.els.get(id);
      if (el) el.remove();
      this.els.delete(id);
    }
    this.selection.clear();
    this.renderEdges();
    this.onBlocksDeleted([...ids]);
    this.onSelect([], null);
    this.onChange();
  }

  duplicateSelected() {
    if (!this.project || !this.selection.size) return;
    const made = [];
    for (const id of this.selection) {
      const src = this.blocks.find((b) => b.id === id);
      if (!src) continue;
      const copy = {
        ...src,
        id: 'b_' + Math.random().toString(36).slice(2, 9),
        x: src.x + 28, y: src.y + 28,
        z: Math.max(0, ...this.blocks.map((b) => b.z || 1)) + 1
      };
      this.project.blocks.push(copy);
      this.paintBlock(copy);
      made.push(copy.id);
    }
    this.select(made);
    this.onChange();
  }

  /** Rebuild one block after its content changed (entry edited elsewhere). */
  touch(blockIds) {
    for (const id of blockIds || []) {
      const b = this.blocks.find((x) => x.id === id);
      if (b) this.paintBlock(b);
    }
  }

  touchAll() {
    for (const b of this.blocks) this.paintBlock(b);
    this.renderEdges();
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortDir(path) {
  const parts = String(path).split(/[\\/]/);
  return parts.slice(Math.max(0, parts.length - 3), -1).join(' › ') || path;
}
