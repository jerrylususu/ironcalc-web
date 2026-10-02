# notes.md — 开发进度与决策记录

> 目标（来自 `idea.md`）：基于本机 rust 工具链，做一个能用的前端 Excel，并且能接 AI
> （chat completion 让 LLM 写 JS 驱动改表）。
>
> - **第 1 层**：rust 编译 IronCalc → wasm + 一个 HTML，能加载文件、编辑、公式求值、保存
> - **第 2 层**：AI 抽象层（对话框 / endpoint / apikey / chat history / 执行）

## 协作约定

- **不自己跑浏览器 E2E**，UI 由用户手动验收；仓库里不放 Playwright / 浏览器二进制。
- 临时文件、脚本都放项目内的 `tmp/`，不写到 `/tmp` 或项目外。

---

## 当前状态：✅ 第 1 层 + 第 2 层都已实现（待人工验收）

最后更新：第 2 层（AI 层）实现完成；`tmp/test_ai.mjs` 109 项全绿，`tmp/test_wasm.mjs` 仍 ALL OK。
浏览器侧的 UI 没有自动化验证，验收清单见下。

### 环境 / 版本

| 组件 | 版本 |
| --- | --- |
| rustc / cargo | 1.97.1 |
| target | `wasm32-unknown-unknown`（本次 `rustup target add` 安装） |
| wasm-bindgen-cli | 0.2.126（必须与 `IronCalc/Cargo.lock` 里 wasm-bindgen 完全一致） |
| node / npm | v24.15.0 / 11.12.1 |
| python3 | 3.13.7（只用来起静态服务） |
| IronCalc | 本地 clone，`git log -1` = `b6d34abc FIX: ROW and column can deal with ranges` |

### 已完成

- [x] 编译 IronCalc wasm（`bindings/wasm`，`--features xlsx`）→ `web/pkg/`
      - `ironcalc_bg.wasm` ≈ 4.9 MB，未做 `wasm-opt`
      - 产物含 `snippets/`（时区格式化内联 JS），部署要整目录带走
- [x] 前端页面（零构建、无 node_modules）
      - 虚拟滚动网格（只渲染可视区，池化 DOM 节点复用）、行/列表头、冻结的角标
      - 单元格编辑（双击 / F2 / 直接打字 / 公式栏），Enter/Tab 提交并移动
      - 选区：点选、拖选、Shift 扩选、点表头整行整列；状态栏 求和/平均/数值个数
      - 键盘：方向键、PageUp/Down、Home/End、Delete 清空、Esc 取消、Ctrl+A
      - 剪贴板：Ctrl+C/X/V（TSV），粘贴走 `pauseEvaluation` → 批量 `setUserInput` → `resumeEvaluation` + `evaluate`
      - 撤销/重做按钮 + Ctrl+Z / Ctrl+Y
      - 文件：打开 xlsx（按钮 / 拖拽）、保存 xlsx（下载）、新建（带示例数据）
      - 多工作表：标签切换、＋新建、双击重命名
      - 样式渲染：粗体/斜体/下划线、字体色、填充色、水平对齐、字号
      - `window.IC` 导出 API 供第 2 层调用
- [x] `scripts/build-wasm.sh`（幂等，自动补 target / wasm-bindgen-cli）
- [x] `scripts/serve.sh`
- [x] `README.md`
- [x] Node 端 wasm 冒烟测试 `tmp/test_wasm.mjs` —— **ALL OK**

### 第 2 层（AI 层）已完成

- [x] `web/refs.js`：A1 引用解析/生成（纯函数），`app.js` 和测试共用
- [x] **修 todo 里的两条问题**
      - 单元格内编辑：编辑器 `stopPropagation()` + 网格编辑态直接 return
        （原来 `Backspace` 会被网格当成「清空选区」，方向键/Home/End 被 preventDefault，
        `Enter`/`Tab` 提交后还会再被网格处理一次 → 跳两格）
      - 写公式时点选区域：编辑框以 `=` 开头时，点/拖单元格、点行/列表头插入
        `B3` / `A1:B3` / `A:A` / `1:3`，公式栏里同样生效
      - 顺带修：剪贴板/create/剪贴只在表格有焦点时接管（原来在 AI 设置里粘贴会被粘到单元格）；
        拖放也只在非输入框/非 AI 面板区域才当「打开文件」
