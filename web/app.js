// IronCalc Web — 迷你 Excel（第 1 阶段原型）
//
// 能力：
//   - 加载 / 保存 xlsx（IronCalc 的 wasm-xlsx 绑定）
//   - 单元格编辑、公式求值（引擎内置 SUM/COUNT 等）
//   - 选区、键盘导航、复制粘贴、撤销重做
//   - 通过 window.IC 暴露 API，供第 2 阶段 AI 层驱动
import init, { Model } from './pkg/ironcalc.js';
import { colName, colNumber, a1, parseA1, refText } from './refs.js';
import { initAiPanel } from './ai/panel.js';

const LOCALE = 'en';
const TIMEZONE = 'UTC';
const LANGUAGE = 'en';

const DEF_COL_W = 90; // px，与 ironcalc base 的 DEFAULT_COLUMN_WIDTH 一致
const DEF_ROW_H = 25; // px
const GRID_COLS = 100; // 原型里可滚动的列数（引擎支持 16384）
const GRID_ROWS = 2000; // 原型里可滚动的行数（引擎支持 1048576）
const CACHE_LIMIT = 20000;

// ---------------------------------------------------------------- DOM
const $ = (id) => document.getElementById(id);
const scrollEl = $('scroll');
const canvasEl = $('canvas');
const cellsLayer = $('cells-layer');
const colHeadersEl = $('col-headers');
const colHeadersInner = $('col-headers-inner');
const rowHeadersEl = $('row-headers');
const rowHeadersInner = $('row-headers-inner');
const rangeOverlay = $('range-overlay');
const activeOverlay = $('active-overlay');
const flashLayer = $('flash-layer');
const textLayer = $('text-layer');
const refOverlay = $('ref-overlay');
const editorLayer = $('editor-layer');
const tabList = $('tab-list');
const fxInput = $('fx-input');
const cellRefEl = $('cell-ref');
const statusEl = $('status');
const wbNameEl = $('wb-name');
const toastEl = $('toast');

scrollEl.tabIndex = 0;

// ---------------------------------------------------------------- state
let model = null;
let sheet = 0;
let sel = { ar: 1, ac: 1, fr: 1, fc: 1 }; // anchor + focus（1-based 行列）
let editing = null;
let dragging = false;
let pick = null; // 公式编辑时正在用鼠标选择的区域

const colX = new Float64Array(GRID_COLS + 2); // colX[c] = 第 c 列左边界
let cellCache = new Map();
let cellPool = [];
let flashBoxes = [];
let flashTimer = null;

// 文本单元格高亮 / 公式引用高亮 用的缓存
let dataVersion = 0;          // 每次 invalidate() +1
let textFlagKey = '';         // computeTextCells 的缓存键
let textFlagRenderedKey = ''; // 已画到 DOM 的缓存键
let textFlagCells = [];       // 最近一次算出的文本单元格
let textFlagTruncated = false;

// ---------------------------------------------------------------- utils
function toast(msg, kind) {
  toastEl.textContent = msg;
  toastEl.className = kind === 'error' ? 'error' : '';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hidden'), 3200);
}

function invalidate() {
  if (cellCache.size > CACHE_LIMIT) cellCache = new Map();
  cellCache.clear();
  dataVersion++;
  textFlagKey = '';
  scheduleSave();
}

function selRange() {
  return {
    r1: Math.min(sel.ar, sel.fr),
    r2: Math.max(sel.ar, sel.fr),
    c1: Math.min(sel.ac, sel.fc),
    c2: Math.max(sel.ac, sel.fc),
  };
}

function isSingle() {
  const s = selRange();
  return s.r1 === s.r2 && s.c1 === s.c2;
}

function rangeLabel() {
  const s = selRange();
  const a = `${colName(s.c1)}${s.r1}`;
  if (isSingle()) return a;
  return `${a}:${colName(s.c2)}${s.r2}`;
}

// ---------------------------------------------------------------- metrics
function buildMetrics() {
  for (let c = 1; c <= GRID_COLS; c++) {
    let w = DEF_COL_W;
    try {
      const got = model.getColumnWidth(sheet, c);
      if (got && got > 0) w = got;
    } catch { /* ignore */ }
    colX[c + 1] = colX[c] + w;
  }
  canvasEl.style.width = colX[GRID_COLS + 1] + 'px';
  canvasEl.style.height = GRID_ROWS * DEF_ROW_H + 'px';
  textFlagRenderedKey = ''; // 列宽变了，文本标记要重画
}

function colWidth(c) {
  return colX[c + 1] - colX[c];
}

function colAtX(x) {
  let lo = 1, hi = GRID_COLS, res = 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (colX[m] <= x) { res = m; lo = m + 1; } else hi = m - 1;
  }
  return res;
}

// ---------------------------------------------------------------- data access
function getCell(r, c) {
  const k = r + ':' + c;
  let v = cellCache.get(k);
  if (v !== undefined) return v;
  let text = '', type = 2, style = null;
  try {
    text = model.getFormattedCellValue(sheet, r, c);
    // 空单元格也要取样式：xlsx 里常见“只有填充色没有内容”的表头
    style = model.getCellStyle(sheet, r, c)?.style || null;
    if (text !== '') type = model.getCellType(sheet, r, c);
  } catch { /* ignore */ }
  v = { text, type, style };
  cellCache.set(k, v);
  return v;
}

function resolveColor(color) {
  if (!color) return '';
  try { return model.resolveColor(color) || ''; } catch { return ''; }
}

// ---------------------------------------------------------------- rendering
let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

function render() {
  if (!model) return;
  const sl = scrollEl.scrollLeft, st = scrollEl.scrollTop;
  const vw = scrollEl.clientWidth, vh = scrollEl.clientHeight;

  const c0 = colAtX(sl);
  const c1 = Math.min(GRID_COLS, colAtX(sl + vw));
  const r0 = Math.max(1, Math.floor(st / DEF_ROW_H) + 1);
  const r1 = Math.min(GRID_ROWS, Math.ceil((st + vh) / DEF_ROW_H) + 1);

  renderColHeaders(c0, c1);
  renderRowHeaders(r0, r1);
  renderCells(r0, r1, c0, c1);
  renderTextFlags();
  renderOverlays();
  updateRefHighlight();
  syncFormatToolbar();
  renderRef();
  renderStatus();
}

function renderColHeaders(c0, c1) {
  colHeadersInner.style.transform = `translateX(${-scrollEl.scrollLeft}px)`;
  colHeadersInner.textContent = '';
  const frag = document.createDocumentFragment();
  const s = selRange();
  for (let c = c0; c <= c1; c++) {
    const d = document.createElement('div');
    d.className = 'hcell';
    if (c >= s.c1 && c <= s.c2) d.classList.add('sel');
    d.style.left = colX[c] + 'px';
    d.style.width = colWidth(c) + 'px';
    d.textContent = colName(c);
    d.dataset.c = c;
    frag.appendChild(d);
  }
  colHeadersInner.appendChild(frag);
}

function renderRowHeaders(r0, r1) {
  rowHeadersInner.style.transform = `translateY(${-scrollEl.scrollTop}px)`;
  rowHeadersInner.textContent = '';
  const frag = document.createDocumentFragment();
  const s = selRange();
  for (let r = r0; r <= r1; r++) {
    const d = document.createElement('div');
    d.className = 'rcell';
    if (r >= s.r1 && r <= s.r2) d.classList.add('sel');
    d.style.top = (r - 1) * DEF_ROW_H + 'px';
    d.style.height = DEF_ROW_H + 'px';
    d.textContent = r;
    d.dataset.r = r;
    frag.appendChild(d);
  }
  rowHeadersInner.appendChild(frag);
}

function renderCells(r0, r1, c0, c1) {
  const showGrid = $('chk-grid').checked;
  let i = 0;
  for (let r = r0; r <= r1; r++) {
    const top = (r - 1) * DEF_ROW_H;
    for (let c = c0; c <= c1; c++) {
      let el = cellPool[i];
      if (!el) {
        el = document.createElement('div');
        cellPool.push(el);
        cellsLayer.appendChild(el);
      }
      i++;
      const { text, type, style } = getCell(r, c);

      el.className = 'cell';
      el.style.display = '';
      el.style.left = colX[c] + 'px';
      el.style.top = top + 'px';
      el.style.width = colWidth(c) + 'px';
      el.style.height = DEF_ROW_H + 'px';
      el.style.color = '';
      el.style.background = '#fff';
      el.style.fontSize = '';
      el.style.textDecoration = '';
      el.textContent = '';
      el.dataset.r = r;
      el.dataset.c = c;
      if (!showGrid) el.classList.add('nogrid');

      if (style) applyStyle(el, style);

      if (text === '') { el.dataset.empty = '1'; continue; }
      delete el.dataset.empty;

      const h = style?.alignment?.horizontal;
      let align = h && h !== 'general' ? h : (type === 1 ? 'right' : 'left');
      if (align === 'centerContinuous') align = 'center';
      if (align === 'justify' || align === 'distributed' || align === 'fill') align = 'left';
      if (align === 'center') el.classList.add('al-center');
      else if (align === 'right') el.classList.add('al-right');

      if (type === 16) el.classList.add('error');
      el.textContent = text;
    }
  }
  for (; i < cellPool.length; i++) cellPool[i].style.display = 'none';
}

