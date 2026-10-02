# ironcalc-web — 浏览器里的迷你 Excel（IronCalc + wasm + AI）

把 Rust 写的表格引擎 [IronCalc](https://github.com/ironcalc/IronCalc) 编译成 WebAssembly，
再用一个零构建的静态页面把它包成一个能用的 Excel：**打开 / 编辑 / 公式求值 / 保存 xlsx**，
右侧再挂一个 **AI 对话框**：用自然语言让 LLM 写 JS 直接改表。

分阶段计划的两层都做完了：

- **第 1 层**：纯前端表格（wasm 引擎 + 手写网格 UI）
- **第 2 层**：AI 抽象层（provider / 对话框 / endpoint+apikey / 会话历史 / 白名单沙箱执行）

---

## 快速开始

`web/pkg/` 已经编译好了（本地），直接起服务即可：

```bash
scripts/serve.sh
# ==> http://127.0.0.1:8765/
```

等价的手写命令：

```bash
python3 -m http.server 8765 --directory web
# 或者： npx serve web
```

> ⚠️ 必须通过 http 打开。直接双击 `web/index.html`（`file://`）会因为 CORS 加载不了 `.wasm`。

打开的页面默认带一小片示例数据（商品 / 数量 / 单价 / 小计 + SUM），可以直接拿来验证公式。

### 试 AI：起一个假的 completion API（不联网、不花钱）

```bash
scripts/mock-api.sh          # ==> http://127.0.0.1:8766/v1
```

然后页面右上角 **✦ AI** 打开面板 → **⚙**：

| 字段 | 填什么 |
| --- | --- |
| Endpoint (base_url) | `http://127.0.0.1:8766/v1`（只填 `http://127.0.0.1:8766` 也会自动补 `/v1`） |
| API Key | 留空 |
| Model | `mock-gpt` |

点「测试连接」应该看到 3 个 mock 模型；保存后关掉设置，在下面输入框里说
**「帮我在 B5 求和」**、**「给 D 列加 6% 的税」**、**「表头加粗居中」**……
假服务会按关键词返回不同的示例代码，点回复里代码块上的「运行」就会真的改表。

假服务支持的关键词（见 `tmp/fake_openai.mjs`）：`求和/合计/sum`、`税/tax`、`标题/title`、
`样式/style/加粗/居中`、`多步/multi`、`坏代码/badcode`、`越权/escape`、
`服务器错误/error500`、`未授权/unauthorized`。

换成真 endpoint 也行：任何 OpenAI 兼容的 `/chat/completions` 都能用（流式 / 非流式都支持）。
⚠️ 浏览器直连要求 endpoint 允许跨域（CORS）；很多厂商的官方 API 默认不允许，这时需要在中间加一层自己的转发。

---

## 功能（第 1 层：表格）

| 能力 | 说明 |
| --- | --- |
| 打开 xlsx | 工具栏「打开」或直接把文件拖到页面上；`.xlsx` / `.xlsm` |
| 保存 xlsx | 工具栏「保存」，走 IronCalc 的 xlsx writer 导出，浏览器下载 |
| 编辑 | 双击 / `F2` / 直接打字进入编辑；公式栏也能输入 |
| 公式求值 | 由 Rust 引擎负责，`SUM` / `COUNT` / `AVERAGE` / 四则运算 / 引用等 |
| 多工作表 | 底部标签切换；`＋` 新建；双击标签重命名 |
| 选区 | 点选、拖选、Shift 扩选、点行/列头整行整列；状态栏显示 求和/平均/数值个数 |
| 撤销重做 | `Ctrl+Z` / `Ctrl+Y`（引擎内置 undo 栈） |
| 剪贴板 | `Ctrl+C/X/V`，TSV 格式，可跨软件粘贴（粘贴走引擎批量写入 + 挂起求值） |
| 样式 | 渲染单元格的 粗体/斜体/下划线、字体色、填充色、水平对齐、字号 |
| 写公式时点选区域 | 编辑框内容以 `=` 开头时，点/拖单元格、点行列表头会把 `B3` / `A1:B3` / `A:A` / `1:3` 插到光标处（Excel 行为） |

### 快捷键

| 键 | 行为 |
| --- | --- |
| 方向键 / `PageUp` `PageDown` | 移动选区（按住 `Shift` 扩大选区） |
| `Home` / `End` | 跳到行首 / 行尾 |
| `Enter` | 提交并下移（配合 `Shift` 上移） |
| `Tab` / `Shift+Tab` | 提交并右移 / 左移 |
| `F2` | 编辑当前单元格（保留原内容） |
| 任意可见字符 | 直接开始编辑（覆盖原内容） |
| `Delete` / `Backspace` | 清空选区内容 |
| `Esc` | 取消编辑 |
| `Ctrl+A` | 全选 |
| `Ctrl+S` / `Ctrl+O` | 保存 / 打开 |

> 在单元格编辑器和公式栏里，按键归输入框自己（方向键、`Backspace`、`Home/End` 都正常）；
> 复制粘贴也只在表格有焦点时接管，AI 面板 / 设置里粘贴走浏览器默认行为。

---

## 功能（第 2 层：AI）

| 能力 | 说明 |
| --- | --- |
| 对话框 | 右侧面板（工具栏 **✦ AI** 开关），支持 markdown / 代码块 / 流式逐字上屏 |
| endpoint + api key + model | ⚙ 里配置，存在 localStorage；「测试连接」走 `GET /models` |
| provider 抽象 | `web/ai/provider.js`：OpenAI 兼容，流式 SSE + 非流式、超时、取消、401/500 归一化 |
| 会话 | 多会话列表（localStorage 持久化）、新建 / 切换 / 删除，最近 80 条消息 |
| 看懂表 | 每次请求把当前工作簿压成一段紧凑文本（表名 / 选区 / used range 的 TSV，公式保留原文）塞进 system 消息 |
| 执行 | 模型输出 ```js 代码块 → 点「运行」或开「自动执行」→ 白名单沙箱里执行 `IC.*` |
| 回滚 | 一次 AI 改动前自动存 xlsx 快照，「回滚这次改动」一键还原（快照只在本次页面会话内有效） |
| 多步骤 | 一条回复里多个代码块，可分别运行；执行结果（成功了哪些调用 / 报错在哪一步）显示在消息下面 |

设计意图：**不把表格状态序列化给模型去“规划 API 调用”，而是让模型直接写调用 `IC.*` 的 JS**。
`IC` 是页面上的一个窄接口（行列 1-based，也接受 A1 写法），模型只要会写 JS 就能改表。

### AI 的执行流程

```
输入问题
  → buildContext(IC)          # 当前表快照（used range → TSV）
  → POST {base}/chat/completions（流式）
  → 解析出 ```js 代码块
  → runAiCode(code, IC)       # 静态扫描 + new Function + 白名单注入
  → IC.* 改 wasm model → 引擎重算 → 网格刷新
```

### 安全边界（重要）

`web/ai/sandbox.js` 是**防误伤**，不是防恶意代码的沙箱：

- 静态扫描拦掉 `import(` / `eval(` / `new Function` / `globalThis` / `window` / `document` /
  `fetch` / `localStorage` / `require` / `process` / `__proto__` 等；
- `new Function` 里把上面这些名字**作为形参遮蔽成 `undefined`**，并且只注入白名单里的 `IC` 方法；
- 内层 `"use strict"`；
- 写操作限于「表格 + 样式 + 工作表结构」，`IC.fromXlsx` / `IC.download` 这类破坏性或触发下载的方法**不在白名单里**。

但它跑在同一个 realm，**模型仍能写出死循环卡住页面**。要跑真正不可信的代码得挪到 Web Worker 里加超时终止。
另外：默认不自动执行，代码块要你点「运行」；执行前有 xlsx 快照可以回滚。

### 给 AI 用的 IC API

完整清单写在 prompt 里（`web/ai/prompt.js` 的 `IC_API_DOC`），沙箱白名单在 `web/ai/sandbox.js`
的 `IC_WHITELIST`。常用：

```js
IC.getCell('B3')                    // { content, value }
IC.getRange('A1:C3')                // 二维数组（显示值）
IC.getRangeRaw('A1:C3')             // 二维数组（公式原文）
IC.usedRange()                      // { r1,c1,r2,c2 } | null
IC.getSelection()                   // { sheet, sheetName, r1,c1,r2,c2, label }

IC.setCell('B5', '=SUM(B2:B4)')
IC.setRange('D2:D4', [['=B2*C2*1.06'], ['=B3*C3*1.06'], ['=B4*C4*1.06']])
IC.clearRange('A1:C3')
IC.format('A1:D1', { bold: true, align: 'center', fill: '#1a73e8', color: '#ffffff' })
IC.applyStyle('A1:D1', 'font.b', 'true')        // 底层 style path
IC.setColumnWidth('A', 'C', 120)
IC.insertRows(3, 2) IC.deleteColumns('E', 1)
IC.merge('A1:D1') IC.unmerge('A1:D1')

IC.sheets() IC.selectSheet('Sheet2') IC.newSheet('汇总')
IC.renameSheet('Sheet1', '明细') IC.deleteSheet('Sheet2')
IC.select('B3') IC.selectRange(1, 1, 3, 3)
IC.a1(3, 2)                         // 'B3'
IC.parseRef('Sheet2!A1:B3')         // { sheet, sheetName, r1,c1,r2,c2 }
IC.getName() IC.setName('Q3 预算')
IC.undo() IC.redo() IC.toast('…')
```

控制台里也能直接玩（`window.IC`），AI 面板本身挂在 `window.AI`。

---

## 目录结构

```
261002-ironcalc-web/
├── IronCalc/              # 上游 Rust 仓库（clone 来的，未改动）
├── web/                   # 前端（无构建步骤，纯静态）
│   ├── index.html         # 网格 + AI 面板的静态骨架
│   ├── style.css          # 表格样式
│   ├── ai.css             # AI 面板样式
│   ├── app.js             # 表格：渲染 / 交互 / 文件 IO / window.IC
│   ├── refs.js            # A1 引用解析与生成（纯函数，可单测）
│   ├── ai/
│   │   ├── provider.js    # OpenAI 兼容 chat client（流式/非流式/超时/取消）
│   │   ├── sandbox.js     # 白名单 + new Function 执行模型写的 JS
│   │   ├── context.js     # 工作簿 → prompt 文本；消息组装
│   │   ├── prompt.js      # system prompt + IC API 文档
│   │   ├── markdown.js    # 极简 markdown / 代码块解析（纯函数）
│   │   └── panel.js       # 对话框 UI：会话 / 设置 / 流式 / 执行 / 回滚
│   └── pkg/               # wasm-bindgen 产物（构建生成，可重新生成）
├── scripts/
│   ├── build-wasm.sh      # 重新编译 wasm
│   ├── serve.sh           # 起本地静态服务
│   └── mock-api.sh        # 起假的 OpenAI 兼容 API（验证 AI 层用）
├── tmp/                   # 临时文件 / 验证脚本（不进产品）
│   ├── test_wasm.mjs      # 第 1 层：wasm / 引擎冒烟测试
│   ├── test_ai.mjs        # 第 2 层：provider / sandbox / context / 端到端
│   └── fake_openai.mjs    # 假 completion API 服务器（可被测试 import）
├── notes.md               # 开发进度 / 决策 / 已知问题 / 人工验收清单
└── README.md
```

页面本身没有打包器、没有 node_modules：`index.html` 就是一个 `<script type="module">`，
`app.js` 直接 `import init, { Model } from './pkg/ironcalc.js'`。

---

## 重新编译 wasm

只有改了 Rust 侧（或想升级 IronCalc）才需要。前置：rust 工具链、python3（起服务用）。

```bash
scripts/build-wasm.sh
```

脚本会按需自动做这几件事：

1. `rustup target add wasm32-unknown-unknown`
2. `cargo install wasm-bindgen-cli --version 0.2.126`
   （版本必须与 `IronCalc/Cargo.lock` 里的 `wasm-bindgen` 一致，否则报 schema 版本错误）
3. `cargo build --release --target wasm32-unknown-unknown -p wasm --features xlsx`
   （在 `IronCalc/` 里；`xlsx` feature 提供 `Model.fromXlsx` / `model.toXlsx`）
4. `wasm-bindgen --target web --out-dir web/pkg --out-name ironcalc`

产物约 4.9 MB（未跑 `wasm-opt`；接入 binaryen 可再压一半左右）。

> `web/pkg/snippets/` 是 wasm-bindgen 生成的内联 JS 片段（时区格式化用），
> 部署时 `pkg/` 整个目录要一起拷，不能只拿 `.wasm`。

---

## 测试

只做 Node 侧的测试，**不启动浏览器**：

```bash
node tmp/test_wasm.mjs    # 第 1 层：引擎 / undo / xlsx round-trip
node tmp/test_ai.mjs      # 第 2 层：provider / sandbox / context / markdown / refs + 端到端
```

`test_ai.mjs` 会自己在随机端口起 `tmp/fake_openai.mjs`，覆盖：

- A1 引用解析（`B3` / `A1:C3` / `A:A` / `1:3` / `$A$1` / `Sheet!` / 引号表名 / 非法输入）
- provider：非流式、流式 SSE 累积、`/models`、Authorization、401/500、取消、超时
- sandbox：白名单注入、op 计数、`await`、返回值、console 捕获、`maxOps`、
  拦截 `window/document/globalThis/import()/eval/require/fetch/__proto__` 与不存在的方法
- context / markdown / buildMessages
- **端到端**：假 API 吐 JS → 沙箱执行 → 写进真实 wasm Model → 断言单元格值
- 静态检查：沙箱白名单里的每个方法都真的存在于 `app.js` 的 `IC`（防止两边漂移）

**浏览器 UI 由人工验收**（见 `notes.md` 里的验收清单），仓库里不放 Playwright。

---

## 已知限制

第 1 层有意为之：

- **不支持旧版 `.xls`**：IronCalc 只实现 OOXML（xlsx/xlsm）。选到 `.xls` 会提示先另存为 xlsx。
- **行高按统一 25px 渲染**，不读每行的自定义高度（列宽会读；`IC.setRowHeight` 只写进文件）。
- **不渲染合并单元格**、冻结窗格、条件格式的 dxf 底色、图标集/数据条、图片与批注。
- **文本不溢出到相邻空单元格**（Excel 的行为），超出就裁掉。
- 可滚动范围固定 2000 行 × 100 列（引擎本身支持 1,048,576 × 16,384）。
- 未做 `wasm-opt` 体积优化。
- 没有服务端，一切都在浏览器本地；保存 = 下载文件。

第 2 层相关：

- 沙箱不是真沙箱（同 realm），**死循环会卡住页面**；要跑不可信代码得挪到 Worker。
- 浏览器直连第三方 API 需要对方允许 CORS；不行就自己加转发。
- 回滚快照只在当前页面会话内有效（不写进 localStorage，避免撑爆配额）。
- 模型输出的是 JS，跑之前请自己看一眼代码块——这是「不把表格状态塞给模型」换来的代价。
