#!/usr/bin/env bash
# 启动本地静态服务（必须走 http，file:// 下 wasm 会被 CORS 拦住）
#
# 用法：
#   scripts/serve.sh              # http://127.0.0.1:8765/
#   PORT=9000 scripts/serve.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8765}"

if [ ! -f "$ROOT/web/pkg/ironcalc.js" ]; then
  echo "web/pkg 不存在，先执行：scripts/build-wasm.sh" >&2
  exit 1
fi

echo "==> http://127.0.0.1:$PORT/   (Ctrl-C 停止)"
exec python3 -m http.server "$PORT" --directory "$ROOT/web"
