import type { FastifyInstance } from "fastify";
import { db } from "../db.js";

export function registerHealthRoutes(app: FastifyInstance) {
  // 健康趋势（主数据源）
  app.get("/api/health", async (req) => {
    const q = req.query as { days?: string };
    const days = Number(q.days || 30);
    const rows = db.prepare(
      `SELECT date, metric, value FROM health_daily WHERE is_primary = 1 AND date >= date('now', '-' || ? || ' days') ORDER BY date`
    ).all(days) as any[];
    const series: Record<string, Array<{ date: string; value: number }>> = {};
    for (const r of rows) (series[r.metric] ||= []).push({ date: r.date, value: r.value });
    // 异常检测：静息心率/HRV 相对 30 天基线偏移
    const alerts: string[] = [];
    for (const metric of ["resting_hr", "hrv_ms"]) {
      const s = series[metric];
      if (!s || s.length < 10) continue;
      const base = s.slice(0, -3).reduce((a, b) => a + b.value, 0) / (s.length - 3);
      const last3 = s.slice(-3).reduce((a, b) => a + b.value, 0) / 3;
      const dev = (last3 - base) / base;
      if ((metric === "resting_hr" && dev > 0.08) || (metric === "hrv_ms" && dev < -0.12)) {
        alerts.push(
          metric === "resting_hr"
            ? `近3天静息心率偏高（${Math.round(last3)} vs 基线 ${Math.round(base)}），注意恢复`
            : `近3天 HRV 偏低（${Math.round(last3)} vs 基线 ${Math.round(base)}），疲劳风险`
        );
      }
    }
    const today = rows.filter((r) => r.date === new Date().toISOString().slice(0, 10));
    return { days, series, alerts, today };
  });

  // 单日健康明细样本（睡眠分段等）
  app.get("/api/health/:date/samples", async (req) => {
    const { date } = req.params as { date: string };
    const rows = db.prepare(
      `SELECT hs.metric, hs.samples, s.label FROM health_samples hs JOIN sources s ON s.id = hs.source_id
       WHERE hs.date = ?`
    ).all(date) as any[];
    return rows.map((r) => ({ metric: r.metric, label: r.label, samples: JSON.parse(r.samples) }));
  });

  // 各指标可选数据源（主数据源设置用）
  app.get("/api/health/sources", async () => {
    return db.prepare(
      `SELECT DISTINCT s.id, s.type, s.label, s.priority, s.enabled FROM health_daily h JOIN sources s ON s.id = h.source_id ORDER BY s.priority`
    ).all();
  });
}
