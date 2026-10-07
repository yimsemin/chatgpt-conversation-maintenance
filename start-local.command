#!/bin/zsh
# 대화 정리 앱을 켠다. 이 터미널 창이 앱이다: 창을 닫거나 Ctrl+C 를 누르면 앱이 종료된다.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN=""

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ]; then
  for CANDIDATE in \
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node" \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
  do
    if [ -x "$CANDIDATE" ]; then
      NODE_BIN="$CANDIDATE"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node.js 24 이상을 찾지 못했습니다. Codex 앱 또는 Node.js를 설치한 뒤 다시 실행하세요."
  read -r "?Enter를 누르면 닫힙니다."
  exit 1
fi

cd "$SCRIPT_DIR" || exit 1
"$NODE_BIN" "$SCRIPT_DIR/src/launcher.js"
STATUS=$?
echo
if [ "$STATUS" -eq 0 ]; then
  echo "앱이 종료되었습니다. 이 창을 닫아도 됩니다."
else
  echo "앱을 켜지 못했거나 비정상 종료되었습니다(위 안내 참고)."
fi
read -r "?Enter를 누르면 닫힙니다."
exit "$STATUS"
