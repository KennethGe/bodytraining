import path from "node:path";

const root = process.cwd();

export const config = {
  root,
  dataDir: path.join(root, "..", "data"),
  rawDir: path.join(root, "..", "data", "raw"),
  dbFile: path.join(root, "..", "data", "db.sqlite"),
  coachPromptFile: path.join(root, "..", "data", "coach_prompt.md"),
  port: Number(process.env.PORT || 3001),
  authPassword: process.env.AUTH_PASSWORD || "",
  sessionSecret: process.env.SESSION_SECRET || "dev-insecure-secret",
  sessionDays: Number(process.env.SESSION_DAYS || 30),
  syncIntervalMin: Number(process.env.SYNC_INTERVAL_MIN || 15),
  garmin: {
    email: process.env.GARMIN_EMAIL || "",
    password: process.env.GARMIN_PASSWORD || "",
  },
  suunto: {
    email: process.env.SUUNTO_EMAIL || "",
    password: process.env.SUUNTO_PASSWORD || "",
    proxy: process.env.SUUNTO_PROXY || "", // 仅颂拓流量走该代理（绕过区域封锁），如 http://127.0.0.1:7890
    sessionKey: process.env.SUUNTO_SESSION_KEY || "", // 从已登录机器迁移的会话密钥（login2 被封时的免登录通道）
    sessionFile: process.env.SUUNTOOL_SESSION_FILE || "", // suuntool 会话文件路径（默认 ~/.config/suuntool/session.json）
  },
  icu: {
    apiKey: process.env.ICU_API_KEY || "",
  },
  ai: {
    apiKey: process.env.DASHSCOPE_API_KEY || "",
    baseUrl:
      process.env.DASHSCOPE_BASE_URL ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    chatModel: process.env.QWEN_CHAT_MODEL || "qwen-plus",
    vlModel: process.env.QWEN_VL_MODEL || "qwen-vl-plus",
    asrModel: process.env.QWEN_ASR_MODEL || "qwen3-asr-flash",
  },
};

export const authRequired = Boolean(config.authPassword);
