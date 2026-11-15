# BodyTraining

个人训练数据记录 + AI 教练分析应用。从 Garmin / Suunto 同步活动与健康数据（明细 + 摘要），查重合并、趋势分析、AI 教练对话（千问多模态）、训练计划生成与推送、账号间活动互导。

单用户、轻量：SQLite 单文件库，前端构建产物由后端托管，一条命令跑起来。PC / H5 响应式。

## 快速开始

```bash
npm install
npm run build      # 构建前端
npm start          # 启动，访问 http://127.0.0.1:3001
# 或开发模式（前后端热更新）：npm run dev  → http://localhost:5173
```

首次启动为空库状态：在 `.env` 填入佳明/颂拓账号凭据后重启，即自动启用对应数据源并开始同步（每 15 分钟 + 手动）。

## 配置（.env）

复制 `.env.example` 为 `.env`：

| 变量 | 说明 |
|---|---|
| `AUTH_PASSWORD` | 登录密码。不设置则仅监听 127.0.0.1 且免登录；设置后监听 0.0.0.0 并要求登录 |
| `SESSION_SECRET` | Cookie 签名密钥（设置密码时必填） |
| `SYNC_INTERVAL_MIN` | 同步间隔分钟数，默认 15 |
| `GARMIN_EMAIL` / `GARMIN_PASSWORD` | 佳明**美区**账号。同步通过 Python sidecar（`server/sidecar/.venv` 已内置 garminconnect，无需额外安装） |
| `SUUNTO_EMAIL` / `SUUNTO_PASSWORD` | 颂拓账号。**注意：Sports Tracker 的 login2 密码登录端点已被官方边缘层全局封禁（2026-11 实测）**，新登录不可用 |
| `SUUNTO_SESSION_KEY` / `SUUNTOOL_SESSION_FILE` | 颂拓免登录通道：从已登录机器迁移会话（默认读 `~/.config/suuntool/session.json`）。会话读取接口不受区域封禁影响 |
| `ICU_API_KEY` | 备选接力通道：Intervals.icu 个人 API Key（Suunto 官方合作伙伴同步） |
| `DASHSCOPE_API_KEY` | 阿里云百炼 API Key（AI 教练）。未配置时教练页显示提示，其余功能不受影响 |
| `QWEN_CHAT_MODEL` / `QWEN_VL_MODEL` / `QWEN_ASR_MODEL` | 文本 / 图片 / 语音模型名 |

凭据只放 `.env`，不入库、不进对话。

## 功能

- **同步**：每 15 分钟增量拉取 + 手动同步；活动同步"摘要 + 逐秒明细流（心率/配速/功率/踏频/海拔/GPS）+ FIT 原始文件"；健康同步"日汇总 + 明细样本"。原始文件存 `data/raw/`，支持全量重放。
- **查重合并**：跨源按"类型 + 开始时间 ±2min + 时长/距离差 <2%"指纹合并，主记录按数据源优先级选取，列表只展示一条并标注来源数。
- **活动**：列表（筛选）、详情（Leaflet 轨迹、ECharts 心率/配速/功率/海拔、储备心率五区间分布、合并来源提示）。
- **趋势**：周训练量/时长/负荷、运动类型分布（4 周 / 90 天 / 1 年）。
- **健康**：睡眠/静息心率/HRV/步数/压力/身体电量趋势与今日卡片，异常自动提示；每个指标展示"主数据源"数值（按源优先级，可在设置调整）。
- **AI 教练**：千问（DashScope OpenAI 兼容模式），文字/图片/语音输入；函数工具按需取数（活动明细、健康、负荷、单日多段跑步质量课结构）；长期记忆（教练自动提炼 + 设置页可编辑）+ 会话摘要压缩；教练 Prompt 存 `data/coach_prompt.md`，设置页可直接编辑热生效。
- **训练计划**：AI 生成结构化课程（草稿）→ 计划页逐条编辑确认 → 推送到佳明/颂拓（演示通道可体验）；推送状态跟踪。
- **活动互导**：按运动分类配置规则（源 → 目标），同步后自动传输，防回环（transferred 标记），互导副本与源活动查重合并。
- **数据**：备份下载（SQLite 文件）、全量重放、清空。

## 目录结构

```
server/           Fastify + better-sqlite3 后端
  src/sync/       适配器（garmin/suunto/mock）、查重、互导、调度
  src/coach/      千问客户端、工具、Prompt
  src/routes/     REST API
  sidecar/        garmin_sync.py（非官方 Garmin 通道，需 python3 + garminconnect）
web/              React + Vite + Tailwind + ECharts + Leaflet
data/             （运行时生成，勿提交）db.sqlite、raw/、coach_prompt.md
```

## 部署（Docker 单容器）

```bash
docker build -t bodytraining .
docker run -d --name bodytraining -p 3001:3001 \
  --env-file .env -v bodytraining-data:/app/data bodytraining
```

- 数据（SQLite、FIT 原始文件、coach_prompt.md）在容器内 `/app/data`，用卷持久化
- 佳明 sidecar 的 venv 与 token 也在 `/app/data` 之外的镜像路径内；MFA 场景同本机流程

## 免责声明

Garmin / Suunto 接入均使用非官方通道（个人自用），可能违反其服务条款，接口随官方改版可能失效；失效时同步状态会报错，已入库数据不受影响。请仅用于自己的账号和数据，控制调用频率。

## 已知边界

- 真实佳明同步依赖本机 python3 + `garminconnect`；佳明 token 约 1 小时有效，15 分钟自动同步会滚动续期，只有长时间中断后首次同步才需重新 MFA。
- Suunto 健康明细（睡眠分段/HRV/活动）走 247 时间线接口，服务端仅保留约 2 周历史；建议健康主源用佳明。
- AI 教练需配置 `DASHSCOPE_API_KEY`；如用第三方兼容网关，另配 `DASHSCOPE_BASE_URL` 与 `QWEN_CHAT_MODEL`/`QWEN_VL_MODEL`/`QWEN_ASR_MODEL`（模型名以网关 `/models` 列表为准）。
- 训练计划推送佳明已实测可用（workout-service 创建 + 按日期排程）；颂拓课程推送需 SuuntoPlus Guides 协议，暂不支持。
- 活动互导：颂拓 → 佳明已实测可用（FIT 统一重编码后上传，佳明对第三方 FIT 兼容性差）；佳明 → 颂拓的上传协议已逆向官方 App 破解并按真实格式实现（multipart 三 part：workoutBinary/workoutExtensions/sml，其中 sml 为 GZIP 的 `{"Summary":..,"Data":..}`），但迁移会话被服务端禁写（返回 523 "Workout could not be saved"，读取正常），需官方 OAuth 会话才能真正写入。
- 佳明 FIT 补拉偶尔返回 TCX（XML）而非 FIT，系统会自动识别并解析；泳池游泳等无心率轨的活动没有 hr 流属正常。
- Docker 部署见上节；镜像构建需在有 docker 的机器上验证（开发机无 docker）。
