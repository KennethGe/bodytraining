import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { aiConfigured, coachChat, transcribeAudio } from "../coach/client.js";
import { getCoachPrompt, setCoachPrompt } from "../coach/prompt.js";
import { memoryList, memoryWrite, memoryDelete } from "../coach/data.js";

export function registerCoachRoutes(app: FastifyInstance) {
  app.get("/api/coach/status", async () => ({ configured: aiConfigured() }));

  app.get("/api/coach/sessions", async () =>
    db.prepare(`SELECT id, title, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC LIMIT 50`).all()
  );

  app.post("/api/coach/sessions", async () => {
    const info = db.prepare(`INSERT INTO chat_sessions (title) VALUES (NULL)`).run();
    return { id: info.lastInsertRowid };
  });

  app.get("/api/coach/sessions/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    return db.prepare(
      `SELECT id, role, content, attachments, created_at FROM chat_messages WHERE session_id = ? AND role != 'tool' ORDER BY id`
    ).all(Number(id));
  });

  app.delete("/api/coach/sessions/:id", async (req) => {
    const { id } = req.params as { id: string };
    db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(Number(id));
    return { ok: true };
  });

  // 对话（text / imageDataUrl）
  app.post("/api/coach/chat", async (req, reply) => {
    if (!aiConfigured()) {
      return reply.code(503).send({ error: "AI_NOT_CONFIGURED", message: "未配置 DASHSCOPE_API_KEY，请在 .env 中设置后重启服务" });
    }
    const { sessionId, text, imageDataUrl } = req.body as any;
    let sid = sessionId;
    if (!sid) {
      sid = (db.prepare(`INSERT INTO chat_sessions (title) VALUES (?)`).run((text || "对话").slice(0, 30)).lastInsertRowid) as number;
    }
    try {
      const res = await coachChat({ sessionId: sid, text, imageDataUrl });
      return { sessionId: sid, ...res };
    } catch (e: any) {
      if (e.message === "AI_NOT_CONFIGURED") {
        return reply.code(503).send({ error: "AI_NOT_CONFIGURED", message: "未配置 DASHSCOPE_API_KEY" });
      }
      return reply.code(502).send({ error: e.message });
    }
  });

  // 语音转写（audioBase64: webm/opus）
  app.post("/api/coach/transcribe", async (req, reply) => {
    if (!aiConfigured()) return reply.code(503).send({ error: "AI_NOT_CONFIGURED" });
    const { audioBase64, format } = req.body as any;
    try {
      return { text: await transcribeAudio(audioBase64, format || "webm") };
    } catch (e: any) {
      return reply.code(502).send({ error: e.message });
    }
  });

  // 手动生成上周周报
  app.post("/api/coach/weekly/run", async (req) => {
    const { force } = (req.body || {}) as { force?: boolean };
    const { generateWeeklyReport } = await import("../coach/weekly.js");
    return generateWeeklyReport(Boolean(force));
  });

  // 教练 Prompt 读写
  app.get("/api/coach/prompt", async () => ({ prompt: getCoachPrompt() }));
  app.put("/api/coach/prompt", async (req) => {
    const { prompt } = req.body as any;
    setCoachPrompt(String(prompt ?? ""));
    return { ok: true };
  });

  // 长期记忆管理
  app.get("/api/coach/memory", async () => memoryList());
  app.put("/api/coach/memory", async (req) => {
    const { key, content } = req.body as any;
    memoryWrite(String(key), String(content));
    return { ok: true };
  });
  app.delete("/api/coach/memory/:key", async (req) => {
    const { key } = req.params as { key: string };
    memoryDelete(key);
    return { ok: true };
  });
}
