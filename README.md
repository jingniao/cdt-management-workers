# CDT-Management Workers

**Cloudflare Workers + D1 版 CDT 管理面板：阿里云 CDT 抢占式实例的单机保活 + 多机联合换班 + DDNS + 通知。**

这是 [BeacherZ/cdt-management](https://github.com/BeacherZ/cdt-management)（Python + FastAPI + SQLite + Docker）的 TypeScript 移植版，跑在 Cloudflare Workers 上：后端是 Hono + D1，前端基于原项目的 React + Vite，部署凭据与邮件配置流程已适配 Workers，定时巡检由 Workers Cron Triggers 驱动。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jingniao/cdt-management-workers)

> **部署时只填两个密钥：SESSION_SECRET、ENCRYPTION_KEY。** 管理员账号、阿里云实例、DDNS、Telegram、邮件和通用 Webhook 均在面板中配置。Cloudflare 根据 `.dev.vars.example` 显示这两个输入项；请使用本仓库的部署按钮。

> 首次打开面板，先输入部署时保存的 SESSION_SECRET 验证部署者身份，再创建管理员用户名和登录密码。初始化完成后，仅用用户名和密码登录。

> 已修复审计列出的 9 项问题，并补充跨执行环境登录限流、认证查询失败拒绝访问及开发依赖升级。回归测试与本地 Cloudflare 运行验证不能替代真实云账号的端到端验收，首次仍请使用测试实例。

## 架构

```
                          ┌─────────────────────────────┐
                          │        Cloudflare           │
                          │                             │
  浏览器 ──HTTPS──▶ Worker (Hono, src/index.ts)          │
                          │  ├─ /api/* → src/api.ts     │
                          │  ├─ 静态资源 → [assets]      │
                          │  │   web/dist (React+Vite)  │
                          │  └─ scheduled() 每分钟      │
                          │      └─ src/scheduler.ts    │
                          │          ├─ shift.reconcileAll()
                          │          ├─ 每日报告          │
                          │          ├─ dns.reconcile()  │
                          │          └─ 每小时 pruneEvents│
                          │                             │
                          │  D1 (cdt-management)        │
                          │  settings / servers /       │
                          │  keepalives / shift_groups… │
                          └──────┬───────────┬──────────┘
                                 │           │
                    阿里云 ECS/CDT/BSS   Cloudflare API
                    (RPC 签名, HMAC-SHA1)  (DDNS, Bearer Token)
                                 │
                          Telegram Bot API / Webhook
                          (通知；邮件见下)
```

### 模块对照（Python → TypeScript）

| 原项目 `app/*.py` | Workers `src/*.ts` | 说明 |
| --- | --- | --- |
| `api.py` | `api.ts` + `index.ts` | Hono 路由，`/api/*` 与原接口同形；`index.ts` 另管静态资源与 `scheduled()` |
| `scheduler.py` | `scheduler.ts` | 每轮 `runReconcile()`：换班引擎 → 每日报告 → DNS 对账 → 每小时清旧事件 |
| `shift.py` | `shift.ts` | 换班引擎（单机保活 / 联合换班 / 故障转移 / 熔断） |
| `aliyun.py` + `billing.py` | `aliyun.ts` + `billing.ts` | 阿里云 RPC 签名（HMAC-SHA1）手写实现；费用/余额 |
| `ddns.py` | `ddns.ts` | Cloudflare DDNS（查 Zone → 找 Record ID → PUT A 记录，重试 3 次） |
| `dns.py` | `dns.ts` | 绑定关系：谁该指向哪个 IP、什么时候需要更新、巡检对账 |
| `notify.py` | `notify.ts` | Telegram / 邮件（Webhook 转发）/ Webhook |
| `messages.py` | `messages.ts` | 通知文案（与原脚本逐字对齐，中文原文不动） |
| `db.py` + `repo.py` | `db.ts` + `repo.ts` + `migrations/0001_schema.sql` | D1，表名/列名与原 SQLite 一致 |
| `security.py` | `security.ts` | PBKDF2 密码、AES-GCM 字段加密、HMAC 会话 |
| `settings.py` | `settings.ts` | 常量与默认值 |
| `web/` | `web/` | React + Vite 前端；首次初始化与邮件设置已适配 Workers |

## 移植 vs 简化 / 降级

Workers 没有常驻进程、没有线程、没有 TCP 套接字，以下是**有意**的降级，代码里以 `// SIMPLIFIED:` 标记：

| 原行为 | Workers 版 | 原因 |
| --- | --- | --- |
| 5 秒事件确认线程（`_confirm_loop`）：手动启停后约 5 秒确认到位并补发通知 | 确认发生在下一轮巡检（下一分钟 cron tick），见 `scheduler.ts` | Workers 无后台线程；Cron 最小间隔 1 分钟 |
| 10 秒快速对账窗口（建组后 90 秒内每 10 秒一轮） | 无。Cron 固定每分钟；建组时 API 仍会同步引导一轮；想立即跑可调 `POST /api/v1/reconcile` | 同上 |
| 巡检间隔可自定义（默认 60 秒，最小 30 秒） | Cron 固定 `*/1 * * * *`（1 分钟）；`CDT_RECONCILE_INTERVAL` 仅作下限参考 | Cron Triggers 最小 1 分钟 |
| 邮件：SMTP 直发（SSL/TLS，`notify_mail_host` 等） | **不走 SMTP**：见下文「邮件通知」 | Workers 没有 SMTP 能力；不做「假装发出」的实现 |
| Telegram 代理（`notify_tg_proxy`） | 忽略该配置 | Workers `fetch` 不支持 HTTP 代理 |
| 登录限流：进程内内存计数 | D1 原子计数，5 分钟内最多 8 次尝试，成功后清除 | 多个执行环境共享计数，校验前预占次数，防止并发绕过 |
| DDNS 解析强制 IPv4（改 urllib3 的 gai family） | 无此钩子，由 Cloudflare 运行时解析 | Workers 无底层 DNS 控制 |
| AccessKey Secret 加密：Python Fernet | **格式不兼容**：AES-256-GCM，`aesgcm:v1:<base64(iv+ciphertext)>`（WebCrypto） | Workers 无 Fernet；**旧 Docker 的数据库不能直接迁移**，见下文 |

### 邮件通知

在「设置 → 通知 → 邮件通知」填写：

- 邮件转发地址：HTTPS URL，接收 `{to, subject, title, text, html, kind}` JSON 并负责发送邮件。
- 认证密钥：可选，以 `Authorization: Bearer <key>` 发给转发服务；在数据库中加密保存，不通过设置接口回显。
- 收件人：通知接收邮箱。开启通知前可以先点击「发送测试」，测试使用当前草稿，不会自动保存。

此版本不直接连接 SMTP。不能把 SMTP 主机或任意邮件厂商 API 地址直接当作兼容转发接口。
升级前配置的 EMAIL_WEBHOOK_URL / EMAIL_API_KEY 仍可作为回退；面板已保存的非空值优先。

### 加密格式断裂（旧库不能直接迁移）

原 Docker 版用 Fernet 加密 `access_key_secret`，Workers 版用 WebCrypto AES-256-GCM（`ENCRYPTION_KEY`，base64 编码的 32 字节密钥，存储格式 `aesgcm:v1:<base64(iv+ciphertext)>`）。两种格式互不兼容：

- **旧 `cdt-management.db` 不能直接导入 D1**：`servers.access_key_secret` 解不出来。
- 迁移办法：部署后在面板里重新填写每台服务器的 AccessKey Secret（或重新添加服务器）。`master.key` 与新 `ENCRYPTION_KEY` 也**不是**同一个东西，不要混用。
- 登录密码格式未变：`pbkdf2_sha256$<rounds>$<b64salt>$<b64hash>`（PBKDF2-SHA256，100000 轮——Workers 的 WebCrypto 最多只支持 100000 轮，Python 原版的 260000 轮在这里会报错），密码哈希本身可以沿用。

## 部署

### 准备两个独立密钥

在自己的电脑运行下面两条命令，将结果保存到密码管理器。不要提交真实值到 Git。

```bash
# SESSION_SECRET：64 位随机十六进制字符串
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# ENCRYPTION_KEY：32 字节随机数的 Base64 编码，通常 44 字符
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

SESSION_SECRET 用于会话签名及首次初始化验证。ENCRYPTION_KEY 用于数据加密，必须与数据库一起备份；丢失后无法解密已有凭据。**更新部署时保留两个密钥，尤其不要替换 ENCRYPTION_KEY。**

### 使用部署按钮

点击本页 Deploy to Cloudflare 按钮，填写两个密钥后部署。D1 由部署流程创建和绑定，仓库保留占位数据库 ID。构建命令使用 `npm run build`，部署命令使用 `npm run deploy`；部署脚本会先对绑定名 `DB` 应用迁移，再部署 Worker。

完成后打开自己的面板地址：

1. 输入 SESSION_SECRET 验证首次初始化，创建管理员账号和登录密码。
2. 在「服务器」添加阿里云 AccessKey ID/Secret、地域和实例。
3. 在「设置」按需填写 DDNS、Telegram、邮件和 Webhook，未使用的渠道保持关闭。

不要把 SESSION_SECRET 输入第三方网站；它不是日常登录密码。

### 命令行部署

需要 Node.js 22.13+、npm、Bash 和 Python 3，先执行 `npx wrangler login`。

```bash
npm run deploy:all
# 只检查构建，不部署：
bash scripts/deploy.sh --dry-run
```

脚本安装依赖、构建前端、检查类型、创建 D1、应用迁移，并且只询问缺失的两个密钥。已存在的密钥会保留；不能读取现有密钥列表时会停止，避免误覆盖。首次部署需粘贴已备份的密钥，不会悄悄生成无法找回的随机值。

### 手动部署

```bash
npm ci
npx wrangler d1 create cdt-management
# 将上一步得到的 database_id 填入 wrangler.toml
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ENCRYPTION_KEY
npm run build
npm run deploy
```

更新已有部署时，省略创建数据库和设置密钥的步骤。`npm run deploy` 会应用新增迁移，保留已有设置。旧环境中的 Cloudflare/Telegram/邮件变量仍可回退使用；在面板填写新值后，面板非空值优先。

### 本地开发与测试

复制 `.dev.vars.example` 到 `.dev.vars` 并填两个本地测试密钥。若需要模拟云接口，额外在自己的 `.dev.vars` 中加入 `CDT_DRY_RUN="1"`（不要把模拟开关加入示例密钥清单）。

```bash
npx wrangler d1 migrations apply DB --local
npm run build
npx wrangler dev
# 后端类型检查
npm run check
# 回归测试需要 Node.js 22.13+ 及 Bash，Windows 可使用 Git Bash
npm test
```

30 项回归测试覆盖初始化、并发换班、云 API 请求/响应契约、dry-run、DDNS zone 发现、共享登录限流、认证存储故障、加密保存邮件凭据、草稿测试、配置优先级和重复部署保留密钥。

## 审计修复与升级

所有 API 请求和定时巡检现在进入同一个 `ControlPlane` Durable Object。写操作完整串行执行，包含读取实例状态到发送云端指令之间的所有等待；读取接口仍可响应。正在处理操作时，新 Cron tick 跳过，由下一分钟继续；不会堆积旧巡检。

升级需要保留并应用 `wrangler.toml` 中的 `CONTROL_PLANE` binding 和 `v1-control-plane` migration，同时保留自己的 Worker 名称、D1 ID 和原密钥。不要只拷贝 TypeScript 文件而遗漏部署配置。控制入口未绑定时，API 返回 503，避免退回不安全的直接执行路径。

`npm run deploy` 先应用 D1 迁移，其中 `0003_auth_rate_limits.sql` 创建共享限流表。未应用迁移或认证数据库暂时不可用时，登录和相关认证检查会拒绝请求，不会跳过保护。

- ECS 普通停机将内部 `Stop` 映射到 `KeepCharging`；批量启停检查目标实例的 Code，缺失或失败不再当作成功。权限、网络和未知错误不会触发计费停机降级。
- `CDT_DRY_RUN=1` 时通用 Webhook 也不发请求；Telegram、邮件和 DNS 保持模拟行为。
- DDNS 从记录名开始逐级匹配实际可访问的 zone，支持 `example.co.uk` 和独立托管子域。仍可手动指定 Zone ID。
- 登录计数保存在 D1；会话撤销和 session_epoch 查询失败时返回 503。
- 开发工具链升级至 Wrangler 4.162.0；本次依赖扫描为 0 个已知问题。

本地运行验证使用 Wrangler 的 Local Explorer 定时调用入口，并检查 D1 的 `scheduler_last_prune` 标记确认任务执行；直接访问 SPA 下的 `/__scheduled` 返回 200 不能独立证明任务已运行。

## Cron（定时巡检）

`wrangler.toml` 已配：

```toml
[triggers]
crons = ["*/1 * * * *"]
```

每分钟一轮：换班引擎 → 每日报告（到点才发）→ DNS 对账 → 每小时清 14 天前的旧事件。Cron 最小间隔就是 1 分钟，**不要**指望改成 10 秒；想立即触发一轮，调 `POST /api/v1/reconcile`（需登录 + CSRF）。

## 配一遍的流程

1. **服务器** → 添加服务器：填别名、Region、AccessKey ID/Secret、实例 ID、配额与限流阈值，按需选停机模式（默认节省停机）。
2. 二选一（或都要，但**同一台不要同时挂两边**）：
   - **单机保活** → 添加保活，勾上这台；要限定运行时段/日期就在同一个设置页里填
   - **联合换班** → 新建换班组，选排班周期（一天一轮按工时，一月一轮按天数），按顺序添加成员
3. **设置 → DDNS**：填 Cloudflare Token（或 Global API Key）、TTL，开启
4. **DNS**：加域名记录，再把它绑到某台实例或某个换班组（不绑就谁也不会去动它）
5. **设置 → 通知**：填 Telegram Bot Token + Chat ID，点「发送测试」确认能收到；邮件填写转发地址、收件人和可选认证密钥（见上文）
6. 回概览点「立即同步」，看第一轮结果

## 添加阿里云账号（RAM 权限）

完整功能需要给当前用户添加以下三种 RAM 权限（RAM 访问控制 → 身份管理 → 用户 → 权限管理）：

| RAM 权限 | 用在哪 |
| --- | --- |
| `AliyunECSFullAccess` | 查实例、开机、停机（含节省停机） |
| `AliyunCDTReadOnlyAccess` | 读当月 CDT 公网流量 |
| `AliyunBSSReadOnlyAccess` | 账户余额、实例账单 |

- 少了 CDT 这组，整轮对账都会失败，不是流量空着 —— 必须给
- 少了 BSS 这组，费用和余额显示不出来，启停照常
- 国内站和国际站的 AK 不通用，一台实例一套凭据
- RAM 控制台：[国内站](https://ram.console.aliyun.com/users) · [国际站](https://ram.console.alibabacloud.com/users)

AccessKey Secret 只存在 D1 里（AES-GCM 加密），绝不会出现在前端或日志里；面板的 API 响应里只会看到打码后的值。

## 数据放在哪

| 位置 | 内容 |
| --- | --- |
| D1 `cdt-management` | 实例、换班组、换班进度、事件、流量采样（表名/列名与原 SQLite 一致） |
| `ENCRYPTION_KEY`（Secret） | 加密主密钥，**必须与库一起备份**，丢了 AccessKey Secret 无法解密 |

## 常见问题

**换班了但没收到通知？** 先看「设置 → 通知」里渠道是否启用、点测试能不能发出去；再看概览的「最近事件」有没有对应记录。通知失败只记事件，不会阻塞换班。邮件未在面板填写转发地址，也没有旧环境回退值时，会提示 `email_not_configured`。

**DDNS 显示「IP 无效跳过」？** 实例还没拿到公网 IP，或者不是公网 IPv4。等下一轮同步，或手动刷新那台实例。

**所有成员都超限了怎么办？** 会全局熔断，全部节省停机，等下个月流量重置后手动开机，或调整阈值。

**忘了面板密码？** 不要删除数据库或更换 ENCRYPTION_KEY。可由 Cloudflare 账号管理员通过 D1 管理工具重置管理员密码哈希并递增 session_epoch；当前版本没有自动找回邮件流程，操作前请备份数据库。ADMIN_PASSWORD 不参与本版本登录。

**事件确认变慢了？** 正常。Workers 版没有 5 秒确认线程，手动启停的「到位确认」要等下一分钟 cron tick。

## 已知问题与未验证项

- 类型检查与部署演练已通过（见上文版本说明），但**没有用真实阿里云账号验证过**：Aliyun RPC 签名只做了本地交叉验证（与 Node HMAC-SHA1 对照一致），ECS/CDT/BSS 的实际调用、换班全流程、DDNS 同步都需要在测试实例上跑一遍。
- 前端构建已验证通过（`cd web && npm install && npm run build`，exit 0）。注意 `web/vite.config.ts` 的 `outDir` 已由原项目的 `../app/static` 改为 `dist`，否则 `wrangler [assets]` 找不到产物。
- `wrangler.toml` 里的 `database_id` 是占位符；部署按钮自动创建并绑定 D1，命令行手动部署需先创建数据库并填入真实 ID。更新已有部署时保留原 Worker 名称和数据库 ID。

## 致谢与许可

MIT 许可，见 `LICENSE` 与 `NOTICE.md`。

- 原项目：[**BeacherZ/cdt-management**](https://github.com/BeacherZ/cdt-management)（MIT）—— 后端逻辑、换班引擎、DDNS 与通知实现均移植自该项目；本移植版与原作者无关。
- 界面设计与安装体验参考了 [**wang4386/CDT-Monitor**](https://github.com/wang4386/CDT-Monitor)（作者青柠，MIT），详见 `NOTICE.md`。