- [x] 扩充 `window.IC`：`setRange`/`clearRange`/`usedRange`/`getRangeRaw`/`getSelection`/
      `format`/`applyStyle`/`setColumnWidth`/`insert*`/`delete*`/`merge`/`selectRange`/
      `selectSheet`/`newSheet`/`renameSheet`/`deleteSheet`/`a1`/`parseRef`……（行列 1-based，也收 A1 写法）
- [x] `web/ai/provider.js`：OpenAI 兼容 chat client（SSE 流式 + 非流式、`/models`、超时、取消、
      401/500 归一化成 `ApiError`、`base_url` 自动补 `/v1`）
- [x] `web/ai/sandbox.js`：静态扫描 + `new Function` 白名单注入 + 遮蔽 `window/document/fetch/eval/...`，
      支持 `await`、op 计数、console 捕获、`maxOps` 守卫
- [x] `web/ai/context.js` + `prompt.js`：used range → 紧凑 TSV 快照；system prompt 带完整 IC API 文档
- [x] `web/ai/markdown.js`：代码块抽取 + 极简 markdown 渲染（纯函数、HTML 转义）
- [x] `web/ai/panel.js` + `web/ai.css`：右侧面板、流式渲染、代码块「运行/再运行」、自动执行、
      ⚙ endpoint/apikey/model/温度/测试连接、多会话（localStorage）、xlsx 快照回滚
- [x] `tmp/fake_openai.mjs` + `scripts/mock-api.sh`：假 OpenAI 兼容服务（流式/非流式/401/500/CORS/多脚本）
- [x] `tmp/test_ai.mjs`：109 项全绿（含端到端：假 API 吐 JS → 沙箱 → 真的写进 wasm Model）

### 验证证据（第 2 层）

`node tmp/test_ai.mjs` 109 项全绿，覆盖：

- `refs`：`colName`/`colNumber`/`parseA1`（`B3`/`A1:C3`/`A:A`/`1:3`/`$A$1`/`Sheet2!`/引号表名/非法输入）/`refText`
- `provider`：非流式、流式 chunk 累积与非流式一致、`/models`、Authorization 头、
  401/500 错误归一、已取消 signal、超时、未配 model
- `sandbox`：白名单注入、op 计数、`await`、返回值、console 捕获、`maxOps`、语法错误；
  拦截 `window/document/globalThis/import()/eval/require/fetch/__proto__` 与不存在的方法
- `context`/`buildMessages`/`markdown`：快照内容、context 插入位置、HTML 转义
- 端到端：`求和`→B5=10、`加税 6%`→D2=7.95 / D5=22.26、多代码块、坏代码走错误分支、越权被拦
- 不漂移：静态检查 `IC_WHITELIST` 里每个方法都存在于 `app.js` 的 `IC`

### 验证证据（第 1 层）

`node tmp/test_wasm.mjs` 全绿，覆盖：

- 引擎：`=B2*C2`、`=SUM(B2:B4)` → 10、`=COUNT(B2:B4)` → 3、`=SUM(D2:D4)` → 21
- 类型：`getCellType` 数字=1 / 文本=2 / 错误=16；`getColumnWidth`=90、`getRowHeight`=25
- 错误单元格：`=NOSUCHFN(1)` → `#NAME?`；`=1/0` → `#DIV/0!`
- undo / redo（`canUndo` 正确）
- xlsx round-trip：`toXlsx()` → `fromXlsx()` 后公式结果与单元格内容一致
- 真实文件：加载 `IronCalc/xlsx/tests/example.xlsx`（10 个工作表）→ 再导出 → 再加载仍 10 表

