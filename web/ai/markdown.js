// 极简 markdown：只处理聊天里真正会用到的东西（代码块 / 行内代码 / 粗斜体 / 列表 / 标题 / 链接）。
// 纯字符串进出，不碰 DOM —— 这样可以在 Node 里直接测（见 tmp/test_ai.mjs）。

const JS_LANGS = new Set(['js', 'javascript', 'mjs', 'ts', 'typescript', 'jsx', 'tsx']);

/** 从 markdown 文本里抽出围栏代码块，保留顺序。 */
export function extractCodeBlocks(text) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];
  let inFence = false;
  let lang = '';
  let buf = [];
  const flush = () => {
    blocks.push({ lang, code: buf.join('\n'), runnable: isRunnable(lang) });
    buf = [];
  };
  for (const line of lines) {
    const open = /^\s*```+\s*([\w+#.-]*)\s*$/.exec(line);
    if (inFence) {
      if (/^\s*```+\s*$/.test(line)) { inFence = false; flush(); }
      else buf.push(line);
      continue;
    }
    if (open) { inFence = true; lang = (open[1] || '').toLowerCase(); buf = []; }
  }
  if (inFence) flush(); // 没闭合的围栏也当代码块，方便调试
  return blocks;
}

/** 没写语言标记的围栏按 JS 处理（prompt 里要求模型写 ```js）。 */
export function isRunnable(lang) {
  return !lang || JS_LANGS.has(String(lang).toLowerCase());
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
}

/**
 * 渲染成 HTML 字符串。
 * blockMeta[i] = { runnable?: boolean, label?: string } 用来给第 i 个代码块加「运行」按钮。
 */
export function renderMarkdown(text, { blockMeta = [] } = {}) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let i = 0;
  let blockIndex = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const open = /^\s*```+\s*([\w+#.-]*)\s*$/.exec(line);
    if (open) {
      const lang = (open[1] || '').toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 跳过闭合围栏
      const meta = blockMeta[blockIndex] || {};
      const runnable = meta.runnable ?? isRunnable(lang);
      const dis = meta.disabled ? ' disabled' : '';
      const head = runnable
        ? `<div class="ai-code-head"><span class="ai-lang">${escapeHtml(lang || 'js')}</span>` +
          `<button class="ai-run" data-block="${blockIndex}"${dis}>${escapeHtml(meta.label || '运行')}</button></div>`
        : `<div class="ai-code-head"><span class="ai-lang">${escapeHtml(lang || 'code')}</span></div>`;
      out.push(
        `<div class="ai-code" data-lang="${escapeHtml(lang)}" data-block="${blockIndex}">` +
        head + `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre></div>`,
      );
      blockIndex++;
      continue;
    }

    // 空行
    if (/^\s*$/.test(line)) { i++; continue; }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inline(escapeHtml(h[2]))}</h${h[1].length}>`); i++; continue; }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr />'); i++; continue; }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${inline(escapeHtml(buf.join('\n')))}</blockquote>`);
      continue;
    }

    // 列表
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const items = [];
      while (i < lines.length) {
        const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${inline(escapeHtml(m[1]))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // 段落：连续的非空、非结构行
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*```/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br />')}</p>`);
  }

  return out.join('\n');
}
