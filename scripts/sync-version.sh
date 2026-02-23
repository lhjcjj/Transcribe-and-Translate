#!/usr/bin/env bash
# 从项目根目录的 VERSION 文件同步版本号到 frontend/package.json 和 backend/app/main.py
# 用法：在项目根目录执行 ./scripts/sync-version.sh

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_FILE="$ROOT/VERSION"

if [ ! -f "$VERSION_FILE" ]; then
  echo "Error: VERSION file not found at $VERSION_FILE"
  exit 1
fi

VER=$(cat "$VERSION_FILE" | tr -d '[:space:]')
if [ -z "$VER" ]; then
  echo "Error: VERSION is empty"
  exit 1
fi

echo "Syncing version: $VER"

# frontend/package.json
if [ -f "$ROOT/frontend/package.json" ]; then
  if command -v node >/dev/null 2>&1; then
    PKG_JSON="$ROOT/frontend/package.json" VER="$VER" node -e "
    const fs = require('fs');
    const p = process.env.PKG_JSON;
    const v = process.env.VER;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.version = v;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    "
    echo "  -> frontend/package.json"
  fi
fi

# backend/app/main.py (version="x.y.z")
if [ -f "$ROOT/backend/app/main.py" ]; then
  case "$(uname -s)" in
    Darwin) sed -i '' "s/version=\"[^\"]*\"/version=\"$VER\"/" "$ROOT/backend/app/main.py" ;;
    *)      sed -i "s/version=\"[^\"]*\"/version=\"$VER\"/" "$ROOT/backend/app/main.py" ;;
  esac
  echo "  -> backend/app/main.py"
fi

echo "Done."
