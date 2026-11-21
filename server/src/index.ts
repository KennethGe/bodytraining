import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { config, authRequired } from "./config.js";
import { setupAuth, makeToken, verifyToken } from "./auth.js";
import { db } from "./db.js";
import { ensureCoachPrompt } from "./coach/prompt.js";
import { ensureSources, startScheduler, syncAll, syncSource } from "./sync/engine.js";
import { registerActivityRoutes } from "./routes/activities.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerCoachRoutes } from "./routes/coach.js";
import { registerSettingsRoutes } from "./routes/settings.js";

const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

await app.register(cookie, { secret: config.sessionSecret });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

ensureCoachPrompt();
ensureSources();

// ---------- 认证 ----------
app.get("/api/auth/status", async (req) => ({ authRequired, loggedIn: verifyToken(req.cookies?.bt_session) }));
app.post("/api/auth/login", async (req, reply) => {
  const { password } = req.body as { password?: string };
  if (!authRequired) return { ok: true };
  if (password !== config.authPassword) return reply.code(401).send({ error: "密码错误" });
  reply.setCookie("bt_session", makeToken(), {
    path: "/", httpOnly: true, sameSite: "lax",
    maxAge: config.sessionDays * 86400,
    secure: false,
  });
  return { ok: true };
});
app.post("/api/auth/logout", async (_req, reply) => {
  reply.clearCookie("bt_session", { path: "/" });
  return { ok: true };
});
app.get("/api/health-ping", async () => ({ ok: true }));

setupAuth(app);

// ---------- 业务路由 ----------
registerActivityRoutes(app);
registerHealthRoutes(app);
registerPlanRoutes(app);
registerCoachRoutes(app);
registerSettingsRoutes(app);

// 手动同步
app.post("/api/sync", async () => ({ results: await syncAll() }));
app.post("/api/sync/:sourceId", async (req) => {
  const { sourceId } = req.params as { sourceId: string };
  return syncSource(Number(sourceId));
});

// ---------- 静态文件（生产模式托管前端构建产物） ----------
const webDist = path.join(config.root, "..", "web", "dist");
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
}

const host = authRequired ? "0.0.0.0" : "127.0.0.1";
await app.listen({ port: config.port, host });
console.log(`[bodytraining] http://${host}:${config.port}  (登录${authRequired ? "已启用" : "未启用，仅本机访问"})`);

startScheduler();
console.log(`[bodytraining] 同步调度：每 ${config.syncIntervalMin} 分钟；数据表 ${(db.prepare(`SELECT COUNT(*) c FROM activities`).get() as any).c} 条活动`);
