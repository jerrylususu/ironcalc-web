# todo.md

## ✅ 本轮完成（短期清单，除 #3 自动执行高亮外全做）

- **#1 运行按钮跑过就灰**：写操作执行成功后按钮变「已执行」不可点；
  点「回滚这次改动」或 `Ctrl+Z`/`Ctrl+Y`（任意撤销/重做）后恢复「再运行一次」。
  实现：`panel.js` 的 `runDisabled()` + `state.undoSeq`（`app.js` 撤销/重做时
  `notifyHistory()` 发 `ic:history` 事件）。
- **#2 只读免确认**：`sandbox.js` 新增 `IC_WRITE_METHODS` + `isReadOnlyCode()`；
  只读/纯计算的代码块回复一到就自动跑（不受「自动执行」开关影响），含写方法或 `IC[...]` 动态访问的要手点。
- **#4 格式工具栏**：加粗/斜体/下划线/删除线 + 字号下拉；`Ctrl+B/I/U`；
  按钮回显当前单元格样式；补上了 `.cell.strike` 渲染（原来只存样式不显示）。
- **#5 公式引用染色**：编辑公式时把文本光标所在的 A1 引用用紫色虚线框圈出来
  （`refTokenAt()`，排除 `LOG10(` 这类函数名）；单元格编辑器和公式栏都生效。
- **#6 reasoning 展示**：`provider.js` 收 `delta.reasoning_content`（兼容 `reasoning`）并流式回调；
  面板渲染成可折叠「💭 思考过程」，**不回传进历史**。
- **#7 文本单元格高亮 + 转数字**：工具栏勾「文本」→ 像数字的文本绿色淡底 + 左上角小三角；
  二级「只看数字」可切「全部文本」；「转选区」/「转全部」一键转成真数字
  （先清 `@` 文本格式让引擎自己解析，认不出再用本地清洗兑底）。
- **#8 ttft / token**：`provider.js` 请求带 `stream_options.include_usage`，
  从最后一个 chunk 取 usage，记录首个 delta 时间；面板底部显示「首字 x.xs · ↑… ↓… · 缓存 … · 思考 …」。
- **#9 执行结果回传 + prefix cache**：`context.js` 新增 `composeUserContent()` / `messagesToApi()`；
  快照在发消息当刻拼进用户消息的 `apiContent` 存下，执行结果作为**合成的 user 消息**追加；
  整个历史数组只追加不改写，第 N 轮是第 N+1 轮的前缀。

验证：`node tmp/test_ai.mjs` + `node tmp/test_wasm.mjs` 全绿（新增 reasoning/usage/ttft、
`isReadOnlyCode`、append-only、disabled 按钮等断言）。UI 请按 `notes.md` 验收清单 26–34 条手动过。

---

## ✅ 已修复（AI 改动高亮这一轮）

4. ~~AI 跑完之后「行/列被莫名加粗，原有加粗被破坏」~~
   **结论**：代码里根本没有「AI 改动自动加粗」这回事——加粗只可能来自模型自己写的
   `IC.format` / `IC.applyStyle`。值写入不动样式（原来粗体改完还是粗体），`insertRows`
   会把行样式下移，这些是 Excel 正常行为。
   **真 bug**：`web/app.js` 的 `areaObj` 把 `width/height` 写反了（IronCalc 的 `Area`
   里 width=列数、height=行数），实测 `IC.format('A1:D1',{bold:true})` 实际加粗的是
   **A1:A4** 一整列 → 行列错位、格式被冲掉。已改成 `width: c2-c1+1, height: r2-r1+1`。
   **新功能**：AI 每次执行完，按这次真正调用的 `IC.*` 区域画**纯视觉高亮框**
   （橙色边框 + 淡背景，2.6s 自动淡出）。覆盖层不写模型样式，所以永远不会破坏原格式。
   实现：`web/app.js` 的 `flashAreas/opArea/IC.highlightOps` + `web/index.html` 的
   `#flash-layer` + `web/style.css` 的 `.flash-box`；`web/ai/panel.js` 执行完调用它。
   顺带在系统提示词里说清：不要用加粗/颜色标自己的改动，界面会自动高亮。

## ✅ 已修复（第 2 层这一轮做的）

1. ~~公式没法在单元格内输入？~~
   **根因**：单元格编辑器在 `#scroll` 里，按键会冒泡到网格的 keydown handler。
   `Backspace` 被当成「清空选区」（直接清空整格），方向键 / `Home` / `End` 被 `preventDefault`，
   `Enter` / `Tab` 提交后还会再被网格处理一次 → 往下跳两格。
   **修法**（`web/app.js`）：编辑器 keydown 里 `ev.stopPropagation()`，网格 handler 在编辑态直接 `return`。

2. ~~写公式的时候选区只能手写，不能直接选中选区 像其他应用那样直接~~
   **修法**（`web/app.js` + `web/refs.js`）：编辑框内容以 `=` 开头时进入「选区模式」——
   点/拖单元格插入 `B3` / `A1:B3`，点列头插入 `A:C`，点行头插入 `1:3`，拖动时引用实时更新；
   单元格内编辑器和公式栏都支持。

3. 顺手发现并修掉的：**AI 设置里的 endpoint / api key 粘贴不进去**（粘贴被文档级
   `paste` 监听器抢去写单元格了）。现在剪贴板（复制/剪切/粘贴）只在表格有焦点时接管，
   输入框和 `#ai-panel` 里一律交给浏览器；拖放同理。

