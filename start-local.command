#!/bin/zsh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN=""

for CANDIDATE in \
  "/Applications/Codex.app/Contents/Resources/cua_node/bin/node" \
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
do
  if [ -x "$CANDIDATE" ]; then
    NODE_BIN="$CANDIDATE"
    break
  fi
done

if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node.js 24 이상을 찾지 못했습니다. Codex 앱 또는 Node.js를 설치한 뒤 다시 실행하세요."
  read -r "?Enter를 누르면 닫힙니다."
  exit 1
fi

if ! "$NODE_BIN" "$SCRIPT_DIR/launcher.js"; then
  read -r "?실행에 실패했습니다. Enter를 누르면 닫힙니다."
  exit 1
fi