function applyStyle(el, st) {
  const f = st.font;
  if (f) {
    if (f.b) el.classList.add('bold');
    if (f.i) el.classList.add('italic');
    const deco = [];
    if (f.u) deco.push('underline');
    if (f.strike) deco.push('line-through');
    if (deco.length) el.style.textDecoration = deco.join(' ');
    const c = resolveColor(f.color);
    if (c) el.style.color = c;
    if (f.sz && Math.abs(f.sz - 11) > 0.01) el.style.fontSize = (f.sz * 1.333).toFixed(1) + 'px';
  }
  const bg = resolveColor(st.fill?.color);
  if (bg) el.style.background = bg;
}

// ---------------- AI 改动高亮：纯视觉覆盖层，不写进模型样式，几秒后自动消失 ----------------
const FLASH_MS = 2600;

function clearFlashes() {
  clearTimeout(flashTimer);
  flashTimer = null;
  for (const el of flashBoxes) el.remove();
  flashBoxes = [];
}

function touchesArea(a, b) {
  return a.sheet === b.sheet && a.r1 <= b.r2 + 1 && b.r1 <= a.r2 + 1 && a.c1 <= b.c2 + 1 && b.c1 <= a.c2 + 1;
}

/** 把重叠/相邻的区域并成尽量少的矩形 */
function mergeAreas(areas) {
  const out = [];
  for (const src of areas) {
    let cur = { ...src };
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < out.length; i++) {
        if (touchesArea(out[i], cur)) {
          cur = {
            sheet: cur.sheet,
            r1: Math.min(out[i].r1, cur.r1), c1: Math.min(out[i].c1, cur.c1),
            r2: Math.max(out[i].r2, cur.r2), c2: Math.max(out[i].c2, cur.c2),
          };
          out.splice(i, 1);
          merged = true;
          break;
        }
      }
    }
    out.push(cur);
  }
  return out;
}

/** 画出高亮框，几秒后自动消失。areas: [{sheet,r1,c1,r2,c2}] */
function flashAreas(areas, ms = FLASH_MS) {
  clearFlashes();
  const here = (areas || [])
    .filter((a) => a && a.sheet === sheet)
    .map((a) => ({
      sheet: a.sheet,
      r1: Math.max(1, Math.min(a.r1, a.r2)),
      r2: Math.min(GRID_ROWS, Math.max(a.r1, a.r2)),
      c1: Math.max(1, Math.min(a.c1, a.c2)),
      c2: Math.min(GRID_COLS, Math.max(a.c1, a.c2)),
    }))
    .filter((a) => a.r1 <= a.r2 && a.c1 <= a.c2);
  if (!here.length) return 0;
  for (const a of mergeAreas(here)) {
    const d = document.createElement('div');
    d.className = 'flash-box';
    d.style.left = colX[a.c1] + 'px';
    d.style.top = (a.r1 - 1) * DEF_ROW_H + 'px';
    d.style.width = (colX[a.c2 + 1] - colX[a.c1]) + 'px';
    d.style.height = (a.r2 - a.r1 + 1) * DEF_ROW_H + 'px';
    d.style.animationDuration = ms + 'ms';
    flashLayer.appendChild(d);
    flashBoxes.push(d);
  }
  flashTimer = setTimeout(clearFlashes, ms + 80);
  return here.length;
}

/** 从沙箱的 ops 推断这次改到的区域（args 已被 brief，只取前面的范围参数） */
function opArea(op) {
  return opAreasRaw(op?.name, op?.args || [])[0] || null;
}

/**
 * 与 opArea 同源，但吃「原始参数」（沙箱 onOp 回调给的是未 brief 的值），
 * 因此能拿到 setRange 二维数组的真实尺寸；也修了跨表引用（Sheet2!A1）。
 * 返回这次调用涉及的区域数组（读方法返回空）。
 */
function opAreasRaw(name, args = []) {
  const asRef = typeof args[0] === 'string' ? parseRef(args[0]) : null;
  const n = (i) => (typeof args[i] === 'number' ? args[i] : null);
  const box = (r1, c1, r2, c2, sh = asRef ? asRef.sheet : sheet) => ({ sheet: sh, r1, c1, r2, c2 });

  if (name === 'setCell') {
    if (asRef) return [box(asRef.r1, asRef.c1, asRef.r1, asRef.c1)];
    if (n(0) != null && n(1) != null) return [box(args[0], args[1], args[0], args[1])];
    return [];
  }
  if (name === 'setRange') {
    const values = args[args.length - 1];
    let r1, c1, rMax, cMax;
    if (asRef) { r1 = asRef.r1; c1 = asRef.c1; rMax = asRef.r2; cMax = asRef.c2; }
    else if (n(0) != null && n(1) != null) { r1 = n(0); c1 = n(1); rMax = n(2) ?? r1; cMax = n(3) ?? c1; }
    else return [];
    const grid = Array.isArray(values) && Array.isArray(values[0]) ? values : [values];
    const rows = Math.max(1, grid.length);
    const cols = Math.max(1, ...grid.map((row) => (Array.isArray(row) ? row.length : 1)));
    return [box(r1, c1, Math.min(r1 + rows - 1, rMax), Math.min(c1 + cols - 1, cMax))];
  }
  if (name === 'clearRange' || name === 'applyStyle' || name === 'format'
      || name === 'merge' || name === 'unmerge') {
    if (asRef) return [box(asRef.r1, asRef.c1, asRef.r2, asRef.c2)];
    if (n(0) != null && n(1) != null && n(2) != null && n(3) != null) {
      return [box(n(0), n(1), n(2), n(3))];
    }
    return [];
  }
  if (name === 'insertRows' || name === 'deleteRows') {
    if (n(0) == null) return [];
    const u = usedRangeOf(sheet);
    return [box(args[0], u ? u.c1 : 1, args[0] + (n(1) || 1) - 1, u ? u.c2 : 12)];
  }
  if (name === 'insertColumns' || name === 'deleteColumns') {
    if (n(0) == null) return [];
    const u = usedRangeOf(sheet);
    return [box(u ? u.r1 : 1, args[0], u ? u.r2 : GRID_ROWS, args[0] + (n(1) || 1) - 1)];
  }
  return [];
}

function sheetPrefixedRef(sh, r, c) {
  const base = a1(r, c);
  if (sh === sheet) return base;
  let name = '';
  try { name = model.getWorksheetsProperties()[sh]?.name || ''; } catch { /* ignore */ }
  return name ? `${name}!${base}` : base;
}

function cellSnapshot(sh, r, c) {
  let content = '', value = '';
  try { content = model.getCellContent(sh, r, c); } catch { /* ignore */ }
  try { value = model.getFormattedCellValue(sh, r, c); } catch { /* ignore */ }
  return { sheet: sh, r, c, ref: sheetPrefixedRef(sh, r, c), content, value };
}

function readAreaCells(areas, cap = 300) {
  const out = [];
  for (const a of areas || []) {
    for (let r = a.r1; r <= a.r2; r++) {
      for (let c = a.c1; c <= a.c2; c++) {
        if (out.length >= cap) return out;
        out.push(cellSnapshot(a.sheet, r, c));
      }
    }
  }
  return out;
}

function pickDisplay(cell) {
  const v = cell.value === null || cell.value === undefined ? '' : String(cell.value);
  if (v !== '') return v;
  return cell.content === null || cell.content === undefined ? '' : String(cell.content);
}

/**
 * 记录一次 AI 执行前后的单元格差异。沙箱每调用一个 IC 写方法前 record(name, args)
 * 抓一次 before（此时还没写），执行完 finish() 对比现在，产出：
 *   { areas: [{sheet,r1,c1,r2,c2}], diff: [{ref,before,after}], truncated, moreChanges }
 * areas 同时用于「重新高亮」重放动画。
 */