性能抽样（Node，非浏览器）：`getFormattedCellValue` ≈ 0.4µs/次，`getCellStyle` ≈ 3.5µs/次，
一屏 ~500 个单元格 ≈ 2ms 取数，所以**每帧都取样式**（含空单元格的填充色）也不卡。

---

## 关键决策

1. **不用 `wasm-pack`，改用 `cargo build` + `wasm-bindgen` CLI。**
   本机没有 wasm-pack，`cargo install wasm-pack` 之后它在 release 构建时还会去 GitHub
   Releases 拉 `wasm-bindgen` / `wasm-opt` 预编译二进制，网络不通就卡死。
   直接 `cargo install wasm-bindgen-cli --version 0.2.126`（只依赖 crates.io）最稳，
   代价是要自己盯版本号 —— `build-wasm.sh` 里已经固定并会在不一致时告警。

2. **前端不用上游 `webapp/` 里的 React 组件（`webapp/IronCalc`）。**
   那一套是给 app.ironcalc.com 用的完整件，要 pnpm + Vite + React 构建。
   第 1 层目标是"基本能用 + 好理解"，所以手写一个 ~800 行的原生 JS 网格：
   零依赖、零构建、改起来直接刷新，第 2 层往里塞对话框也不会被框架掣肘。

3. **选区/编辑全部交给自己实现，只把"数据与求值"交给 wasm。**
   IronCalc 的 wasm 绑定里也有 `onArrowRight` / `setSelectedCell` 这类 UI 状态方法，
   但那些状态是给上游 React 组件用的；我们自己维护 `sel`，只调
   `getFormattedCellValue` / `setUserInput` / `getCellStyle`，耦合最小。

4. **`.xls` 不做，明确提示用户另存为 xlsx。**
   IronCalc 只有 OOXML 的 reader/writer（`xlsx` crate），`.xls` 是 BIFF 二进制格式，
   要另写解析器。idea 里虽然写了"支持 xlsx xls"，但那是原型范围外的成本，已在 README 标注。

5. **单元格数据加了带失效的缓存（`cellCache` / `styleCache`）。**
   滚动时同一格会被反复取；缓存后滚动只对"新露出"的格子访问 wasm。
   任何写操作（编辑/粘贴/撤销/切表/换文件）统一 `invalidate()` 清空。
   另外 `cellCache` 在选区统计里被复用，所以状态栏不额外访问 wasm。

### 第 2 层

6. **不用 function calling / tool schema，让模型直接写 `IC.*` 的 JS。**
   这是 `idea.md` 里就定下的方向：好处是不用把表格状态序列化给模型去"规划 API 调用"，
   模型只要会写 JS 就能干活，多步操作一个代码块就完了；代价是必须自己管执行安全
   （白名单沙箱 + 默认不自动执行 + xlsx 快照回滚）和输出解析（围栏代码块）。

7. **provider 只用 `fetch` 自己写，不引 openai sdk。**
   第 2 层要的是"OpenAI 兼容"而不是"OpenAI"；自己写才能控制：SSE 解析、
   超时/取消、错误归一化（`ApiError` 带 `status`），并且**同一份代码在浏览器和 Node 里都能跑**
   —— 所以 provider / sandbox / context / markdown 全部不碰 DOM，才能被 `tmp/test_ai.mjs` 直接 import。
   UI 只在 `panel.js` 里。

8. **沙箱用 `new Function` + 形参遮蔽，不用 iframe / Worker。**
   同 realm 就挡不住死循环，但实现简单、能直接摸到 `IC` 和 wasm 对象；
   原型阶段够用，README 里把边界写清楚了。顺带一个细节：外层函数**故意不写 `"use strict"`**
   （strict 下形参不能叫 `eval`），strict 放在内层 IIFE 里。

