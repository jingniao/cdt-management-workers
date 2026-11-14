# CDT-Management Workers

部署在 Cloudflare 上的阿里云 CDT 实例管理面板，支持单机保活、联合换班、流量超限停机、DDNS 和通知。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jingniao/cdt-management-workers)

1. 点击上方按钮，按提示连接 GitHub 和 Cloudflare 账号。
2. 填写下面两个密钥，其他配置部署后在面板中填写。
3. 构建命令使用 `npm run build`，部署命令使用 `npm run deploy`。数据库会自动创建并初始化。
4. 部署完成后，打开生成的访问地址。

| 必填项 | 填写内容 |
| --- | --- |
| `SESSION_SECRET` | 独立生成的 64 位随机十六进制字符串，用于登录会话和首次初始化验证 |
| `ENCRYPTION_KEY` | 32 字节随机值的 Base64 编码（44 个字符），用于加密保存凭据 |

电脑安装 Node.js 后，可分别运行以下命令生成：

```bash
# SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**请备份两个密钥，更新时保持原值。ENCRYPTION_KEY 丢失或更换后，已有凭据将无法解密。**

## 首次使用

1. 在自己的面板地址输入 `SESSION_SECRET`，创建管理员用户名和登录密码；之后只用用户名和密码登录。
2. 进入「服务器」，添加阿里云 AccessKey ID、AccessKey Secret、地域、实例 ID，并设置流量配额和停机阈值。
3. 配置保活或换班后，回到概览点击「立即同步」，检查运行状态和最近事件。

## 获取阿里云 AccessKey

推荐使用专用 RAM 用户，避免使用阿里云主账号的密钥。

1. 登录 [RAM 控制台（国内站）](https://ram.console.aliyun.com/users)或[国际站](https://ram.console.alibabacloud.com/users)，进入「身份管理 → 用户」，创建一个专用用户。
2. 给该用户添加所需权限：

   | 权限策略 | 用途 |
   | --- | --- |
   | `AliyunECSFullAccess` | 查询、启动和停止 ECS 实例 |
   | `AliyunCDTReadOnlyAccess` | 查询 CDT 流量 |
   | `AliyunBSSReadOnlyAccess` | 查询账单和余额，不使用费用功能可不添加 |

3. 打开用户详情，在「认证管理 → AccessKey」中创建 AccessKey，按提示完成验证。
4. 保存生成的 **AccessKey ID** 和 **AccessKey Secret**。Secret 仅在创建时显示，请立即妥善保存，不要提交到 GitHub 或发送到聊天中。

密钥应来自实例所属的阿里云账号；国内站与国际站请分别使用对应站点的账号。

## 面板配置

| 功能 | 操作 |
| --- | --- |
| 单机保活 | 在「单机保活」添加服务器，按需设置运行时段和日期 |
| 联合换班 | 在「联合换班」新建组，选择至少两台服务器，设置顺序和排班周期 |
| DDNS | 先在 Cloudflare 创建 A 记录；在「设置 → DDNS」填写 Token 并开启，再到「DNS」添加记录名并绑定服务器或换班组 |
| Telegram | 在「设置 → 通知」填写 Bot Token 和 Chat ID，开启后发送测试 |
| 邮件 | 填写兼容的 HTTPS 邮件转发地址、收件人和可选认证密钥；不支持直接填写 SMTP 主机 |
| Webhook | 填写接收地址，按需设置请求头和请求体，再发送测试 |

Cloudflare Token 需要目标域名的 **DNS 编辑**权限；自动查找 Zone 时还需 **Zone 读取**权限。

同一台服务器不要同时配置单机保活和联合换班。系统每分钟自动巡检一次；发送测试后，记得点击「保存」让设置生效。

## 更新已有部署

同步仓库代码后重新部署，保留原来的 Worker 名称、D1 数据库 ID 和两个密钥。使用完整的最新部署配置，`npm run deploy` 会自动应用数据库迁移。

## 命令行一键部署（可选）

需要 Node.js 22.13+、Git、Bash 和 Python 3。

```bash
git clone https://github.com/jingniao/cdt-management-workers.git
cd cdt-management-workers
npx wrangler login
npm run deploy:all
```

脚本会构建前端、创建数据库并部署，只询问缺失的两个密钥，已有密钥会保留。

---

基于 [BeacherZ/cdt-management](https://github.com/BeacherZ/cdt-management)，界面参考 [wang4386/CDT-Monitor](https://github.com/wang4386/CDT-Monitor)。[MIT 许可](LICENSE) · [致谢](NOTICE.md)