function makeDiffRecorder(cap = 300) {
  const before = new Map();
  const areas = [];
  const seen = new Set();
  let truncated = false;
  let moreChanges = false;

  const record = (name, args) => {
    let list = [];
    try { list = opAreasRaw(name, args || []); } catch { return; }
    for (const a of list) {
      const k = `${a.sheet}:${a.r1}:${a.c1}:${a.r2}:${a.c2}`;
      if (!seen.has(k)) { seen.add(k); areas.push(a); }
      if (truncated) continue;
      const room = cap - before.size;
      if (room <= 0) { truncated = true; continue; }
      for (const cell of readAreaCells([a], room)) {
        const ck = `${cell.sheet}:${cell.r}:${cell.c}`;
        if (!before.has(ck)) before.set(ck, cell);
        if (before.size >= cap) { truncated = true; break; }
      }
    }
  };

  const finish = () => {
    const diff = [];
    for (const cell of before.values()) {
      const now = cellSnapshot(cell.sheet, cell.r, cell.c);
      if (cell.content === now.content && cell.value === now.value) continue;
      if (diff.length >= 12) { moreChanges = true; break; }
      diff.push({ ref: cell.ref, before: pickDisplay(cell), after: pickDisplay(now) });
    }
    return { areas, diff, truncated, moreChanges };
  };

  return { record, finish };
}

// ---------------- 格式工具栏（粗/斜/下划线/删除线/字号） ----------------
function currentStyle() {
  try { return model.getCellStyle(sheet, sel.ar, sel.ac)?.style || null; } catch { return null; }
}

function applyRangeStyle(path, value) {
  model.updateRangeStyle(areaObj(selRange()), path, String(value));
  invalidate();
  render();
}

function toggleFontFlag(prop) {
  const st = currentStyle();
  applyRangeStyle('font.' + prop, !(st?.font?.[prop]));
}

function setFontSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 1) return;
  applyRangeStyle('font.size', n);
}

/** 工具栏按钮回显当前单元格的样式。 */
function syncFormatToolbar() {
  const f = currentStyle()?.font || {};
  $('btn-bold').classList.toggle('on', !!f.b);
  $('btn-italic').classList.toggle('on', !!f.i);
  $('btn-underline').classList.toggle('on', !!f.u);
  $('btn-strike').classList.toggle('on', !!f.strike);
  const el = $('font-size');
  if (document.activeElement !== el) el.value = String(f.sz || 11);
}

// ---------------- 文本单元格高亮 + 一键转数字 ----------------
/** 把「看着像数字的文本」清成数字（千分位/货币符号/百分号/括号负数）；做不到返回 null。 */
function cleanNumericText(s) {
  let t = String(s ?? '').trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1).trim(); }
  t = t.replace(/[¥$€£₩\s\u00a0]/g, '');
  let pct = false;
  if (t.endsWith('%')) { pct = true; t = t.slice(0, -1); }
  t = t.replace(/,/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
  let n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (pct) n /= 100;
  if (neg) n = -n;
  return n;
}

/** 扫描当前工作表数据区里的文本单元格（带缓存，按 dataVersion/表/模式失效）。 */
function computeTextCells() {
  const onlyNum = $('chk-text-num').checked;
  const key = `${dataVersion}:${sheet}:${onlyNum ? 'num' : 'all'}`;
  if (textFlagKey === key) return textFlagCells;
  const cells = [];
  const CAP = 3000;
  const SCAN_CAP = 200000;
  let scanned = 0;
  const u = usedRangeOf(sheet);
  if (u) {
    outer:
    for (let r = u.r1; r <= u.r2; r++) {
      for (let c = u.c1; c <= u.c2; c++) {
        if (++scanned > SCAN_CAP || cells.length >= CAP) break outer;
        let raw = '', type = 2, disp = '';
        try {
          raw = model.getCellContent(sheet, r, c);
          type = model.getCellType(sheet, r, c);
          if (type !== 2 || raw === '' || raw.startsWith('=')) continue;
          disp = model.getFormattedCellValue(sheet, r, c);
        } catch { continue; }
        const num = cleanNumericText(disp);
        if (onlyNum && num === null) continue;
        cells.push({ r, c, raw, num });
      }
    }
  }
  textFlagTruncated = cells.length >= CAP || scanned > SCAN_CAP;
  textFlagKey = key;
  textFlagCells = cells;
  return cells;
}

function renderTextFlags() {
  if (!$('chk-text').checked) {
    if (textLayer.childNodes.length) { textLayer.textContent = ''; textFlagRenderedKey = ''; }
    updateNumifyButtons();
    return;
  }
  const key = `${dataVersion}:${sheet}:${$('chk-text-num').checked ? 'num' : 'all'}`;
  if (textFlagRenderedKey !== key) {
    textLayer.textContent = '';
    const frag = document.createDocumentFragment();
    for (const { r, c } of computeTextCells()) {
      const d = document.createElement('div');
      d.className = 'text-flag';
      d.style.left = colX[c] + 'px';
      d.style.top = (r - 1) * DEF_ROW_H + 'px';
      d.style.width = colWidth(c) + 'px';
      d.style.height = DEF_ROW_H + 'px';
      frag.appendChild(d);
    }
    textLayer.appendChild(frag);
    textFlagRenderedKey = key;
  }
  updateNumifyButtons();
}

function selectionCandidates() {
  const s = selRange();
  if (s.r1 === s.r2 && s.c1 === s.c2) return [];
  return computeTextCells().filter((x) => x.num !== null && x.r >= s.r1 && x.r <= s.r2 && x.c >= s.c1 && x.c <= s.c2);
}

function updateNumifyButtons() {
  const on = $('chk-text').checked;
  const allBtn = $('btn-numify-all');
  const selBtn = $('btn-numify');
  if (!on) { allBtn.disabled = true; selBtn.disabled = true; return; }
  allBtn.disabled = !computeTextCells().some((x) => x.num !== null);
  selBtn.disabled = selectionCandidates().length === 0;
}

