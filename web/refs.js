// A1 引用相关的纯函数（无 DOM、无 wasm），app.js 和测试共用。
// 单独拆出来是因为「公式编辑时点选区域」和「AI 用 A1 写法调 IC」都依赖它，值得单测。

/** 1 → 'A'，27 → 'AA'，16384 → 'XFD' */
export function colName(n) {
  let x = Math.floor(Number(n));
  if (!Number.isFinite(x) || x < 1) return '';
  let s = '';
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** 'A' → 1，'AA' → 27；非法返回 0 */
export function colNumber(letters) {
  const s = String(letters ?? '').replace(/\$/g, '').toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(s)) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

export function a1(r, c) {
  return `${colName(c)}${r}`;
}

/**
 * 'A1' / 'A1:C3' / 'A:A' / '1:3' / "Sheet2!A1:B3" → { sheetName, r1, c1, r2, c2 }
 * bounds 用来补全开放式引用（A:A 的 r2、1:3 的 c2）。
 */
export function parseA1(ref, bounds = { rows: 1048576, cols: 16384 }) {
  let s = String(ref ?? '').trim();
  let sheetName = null;
  const bang = s.lastIndexOf('!');
  if (bang >= 0) {
    sheetName = s.slice(0, bang).replace(/^'+|'+$/g, '');
    s = s.slice(bang + 1);
  }
  s = s.replace(/\$/g, '');
  const parts = s.split(':');
  if (parts.length > 2) throw new Error(`无法解析引用: ${ref}`);

  const one = (part) => {
    if (part === undefined || part === '') return { r: null, c: null };
    let m = /^([A-Za-z]{1,3})(\d+)$/.exec(part);
    if (m) return { r: Number(m[2]), c: colNumber(m[1]) };
    m = /^([A-Za-z]{1,3})$/.exec(part);
    if (m) return { r: null, c: colNumber(m[1]) };
    m = /^(\d+)$/.exec(part);
    if (m) return { r: Number(m[1]), c: null };
    throw new Error(`无法解析引用: ${ref}`);
  };

  const a = one(parts[0]);
  const b = parts.length === 2 ? one(parts[1]) : a;
  if (!a.r && !a.c && !b.r && !b.c) throw new Error(`无法解析引用: ${ref}`);
  return {
    sheetName,
    r1: a.r ?? b.r ?? 1,
    r2: b.r ?? a.r ?? bounds.rows,
    c1: a.c ?? b.c ?? 1,
    c2: b.c ?? a.c ?? bounds.cols,
  };
}

/** 编辑公式时鼠标点选出来的引用文本：单格 'B3'、区域 'A1:B3'、整列 'A:C'、整行 '1:3' */
export function refText(kind, r1, c1, r2, c2) {
  const a = Math.min(r1, r2), b = Math.max(r1, r2);
  const x = Math.min(c1, c2), y = Math.max(c1, c2);
  if (kind === 'cols') return `${colName(x)}:${colName(y)}`;
  if (kind === 'rows') return `${a}:${b}`;
  if (a === b && x === y) return `${colName(x)}${a}`;
  return `${colName(x)}${a}:${colName(y)}${b}`;
}