## ⏭ 待你人工验收

论文级细节见 `notes.md` 的「人工验收清单」第 15–24 条（第 1 层是 1–14 条）。
先 `scripts/serve.sh`，再 `scripts/mock-api.sh`，面板 ⚙ 填 `http://127.0.0.1:8766/v1` + `mock-gpt`。

## 以后想做的

见 `notes.md` 末尾「下一步（想继续做的话）」：沙箱挪 Worker、按需读区域、
对话重发/编辑/token 显示、AI 改动做成一个 undo 分组、行高与合并单元格渲染。





---
长期 后面再说
- 用一个成熟的流式md解析？现在表格有点问题

---
短期


- 自动执行好像不会触发高亮动画？bug 待排查
- 只读操作 不用展示 回滚改动按钮？
- llm 一次操作可能会有多次读查询，不应该在一次读完之后就终止会话
J 列有几个合计数字应该是公式但现在是手算的，帮我找出来是什么格子
我先读一下 J 列的原始内容（公式/手工数值）和显示值，确认哪些格是手算的。

js
再运行一次
const raw = await IC.getRangeRaw('J1:J16');
const disp = await IC.getRange('J1:J16');
const rows = raw.map((r, i) => `J${i + 1}: 原始=${JSON.stringify(r[0])} | 显示=${JSON.stringify(disp[i][0])}`);
return rows.join('\n');
✅ 已执行：getRangeRaw、getRange（1ms） · 返回 "J1: 原始=\"\" | 显示=\"\"\nJ2: 原始=\"应缴费额\" | 显示=\"应缴费额\"\nJ3: 原始=\"20.16\" | 显示=\"20.16\"\nJ4: 原始=\"…"
首字 2.1s · ↑2.6k ↓1.2k · 缓存 1.2k · 思考 1.1k
你找到了吗？
我来定位 J 列里哪些是手写死的数字、而不是公式——顺便把相邻的 K、L 列一起读出来，因为合计数字有可能落在合并表头下的任意一列。

js
再运行一次
const raw = await IC.getRangeRaw(1, 10, 16, 12); // J:K:L
const lines = [];
for (let r = 0; r < 16; r++) {
  const parts = [];
  for (const [i, letter] of ['J','K','L'].entries()) {
    const v = raw[r][i];
    if (v !== '' && v != null) parts.push(`${letter}${r + 1}=${JSON.stringify(v)}`);
  }
  if (parts.length) lines.push(`行${r + 1}: ${parts.join('  ')}`);
}
return lines.join('\n');
✅ 已执行：getRangeRaw（1ms） · 返回 "行2: J2=\"应缴费额\"\n行3: J3=\"20.16\" K3=\"20.16\" L3=\"多1.44\"\n行4: J4=\"764\" K4=\"764\"\n行5: …"
首字 1.2s · ↑4.0k ↓6.1k · 缓存 2.6k · 思考 5.9k
继续
已经能看出点名堂了——J 列里没有一个是公式（全部是纯数字）。我再精确扫一下第 8、15、16 行，把每个非空格子的地址和原始值列出来确认。

js
再运行一次
const raw = await IC.getRangeRaw('A8:V16');
const letters = [];
for (let c = 1; c <= 22; c++) letters.push(IC.a1(1, c).replace(/1$/, ''));
const out = [];
for (let r = 0; r < raw.length; r++) {
  const rowLabel = r + 8;
  const cells = [];
  for (let c = 0; c < raw[r].length; c++) {
    const v = raw[r][c];
    if (v !== '' && v != null) cells.push(`${letters[c]}${rowLabel}=${v}`);
  }
  out.push(`行${rowLabel}: ${cells.join(' | ') || '(空)'}`);
}
return out.join('\n');
✅ 已执行：getRangeRaw、a1×22（1ms） · 返回 "行8: G8=1349.47 | J8=928.79 | K8=9月比8月多2.16元 | S8=420.68 | T8=9月比8月多0.36\n行9: A9=6…"
首字 1.2s · ↑5.5k ↓3.0k · 缓存 4.0k · 思考 2.8k



- 单元格点击加粗 console error；其他的格式调整也是这样
ironcalc.js:1604 Uncaught Error: Error: invalid type: unit value, expected u32
    at __wbg_Error_92b29b0548f8b746 (ironcalc.js:1604:25)
    at wasm.wasm.wasm_bindgen[796926cdf6841328]::__wbindgen_error_new::__wbg_Error_92b29b0548f8b746 externref shim (ironcalc_bg.wasm:0x4253df)
    at wasm.wasm.wasm[e1a85a7112d33378]::to_js_error (ironcalc_bg.wasm:0x3f7b2a)
    at wasm.wasm.model_updateRangeStyle (ironcalc_bg.wasm:0x1f8dba)
    at wasm.wasm.model_updateRangeStyle externref shim (ironcalc_bg.wasm:0x424eaa)
    at wasm.wasm.model_updateRangeStyle externref shim multivalue shim (ironcalc_bg.wasm:0x423213)
    at Model.updateRangeStyle (ironcalc.js:1469:26)
    at applyRangeStyle (app.js:393:9)
    at toggleFontFlag (app.js:400:3)
    at $.onclick (app.js:1156:31)