/** 把「像数字的文本」转成真数字。scope: 'selection' | 'all' */
function numify(scope) {
  const s = selRange();
  const single = s.r1 === s.r2 && s.c1 === s.c2;
  const list = (scope === 'selection'
    ? (single ? [] : computeTextCells().filter((x) => x.num !== null && x.r >= s.r1 && x.r <= s.r2 && x.c >= s.c1 && x.c <= s.c2))
    : computeTextCells().filter((x) => x.num !== null));
  if (!list.length) { toast('没有可转换的文本数字'); return; }
  let done = 0, failed = 0;
  try {
    model.pauseEvaluation();
    for (const x of list) {
      try {
        // 文本格式会把数字顶回去，先清成 general
        let fmt = '';
        try { fmt = model.getCellStyle(sheet, x.r, x.c)?.style?.num_fmt || ''; } catch { /* ignore */ }
        if (fmt.replace(/"/g, '').trim() === '@') {
          model.updateRangeStyle({ sheet, row: x.r, column: x.c, width: 1, height: 1 }, 'num_fmt', 'general');
        }
        model.setUserInput(sheet, x.r, x.c, x.raw);
        if (model.getCellType(sheet, x.r, x.c) === 1) { done++; continue; }
        // 引擎认不出来（比如 ¥88），用本地清洗后的数字兑底
        model.setUserInput(sheet, x.r, x.c, String(x.num));
        if (model.getCellType(sheet, x.r, x.c) === 1) done++; else failed++;
      } catch { failed++; }
    }
  } finally {
    model.resumeEvaluation();
    model.evaluate();
  }
  invalidate();
  render();
  toast(`已转换 ${done} 个${failed ? `，${failed} 个失败` : ''}（${scope === 'all' ? '整表' : '选区'}）`);
}

// ---------------- 编辑公式时高亮光标所在的引用（Excel 式） ----------------
const REF_TOKEN_RE = /(?:(?:'[^']*'|[A-Za-z_][A-Za-z0-9_.]*)!)?(?:\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)/g;

/** 找出公式文本里包含 pos 的那个 A1 引用 token（排除函数名）。 */
function refTokenAt(text, pos) {
  REF_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = REF_TOKEN_RE.exec(text))) {
    const start = m.index, end = start + m[0].length;
    if (start > pos) break;
    if (pos < start || pos > end) continue;
    const prev = text[start - 1] || '';
    const next = text[end] || '';
    if (/[A-Za-z0-9_.$']/.test(prev)) continue;
    if (next === '(') continue; // 函数名，不是引用
    if (/[A-Za-z0-9_.$]/.test(next)) continue;
    return m[0];
  }
  return null;
}

function hideRefHighlight() {
  refOverlay.classList.add('hidden');
}

function editingInput() {
  if (editing && document.activeElement === editing.el) return editing.el;
  if (document.activeElement === fxInput) return fxInput;
  return null;
}

function updateRefHighlight() {
  const el = editingInput();
  if (!el || !el.value.startsWith('=')) { hideRefHighlight(); return; }
  const token = refTokenAt(el.value, el.selectionStart ?? el.value.length);
  if (!token) { hideRefHighlight(); return; }
  let a;
  try { a = parseRef(token); } catch { hideRefHighlight(); return; }
  if (a.sheet !== sheet) { hideRefHighlight(); return; }
  const r1 = Math.max(1, Math.min(GRID_ROWS, Math.min(a.r1, a.r2)));
  const r2 = Math.max(1, Math.min(GRID_ROWS, Math.max(a.r1, a.r2)));
  const c1 = Math.max(1, Math.min(GRID_COLS, Math.min(a.c1, a.c2)));
  const c2 = Math.max(1, Math.min(GRID_COLS, Math.max(a.c1, a.c2)));
  refOverlay.classList.remove('hidden');
  refOverlay.style.left = colX[c1] + 'px';
  refOverlay.style.top = (r1 - 1) * DEF_ROW_H + 'px';
  refOverlay.style.width = (colX[c2 + 1] - colX[c1]) + 'px';
  refOverlay.style.height = (r2 - r1 + 1) * DEF_ROW_H + 'px';
}

/** 撤销/重做后通知 AI 面板：已执行过的写操作按钮重新可点。 */
function notifyHistory() {
  try { document.dispatchEvent(new CustomEvent('ic:history')); } catch { /* ignore */ }
}

function renderOverlays() {
  const s = selRange();
  const x = colX[s.c1];
  const y = (s.r1 - 1) * DEF_ROW_H;
  const w = colX[s.c2 + 1] - x;
  const h = (s.r2 - s.r1 + 1) * DEF_ROW_H;

  activeOverlay.classList.remove('hidden');
  activeOverlay.style.left = colX[sel.ac] + 'px';
  activeOverlay.style.top = (sel.ar - 1) * DEF_ROW_H + 'px';
  activeOverlay.style.width = colWidth(sel.ac) + 'px';
  activeOverlay.style.height = DEF_ROW_H + 'px';

  if (isSingle()) {
    rangeOverlay.classList.add('hidden');
  } else {
    rangeOverlay.classList.remove('hidden');
    rangeOverlay.style.left = x + 'px';
    rangeOverlay.style.top = y + 'px';
    rangeOverlay.style.width = w + 'px';
    rangeOverlay.style.height = h + 'px';
  }
}

function renderRef() {
  cellRefEl.textContent = rangeLabel();
  if (editing) {
    // 单元格内编辑时，公式栏跟随显示正在编辑的内容
    if (fxInput.value !== editing.el.value) fxInput.value = editing.el.value;
    return;
  }
  if (document.activeElement !== fxInput) {
    try {
      fxInput.value = model.getCellContent(sheet, sel.ar, sel.ac);
    } catch { fxInput.value = ''; }
  }
}

function parseNum(s) {
  if (!s) return null;
  const t = s.replace(/[,\s\u00a0]/g, '');
  if (/^-?\d+(\.\d+)?%$/.test(t)) return parseFloat(t) / 100;
  if (/^[-(]?\d+(\.\d+)?([eE][-+]?\d+)?\)?$/.test(t)) {
    const neg = /^\(.*\)$/.test(t);
    const v = parseFloat(t.replace(/[()]/g, ''));
    return neg ? -v : v;
  }
  return null;
}

function renderStatus() {
  const parts = [];
  const s = selRange();
  const n = (s.r2 - s.r1 + 1) * (s.c2 - s.c1 + 1);
  if (n > 1 && n <= 2000) {
    let sum = 0, count = 0;
    for (let r = s.r1; r <= s.r2; r++) {
      for (let c = s.c1; c <= s.c2; c++) {
        const { text } = getCell(r, c);
        const v = parseNum(text);
        if (v !== null && Number.isFinite(v)) { sum += v; count++; }
      }
    }
    if (count) {
      const avg = sum / count;
      const fmt = (v) => (Math.round(v * 1e6) / 1e6).toLocaleString('en-US');
      parts.push(`求和: ${fmt(sum)}　平均: ${fmt(avg)}　数值个数: ${count}`);
    }
  }
  if ($('chk-text').checked) {
    const cells = computeTextCells();
    const num = cells.filter((x) => x.num !== null).length;
    parts.push($('chk-text-num').checked
      ? `文本数字: ${num}`
      : `文本单元格: ${cells.length}（像数字 ${num}）`);
    if (textFlagTruncated) parts.push('（只统计前 3000 个）');
  }
  statusEl.textContent = parts.join('　|　');
}

// ---------------------------------------------------------------- tabs
function renderTabs() {
  let props = [];
  try { props = model.getWorksheetsProperties(); } catch { /* ignore */ }
  tabList.textContent = '';
  props.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'tab' + (i === sheet ? ' active' : '');
    b.textContent = p.name;
    b.title = p.name + '（双击重命名）';
    b.onclick = () => selectSheet(i);
    b.ondblclick = () => {
      const name = prompt('重命名工作表', p.name);
      if (name && name !== p.name) {
        try { model.renameSheet(i, name); renderTabs(); scheduleSave(); } catch (e) { toast(e, 'error'); }
      }
    };
    tabList.appendChild(b);
  });
  wbNameEl.textContent = model.getName();
}

function selectSheet(i) {
  sheet = i;
  pick = null;
  clearFlashes();
  invalidate();
  cellPool.forEach((el) => el.remove());
  cellPool = [];
  buildMetrics();
  renderTabs();
  render();
}

// ---------------------------------------------------------------- selection
function focusGrid() {
  if (document.activeElement !== scrollEl) scrollEl.focus({ preventScroll: true });
}

function setSelection(ar, ac, fr = ar, fc = ac) {
  sel = { ar, ac, fr, fc };
  // 自动滚动到可见
  const el = scrollEl;
  const x = colX[ac], y = (ar - 1) * DEF_ROW_H;
  const w = colWidth(ac), h = DEF_ROW_H;
  if (x < el.scrollLeft) el.scrollLeft = x;
  if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = x + w - el.clientWidth;
  if (y < el.scrollTop) el.scrollTop = y;
  if (y + h > el.scrollTop + el.clientHeight) el.scrollTop = y + h - el.clientHeight;
  render();
}

function moveSelection(dr, dc, extend) {
  const r = Math.min(GRID_ROWS, Math.max(1, sel.ar + dr));
  const c = Math.min(GRID_COLS, Math.max(1, sel.ac + dc));
  if (extend) setSelection(sel.ar, sel.ac, r, c);
  else setSelection(r, c);
}

function selectAll() {
  setSelection(1, 1, GRID_ROWS, GRID_COLS);
}

// ---------------------------------------------------------------- editing
function cellRect(r, c) {
  return {
    x: colX[c],
    y: (r - 1) * DEF_ROW_H,
    w: colWidth(c),
    h: DEF_ROW_H,
  };
}

// ---- 公式编辑态：用鼠标点选区域，把引用插进编辑器（Excel 式） ----
// 只要正在编辑的输入框（单元格内编辑器 / 公式栏）内容以 = 开头，就进入“选区模式”:
// 点/拖单元格、点行/列表头，会往光标处插入 A1 / A1:B3 / A:A / 1:1，而不是提交编辑。
function formulaInput() {
  if (editing && editing.el.value.startsWith('=')) return editing.el;
  if (document.activeElement === fxInput && fxInput.value.startsWith('=')) return fxInput;
  return null;
}

function beginPick(el, kind, r1, c1, r2, c2) {
  let start = el.selectionStart ?? el.value.length;
  let end = el.selectionEnd ?? start;
  // 全文被选中（如公式栏 focus 时的全选）→ 当成“插到末尾”，否则替换选中部分
  if (start === 0 && end === el.value.length && end > 0) start = end;
  pick = { el, kind, anchor: { r: r1, c: c1 }, start, end };
  updatePick(r1, c1, r2, c2);
}

function updatePick(r1, c1, r2, c2) {
  if (!pick) return;
  const ref = refText(pick.kind, r1, c1, r2, c2);
  const v = pick.el.value;
  pick.el.value = v.slice(0, pick.start) + ref + v.slice(pick.end);
  pick.end = pick.start + ref.length;
  if (document.activeElement !== pick.el) pick.el.focus();
  pick.el.setSelectionRange(pick.end, pick.end);
}

function endPick() {
  if (!pick) return;
  const { el, end } = pick;
  pick = null;
  if (document.activeElement !== el) el.focus();
  el.setSelectionRange(end, end);
}

