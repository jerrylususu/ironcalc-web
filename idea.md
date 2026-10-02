当前机器上有 rust 工具链
我想基于此 实现一个基本的前端excel，同时还能接入ai （用chat completion api 让llm写js 驱动） 便于对excel文件的修改

分阶段来做
1. rust编译ironcalc 到wasm，写一个html整合下，基本能用（可以加载文件 编辑 eval公式 保存） 支持 xlsx xls，可以只支持基本的公式 sum count 这些 不用特别高级的
2. 加入ai抽象层，对话框，endpoint apikey，输入问题 执行 chat history session..
