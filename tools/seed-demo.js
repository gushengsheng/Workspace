// Generates a demo project so the canvas can be verified without hand-clicking.
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'workspace');
const proj = path.join(dir, 'projects');
fs.mkdirSync(proj, { recursive: true });

const now = Date.now();
const id = (p) => p + '_' + Math.random().toString(36).slice(2, 10);

const entries = [
  {
    title: 'AI 泌尿肿瘤综述 · 主论点',
    body: '# 主论点\n\n影像组学在 mpMRI 检测中的外部验证覆盖率明显低于内部验证。\n\n- 内部验证 597 篇\n- 外部验证 517 篇\n- 差距集中在 **PI-RADS ≥3** 亚组\n\n成本函数 $C = \\alpha n + \\beta t$ 决定样本量取舍。\n'
  },
  {
    title: '待确认：分类口径',
    body: '大语言/基础模型/深度学习/机器学习 可能是包含关系。\n\n> 需要在开头加一句引用，说明本文采用哪一层。\n\n| 层 | 例子 | 本文归入 |\n|---|---|---|\n| 模型族 | 大语言模型 | 方法 |\n| 任务 | 检测/分型 | 域 |\n'
  },
  {
    title: '写作顺序',
    body: '## 顺序\n\n1. 先做 02 肾癌样板\n2. 验收后再铺开\n3. 最后统一口径\n'
  },
  {
    title: '读 papers 里的三篇',
    body: '这一批要读的是：\n\n- Gabriel 2023（mpMRI 外部验证队列）\n- 另一篇 PSMA PET/CT 汇总\n\n读完回来补进 T05 表。'
  }
].map((e) => ({ id: id('e'), title: e.title, body: e.body, tags: [], createdAt: now, updatedAt: now }));

const root = path.resolve(__dirname, '..', 'assets');

const lib = {
  id: id('lib'), name: '综述文库', root,
  createdAt: now, updatedAt: now,
  items: [
    { id: id('it'), path: root, kind: 'dir', name: 'assets', size: 0, mtime: now, addedAt: now },
    { id: id('it'), path: 'C:\\Windows\\System32\\notepad.exe', kind: 'app', name: 'notepad.exe', size: 0, mtime: now, addedAt: now }
  ]
};

const B = {
  entry1: id('b'), entry2: id('b'), entry3: id('b'), entry4: id('b'),
  lib: id('b'), env: id('b'), dir: id('b'), notepad: id('b'), url: id('b')
};

const blocks = [
  { id: B.entry1, kind: 'entry', refId: entries[0].id, x: 80, y: 60, w: 360, h: 250, z: 1 },
  { id: B.entry2, kind: 'entry', refId: entries[1].id, x: 500, y: 40, w: 330, h: 220, z: 2 },
  { id: B.entry3, kind: 'entry', refId: entries[2].id, x: 520, y: 300, w: 300, h: 180, z: 3 },
  { id: B.entry4, kind: 'entry', refId: entries[3].id, x: 60, y: 360, w: 340, h: 190, z: 4 },
  { id: B.lib, kind: 'library', refId: lib.id, x: 900, y: 60, w: 290, h: 170, z: 5 },
  { id: B.env, kind: 'environment', refId: 'env_placeholder', x: 900, y: 280, w: 310, h: 200, z: 6 },
  { id: B.dir, kind: 'dir', refId: lib.root, x: 900, y: 520, w: 280, h: 150, z: 7 },
  { id: B.notepad, kind: 'app', refId: 'C:\\Windows\\System32\\notepad.exe', x: 1220, y: 520, w: 250, h: 140, z: 8 },
  { id: B.url, kind: 'url', refId: 'https://pubmed.ncbi.nlm.nih.gov/', x: 1220, y: 340, w: 260, h: 150, z: 10 }
];

const edges = [
  { id: id('ed'), fromBlock: B.entry1, fromSide: 'r', toBlock: B.entry2, toSide: 'l', kind: 'ref', label: '' },
  { id: id('ed'), fromBlock: B.entry1, fromSide: 'b', toBlock: B.entry4, toSide: 't', kind: 'ref', label: '' },
  { id: id('ed'), fromBlock: B.entry2, fromSide: 'b', toBlock: B.entry3, toSide: 't', kind: 'ref', label: '' },
  // 环境的三条线 == 三个作用项
  { id: id('ed'), fromBlock: B.env, fromSide: 'r', toBlock: B.lib, toSide: 'b', kind: 'works', label: '作用于' },
  { id: id('ed'), fromBlock: B.env, fromSide: 'b', toBlock: B.dir, toSide: 't', kind: 'works', label: '作用于' },
  { id: id('ed'), fromBlock: B.env, fromSide: 't', toBlock: B.url, toSide: 'l', kind: 'works', label: '作用于' }
];

const envId = id('env');
const project = {
  id: id('prj'), name: 'AI 泌尿肿瘤综述 v6',
  createdAt: now, updatedAt: now,
  viewX: -170, viewY: -70, viewScale: 0.78,
  entries, blocks, edges,
  envs: [{
    id: envId, name: '开工：综述环境', description: '',
    funcs: [
      { id: id('f'), kind: 'block', blockId: B.lib, on: true, opener: '', mode: 'selector', selector: '*.pdf', picks: {}, openers: {}, command: '', label: '' },
      { id: id('f'), kind: 'block', blockId: B.dir, on: true, opener: '', mode: 'selector', selector: '', picks: {}, openers: {}, command: '', label: '' },
      { id: id('f'), kind: 'block', blockId: B.url, on: true, opener: '', mode: 'selector', selector: '', picks: {}, openers: {}, command: '', label: '' }
    ],
    lastRunAt: 0
  }],
  tasks: [
    { id: id('t'), title: '确认分类口径', level: 'A', done: false, createdAt: now },
    { id: id('t'), title: '整理 T05 表', level: 'B', done: false, createdAt: now + 1 },
    { id: id('t'), title: '读 Gabriel 2023', level: 'C', done: false, createdAt: now + 2 }
  ]
};
blocks.find((b) => b.id === B.env).refId = envId;

fs.writeFileSync(path.join(proj, project.id + '.json'), JSON.stringify(project, null, 2), 'utf8');

const indexFile = path.join(dir, 'index.json');
let index = { version: 1, settings: {}, libraries: [], projects: [] };
if (fs.existsSync(indexFile)) {
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { }
}
index.settings = index.settings || {};
index.settings.lastProjectId = project.id;
index.libraries = [lib];
index.projects = [{ id: project.id, name: project.name, updatedAt: now, entries: entries.length, blocks: blocks.length }];
fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf8');

console.log('demo project ->', project.id);
