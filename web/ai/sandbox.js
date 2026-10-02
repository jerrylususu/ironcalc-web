// 执行 LLM 写出来的 JS。
//
// 两层防护：
//   1) 静态扫描：明显危险的东西（import(、eval、globalThis、document、fetch…）直接拒绝，
//      给出比 "undefined is not a function" 好读的报错。
//   2) new Function + 白名单：只注入 IC 上允许的方法，并把 window/document/globalThis/fetch
//      等作为同名形参遮蔽成 undefined；strict mode。
//
// 注意：这不是真正的沙箱（同一个 realm，模型仍能写出死循环卡住页面）。
// 原型阶段够用；真要跑不可信代码得挪到 Worker + 超时终止。见 README「已知限制」。

export const IC_WHITELIST = [
  // 读
  'getCell', 'getRange', 'getRangeRaw', 'usedRange', 'getSelection',
  // 写
  'setCell', 'setRange', 'clearRange', 'applyStyle', 'format',
  'setColumnWidth', 'setRowHeight',
  'insertRows', 'insertColumns', 'deleteRows', 'deleteColumns',
  'merge', 'unmerge', 'evaluate',
  // 选区
  'select', 'selectRange',
  // 工作表
  'sheets', 'selectSheet', 'newSheet', 'renameSheet', 'deleteSheet',
  // 其它
  'undo', 'redo', 'canUndo', 'canRedo',
  'getName', 'setName', 'a1', 'parseRef', 'toast', 'refresh',
];

/** 沙箱里可以直接读的属性（getter）。 */
export const IC_READONLY_PROPS = ['sheet'];

const FORBIDDEN = [
  [/\bimport\s*\(/, 'import() 动态导入'],
  [/\brequire\s*\(/, 'require()'],
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\b/, 'new Function'],
  [/\bglobalThis\b/, 'globalThis'],
  [/\b__proto__\b/, '__proto__'],
  [/\bconstructor\s*\.\s*constructor\b/, 'constructor.constructor'],
  [/\bdocument\b/, 'document'],
  [/\bwindow\b/, 'window'],
  [/\bself\b/, 'self'],
  [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/, '浏览器存储'],
  [/\bXMLHttpRequest\b|\bfetch\s*\(/, '网络请求'],
  [/\bnavigator\b|\blocation\b/, 'navigator/location'],
  [/\bpostMessage\b|\bimportScripts\b/, 'postMessage/importScripts'],
  [/\bprocess\b|\bmodule\b|\bexports\b/, 'Node 全局'],
];

// 这些名字会在 new Function 里被遮蔽，防止绕过静态扫描（例如拼字符串再取全局）
const SHADOWED = [
  'window', 'document', 'globalThis', 'self', 'top', 'parent', 'frames',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'localStorage', 'sessionStorage', 'indexedDB',
  'importScripts', 'postMessage', 'navigator', 'location',
  'require', 'process', 'module', 'exports', 'eval', 'Function',
];

export function scanCode(code) {
  const src = String(code ?? '');
  for (const [re, label] of FORBIDDEN) {
    const m = re.exec(src);
    if (m) return { blocked: true, reason: `代码里出现了被禁用的 ${label}（沙箱只允许调用 IC.*）` };
  }
  return { blocked: false, reason: '' };
}

function brief(v, depth = 0) {
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 2) return Array.isArray(v) ? `[…${v.length} 项]` : '{…}';
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => brief(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v).slice(0, 12)) out[k] = brief(v[k], depth + 1);
  return out;
}

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
}

/** 供 UI/测试展示的「这次执行干了什么」摘要。 */
export function summarizeOps(ops) {
  const counts = new Map();
  for (const op of ops) counts.set(op.name, (counts.get(op.name) || 0) + 1);
  return [...counts.entries()].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join('、');
}

/**
 * 执行一段 LLM 生成的代码。
 * 返回 { ok, result, ops, logs, ms, error? }（不抛异常，错误也在返回值里）
 */
export async function runAiCode(code, ic, opts = {}) {
  const {
    whitelist = IC_WHITELIST,
    readonlyProps = IC_READONLY_PROPS,
    maxOps = 5000,
    maxLogs = 200,
    onOp,
  } = opts;

  const t0 = nowMs();
  const ops = [];
  const logs = [];
  const pushLog = (level) => (...args) => {
    if (logs.length < maxLogs) logs.push({ level, text: args.map((a) => stringify(a)).join(' ') });
  };
  const sandboxConsole = {
    log: pushLog('log'), info: pushLog('info'), warn: pushLog('warn'),
    error: pushLog('error'), debug: pushLog('debug'),
  };

  const scan = scanCode(code);
  if (scan.blocked) {
    return { ok: false, error: { message: scan.reason, blocked: true }, ops, logs, ms: nowMs() - t0 };
  }

  // 白名单注入
  const sandbox = Object.create(null);
  const available = [];
  for (const name of whitelist) {
    const fn = ic?.[name];
    if (typeof fn !== 'function') continue;
    available.push(name);
    sandbox[name] = (...args) => {
      if (ops.length >= maxOps) throw new Error(`IC 调用次数超过上限（${maxOps} 次），代码可能有异常循环`);
      ops.push({ name, args: args.map((a) => brief(a)) });
      onOp?.(name, args);
      return fn.apply(ic, args);
    };
  }
  for (const prop of readonlyProps) {
    if (prop in (ic || {})) {
      available.push(prop);
      Object.defineProperty(sandbox, prop, { get: () => ic[prop], enumerable: true });
    }
  }

  let fn;
  try {
    // 外层故意不是 strict：strict 下形参不能叫 eval（"Unexpected eval or arguments"）。
    // 真正的 strict 放在内层 IIFE，模型代码拿不到 sloppy 的宽松语义。
    fn = new Function(
      'IC', 'console', ...SHADOWED,
      `return (async () => {\n"use strict";\n${code}\n})();`,
    );
  } catch (e) {
    return { ok: false, error: { message: `代码语法错误：${e?.message || e}`, syntax: true }, ops, logs, ms: nowMs() - t0 };
  }

  try {
    const result = await fn(sandbox, sandboxConsole, ...SHADOWED.map(() => undefined));
    return { ok: true, result: brief(result), ops, logs, ms: nowMs() - t0, available };
  } catch (e) {
    return {
      ok: false,
      error: { message: String(e?.message || e), stack: e?.stack },
      ops,
      logs,
      ms: nowMs() - t0,
      available,
      failedAt: ops.length ? ops[ops.length - 1].name : null,
    };
  }
}

function stringify(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