9. **用在 range 查包围盒（`getColumnsWithData`）而不是逐格扫。**
   2000×100 逐格 `getCellType` 要 ~10ms，逐行调 `getColumnsWithData` 只要 ~1.2ms，
   而且能直接用引擎自己的"哪些行/列有数据"索引。

10. **AI 改动前存一份 xlsx 快照用于回滚。**
    引擎的 undo 栈是「一次 setUserInput 一步」，一次 AI 改动可能是十几步，
    没有事务/分组 API；`toXlsx()` 存字节最简单且能完整还原（代价是内存，且不跨刷新）。

11. **A1 解析抽到 `web/refs.js`。**
    「写公式时点选区域」和「AI 用 A1 写法调 IC」是同一套解析逻辑，抽出来才能单测
    （浏览器里没法自动验证）。为此 `app.js` 不再依赖 wasm 的 `columnNameFromNumber`。

---

## 踩过的坑

- `wasm-bindgen --out-dir ../../web/pkg` 是相对 `IronCalc/` 解析的，手写时容易写错一级
  跑到项目外面去（已改成脚本里用绝对路径 `$ROOT/web/pkg`）。
- `bindings/wasm/test.html` 和 `README.md` 里的 `new Model(name, locale)` 是过期的，
  实际构造函数是 **4 个参数** `new Model(name, locale, timezone, language_id)`；
  `fromXlsx(bytes, name, locale, timezone, language_id)`，10 个表的 example 用
  `'en','UTC','en'` 能正常加载。
- 空字符串 `setUserInput(sheet, r, c, '')` 是清空单元格的正确姿势；粘贴时不写空字符串，
  否则会把目标区域已有内容抹掉（现在只有非空单元格才写）。
- 清空选区用了 `pauseEvaluation` + 循环 `setUserInput` + `evaluate`，
  比逐格写触发重算快很多。
- **事件委派在 `document` 上就要小心焦点归属**：单元格编辑器的键会冒泡到 `#scroll`
  的 keydown（`Backspace` 被当成"清空选区"、`Enter` 被处理两次）；
  剪切板 `document` 监听器不区分焦点，把 AI 设置里的粘贴抢到了表格里。
  修法：编辑器自己 `stopPropagation()`，全局剪贴板/拖放先判断
  `document.activeElement` / `ev.target` 是不是输入框或 `#ai-panel` 里的东西。
- 假 API 服务器一开始让 `replyFor()` 同时返回"错误体"和"markdown 字符串"，
  服务端却统一去读 `reply.body.choices[0]` → 第一个 200 就崩。
  改成 `{ status, content }` / `{ status, error }` 两种明确形状。
- 流式的超时/取消一开始只在 `fetch()` 那一层做了 `ApiError` 转换，
  `readSse` 里 reader 抛的 `AbortError` 会裸着漏出去（面板判断不了类型、非流式回退也不生效）。
- 沙箱的 `brief()`（给用户看的返回值摘要）深度阈值是 1，`IC.getRange()` 的二维数组
  被压成 `["[1 项]","[1 项]"]`，看不到内容；改成深度 2 + 每层最多 10 项。

---

## 人工验收清单（请手动过一遍）

服务已在跑：<http://127.0.0.1:8765/>（重启：`scripts/serve.sh`）

