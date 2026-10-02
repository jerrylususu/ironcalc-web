// 把工作簿现状压成一段紧凑文本塞进 prompt。
// 目标是让模型「看得懂表」，但不要把一个 10 万行的表塞进上下文。

const DEFAULT_LIMITS = { maxRows: 80, maxCols: 24, maxCell: 60, maxSheets: 20 };

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * buildContext(IC, limits) → 纯文本
 * 依赖的 IC 方法：getName/sheets/sheet/getSelection/usedRange/getRangeRaw
 */
export function buildContext(IC, limits = {}) {
  const { maxRows, maxCols, maxCell, maxSheets } = { ...DEFAULT_LIMITS, ...limits };
  const out = [];
  let wbName = '';
  try { wbName = IC.getName(); } catch { /* ignore */ }
  out.push(`工作簿名称: ${wbName || '(未命名)'}`);

  let sheets = [];
  try { sheets = IC.sheets(); } catch { /* ignore */ }
  const active = IC.sheet ?? 0;
  const shown = sheets.slice(0, maxSheets).map((s, i) => (i === active ? `${s}（当前）` : s));
  out.push(`工作表(${sheets.length}): ${shown.join(' | ')}${sheets.length > maxSheets ? ' …' : ''}`);

  let sel = null;
  try { sel = IC.getSelection(); } catch { /* ignore */ }
  if (sel) out.push(`当前选区: ${sel.sheetName}!${sel.label}`);

  let used = null;
  try { used = IC.usedRange(); } catch { /* ignore */ }
  if (!used) {
    out.push('当前工作表是空的。');
    return out.join('\n');
  }

  const r2 = Math.min(used.r2, used.r1 + maxRows - 1);
  const c2 = Math.min(used.c2, used.c1 + maxCols - 1);
  const truncated = r2 < used.r2 || c2 < used.c2;
  const ref = `${col(used.c1)}${used.r1}:${col(c2)}${r2}`;
  out.push(`当前工作表有数据的范围: ${col(used.c1)}${used.r1}:${col(used.c2)}${used.r2}` +
    (truncated ? `（下面只给前 ${r2 - used.r1 + 1} 行 × ${c2 - used.c1 + 1} 列）` : ''));
  out.push('--- 数据开始（制表符分隔；公式以 = 开头，显示值在括号里）---');

  // 表头行（列名）
  const header = ['\\'];
  for (let c = used.c1; c <= c2; c++) header.push(col(c));
  out.push(header.join('\t'));

  let rows;
  try { rows = IC.getRangeRaw(used.r1, used.c1, r2, c2); } catch { rows = []; }
  for (let i = 0; i < rows.length; i++) {
    const line = [String(used.r1 + i)];
    for (const cell of rows[i]) line.push(clip(cell, maxCell));
    out.push(line.join('\t'));
  }
  out.push('--- 数据结束 ---');

  if (sel && !(sel.r1 === 1 && sel.c1 === 1 && sel.r2 === used.r2 && sel.c2 === used.c2)) {
    try {
      const vals = IC.getRange(sel.r1, sel.c1, Math.min(sel.r2, sel.r1 + 20), Math.min(sel.c2, sel.c1 + 10));
      out.push(`选区 ${sel.label} 的显示值: ${JSON.stringify(vals)}`);
    } catch { /* ignore */ }
  }

  return out.join('\n');
}

function col(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || 'A';
}

/** 把当轮快照拼进用户消息内容——这样历史消息数组只追加、不改写，prefix cache 才保得住。 */
export function composeUserContent(text, context = '') {
  const t = String(text ?? '');
  if (!context) return t;
  return `【当前工作簿快照】\n${context}\n---\n\n${t}`;
}

/**
 * 把会话消息转成发给模型的 messages。
 *
 * 关键：**只追加、不改写**。
 *   - 用户消息用 `apiContent`（发消息当刻就存好的「快照 + 原文」），没有则退回 content。
 *   - assistant 消息后面追加一条合成的 user 消息，把那次代码执行结果回传给模型；
 *     结果是从 `m.runs` 确定性推导出来的，所以同一段历史每轮拼出来都一样。
 * 这样第 N 轮的消息数组是第 N+1 轮的前缀，服务端的 prefix cache 能命中。
 */
export function messagesToApi(messages = [], { max = 80 } = {}) {
  const out = [];
  const list = messages.slice(-max);
  for (const m of list) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = m.apiContent ?? m.content;
    if (!content) continue;
    out.push({ role: m.role, content });
    if (m.role === 'assistant' && m.runs && Object.keys(m.runs).length) {
      const lines = [];
      for (const key of Object.keys(m.runs).sort((a, b) => Number(a) - Number(b))) {
        const r = m.runs[key];
        if (r?.text) lines.push(r.text);
      }
      if (m.logs?.length) lines.push('console: ' + m.logs.map((l) => l.text).join(' | '));
      if (lines.length) out.push({ role: 'user', content: `【代码执行结果】\n${lines.join('\n')}` });
    }
  }
  return out;
}

/**
 * 组装发给模型的消息数组（system + 历史）。
 * history 已经是可以直接发的 { role, content }（由 messagesToApi 生成，或测试里手写）。
 */
export function buildMessages({ history = [], system = '', maxHistory = 80 } = {}) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of history.slice(-maxHistory)) {
    if (!m || !m.content) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    msgs.push({ role: m.role, content: m.content });
  }
  return msgs;
}
