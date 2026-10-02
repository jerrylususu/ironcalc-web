#!/usr/bin/env bash
# 把 IronCalc 的 wasm 绑定（含 xlsx 读写）编译到 web/pkg/
#
# 用法：
#   scripts/build-wasm.sh            # release 构建（默认）
#   PROFILE=debug scripts/build-wasm.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IRONCALC="$ROOT/IronCalc"
OUT="$ROOT/web/pkg"
PROFILE="${PROFILE:-release}"
WB_VERSION="${WB_VERSION:-0.2.126}"   # 必须与 IronCalc/Cargo.lock 里的 wasm-bindgen 一致

if [ ! -d "$IRONCALC/bindings/wasm" ]; then
  echo "找不到 $IRONCALC，请先 clone https://github.com/ironcalc/IronCalc" >&2
  exit 1
fi

command -v cargo >/dev/null || { echo "缺少 cargo（需要 rust 工具链）" >&2; exit 1; }

if ! rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$'; then
  echo "==> rustup target add wasm32-unknown-unknown"
  rustup target add wasm32-unknown-unknown
fi

if ! command -v wasm-bindgen >/dev/null; then
  echo "==> cargo install wasm-bindgen-cli --version $WB_VERSION（首次约 2-3 分钟）"
  cargo install wasm-bindgen-cli --version "$WB_VERSION" --locked
fi

HAVE="$(wasm-bindgen --version | awk '{print $2}')"
if [ "$HAVE" != "$WB_VERSION" ]; then
  echo "警告：wasm-bindgen-cli 版本 $HAVE 与 Cargo.lock 的 $WB_VERSION 不一致，可能报 schema 版本错误" >&2
fi

cd "$IRONCALC"
if [ "$PROFILE" = "release" ]; then
  echo "==> cargo build --release（lto 打开，首次 3-5 分钟）"
  cargo build --release --target wasm32-unknown-unknown -p wasm --features xlsx
  WASM="$IRONCALC/target/wasm32-unknown-unknown/release/wasm.wasm"
else
  echo "==> cargo build（debug）"
  cargo build --target wasm32-unknown-unknown -p wasm --features xlsx
  WASM="$IRONCALC/target/wasm32-unknown-unknown/debug/wasm.wasm"
fi

echo "==> wasm-bindgen --target web"
rm -rf "$OUT"
wasm-bindgen --target web --out-dir "$OUT" --out-name ironcalc "$WASM"

echo "==> 完成：$OUT"
ls -lh "$OUT/ironcalc_bg.wasm" | awk '{print "    wasm 体积: " $5}'
