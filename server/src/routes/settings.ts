import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { db, kvSet } from "../db.js";
import { config } from "../config.js";
import { getAdapter, syncAll, recomputeHealthPrimary } from "../sync/engine.js";
import { recomputeMerges } from "../sync/dedupe.js";
import { parseFitStreams } from "../sync/fit-parse.js";
import { stravaAuthUrl, stravaExchangeCode, stravaStatus, stravaDisconnect } from "../sync/strava.js";

export function registerSettingsRoutes(app: FastifyInstance) {
  // ---------- 数据源 ----------
  app.get("/api/sources", async () => {
    const rows = db.prepare(`SELECT * FROM sources ORDER BY priority`).all() as any[];
    // 仅展示活跃同步源（strava）；已停用的 garmin/suunto/icu 行保留供历史活动 JOIN，但不再出现在同步管理里
    return rows.filter((s) => s.type === "strava" || s.enabled).map((s) => {
      const a = getAdapter(s.type);
      const avail = a?.available() ?? { ok: false, reason: "未知数据源" };
      return { ...s, available: avail.ok, unavailable_reason: avail.reason ?? null };
    });
  });

  app.put("/api/sources/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { enabled, priority } = req.body as any;
    db.prepare(`UPDATE sources SET enabled = COALESCE(?, enabled), priority = COALESCE(?, priority) WHERE id = ?`)
      .run(enabled != null ? (enabled ? 1 : 0) : null, priority ?? null, Number(id));
    recomputeMerges();
    recomputeHealthPrimary();
    return { ok: true };
  });

  // ---------- Strava OAuth 连接（秘密只进本服务，不进对话） ----------
  const stravaRedirect = () => `http://localhost:${config.port}/api/strava/callback`;
  app.get("/api/strava/status", async () => stravaStatus());
  app.get("/api/strava/auth-url", async () => {
    if (!config.strava.clientId || !config.strava.clientSecret)
      return { ok: false, message: "先在 .env 配置 STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET" };
    return { ok: true, url: stravaAuthUrl(stravaRedirect()) };
  });
  app.get("/api/strava/callback", async (req, reply) => {
    const { code, error } = req.query as { code?: string; error?: string };
    if (error || !code) {
      console.log("[strava] callback denied:", error || "no code");
      return reply.redirect("/?strava=denied");
    }
    try {
      const t = await stravaExchangeCode(String(code), stravaRedirect());
      console.log("[strava] connected, athlete:", t.athlete || "?");
    } catch (e: any) {
      console.log("[strava] exchange failed:", e?.message);
      return reply.redirect("/?strava=error");
    }
    return reply.redirect("/?strava=connected");
  });
  app.post("/api/strava/disconnect", async () => {
    stravaDisconnect();
    return { ok: true };
  });

  // Garmin MFA 验证码提交（一次性，存入 kv 供 sidecar 登录时消费）
  app.post("/api/garmin/mfa", async (req) => {
    const { code } = req.body as { code?: string };
    if (!code || !/^\d{4,8}$/.test(code.trim())) return { ok: false, error: "验证码格式不对" };
    kvSet("garmin_mfa_code", code.trim());
    return { ok: true };
  });

  // ---------- 互导规则 ----------
  app.get("/api/transfer-rules", async () =>
    db.prepare(`SELECT * FROM transfer_rules`).all()
  );
  app.post("/api/transfer-rules", async (req) => {
    const { sourceType, targetType, sports, enabled } = req.body as any;
    const info = db.prepare(
      `INSERT INTO transfer_rules (source_type, target_type, sports, enabled) VALUES (?, ?, ?, ?)`
    ).run(sourceType, targetType, JSON.stringify(sports || []), enabled ? 1 : 0);
    return { id: info.lastInsertRowid };
  });
  app.put("/api/transfer-rules/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { sourceType, targetType, sports, enabled } = req.body as any;
    db.prepare(
      `UPDATE transfer_rules SET source_type = COALESCE(?, source_type), target_type = COALESCE(?, target_type),
       sports = COALESCE(?, sports), enabled = COALESCE(?, enabled) WHERE id = ?`
    ).run(sourceType ?? null, targetType ?? null, sports ? JSON.stringify(sports) : null,
      enabled != null ? (enabled ? 1 : 0) : null, Number(id));
    return { ok: true };
  });
  app.delete("/api/transfer-rules/:id", async (req) => {
    const { id } = req.params as { id: string };
    db.prepare(`DELETE FROM transfer_rules WHERE id = ?`).run(Number(id));
    return { ok: true };
  });
  app.get("/api/transfer-log", async () =>
    db.prepare(
      `SELECT t.*, a.name AS activity_name FROM transfer_log t JOIN activities a ON a.id = t.activity_id ORDER BY t.id DESC LIMIT 100`
    ).all()
  );
  // 批量补跑（对历史活动重新执行规则）
  app.post("/api/transfer-rules/run", async () => {
    const { runTransfers } = await import("../sync/transfer.js");
    const res = await runTransfers();
    recomputeMerges();
    return res;
  });

  // ---------- 个人档案 ----------
  app.get("/api/profile", async () => db.prepare(`SELECT * FROM coach_profile WHERE id = 1`).get());
  app.put("/api/profile", async (req) => {
    const { height_cm, weight_kg, age, max_hr, resting_hr, goal } = req.body as any;
    db.prepare(
      `UPDATE coach_profile SET height_cm = ?, weight_kg = ?, age = ?, max_hr = ?, resting_hr = ?, goal = ? WHERE id = 1`
    ).run(height_cm ?? null, weight_kg ?? null, age ?? null, max_hr ?? null, resting_hr ?? null, goal ?? null);
    return { ok: true };
  });

  // ---------- 数据 ----------
  app.get("/api/data/backup", async (_req, reply) => {
    // 备份 = SQLite 文件（WAL checkpoint 后直接下发）
    db.pragma("wal_checkpoint(TRUNCATE)");
    const buf = fs.readFileSync(config.dbFile);
    reply.header("Content-Disposition", `attachment; filename="bodytraining-backup.sqlite"`);
    reply.header("Content-Type", "application/octet-stream");
    return reply.send(buf);
  });

  app.post("/api/data/backfill-fit", async (req) => {
    const { sourceType } = req.body as { sourceType?: string };
    const src = db.prepare(`SELECT * FROM sources WHERE type = ?`).get(sourceType || "garmin") as any;
    if (!src) return { ok: false, error: "源不存在" };
    const adapter = getAdapter(src.type);
    if (!adapter?.getRawFit) return { ok: false, error: "该源不支持 FIT 下载" };
    const rows = db.prepare(
      `SELECT id, external_id, raw_path FROM activities WHERE source_id = ? AND (raw_path IS NULL OR id NOT IN (SELECT activity_id FROM activity_streams WHERE kind = 'hr'))`
    ).all(src.id) as any[];
    let done = 0, failed = 0;
    const errors: string[] = [];
    for (let i = 0; i < rows.length; i += 8) {
      await Promise.all(rows.slice(i, i + 8).map(async (r) => {
        try {
          let buf: Buffer | null = r.raw_path && fs.existsSync(path.join(config.dataDir, r.raw_path))
            ? fs.readFileSync(path.join(config.dataDir, r.raw_path))
            : null;
          if (!buf && adapter.getRawFit) {
            buf = await adapter.getRawFit(r.external_id);
            if (buf && buf.length) {
              const ext = buf.subarray(0, 64).toString("latin1").includes("<?xml") ? "tcx" : "fit";
              const rel = path.join("raw", `${src.type}_${r.external_id}.${ext}`);
              fs.writeFileSync(path.join(config.dataDir, rel), buf);
              db.prepare(`UPDATE activities SET raw_path = ? WHERE id = ?`).run(rel, r.id);
            }
          }
          if (buf && buf.length) {
            done++;
            const hasHr = db.prepare(`SELECT 1 FROM activity_streams WHERE activity_id = ? AND kind = 'hr'`).get(r.id);
            if (!hasHr) {
              const parsed = await parseFitStreams(buf);
              if (Object.keys(parsed).length) {
                const st = db.prepare(
                  `INSERT INTO activity_streams (activity_id, kind, points) VALUES (?, ?, ?)
                   ON CONFLICT(activity_id, kind) DO UPDATE SET points = excluded.points`
                );
                for (const [kind, pts] of Object.entries(parsed)) if (pts.length) st.run(r.id, kind, JSON.stringify(pts));
              }
            }
          }
        } catch (e: any) { failed++; if (errors.length < 5) errors.push(`${r.external_id}: ${e.message}`); }
      }));
    }
    return { ok: true, total: rows.length, done, failed, errors };
  });

  app.post("/api/data/replay", async () => {
    // 全量重放：清结构化数据（保留规则/记忆/计划），重新同步
    db.exec(`
      DELETE FROM activity_streams; DELETE FROM activities;
      DELETE FROM health_daily; DELETE FROM health_samples;
      UPDATE sources SET last_sync_at = NULL;
    `);
    const results = await syncAll();
    return { results };
  });

  app.post("/api/data/clear", async () => {
    db.exec(`
      DELETE FROM activity_streams; DELETE FROM activities;
      DELETE FROM health_daily; DELETE FROM health_samples; DELETE FROM sync_log;
      DELETE FROM transfer_log;
    `);
    return { ok: true };
  });

  app.get("/api/sync-log", async () =>
    db.prepare(
      `SELECT l.*, s.label FROM sync_log l JOIN sources s ON s.id = l.source_id ORDER BY l.id DESC LIMIT 50`
    ).all()
  );
}
