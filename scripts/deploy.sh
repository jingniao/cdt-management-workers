#!/usr/bin/env bash
# 一键部署 cdt-management-workers 到 Cloudflare。
#
# 用法：
#   ./scripts/deploy.sh            # 全程交互式：一路回车/填空即可
#   ./scripts/deploy.sh --dry-run  # 只检查 + 演练，不建 D1、不设密钥、不部署
#
# 脚本会依次做：
#   1. 检查 node / npm / wrangler 登录
#   2. npm install + 构建前端 (npm run build:web)
#   3. 创建 D1 数据库（若 wrangler.toml 里的 database_id 还是占位符），
#      并把真实 database_id 写回 wrangler.toml
#   4. 应用 D1 迁移（本地 + 远端）
#   5. 仅补充缺失的 SESSION_SECRET / ENCRYPTION_KEY，保留已有密钥
#   6. npx wrangler deploy
#
# 注意：密钥只会通过 `wrangler secret put` 进 Cloudflare，不会写进任何文件。
# 部署前请先在不重要的实例上测试；本项目尚未用真实阿里云账号验证过。

set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  echo "== dry-run 模式：只检查 + 演练，不建库、不设密钥、不部署 =="
fi

step() { echo; echo "== $1 =="; }

# ---------- 1. 检查 ----------
step "检查环境"
command -v node >/dev/null || { echo "找不到 node，请先安装 Node.js 18+"; exit 1; }
command -v npm >/dev/null || { echo "找不到 npm"; exit 1; }
echo "node: $(node --version)  npm: $(npm --version)"

if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! npx wrangler whoami >/dev/null 2>&1; then
    echo "还未登录 Cloudflare，请先跑一次："
    echo "  npx wrangler login"
    echo "登录完成后再跑 ./scripts/deploy.sh"
    exit 1
  fi
  echo "Cloudflare 已登录"
fi

# ---------- 2. 安装 + 构建 ----------
step "安装依赖并构建前端"
npm install
npm run build:web
npx tsc --noEmit
echo "类型检查通过，前端已构建到 web/dist"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "dry-run 完成：上面这些步骤都通过了。正式部署请跑："
  echo "  ./scripts/deploy.sh"
  exit 0
fi

# ---------- 3. D1 ----------
step "D1 数据库"
DB_ID=$(grep -oE 'database_id = "[^"]+"' wrangler.toml | cut -d'"' -f2 || true)
if [[ "$DB_ID" == "00000000-0000-0000-0000-000000000000" || -z "$DB_ID" ]]; then
  echo "正在创建 D1 数据库 cdt-management …"
  CREATE_OUT=$(npx wrangler d1 create cdt-management)
  echo "$CREATE_OUT"
  NEW_ID=$(echo "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n 1)
  if [[ -z "$NEW_ID" ]]; then
    echo "没能从 wrangler 输出里拿到 database_id，请手动创建并填进 wrangler.toml"
    exit 1
  fi
  # 把占位符换成真实 ID（只替换 database_id 这一行）
  python3 - "$NEW_ID" <<'PY'
import re, sys
new_id = sys.argv[1]
p = "wrangler.toml"
s = open(p).read()
s, n = re.subn(r'database_id = "[^"]+"', f'database_id = "{new_id}"', s, count=1)
assert n == 1, "wrangler.toml 里没找到 database_id"
open(p, "w").write(s)
print(f"database_id 已写入 wrangler.toml: {new_id}")
PY
else
  echo "D1 已配置，database_id: $DB_ID"
fi

# ---------- 4. 迁移 ----------
step "应用 D1 迁移"
npx wrangler d1 migrations apply DB --local
npx wrangler d1 migrations apply DB --remote

# ---------- 5. Secrets ----------
step "检查部署密钥（已有密钥保留，其余配置在面板填写）"
bash scripts/setup-secrets.sh

# ---------- 6. 部署 ----------
step "部署到 Cloudflare Workers"
npx wrangler deploy

echo
echo "部署完成。打开上面输出的 workers.dev 地址，用 SESSION_SECRET 验证首次初始化，"
echo "创建管理员账号后，在面板设置 DDNS、Telegram、邮件，并添加阿里云实例。"