function startEdit(initial) {
  if (editing) return;
  const r = sel.ar, c = sel.ac;
  let raw = '';
  try { raw = model.getCellContent(sheet, r, c); } catch { /* ignore */ }
  const rect = cellRect(r, c);

  const el = document.createElement('input');
  el.className = 'cell-editor';
  el.style.left = rect.x + 'px';
  el.style.top = rect.y + 'px';
  el.style.width = Math.max(rect.w, 60) + 'px';
  el.style.height = rect.h + 'px';
  el.value = initial !== undefined ? initial : raw;
  el.spellcheck = false;

  editorLayer.appendChild(el);
  editing = { el, r, c, original: raw };

  el.addEventListener('keydown', (ev) => {
    // 编辑器自己的按键不再冒泡给网格（否则 Enter/Tab 会被处理两次、Backspace 会清空整格）
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); commitEdit({ dr: 1, dc: 0 }); }
    else if (ev.key === 'Tab') { ev.preventDefault(); commitEdit({ dr: 0, dc: ev.shiftKey ? -1 : 1 }); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
  });
  el.addEventListener('input', updateRefHighlight);
  el.addEventListener('click', updateRefHighlight);
  el.addEventListener('keyup', updateRefHighlight);
  el.addEventListener('select', updateRefHighlight);
  el.addEventListener('blur', () => {
    hideRefHighlight();
    if (editing && editing.el === el) commitEdit(null);
  });

  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

function commitEdit(move) {
  if (!editing) return;
  const ed = editing;
  editing = null;
  pick = null;
  hideRefHighlight();
  const value = ed.el.value;
  ed.el.remove();
  if (value !== ed.original) {
    try { model.setUserInput(sheet, ed.r, ed.c, value); invalidate(); }
    catch (e) { toast('公式错误: ' + e, 'error'); }
  }
  if (move) {
    const r = Math.min(GRID_ROWS, Math.max(1, ed.r + move.dr));
    const c = Math.min(GRID_COLS, Math.max(1, ed.c + move.dc));
    sel = { ar: r, ac: c, fr: r, fc: c };
  }
  focusGrid();
  render();
}

function cancelEdit() {
  if (!editing) return;
  const ed = editing;
  editing = null;
  pick = null;
  hideRefHighlight();
  ed.el.remove();
  focusGrid();
  render();
}

// ---------------------------------------------------------------- clipboard
function buildTSV() {
  const s = selRange();
  const lines = [];
  for (let r = s.r1; r <= s.r2; r++) {
    const row = [];
    for (let c = s.c1; c <= s.c2; c++) {
      let v = '';
      try { v = model.getCellContent(sheet, r, c); } catch { /* ignore */ }
      row.push(v.includes('\t') || v.includes('\n') ? '"' + v.replace(/"/g, '""') + '"' : v);
    }
    lines.push(row.join('\t'));
  }
  return lines.join('\n');
}

function pasteTSV(text) {
  if (!text) return;
  const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
  const s = selRange();
  try {
    model.pauseEvaluation();
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < rows[i].length; j++) {
        const r = s.r1 + i, c = s.c1 + j;
        if (r > GRID_ROWS || c > GRID_COLS) continue;
        let v = rows[i][j];
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/""/g, '"');
        if (v === '') continue;
        model.setUserInput(sheet, r, c, v);
      }
    }
  } finally {
    model.resumeEvaluation();
    model.evaluate();
  }
  invalidate();
  setSelection(s.r1, s.c1, s.r1 + rows.length - 1, s.c1 + Math.max(...rows.map((x) => x.length)) - 1);
}

function clearSelection() {
  const s = selRange();
  try {
    model.pauseEvaluation();
    for (let r = s.r1; r <= s.r2; r++) {
      for (let c = s.c1; c <= s.c2; c++) model.setUserInput(sheet, r, c, '');
    }
  } finally {
    model.resumeEvaluation();
    model.evaluate();
  }
  invalidate();
  render();
}

// ---------------------------------------------------------------- keyboard
scrollEl.addEventListener('keydown', (ev) => {
  // 编辑中的按键归编辑器/公式栏（Enter/Tab/Esc 由它们自己处理）
  if (editing) return;
  const ctrl = ev.ctrlKey || ev.metaKey;
  const key = ev.key;

  if (ctrl && (key === 'z' || key === 'Z')) {
    ev.preventDefault();
    try { ev.shiftKey ? model.redo() : model.undo(); } catch { /* ignore */ }
    invalidate(); render(); updateUndoButtons(); notifyHistory();
    return;
  }
  if (ctrl && (key === 'y' || key === 'Y')) {
    ev.preventDefault();
    try { model.redo(); } catch { /* ignore */ }
    invalidate(); render(); updateUndoButtons(); notifyHistory();
    return;
  }
  if (ctrl && (key === 'b' || key === 'B')) { ev.preventDefault(); toggleFontFlag('b'); return; }
  if (ctrl && (key === 'i' || key === 'I')) { ev.preventDefault(); toggleFontFlag('i'); return; }
  if (ctrl && (key === 'u' || key === 'U')) { ev.preventDefault(); toggleFontFlag('u'); return; }
  if (ctrl && (key === 'a' || key === 'A')) { ev.preventDefault(); selectAll(); return; }
  if (ctrl && (key === 'c' || key === 'C' || key === 'x' || key === 'X')) {
    // 交给 copy/cut 事件处理
    return;
  }

  switch (key) {
    case 'ArrowUp': ev.preventDefault(); moveSelection(-1, 0, ev.shiftKey); return;
    case 'ArrowDown': ev.preventDefault(); moveSelection(1, 0, ev.shiftKey); return;
    case 'ArrowLeft': ev.preventDefault(); moveSelection(0, -1, ev.shiftKey); return;
    case 'ArrowRight': ev.preventDefault(); moveSelection(0, 1, ev.shiftKey); return;
    case 'PageDown': ev.preventDefault(); moveSelection(20, 0, ev.shiftKey); return;
    case 'PageUp': ev.preventDefault(); moveSelection(-20, 0, ev.shiftKey); return;
    case 'Home': ev.preventDefault(); setSelection(sel.ar, 1); return;
    case 'End': ev.preventDefault(); setSelection(sel.ar, GRID_COLS); return;
    case 'Enter':
      ev.preventDefault();
      if (ev.shiftKey) moveSelection(-1, 0); else moveSelection(1, 0);
      return;
    case 'Tab': ev.preventDefault(); moveSelection(0, ev.shiftKey ? -1 : 1); return;
    case 'F2': ev.preventDefault(); startEdit(); return;
    case 'Delete': case 'Backspace':
      ev.preventDefault(); clearSelection(); return;
    case 'Escape':
      ev.preventDefault(); render(); return;
    default: break;
  }

  if (!ctrl && !ev.altKey && key.length === 1) {
    ev.preventDefault();
    startEdit(key);
  }
});

function isTextField(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

// 在网格之外选中了文字（比如 AI 回复里的代码）时，不要抢剪贴板
function selectionOutsideGrid() {
  const s = window.getSelection?.();
  if (!s || s.isCollapsed || !s.anchorNode) return false;
  const node = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
  return !!node && !scrollEl.contains(node);
}

// 只有“焦点在表格上”时才接管复制/剪切/粘贴；输入框、AI 面板里一律交给浏览器。
function gridClipboard(ev) {
  if (editing) return false;
  const active = document.activeElement;
  if (isTextField(active) || isTextField(ev.target)) return false;
  if (active?.closest?.('#ai-panel')) return false;
  if (selectionOutsideGrid()) return false;
  return true;
}

document.addEventListener('copy', (ev) => {
  if (!gridClipboard(ev)) return;
  const t = buildTSV();
  ev.clipboardData.setData('text/plain', t);
  ev.preventDefault();
  toast(`已复制 ${rangeLabel()}`);
});

document.addEventListener('cut', (ev) => {
  if (!gridClipboard(ev)) return;
  ev.clipboardData.setData('text/plain', buildTSV());
  ev.preventDefault();
  clearSelection();
  toast(`已剪切 ${rangeLabel()}`);
});

document.addEventListener('paste', (ev) => {
  if (!gridClipboard(ev)) return;
  const t = ev.clipboardData.getData('text/plain');
  if (t) { ev.preventDefault(); pasteTSV(t); }
});

scrollEl.addEventListener('focus', () => sel && render());

// 拖拽选区
function cellFromEvent(ev) {
  const rect = cellsLayer.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const r = Math.min(GRID_ROWS, Math.max(1, Math.floor(y / DEF_ROW_H) + 1));
  const c = Math.min(GRID_COLS, Math.max(1, colAtX(x)));
  return { r, c };
}

function autoScrollEdge(ev) {
  const rect = scrollEl.getBoundingClientRect();
  if (ev.clientX > rect.right) scrollEl.scrollLeft += 12;
  else if (ev.clientX < rect.left) scrollEl.scrollLeft -= 12;
  if (ev.clientY > rect.bottom) scrollEl.scrollTop += 12;
  else if (ev.clientY < rect.top) scrollEl.scrollTop -= 12;
}

cellsLayer.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  const { r, c } = cellFromEvent(ev);
  const fi = formulaInput();
  if (fi) {
    // 正在写公式：点/拖只选引用，不提交编辑
    if (!pick || pick.el !== fi) beginPick(fi, 'cells', r, c, r, c);
    else updatePick(r, c, r, c);
    setSelection(r, c);
    ev.preventDefault();
    return;
  }
  dragging = true;
  if (ev.shiftKey) setSelection(sel.ar, sel.ac, r, c);
  else setSelection(r, c);
  focusGrid();
  ev.preventDefault();
});

