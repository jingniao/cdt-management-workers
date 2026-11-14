#!/usr/bin/env bash
# Preserve existing secrets. Only first-time/missing keys are prompted for.
set -euo pipefail

if existing=$(npx wrangler secret list --format json 2>&1); then
  # Reject unexpected output rather than replacing keys on a parse failure.
  names=$(printf '%s' "$existing" | node -e '
    let text=""; process.stdin.on("data", c => text+=c); process.stdin.on("end", () => {
      const rows=JSON.parse(text); if (!Array.isArray(rows)) process.exit(1);
      console.log(rows.map(row => row.name).join("\n"));
    });')
elif [[ "$existing" == *"[code: 10007]"* ]]; then
  names="" # Worker does not exist yet; secret put will create it.
else
  printf '%s\n' "$existing" >&2
  echo "无法读取已有密钥，已停止；不会覆盖任何密钥。" >&2
  exit 1
fi

for name in SESSION_SECRET ENCRYPTION_KEY; do
  if printf '%s\n' "$names" | grep -Fxq "$name"; then
    echo "$name 已存在，保留原值。"
    continue
  fi
  echo "请先在密码管理器中生成并保存 $name。"
  if [[ "$name" == "SESSION_SECRET" ]]; then
    echo "建议 64 位随机十六进制字符串；首次初始化面板需要验证此密钥。"
  else
    echo "必须是 32 字节随机数的 Base64 编码（通常 44 字符）。"
  fi
  value=""
  read -r -s -p "$name: " value || true
  echo
  if ! KEY_NAME="$name" KEY_VALUE="$value" node -e '
    const value=process.env.KEY_VALUE || "";
    const ok=process.env.KEY_NAME === "SESSION_SECRET"
      ? value.length >= 32
      : Buffer.from(value,"base64").length === 32 && Buffer.from(value,"base64").toString("base64") === value;
    process.exit(ok ? 0 : 1);
  '; then
    echo "$name 为空或格式不正确，已停止。" >&2
    exit 1
  fi
  printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null
  unset value
  echo "$name 已设置。"
done
echo "管理员账号、DDNS、Telegram 和邮件通知请在面板中配置。"
