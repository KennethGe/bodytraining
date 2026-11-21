import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authRequired, config } from "./config.js";

const COOKIE = "bt_session";

function sign(payload: string): string {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

export function makeToken(): string {
  const exp = Date.now() + config.sessionDays * 86400000;
  const payload = String(exp);
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!authRequired) return true;
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (sign(exp) !== sig) return false;
  return Number(exp) > Date.now();
}

export function setupAuth(app: FastifyInstance) {
  app.addHook("preHandler", async (req: FastifyRequest, reply) => {
    if (!authRequired) return;
    const path = req.url.split("?")[0];
    const open =
      path === "/login" ||
      path === "/api/auth/login" ||
      path === "/api/auth/status" ||
      path === "/api/strava/callback" ||
      path === "/api/health-ping" ||
      path.startsWith("/assets/");
    if (open) return;
    if (path.startsWith("/api/") && !verifyToken(req.cookies?.[COOKIE])) {
      return reply.code(401).send({ error: "未登录" });
    }
    if (!path.startsWith("/api/") && !verifyToken(req.cookies?.[COOKIE])) {
      return reply.redirect("/login");
    }
  });
}