colHeadersEl.addEventListener('mousedown', (ev) => {
  const t = ev.target.closest('.hcell');
  if (!t) return;
  const c = Number(t.dataset.c);
  const fi = formulaInput();
  if (fi) {
    beginPick(fi, 'cols', 1, c, GRID_ROWS, c);
    endPick();
    setSelection(1, c, GRID_ROWS, c);
    ev.preventDefault();
    return;
  }
  setSelection(1, c, GRID_ROWS, c);
  focusGrid();
  ev.preventDefault();
});

rowHeadersEl.addEventListener('mousedown', (ev) => {
  const t = ev.target.closest('.rcell');
  if (!t) return;
  const r = Number(t.dataset.r);
  const fi = formulaInput();
  if (fi) {
    beginPick(fi, 'rows', r, 1, r, GRID_COLS);
    endPick();
    setSelection(r, 1, r, GRID_COLS);
    ev.preventDefault();
    return;
  }
  setSelection(r, 1, r, GRID_COLS);
  focusGrid();
  ev.preventDefault();
});

document.addEventListener('mousemove', (ev) => {
  if (pick) {
    if (ev.buttons === 0) { endPick(); return; }
    if (pick.kind !== 'cells') return;
    autoScrollEdge(ev);
    const { r, c } = cellFromEvent(ev);
    updatePick(pick.anchor.r, pick.anchor.c, r, c);
    setSelection(pick.anchor.r, pick.anchor.c, r, c);
    return;
  }
  if (!dragging) return;
  if (ev.buttons === 0) { dragging = false; return; }
  autoScrollEdge(ev);
  const { r, c } = cellFromEvent(ev);
  if (r !== sel.fr || c !== sel.fc) setSelection(sel.ar, sel.ac, r, c);
});

document.addEventListener('mouseup', () => { dragging = false; endPick(); });

cellsLayer.addEventListener('dblclick', (ev) => {
  if (!ev.target.closest('.cell')) return;
  startEdit();
});

scrollEl.addEventListener('scroll', scheduleRender, { passive: true });
window.addEventListener('resize', () => scheduleRender());

// ---------------------------------------------------------------- formula bar
fxInput.addEventListener('focus', () => {
  try { fxInput.value = model.getCellContent(sheet, sel.ar, sel.ac); } catch { /* ignore */ }
  fxInput.select();
});

fxInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const v = fxInput.value;
    const r = sel.ar, c = sel.ac;
    try { model.setUserInput(sheet, r, c, v); invalidate(); } catch (e) { toast('公式错误: ' + e, 'error'); }
    sel = { ar: Math.min(GRID_ROWS, r + 1), ac: c, fr: Math.min(GRID_ROWS, r + 1), fc: c };
    render();
    focusGrid();
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    renderRef();
    focusGrid();
  }
});

fxInput.addEventListener('input', updateRefHighlight);
fxInput.addEventListener('click', updateRefHighlight);
fxInput.addEventListener('keyup', updateRefHighlight);
fxInput.addEventListener('select', updateRefHighlight);
fxInput.addEventListener('blur', hideRefHighlight);

// ---------------------------------------------------------------- toolbar
$('btn-new').onclick = () => newWorkbook();
$('btn-open').onclick = () => $('file-input').click();
$('btn-save').onclick = () => saveXlsx();
$('btn-undo').onclick = () => { try { model.undo(); } catch { /* ignore */ } invalidate(); render(); updateUndoButtons(); notifyHistory(); };
$('btn-redo').onclick = () => { try { model.redo(); } catch { /* ignore */ } invalidate(); render(); updateUndoButtons(); notifyHistory(); };
$('chk-grid').onchange = () => render();
// 格式工具栏
$('btn-bold').onclick = () => toggleFontFlag('b');
$('btn-italic').onclick = () => toggleFontFlag('i');
$('btn-underline').onclick = () => toggleFontFlag('u');
$('btn-strike').onclick = () => toggleFontFlag('strike');
$('font-size').onchange = (ev) => setFontSize(ev.target.value);
// 文本单元格高亮 / 转数字（低频，收进一个二级按钮里）
const textMenu = $('text-tools-menu');
function syncTextTools() {
  const open = !textMenu.classList.contains('hidden');
  $('btn-text-tools').classList.toggle('on', open || $('chk-text').checked);
}
$('btn-text-tools').onclick = (ev) => {
  ev.stopPropagation();
  textMenu.classList.toggle('hidden');
  syncTextTools();
};
document.addEventListener('click', (ev) => {
  if (!textMenu.classList.contains('hidden') && !ev.target.closest('#text-tools')) {
    textMenu.classList.add('hidden');
    syncTextTools();
  }
});
$('chk-text').onchange = () => { textFlagKey = ''; textFlagRenderedKey = ''; render(); syncTextTools(); };
$('chk-text-num').onchange = () => { textFlagKey = ''; textFlagRenderedKey = ''; render(); };
$('btn-numify').onclick = () => numify('selection');
$('btn-numify-all').onclick = () => numify('all');
$('btn-add-sheet').onclick = () => {
  try { model.newSheet(); } catch (e) { toast(e, 'error'); return; }
  selectSheet(model.getWorksheetsProperties().length - 1);
};

document.addEventListener('keydown', (ev) => {
  const ctrl = ev.ctrlKey || ev.metaKey;
  if (ctrl && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); saveXlsx(); }
  if (ctrl && (ev.key === 'o' || ev.key === 'O')) { ev.preventDefault(); $('file-input').click(); }
});

function updateUndoButtons() {
  try {
    $('btn-undo').disabled = !model.canUndo();
    $('btn-redo').disabled = !model.canRedo();
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 本地兜底保存
// 刷新/误关页面后数据不丢：把工作簿导出成 xlsx，按「文件名」存进 localStorage。
// 多开 tab 处理不同文件时，每个 tab 用 sessionStorage 记住自己当前的文件名（刷新后恢复自己那个）；
// 新开 tab 没有指针时，回退到最近一次保存的文件。
const LS_WB_PREFIX = 'ironcalc.wb.v1.';
const LS_WB_INDEX = 'ironcalc.wb.index.v1';
const SS_WB_CURRENT = 'ironcalc.wb.current.v1';
const WB_SAVE_MAX_BYTES = 4_500_000; // localStorage 约 5MB（UTF-16），留点余量
const WB_KEEP = 12;
let saveTimer = null;
let saveDirty = false;
let saveWarned = false;

function wbKey(name) { return LS_WB_PREFIX + (name || 'Workbook'); }

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 每次数据变动后调用（已去抖）：过一会儿把当前工作簿存到本地。 */
function scheduleSave() {
  saveDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWorkbookNow, 1000);
}

function markCurrentName() {
  if (!model) return;
  try { sessionStorage.setItem(SS_WB_CURRENT, model.getName() || 'Workbook'); } catch { /* ignore */ }
}

function pruneSaved(keep) {
  try {
    let list = JSON.parse(localStorage.getItem(LS_WB_INDEX) || '[]');
    if (!Array.isArray(list)) list = [];
    list = list.filter((n) => n !== keep);
    list.unshift(keep);
    for (const old of list.slice(WB_KEEP)) { try { localStorage.removeItem(wbKey(old)); } catch { /* ignore */ } }
    localStorage.setItem(LS_WB_INDEX, JSON.stringify(list.slice(0, WB_KEEP)));
  } catch { /* ignore */ }
}

function saveWorkbookNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!model || !saveDirty) return;
  const name = model.getName() || 'Workbook';
  try {
    const bytes = model.toXlsx();
    if (bytes.length > WB_SAVE_MAX_BYTES) {
      if (!saveWarned) { saveWarned = true; toast('表格太大，已停止本地自动保存（请用「保存」导出）', 'error'); }
      saveDirty = false;
      return;
    }
    localStorage.setItem(wbKey(name), JSON.stringify({ name, at: Date.now(), data: bytesToBase64(bytes) }));
    try { sessionStorage.setItem(SS_WB_CURRENT, name); } catch { /* ignore */ }
    pruneSaved(name);
    saveDirty = false;
  } catch (e) {
    if (!saveWarned) { saveWarned = true; toast('本地自动保存失败：' + (e?.message || e), 'error'); }
    console.warn('[WB] 本地保存失败', e);
  }
}