1. 首屏：网格、A1 的「商品」、B5 的 SUM=10、D5 的 SUM=21；表头行加粗
2. 双击 B2 改成 5 → D2 变 12.5，D5 变 26
3. 在空单元格直接打字 `=SUM(B2:B4)*2` → 回车出结果；点回去公式栏显示公式原文
4. 公式栏输入 `=AVERAGE(C2:C4)` → 回车
5. 拖选/Shift 选 B2:B4 → 状态栏出现 求和/平均/数值个数；点列头 A 整列高亮
6. Ctrl+C 复制一块，到别处 Ctrl+V；Ctrl+X / Delete 清空
7. Ctrl+Z / Ctrl+Y 各按几次，确认只回退/重做一步
8. 底部 `＋` 新建工作表 → 切换 → 双击标签重命名
9. 「打开」选 `IronCalc/xlsx/tests/example.xlsx` → 10 个标签、能切表、能看到内容与样式
10. 「保存」→ 得到一个 xlsx → 用 Excel / LibreOffice / Numbers 打开，确认数值与公式正常
11. 保存下来的文件再拖回页面，确认能再打开
12. 找一个真实的中文 xlsx（带日期、货币、百分比、填充色）看看格式显示是否可接受
13. 故意输入 `=1/0`、`=NOSUCHFN()`，确认显示红色错误值且不崩
14. 打开 `.xls`（文件选择器切到"所有文件"）→ 应给出"请另存为 xlsx"的提示

### 第 2 层 / 本次修复的验收

先起假服务：`scripts/mock-api.sh`（→ `http://127.0.0.1:8766/v1`），
面板 ⚙ 里 endpoint 填它、model 填 `mock-gpt`、api key 留空。

15. **编辑框键盘（本次修复）**：双击 B2 → 在里面按 `Backspace` 能删字符（不是清空整格）、
    方向键/`Home`/`End` 能移动光标、`Enter` 只向下跳**一格**、`Tab` 只向右跳一格
16. **公式点选（本次修复）**：双击空单元格 → 输 `=SUM(` → 鼠标拖 `B2:B4` → 编辑框里出现
    `=SUM(B2:B4)`（拖拽时引用实时变）→ `Enter` 出结果；再试 `=SUM(` + 点列头 `B` → `=SUM(B:B)`
17. **公式栏也能点选**：点到空单元格 → 公式栏输 `=SUM(` → 鼠标拖区域 → 引用插进公式栏 → `Enter`
18. **粘贴不再飞进单元格（本次修复）**：在 ⚙ 的 Endpoint / API Key 里 `Ctrl+V` → 文字进输入框，
    表格不变；在 AI 输入框里粘贴同理；回到网格里 `Ctrl+V` 仍然粘到单元格
19. **拿去复制**：在 AI 回复里选中一段文字 `Ctrl+C` → 复制的是选中的文字，不是表格区域
20. **AI 面板**：✦ AI 开关；流式逐字上屏；代码块「运行」→ 看到「✅ 已执行：setCell…」；
    「再运行一次」能再跑；开「自动执行」后新回复自动跑
21. **回滚**：让它改一步（如「改标题」）→ 点「回滚这次改动」→ A1 恢复原值
22. **会话**：新建/切换/删除会话；发几条消息后刷新页面 → 历史还在（但回滚快照已失效）
23. **设置**：「测试连接」显示 mock 的 3 个模型；把 endpoint 改成错的地址 → 面板显示 `HTTP 4xx/网络错误` 而不是卡住；
    「停止」能中断一个正在流式的请求
24. **假服务的错误脚本**：说「坏代码」→ 代码块运行后报 `IC.deleteEverything is not a function`；
    说「越权」→ 报「代码里出现了被禁用的 window」；说「服务器错误」→ 回复里出现 `> ⚠️ 请求失败：HTTP 500`
25. **AI 改动高亮**：说「税」/「求和」→ 运行后，被写到的那片区域出现橙色高亮框 + 淡背景，
    约 2.6s 自动消失；**单元格本身的加粗/颜色完全没变**（高亮不写进样式）。
    说「样式」→ 表头 A1:D1 应变成横向一行加粗居中（而不是竖向 A1:A4）。

### 第 3 轮（短期 TODO 一批）的验收

26. **格式工具栏（#4）**：选一块区域 → 点 `B`/`I`/`U`/`S`、改字号 → 立即生效；
    `Ctrl+B/I/U` 同样生效；点回已加粗的单元格，`B` 按钮显示为按下状态；
    删除线**真的显示出来**（上一轮只存了样式没渲染）。
