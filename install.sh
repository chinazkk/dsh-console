#!/usr/bin/env bash
# dsh-console 外部安装脚本 — 幂等，可重复执行
# 用法: 解压压缩包后 cd dsh-console && ./install.sh
set -euo pipefail

PROFILE_DIR="$HOME/.dsh/profiles/web"
TARGET="$PROFILE_DIR/node_modules/dsh-console"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

green()  { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
red()    { printf '\033[31m%s\033[0m\n' "$1"; }

# ── 前置检查 ────────────────────────────────────────────────
[[ -f "$SRC_DIR/lib/index.js" && -f "$SRC_DIR/lib/client.js" ]] || {
  red "错误: lib/ 构建产物缺失（lib/index.js / lib/client.js）"
  red "完整包应已含预构建产物；若从源码构建请先: pnpm install && pnpm build"
  exit 1
}
[[ -d "$PROFILE_DIR" ]] || {
  red "错误: DSH web profile 不存在: $PROFILE_DIR"
  red "请确认已用 'pnpm dsh --profile web' 初始化过 DSH"
  exit 1
}
command -v python3 >/dev/null || { red "错误: 需要 python3"; exit 1; }

# ── 1. 拷贝插件（排除 node_modules / 源码开发残留） ──────────
green "[1/3] 拷贝插件到 $TARGET ..."
rm -rf "$TARGET"
mkdir -p "$TARGET"
tar -C "$SRC_DIR" \
  --exclude='./node_modules' \
  --exclude='./.DS_Store' \
  -cf - package.json README.md install.sh cordis.patch.yml \
         tsconfig.json tsconfig.client.json tsdown.config.ts \
         pnpm-lock.yaml lib src 2>/dev/null | tar -C "$TARGET" -xf -

# ── 2. 注册 bundle（幂等） ──────────────────────────────────
green "[2/3] 注册 dsh-console 到 profile bundles ..."
python3 - "$PROFILE_DIR/package.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    d = json.load(f)
bundles = d.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
if 'dsh-console' not in bundles:
    bundles.append('dsh-console')
    with open(path, 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    print('    已追加 dsh-console 到 dsh.profile.bundles')
else:
    print('    已存在，跳过（幂等）')
PY

# ── 3. 完成 ─────────────────────────────────────────────────
green "[3/3] 安装完成。"
echo ""
yellow "最后一步: 重启 DSH 生效（注意先保存执行中的任务）"
echo "   • 若有 dsh-manager:  ./.comagic/skills/dsh-manager/run.sh dsh-restart"
echo "   • 否则手动:          kill 掉 DSH 进程后在源码目录重跑 pnpm dsh --profile web"
echo ""
echo "重启后浏览器打开 http://127.0.0.1:3080 任意会话，"
echo "顶部标签栏即出现「控制台」（轨迹与任务面板之间）。"