/** 启动时尝试恢复：优先本 tab 上次打开的文件，其次最近保存的文件。 */
function restoreWorkbook() {
  let name = null;
  try { name = sessionStorage.getItem(SS_WB_CURRENT); } catch { /* ignore */ }
  if (!name) {
    try {
      const list = JSON.parse(localStorage.getItem(LS_WB_INDEX) || '[]');
      if (Array.isArray(list) && list.length) name = list[0];
    } catch { /* ignore */ }
  }
  if (!name) return false;
  try {
    const raw = localStorage.getItem(wbKey(name));
    if (!raw) return false;
    const rec = JSON.parse(raw);
    if (!rec?.data) return false;
    const m = Model.fromXlsx(base64ToBytes(rec.data), rec.name || name, LOCALE, TIMEZONE, LANGUAGE);
    replaceModel(m);
    toast(`已恢复上次的《${m.getName()}》`);
    return true;
  } catch (e) {
    console.warn('[WB] 恢复失败', e);
    return false;
  }
}

// 关页面/切后台时把没来得及去抖保存的内容立即落盘
window.addEventListener('pagehide', () => { if (saveDirty) saveWorkbookNow(); });

// ---------------------------------------------------------------- file IO
$('file-input').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (file) await loadFile(file);
});

async function loadFile(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.xls')) {
    toast('不支持旧版 .xls，请先用 Excel/LibreOffice 另存为 .xlsx', 'error');
    return;
  }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const name = file.name.replace(/\.(xlsx|xlsm)$/i, '') || 'Workbook';
    const m = Model.fromXlsx(buf, name, LOCALE, TIMEZONE, LANGUAGE);
    replaceModel(m);
    toast(`已加载 ${file.name}`);
  } catch (e) {
    console.error(e);
    toast('加载失败: ' + e, 'error');
  }
}

function saveXlsx() {
  try {
    const bytes = model.toXlsx();
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (model.getName() || 'workbook') + '.xlsx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('已导出 ' + a.download);
  } catch (e) {
    console.error(e);
    toast('保存失败: ' + e, 'error');
  }
}

// 拖放加载（在输入框 / AI 面板里拖文本不拦截，只有拖文件到页面上才当打开文件）
function dropIsTextTarget(ev) {
  return isTextField(ev.target) || !!ev.target?.closest?.('#ai-panel');
}
document.addEventListener('dragover', (ev) => {
  if (dropIsTextTarget(ev)) return;
  ev.preventDefault();
});
document.addEventListener('drop', (ev) => {
  if (dropIsTextTarget(ev)) return;
  ev.preventDefault();
  const file = ev.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

// ---------------------------------------------------------------- lifecycle
function replaceModel(m) {
  if (model) { try { model.free(); } catch { /* ignore */ } }
  model = m;
  sheet = 0;
  pick = null;
  clearFlashes();
  markCurrentName();
  invalidate();
  cellPool.forEach((el) => el.remove());
  cellPool = [];
  sel = { ar: 1, ac: 1, fr: 1, fc: 1 };
  scrollEl.scrollLeft = 0;
  scrollEl.scrollTop = 0;
  buildMetrics();
  renderTabs();
  render();
  updateUndoButtons();
}

function newWorkbook(seed = true) {
  const m = new Model('Workbook1', LOCALE, TIMEZONE, LANGUAGE);
  if (seed) seedDemo(m);
  replaceModel(m);
}

function seedDemo(m) {
  const data = [
    ['商品', '数量', '单价', '小计'],
    ['苹果', 3, 2.5, '=B2*C2'],
    ['香蕉', 5, 1.2, '=B3*C3'],
    ['橙子', 2, 3.75, '=B4*C4'],
    ['合计', '=SUM(B2:B4)', '', '=SUM(D2:D4)'],
  ];
  m.pauseEvaluation();
  data.forEach((row, i) => row.forEach((v, j) => m.setUserInput(0, i + 1, j + 1, String(v))));
  m.resumeEvaluation();
  m.evaluate();
  try {
    m.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 4, height: 1 }, 'font.b', 'true');
    m.updateRangeStyle({ sheet: 0, row: 5, column: 1, width: 4, height: 1 }, 'font.b', 'true');
    m.setColumnsWidth(0, 1, 4, 110);
  } catch (e) { console.warn('demo style', e); }
}

// ---------------------------------------------------------------- boot
async function boot() {
  await init();
  if (!restoreWorkbook()) newWorkbook(true);
  focusGrid();
  initAiPanel(IC);
  console.log('[IronCalc] ready');
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML =
    '<pre style="padding:20px;font:13px/1.5 monospace;color:#b3261e">初始化失败：' +
    String(e) + '</pre>';
});

// ---------------------------------------------------------------- AI 层接口（第 2 阶段）
// 行列都是 1-based；除 (r, c) 外也接受 A1 引用（'B3' / 'A1:C3' / 'A:A' / '1:3' / "Sheet2!A1:B3"）。
// 沙箱（web/ai/sandbox.js）只把 IC_WHITELIST 里的方法暴露给模型生成的代码。

function sheetIndex(nameOrIndex) {
  if (nameOrIndex === undefined || nameOrIndex === null) return sheet;
  if (typeof nameOrIndex === 'number') {
    const n = model.getWorksheetsProperties().length;
    if (nameOrIndex < 0 || nameOrIndex >= n) throw new Error(`工作表下标越界: ${nameOrIndex}`);
    return nameOrIndex;
  }
  const i = model.getWorksheetsProperties().findIndex((p) => p.name === nameOrIndex);
  if (i < 0) throw new Error(`工作表不存在: ${nameOrIndex}`);
  return i;
}

function colNum(c) {
  if (typeof c !== 'string') return c;
  const n = colNumber(c);
  if (!n) throw new Error(`无效列名: ${c}`);
  return n;
}

const GRID_BOUNDS = { rows: GRID_ROWS, cols: GRID_COLS };

// 'A1' / 'A1:C3' / 'A:A' / '1:3' / "Sheet2!A1:B3" → 带 sheet 下标的区域
function parseRef(ref) {
  const p = parseA1(ref, GRID_BOUNDS);
  return { sheet: sheetIndex(p.sheetName), ...p };
}

// ('A1:B3') 或 (r1, c1, r2, c2 [, sheet]) → 区域
function areaRef(...args) {
  if (typeof args[0] === 'string') return parseRef(args[0]);
  const [r1, c1, r2, c2, sheetOpt] = args;
  return {
    sheet: sheetIndex(sheetOpt),
    r1: Math.min(r1, r2), r2: Math.max(r1, r2),
    c1: Math.min(colNum(c1), colNum(c2)), c2: Math.max(colNum(c1), colNum(c2)),
  };
}

function areaObj(a) {
  // IronCalc 的 Area：width = 列数，height = 行数（别写反，写反会把整行样式打到整列上）
  return { sheet: a.sheet, row: a.r1, column: a.c1, width: a.c2 - a.c1 + 1, height: a.r2 - a.r1 + 1 };
}

// 逐行取"有数据的列"求包围盒（只扫 engine 里真实有数据的行，比逐格扫快得多）
function usedRangeOf(idx) {
  let r1 = 0, r2 = 0, c1 = 0, c2 = 0, blank = 0;
  for (let r = 1; r <= GRID_ROWS; r++) {
    let cols = [];
    try { cols = model.getColumnsWithData(idx, r); } catch { /* ignore */ }
    if (!cols || cols.length === 0) {
      if (r2 && ++blank > 500) break;
      continue;
    }
    blank = 0;
    if (!r1) r1 = r;
    r2 = r;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!c1 || c < c1) c1 = c;
      if (c > c2) c2 = c;
    }
  }
  return r1 ? { r1, c1, r2, c2 } : null;
}

function writeRange(a, values) {
  const grid = Array.isArray(values) && Array.isArray(values[0]) ? values : [values];
  const n = Math.min(grid.length, a.r2 - a.r1 + 1);
  try {
    model.pauseEvaluation();
    for (let i = 0; i < n; i++) {
      const row = grid[i];
      if (!Array.isArray(row)) continue;
      for (let j = 0; j < row.length && a.c1 + j <= a.c2; j++) {
        const v = row[j];
        model.setUserInput(a.sheet, a.r1 + i, a.c1 + j, v === null || v === undefined ? '' : String(v));
      }
    }
  } finally {
    model.resumeEvaluation();
    model.evaluate();
  }
  invalidate();
  render();
  return n;
}

