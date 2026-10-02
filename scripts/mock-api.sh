#!/usr/bin/env bash
# 起一个假的 OpenAI 兼容 completion API，用来本地验证 AI 层（不联网、不花钱）
#
# 用法：
#   scripts/mock-api.sh              # http://127.0.0.1:8766/v1
#   PORT=9001 scripts/mock-api.sh
#   REQUIRE_KEY=1 scripts/mock-api.sh   # 强制要求 Authorization 头（测 401）
#
# 然后把面板 ⚙ 里的 endpoint 填成 http://127.0.0.1:8766/v1，model 填 mock-gpt。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8766}"

echo "==> mock OpenAI API: http://127.0.0.1:$PORT/v1   (Ctrl-C 停止)"
exec env PORT="$PORT" node "$ROOT/tmp/fake_openai.mjs"
