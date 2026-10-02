# todo.md

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

- 运行 / 回滚 改动 是不是应该点完之后变灰，点了负向操作之后再重新启用？
- 只读操作无需确认？ 只有写操作才需要确认？
     已执行：getSelection、getCell（1ms） · 返回 {"表":"Sheet1","范围":"J8","行列":"8行 10列","J8原始内容":"928.79","J8显示值":"928.79"}
- 自动执行好像不会触发高亮动画？
- 加一些基本的格式设置 加粗 斜体 删除线 字体大小？
- 编辑公式的时候，光标所在的范围/单元格 对应边框染色 类似excel那样？
- thinking 的应该支持展示？reasoning_content
{"id":"e15a833e-f934-45da-8627-945e0430796a","object":"chat.completion.chunk","created":1790956019,"model":"deepseek-flash","system_fingerprint":"aeb56401ca74e127821c4f9126dcb669","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":""},"logprobs":null,"finish_reason":null}]}
{"id":"e15a833e-f934-45da-8627-945e0430796a","object":"chat.completion.chunk","created":1790956019,"model":"deepseek-flash","system_fingerprint":"aeb56401ca74e127821c4f9126dcb669","choices":[{"index":0,"delta":{"content":null,"reasoning_content":"The"},"logprobs":null,"finish_reason":null}]}
- 加一个功能 展示文本单元格 （因为可能会对计算造成干扰），一键重置为通用/数字单元格？
- 每次对话显示 ttft, token 消耗？（可以先只支持ds 官方，但是做成抽象能力，未来可以适配其他api）
{
    "id": "e15a833e-f934-45da-8627-945e0430796a",
    "object": "chat.completion.chunk",
    "created": 1790956019,
    "model": "deepseek-flash",
    "system_fingerprint": "aeb56401ca74e127821c4f9126dcb669",
    "choices": [
        {
            "index": 0,
            "delta": {
                "content": "",
                "reasoning_content": null
            },
            "logprobs": null,
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 3235,
        "completion_tokens": 15469,
        "total_tokens": 18704,
        "prompt_tokens_details": {
            "cached_tokens": 1536
        },
        "completion_tokens_details": {
            "reasoning_tokens": 14902
        },
        "prompt_cache_hit_tokens": 1536,
        "prompt_cache_miss_tokens": 1699
    }
}

- 执行结果会回传吗？应该回传？（拼接后面 不要破坏 prefix cache！）
预期结果：非空个数 = 5，但真数字个数 = 0 → 坐实是文本。

确认后，用下面这段把 G3:G7 转成真数字（去掉逗号，空单元格原样保留），G8 就会立刻显示正确合计，且以后改上面几行会自动跟着变：

js
再运行一次
const raw = IC.getRangeRaw('G3:G7');
const nums = raw.map(([v]) => {
  const s = String(v ?? '').trim();
  if (s === '') return [''];               // 空单元格不动
  const n = Number(s.replace(/,/g, ''));
  return [isNaN(n) ? v : n];               // 转不动的原样保留
});
IC.setRange('G3:G7', nums);

return { 转换后: IC.getRange('G3:G7'), G8结果: IC.getCell('G8').value };
顺带说一句：G15（谢晓丽那 6 行）大概率也是同样情况，转换时把范围扩到 G3:G15 更稳妥；要的话我帮你一起处理。

第 1 段：✅ 已执行：getRangeRaw、getRange、setCell×2、getCell×6、clearRange（16ms） · 返回 {"G3G7原始输入":["[…1 项]","[…1 项]","[…1 项]","[…1 项]","[…1 项]"],"探针":{"真数字个数":"0","非空个数":"5"},"G8":{"公式":"=SUM(G3:G7)","结果":"0"},"J8":{"公式":"=SUM(J3:J7)","结果":"928.79"}}
第 2 段：✅ 已执行：getRangeRaw、setRange、getRange、getCell（7ms） · 返回 {"转换后":["[…1 项]","[…1 项]","[…1 项]","[…1 项]","[…1 项]"],"G8结果":"11800"}
你能看到之前的运行结果吗