27. **只读免确认（#2）**：只让 AI「读一下表」（不勾自动执行）→ 回复一到，
    代码块自己就跑了，按钮写着「只读 · 自动运行」；含写操作的块仍要手点「运行」。
28. **跑过就灰（#1）**：「求和」→ 运行按钮变成灰的「已执行」；`Ctrl+Z` 撤销后
    按钮恢复成可点的「再运行一次」；「回滚这次改动」后同样恢复。
29. **思考展示（#6）**：用支持 reasoning 的模型（或 mock）→ 回复上方出现可折叠的
    「💭 思考过程」，流式时是展开的、结束后可折叠；历史里**不会**把 reasoning 发回给模型。
30. **ttft / token（#8）**：每条回复底部显示「首字 x.xs · ↑1.2k ↓300 · 缓存 512 · 思考 64」。
31. **执行结果回传（#9）**：先让它读一次表，再问「你刚才看到了什么」→ 模型能引用上次返回值；
    打开浏览器 Network 看两次请求体：第 2 次的前 N 条消息和第 1 次逐字相同（prefix 只追加）。
32. **文本单元格高亮（#7）**：工具栏勾「文本」→ 表里像数字的文本被绿色淡底 + 左上角小三角标出，
    状态栏显示「文本数字: N」；取消「只看数字」→ 所有文本都被标出。
33. **一键转数字（#7）**：把带千分位/百分号/¥ 的文本格选中 → 「转选区」→ 变右对齐真数字，
    依赖它的 SUM 立刻变对；「转全部」处理整张表。转换后 `Ctrl+Z` 能撤销。
34. **公式引用高亮（#5）**：双击单元格输 `=SUM(B2:B4)` 后把光标移到 `B2:B4` 中间 →
    对应区域出现紫色虚线框；移到 `SUM` 或空白处 → 框消失；公式栏里同样生效。

## 已知问题 / 没做的

第 1 层：

- 行高统一 25px，不读自定义行高（列宽会读；`IC.setRowHeight` 只写进文件）
- 不渲染合并单元格、冻结窗格、条件格式底色/图标集/数据条、图片、批注
- 文本不溢出到相邻空格（直接裁断）
- 可滚动区固定 2000 行 × 100 列（引擎支持 1,048,576 × 16,384）
- 列宽改动（拖拽调整列宽）没做，只能由文件里带进来
- 没有 `wasm-opt`，wasm 4.9MB；真部署可以加 binaryen 压缩

第 2 层：

- **沙箱不是真沙箱**：同 realm，死循环会卡住页面；扒开要上 Worker + 超时终止
- 回滚快照只在当前页面会话内有效（没写 localStorage，怕撑爆配额）
- 浏览器直连第三方 API 需要对方允许 CORS；不行得自己加转发
- 上下文截断是粗暴的前 80 行 × 24 列，大表只会看到左上角
- `IC.format` 支持的样式属性是手写的子集（粗体/斜体/下划线/删除线/字号/字色/填充/数字格式/对齐/换行），
  边框、条件格式没做
- **prefix cache**：同一会话超过 80 条消息后会从头截断，那之后前缀会变、缓存失效；
  要彻底保住得换成分段摘要或按 token 预算裁剪

---

## 下一步（想继续做的话）

1. **把 AI 执行挪进 Worker** + 超时终止，真正隔离死循环；如果要做多轮工具调用，
   可以在沙箱里注入一个异步 `IC.call()` 走 postMessage
2. **上下文惩罚优化**：让模型能主动"读某块区域"（先看 usedRange 再决定读哪片），而不是每次塞前 80 行
3. 对话框能力补齐：重发 / 编辑消息 / 停止后继续、会话重命名（token 与耗时已完成，见第 3 轮）
4. 把 AI 的改动做成「一个 undo 分组」（需要引擎暴露事务 API，或者在 JS 侧记录 diffs 反向应用）
5. 行高 / 合并单元格 / 条件格式的渲染补齐（第 1 层欠账）
