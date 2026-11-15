import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { activityById, activityStats, mergedGroup, streamOf, recentActivities } from "../coach/data.js";

export function registerActivityRoutes(app: FastifyInstance) {
  // 活动列表（仅主记录）
  app.get("/api/activities", async (req) => {
    const q = req.query as { sport?: string; from?: string; to?: string; limit?: string };
    const params: any[] = [];
    let sql = `SELECT a.*, s.label AS source_label FROM activities a JOIN sources s ON s.id = a.source_id
               WHERE a.merged_into IS NULL`;
    if (q.sport && q.sport !== "all") { sql += ` AND a.sport = ?`; params.push(q.sport); }
    if (q.from) { sql += ` AND date(a.start_time) >= date(?)`; params.push(q.from); }
    if (q.to) { sql += ` AND date(a.start_time) <= date(?)`; params.push(q.to); }
    sql += ` ORDER BY a.start_time DESC LIMIT ?`;
    params.push(Number(q.limit || 200));
    const rows = db.prepare(sql).all(...params) as any[];
    // 合并来源计数
    const cnt = db.prepare(
      `SELECT merged_into, COUNT(*) c FROM activities WHERE merged_into IS NOT NULL GROUP BY merged_into`
    ).all() as any[];
    const cntMap = new Map(cnt.map((r) => [r.merged_into, r.c]));
    return rows.map((r) => ({
      ...r,
      merged_sources: (cntMap.get(r.id) || 0) + 1,
    }));
  });

  // 活动详情
  app.get("/api/activities/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = activityById(Number(id));
    if (!a) return reply.code(404).send({ error: "活动不存在" });
    const group = mergedGroup(Number(id));
    const sourceLabels = (db.prepare(
      `SELECT s.label FROM activities a JOIN sources s ON s.id = a.source_id WHERE a.id IN (${group.map(() => "?").join(",")})`
    ).all(...group.map((g) => g.id)) as any[]).map((r) => r.label);
    return {
      activity: a,
      stats: activityStats(a.id),
      sources: sourceLabels,
      profile: db.prepare(`SELECT * FROM coach_profile WHERE id = 1`).get(),
    };
  });

  // 活动流数据（图表用；GPS 全量，其余按 10s 聚合可选）
  app.get("/api/activities/:id/streams", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { kinds?: string };
    const kinds = (q.kinds || "gps,hr,pace,power,altitude,cadence").split(",");
    const out: Record<string, number[][]> = {};
    for (const k of kinds) out[k] = streamOf(Number(id), k);
    return out;
  });

  // 趋势：周/月/年训练量与负荷
  app.get("/api/trends", async (req) => {
    const q = req.query as { range?: string };
    const days = q.range === "year" ? 365 : q.range === "month" ? 90 : 28;
    const acts = recentActivities(days, undefined, 1000);
    const byWeek: Record<string, { distance: number; duration: number; count: number; load: number }> = {};
    const bySport: Record<string, number> = {};
    for (const a of acts) {
      const d = new Date(a.start_time);
      const weekStart = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
      const w = (byWeek[weekStart] ||= { distance: 0, duration: 0, count: 0, load: 0 });
      w.distance += a.distance_m || 0;
      w.duration += a.duration_sec;
      w.count += 1;
      w.load += a.training_load || Math.round((a.duration_sec / 60) * 5);
      bySport[a.sport] = (bySport[a.sport] || 0) + (a.duration_sec || 0);
    }
    return { days, weeks: byWeek, sports: bySport };
  });
}