const IC = {
  version: 2,
  get model() { return model; },
  get sheet() { return sheet; },
  set sheet(v) { selectSheet(sheetIndex(v)); },
  toast,
  refresh: () => { invalidate(); render(); },
  // 纯视觉高亮（不写模型样式）：IC.highlight('A1:C3') / IC.highlightOps(ops)
  highlight(...args) { return flashAreas([areaRef(...args)]); },
  highlightOps(ops) {
    const areas = [];
    for (const op of ops || []) {
      try { const a = opArea(op); if (a) areas.push(a); } catch { /* 忽略解析不了的参数 */ }
    }
    return flashAreas(areas);
  },
  // 直接高亮一组区域（AI 面板「重新高亮」重放用）
  highlightAreas(areas) { return flashAreas(areas || []); },
  // 记录执行前后差异：record(name, rawArgs) 在每次写方法前调用，finish() 取 diff
  diffRecorder: (cap) => makeDiffRecorder(cap),
  a1,
  parseRef,

  // ---- 读 ----
  getCell(rOrRef, c) {
    const a = typeof rOrRef === 'string' ? parseRef(rOrRef) : { sheet, r1: rOrRef, c1: c };
    return {
      content: model.getCellContent(a.sheet, a.r1, a.c1),
      value: model.getFormattedCellValue(a.sheet, a.r1, a.c1),
    };
  },
  getRange(...args) {
    const a = areaRef(...args);
    const out = [];
    for (let r = a.r1; r <= a.r2; r++) {
      const row = [];
      for (let c = a.c1; c <= a.c2; c++) row.push(model.getFormattedCellValue(a.sheet, r, c));
      out.push(row);
    }
    return out;
  },
  getRangeRaw(...args) {
    const a = areaRef(...args);
    const out = [];
    for (let r = a.r1; r <= a.r2; r++) {
      const row = [];
      for (let c = a.c1; c <= a.c2; c++) row.push(model.getCellContent(a.sheet, r, c));
      out.push(row);
    }
    return out;
  },
  usedRange(nameOrIndex) {
    const idx = sheetIndex(nameOrIndex);
    const u = usedRangeOf(idx);
    return u ? { sheet: idx, ...u } : null;
  },
  getSelection() {
    const s = selRange();
    return {
      sheet,
      sheetName: model.getWorksheetsProperties()[sheet]?.name ?? '',
      r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2,
      label: rangeLabel(),
    };
  },

  // ---- 写 ----
  setCell(rOrRef, cOrValue, maybeValue) {
    let a, v;
    if (typeof rOrRef === 'string') { a = parseRef(rOrRef); v = cOrValue; }
    else { a = { sheet, r1: rOrRef, c1: cOrValue }; v = maybeValue; }
    model.setUserInput(a.sheet, a.r1, a.c1, v === null || v === undefined ? '' : String(v));
    invalidate(); render();
    return true;
  },
  setRange(...args) {
    const values = args.pop();
    return writeRange(areaRef(...args), values);
  },
  clearRange(...args) {
    const a = areaRef(...args);
    model.rangeClearContents(a.sheet, a.r1, a.c1, a.r2, a.c2);
    invalidate(); render();
    return true;
  },
  applyStyle(...args) {
    const value = String(args.pop());
    const path = args.pop();
    const a = areaRef(...args);
    model.updateRangeStyle(areaObj(a), path, value);
    invalidate(); render();
    return true;
  },
  // 样式糖：IC.format('A1:D1', { bold: true, fill: '#1a73e8', color: '#fff', align: 'center' })
  format(rOrRef, ...rest) {
    const opts = rest.pop() || {};
    const a = typeof rOrRef === 'string' ? parseRef(rOrRef) : areaRef(rOrRef, ...rest);
    const set = (path, value) => model.updateRangeStyle(areaObj(a), path, String(value));
    if (opts.bold !== undefined) set('font.b', opts.bold);
    if (opts.italic !== undefined) set('font.i', opts.italic);
    if (opts.underline !== undefined) set('font.u', opts.underline);
    if (opts.strike !== undefined) set('font.strike', opts.strike);
    if (opts.size !== undefined) set('font.size', opts.size);
    if (opts.color !== undefined) set('font.color', opts.color);
    if (opts.fill !== undefined) set('fill.color', opts.fill);
    if (opts.numFmt !== undefined) set('num_fmt', opts.numFmt);
    if (opts.align !== undefined) set('alignment.horizontal', opts.align);
    if (opts.wrap !== undefined) set('alignment.wrap_text', opts.wrap);
    invalidate(); render();
    return true;
  },
  setColumnWidth(c1, c2, w) {
    if (w === undefined) { w = c2; c2 = c1; }
    model.setColumnsWidth(sheet, colNum(c1), colNum(c2), w);
    invalidate(); buildMetrics(); render();
    return true;
  },
  setRowHeight(r1, r2, h) {
    if (h === undefined) { h = r2; r2 = r1; }
    model.setRowsHeight(sheet, r1, r2, h);
    render();
    return true;
  },
  insertRows(r, n = 1) { model.insertRows(sheet, r, n); invalidate(); render(); return true; },
  insertColumns(c, n = 1) { model.insertColumns(sheet, colNum(c), n); invalidate(); buildMetrics(); render(); return true; },
  deleteRows(r, n = 1) { model.deleteRows(sheet, r, n); invalidate(); render(); return true; },
  deleteColumns(c, n = 1) { model.deleteColumns(sheet, colNum(c), n); invalidate(); buildMetrics(); render(); return true; },
  merge(...args) { model.mergeCells(areaObj(areaRef(...args))); invalidate(); render(); return true; },
  unmerge(...args) { model.unmergeCells(areaObj(areaRef(...args))); invalidate(); render(); return true; },
  evaluate() { model.evaluate(); invalidate(); render(); return true; },

  // ---- 选区 ----
  select(rOrRef, c) {
    if (typeof rOrRef === 'string') {
      const a = parseRef(rOrRef);
      if (a.sheet !== sheet) selectSheet(a.sheet);
      setSelection(a.r1, a.c1, a.r2, a.c2);
    } else {
      setSelection(rOrRef, c);
    }
    return IC.getSelection();
  },
  selectRange(r1, c1, r2, c2) { setSelection(r1, c1, r2, c2); return IC.getSelection(); },

  // ---- 工作表 ----
  sheets: () => model.getWorksheetsProperties().map((p) => p.name),
  selectSheet(nameOrIndex) { selectSheet(sheetIndex(nameOrIndex)); return IC.getSelection(); },
  newSheet(name) {
    model.newSheet();
    const i = model.getWorksheetsProperties().length - 1;
    if (name) model.renameSheet(i, String(name));
    selectSheet(i);
    return i;
  },
  renameSheet(nameOrIndex, newName) {
    const i = sheetIndex(nameOrIndex);
    model.renameSheet(i, String(newName));
    renderTabs();
    scheduleSave();
    return true;
  },
  deleteSheet(nameOrIndex) {
    const i = sheetIndex(nameOrIndex);
    if (model.getWorksheetsProperties().length <= 1) throw new Error('至少需要保留一个工作表');
    model.deleteSheet(i);
    if (sheet >= i) sheet = Math.max(0, sheet - 1);
    invalidate(); buildMetrics(); renderTabs(); render();
    return true;
  },

  // ---- 撤销 / 文件 ----
  undo() { model.undo(); invalidate(); render(); updateUndoButtons(); notifyHistory(); return model.canUndo(); },
  redo() { model.redo(); invalidate(); render(); updateUndoButtons(); notifyHistory(); return model.canRedo(); },
  canUndo: () => { try { return model.canUndo(); } catch { return false; } },
  canRedo: () => { try { return model.canRedo(); } catch { return false; } },
  toXlsx: () => model.toXlsx(),
  fromXlsx: (bytes, name) => { replaceModel(Model.fromXlsx(bytes, name || 'Workbook', LOCALE, TIMEZONE, LANGUAGE)); return true; },
  getName: () => model.getName(),
  setName: (n) => {
    const old = model.getName();
    model.setName(String(n));
    wbNameEl.textContent = model.getName();
    const next = model.getName() || 'Workbook';
    if (old && old !== next) { try { localStorage.removeItem(wbKey(old)); } catch { /* ignore */ } }
    markCurrentName();
    saveDirty = true;
    saveWorkbookNow();
    return next;
  },
  download: () => saveXlsx(),
};

window.IC = IC;
