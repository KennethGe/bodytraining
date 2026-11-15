import { db } from "../db.js";

// ---------- 数据检索函数（供 AI 工具与 API 共用） ----------

const PRIMARY_FILTER = `merged_into IS NULL`;

export interface ActivityRow {
  id: number; source_id: number; external_id: string; sport: string; name: string;
  start_time: string; duration_sec: number; distance_m: number | null;
  avg_hr: number | null; max_hr: number | null; avg_pace_sec_km: number | null;
  avg_power: number | null; ascent_m: number | null; calories: number | null;
  training_load: number | null; vo2max: number | null; transferred: number;
}

export function recentActivities(days = 14, sport?: string, limit = 50): ActivityRow[] {
  const params: any[] = [days];
  let sql = `SELECT * FROM activities WHERE ${PRIMARY_FILTER} AND start_time >= datetime('now', '-' || ? || ' days')`;
  if (sport && sport !== "all") { sql += ` AND sport = ?`; params.push(sport); }
  sql += ` ORDER BY start_time DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as ActivityRow[];
}

export function activityById(id: number): ActivityRow | undefined {
  return db.prepare(`SELECT * FROM activities WHERE id = ?`).get(id) as ActivityRow | undefined;
}

export function mergedGroup(id: number): ActivityRow[] {
  const a = activityById(id);
  if (!a) return [];
  const primaryId = (a as any).merged_into ?? a.id;
  return db.prepare(
    `SELECT * FROM activities WHERE id = ? OR merged_into = ? ORDER BY source_id`
  ).all(primaryId, primaryId) as ActivityRow[];
}

export function streamOf(activityId: number, kind: string): number[][] {
  const row = db.prepare(`SELECT points FROM activity_streams WHERE activity_id = ? AND kind = ?`).get(activityId, kind) as any;
  return row ? JSON.parse(row.points) : [];
}

/** 逐秒流按窗口聚合成均值序列（压缩 token） */
export function aggregateStream(pts: number[][], windowSec = 60): number[][] {
  if (!pts.length) return [];
  const out: number[][] = [];
  let sum = 0, n = 0, bucket = 0;
  for (const [t, v] of pts) {
    const b = Math.floor(t / windowSec);
    if (b !== bucket && n) { out.push([bucket * windowSec, +(sum / n).toFixed(1)]); sum = 0; n = 0; bucket = b; }
    sum += v; n++;
  }
  if (n) out.push([bucket * windowSec, +(sum / n).toFixed(1)]);
  return out;
}

export function activityStats(activityId: number) {
  const hr = streamOf(activityId, "hr");
  const pace = streamOf(activityId, "pace");
  const power = streamOf(activityId, "power");
  const profile = db.prepare(`SELECT max_hr, resting_hr FROM coach_profile WHERE id = 1`).get() as any;
  const maxHr = profile?.max_hr || (hr.length ? Math.max(...hr.map((p) => p[1])) : 190);
  const restHr = profile?.resting_hr || 55;
  // 储备心率法 5 区间
  const zones = [0, 0, 0, 0, 0];
  for (const [, v] of hr) {
    const r = (v - restHr) / Math.max(1, maxHr - restHr);
    zones[r < 0.6 ? 0 : r < 0.7 ? 1 : r < 0.8 ? 2 : r < 0.9 ? 3 : 4]++;
  }
  const total = hr.length || 1;
  return {
    hrZonePct: zones.map((z) => +((z / total) * 100).toFixed(1)),
    avgHr: hr.length ? +(hr.reduce((s, p) => s + p[1], 0) / hr.length).toFixed(1) : null,
    maxHrSeen: hr.length ? Math.max(...hr.map((p) => p[1])) : null,
    avgPaceSecKm: pace.length ? Math.round(1000 / (pace.reduce((s, p) => s + p[1], 0) / pace.length / 3.6)) : null,
    avgPower: power.length ? Math.round(power.reduce((s, p) => s + p[1], 0) / power.length) : null,
    maxPower: power.length ? Math.max(...power.map((p) => p[1])) : null,
    hrPerMin: aggregateStream(hr, 60),
    pacePerMin: aggregateStream(pace, 60),
    powerPerMin: aggregateStream(power, 60),
  };
}

/** 识别单日多段跑步中的质量课结构（热身/质量/冷身） */
export function daySessionStructure(dateUtc: string) {
  const day = dateUtc.slice(0, 10);
  const acts = db.prepare(
    `SELECT * FROM activities WHERE ${PRIMARY_FILTER} AND sport = 'running' AND date(start_time) = date(?) ORDER BY start_time`
  ).all(day) as ActivityRow[];
  if (acts.length < 2) return null;
  return acts.map((a) => {
    const st = activityStats(a.id);
    return {
      id: a.id, name: a.name, start: a.start_time,
      durationMin: Math.round(a.duration_sec / 60),
      distanceKm: a.distance_m ? +(a.distance_m / 1000).toFixed(2) : null,
      avgHr: st.avgHr, zoneDistribution: st.hrZonePct,
    };
  });
}

export function healthSummary(days = 7) {
  const rows = db.prepare(
    `SELECT date, metric, value FROM health_daily WHERE is_primary = 1 AND date >= date('now', '-' || ? || ' days') ORDER BY date`
  ).all(days) as any[];
  const byDate: Record<string, Record<string, number>> = {};
  for (const r of rows) (byDate[r.date] ||= {})[r.metric] = r.value;
  return byDate;
}

export function trainingLoadSeries(days = 42) {
  const acts = recentActivities(days);
  const byDate: Record<string, number> = {};
  for (const a of acts) {
    const d = a.start_time.slice(0, 10);
    byDate[d] = (byDate[d] || 0) + (a.training_load || Math.round((a.duration_sec / 60) * 5));
  }
  return byDate;
}

export function memoryList() {
  return db.prepare(`SELECT key, content, updated_at FROM coach_memory ORDER BY updated_at DESC`).all();
}
export function memoryWrite(key: string, content: string) {
  db.prepare(
    `INSERT INTO coach_memory (key, content) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`
  ).run(key, content);
}
export function memoryDelete(key: string) {
  db.prepare(`DELETE FROM coach_memory WHERE key = ?`).run(key);
}

export function getProfile() {
  return db.prepare(`SELECT * FROM coach_profile WHERE id = 1`).get();
}
