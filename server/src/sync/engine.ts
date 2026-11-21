import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db.js";
import { garminAdapter } from "./garmin.js";
import { suuntoAdapter } from "./suunto.js";
import { icuAdapter } from "./icu.js";
import { stravaAdapter } from "./strava.js";
import { recomputeMerges } from "./dedupe.js";
import { runTransfers } from "./transfer.js";
import { parseFitStreams } from "./fit-parse.js";
import type { SyncAdapter } from "./types.js";

const adapters: Record<string, SyncAdapter> = {
  garmin: garminAdapter,
  suunto: suuntoAdapter,
  icu: icuAdapter,
  strava: stravaAdapter,
};

export function getAdapter(type: string) {
  return adapters[type];
}

const SEED_SOURCES = [
  { type: "garmin", label: "佳明 Garmin", priority: 10 },
  { type: "suunto", label: "颂拓 Suunto（直连，当前被官方边缘层封禁）", priority: 20 },
  { type: "strava", label: "Strava（颂拓接力）", priority: 21 },
  { type: "icu", label: "Intervals.icu（颂拓接力）", priority: 22 },
];

export function ensureSources() {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO sources (type, label, enabled, priority) VALUES (?, ?, ?, ?)`
  );
  for (const s of SEED_SOURCES) {
    const a = adapters[s.type];
    // 真实源缺凭据时默认禁用；演示源默认启用（有真实源凭据时演示源保持启用，可在设置页关）
    const enabled = a.available().ok ? 1 : 0;
    ins.run(s.type, s.label, enabled, s.priority);
  }
  // 凭据补齐后自动启用真实源
  const upd = db.prepare(`UPDATE sources SET enabled = 1, label = ? WHERE type = ? AND enabled = 0`);
  for (const s of SEED_SOURCES) {
    if (adapters[s.type].available().ok) upd.run(s.label, s.type);
  }
}

function upsertStreams(activityId: number, streams: Record<string, number[][]>) {
  const stmt = db.prepare(
    `INSERT INTO activity_streams (activity_id, kind, points) VALUES (?, ?, ?)
     ON CONFLICT(activity_id, kind) DO UPDATE SET points = excluded.points`
  );
  for (const [kind, pts] of Object.entries(streams)) {
    if (pts?.length) stmt.run(activityId, kind, JSON.stringify(pts));
  }
}

function upsertHealth(sourceId: number, days: { date: string; metrics: Record<string, number>; samples?: Record<string, unknown> }[]) {
  const dh = db.prepare(
    `INSERT INTO health_daily (date, metric, value, source_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(date, metric, source_id) DO UPDATE SET value = excluded.value`
  );
  const ds = db.prepare(
    `INSERT INTO health_samples (date, metric, samples, source_id) VALUES (?, 'detail', ?, ?)
     ON CONFLICT(date, metric, source_id) DO UPDATE SET samples = excluded.samples`
  );
  let rows = 0;
  for (const day of days) {
    for (const [metric, value] of Object.entries(day.metrics || {})) {
      if (value == null) continue;
      dh.run(day.date, metric, value, sourceId);
      rows++;
    }
    if (day.samples && Object.keys(day.samples).length) {
      ds.run(day.date, JSON.stringify(day.samples), sourceId);
    }
  }
  return rows;
}

/** 每个 (date, metric) 按源优先级重算 is_primary */
export function recomputeHealthPrimary() {
  db.exec(`
    UPDATE health_daily SET is_primary = 0;
    UPDATE health_daily SET is_primary = 1
    WHERE id IN (
      SELECT h.id FROM health_daily h
      JOIN sources s ON s.id = h.source_id AND s.enabled = 1
      WHERE s.priority = (
        SELECT MIN(s2.priority) FROM health_daily h2
        JOIN sources s2 ON s2.id = h2.source_id AND s2.enabled = 1
        WHERE h2.date = h.date AND h2.metric = h.metric
      )
    );
  `);
}

export interface SyncResult {
  source: string;
  ok: boolean;
  error?: string;
  activitiesNew: number;
  activitiesUpdated: number;
  healthRows: number;
}

// 单飞：同一源并发同步请求合并；避免并发登录打挂 Garmin 一次性 refresh token
const running = new Set<number>();

export async function syncSource(sourceId: number): Promise<SyncResult> {
  if (running.has(sourceId)) {
    return { source: `#${sourceId}`, ok: false, error: "同步进行中，已跳过", activitiesNew: 0, activitiesUpdated: 0, healthRows: 0 };
  }
  running.add(sourceId);
  try {
    return await doSyncSource(sourceId);
  } finally {
    running.delete(sourceId);
  }
}

function summaryHash(a: { name: string; sport: string; startTime: string; durationSec: number; distanceM?: number; avgHr?: number; maxHr?: number; avgPower?: number; trainingLoad?: number }): string {
  return [a.name, a.sport, a.startTime, Math.round(a.durationSec), Math.round(a.distanceM ?? -1), Math.round(a.avgHr ?? -1), Math.round(a.maxHr ?? -1), Math.round(a.avgPower ?? -1), Math.round(a.trainingLoad ?? -1)].join("|");
}

async function doSyncSource(sourceId: number): Promise<SyncResult> {
  const src = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(sourceId) as any;
  if (!src) throw new Error(`数据源 #${sourceId} 不存在`);
  const adapter = adapters[src.type];
  const startedAt = new Date().toISOString();
  const logIns = db.prepare(
    `INSERT INTO sync_log (source_id, started_at, status) VALUES (?, ?, 'running')`
  );
  const logId = (logIns.run(sourceId, startedAt).lastInsertRowid as number);
  const finish = (status: string, extra: Partial<SyncResult> & { error?: string }) => {
    db.prepare(
      `UPDATE sync_log SET finished_at = ?, status = ?, activities_new = ?, activities_updated = ?, health_rows = ?, error = ? WHERE id = ?`
    ).run(new Date().toISOString(), status, extra.activitiesNew ?? 0, extra.activitiesUpdated ?? 0, extra.healthRows ?? 0, extra.error ?? null, logId);
    // 仅成功时推进游标，失败后下次仍全量/重叠重试
    if (status === "ok") {
      db.prepare(`UPDATE sources SET last_sync_at = ?, last_sync_status = ?, last_sync_error = NULL WHERE id = ?`)
        .run(startedAt, status, sourceId);
    } else {
      db.prepare(`UPDATE sources SET last_sync_status = ?, last_sync_error = ? WHERE id = ?`)
        .run(status, extra.error ?? null, sourceId);
    }
  };

  const avail = adapter.available();
  if (!avail.ok) {
    finish("skipped", { error: avail.reason });
    return { source: src.type, ok: false, error: avail.reason, activitiesNew: 0, activitiesUpdated: 0, healthRows: 0 };
  }

  try {
    const lastSync = src.last_sync_at as string | null;
    const since = lastSync
      ? new Date(new Date(lastSync).getTime() - 86400000).toISOString() // 1 天重叠
      : null;
    const summaries = await adapter.listActivities(since);

    const sel = db.prepare(`SELECT id, summary_hash FROM activities WHERE source_id = ? AND external_id = ?`);
    const ins = db.prepare(
      `INSERT INTO activities (source_id, external_id, sport, name, start_time, duration_sec, distance_m,
         avg_hr, max_hr, avg_pace_sec_km, avg_power, max_power, ascent_m, calories, training_load, vo2max,
         raw_path, fingerprint, detail_json, summary_hash)
       VALUES (@source_id, @external_id, @sport, @name, @start_time, @duration_sec, @distance_m,
         @avg_hr, @max_hr, @avg_pace_sec_km, @avg_power, @max_power, @ascent_m, @calories, @training_load, @vo2max,
         @raw_path, @fingerprint, @detail_json, @summary_hash)`
    );
    const upd = db.prepare(
      `UPDATE activities SET sport=@sport, name=@name, start_time=@start_time, duration_sec=@duration_sec,
         distance_m=@distance_m, avg_hr=@avg_hr, max_hr=@max_hr, avg_pace_sec_km=@avg_pace_sec_km,
         avg_power=@avg_power, max_power=@max_power, ascent_m=@ascent_m, calories=@calories,
         training_load=@training_load, vo2max=@vo2max, raw_path=@raw_path, fingerprint=@fingerprint, detail_json=@detail_json,
         summary_hash=@summary_hash
       WHERE id=@id`
    );

    let newCount = 0, updatedCount = 0;
    const needStreams: number[] = [];
    for (const a of summaries) {
      const fp = `${a.sport}|${a.startTime.slice(0, 16)}|${Math.round(a.durationSec)}`;
      const row = {
        source_id: sourceId,
        external_id: a.externalId,
        sport: a.sport,
        name: a.name,
        start_time: a.startTime,
        duration_sec: a.durationSec,
        distance_m: a.distanceM ?? null,
        avg_hr: a.avgHr ?? null,
        max_hr: a.maxHr ?? null,
        avg_pace_sec_km: a.avgPaceSecKm ?? null,
        avg_power: a.avgPower ?? null,
        max_power: a.maxPower ?? null,
        ascent_m: a.ascentM ?? null,
        calories: a.calories ?? null,
        training_load: a.trainingLoad ?? null,
        vo2max: a.vo2max ?? null,
        raw_path: null as string | null,
        fingerprint: fp,
        detail_json: JSON.stringify(a.detail ?? {}),
        summary_hash: summaryHash(a),
      };
      const existing = sel.get(sourceId, a.externalId) as { id: number; summary_hash: string | null } | undefined;
      let activityId: number;
      let changed = false;
      if (existing) {
        changed = existing.summary_hash !== row.summary_hash;
        activityId = existing.id;
        if (changed) {
          upd.run({ ...row, id: existing.id });
          updatedCount++;
        }
      } else {
        activityId = ins.run(row).lastInsertRowid as number;
        newCount++;
        changed = true;
      }
      // 明细流：新/更新活动 + 历史缺流活动补齐（并发，见下方）
      const hasStream = db.prepare(`SELECT 1 FROM activity_streams WHERE activity_id = ? LIMIT 1`).get(activityId);
      if (changed || !hasStream) needStreams.push(activityId);
      // 原始 FIT 落盘（真实 Garmin 由 sidecar 下载，这里保留路径约定）
      const rawFile = path.join(config.rawDir, `${src.type}_${a.externalId}.fit`);
      if (fs.existsSync(rawFile)) {
        db.prepare(`UPDATE activities SET raw_path = ? WHERE id = ?`).run(path.relative(config.dataDir, rawFile), activityId);
      }
    }

    // 历史缺流补齐：增量 list 不含旧活动，单独把本源缺流活动加入（限 200/轮，防限流）
    const gap = db.prepare(
      `SELECT a.id FROM activities a WHERE a.source_id = ? AND a.id NOT IN (SELECT activity_id FROM activity_streams) LIMIT 200`
    ).all(sourceId) as { id: number }[];
    for (const g of gap) if (!needStreams.includes(g.id)) needStreams.push(g.id);

    // 并发拉取明细流（8 路）
    for (let i = 0; i < needStreams.length; i += 8) {
      const chunk = needStreams.slice(i, i + 8);
      await Promise.all(chunk.map(async (activityId) => {
        const ext = db.prepare(`SELECT external_id, raw_path FROM activities WHERE id = ?`).get(activityId) as any;
        let streamsOk = false;
        try {
          const streams = await adapter.getStreams(ext.external_id);
          if (streams && Object.keys(streams).length) { upsertStreams(activityId, streams as Record<string, number[][]>); streamsOk = true; }
        } catch (e: any) {
          db.prepare(`UPDATE sync_log SET error = ? WHERE id = ?`).run(`streams(${ext.external_id}): ${e.message}`, logId);
        }
        // 原始 FIT 落盘（真相之源，供全量重放/解析）
        let rawRel: string | null = ext.raw_path;
        if (!rawRel && adapter.getRawFit) {
          try {
            const buf = await adapter.getRawFit(ext.external_id);
            if (buf && buf.length) {
              rawRel = path.join("raw", `${src.type}_${ext.external_id}.fit`);
              fs.writeFileSync(path.join(config.dataDir, rawRel), buf);
              db.prepare(`UPDATE activities SET raw_path = ? WHERE id = ?`).run(rawRel, activityId);
            }
          } catch (e: any) {
            db.prepare(`UPDATE sync_log SET error = ? WHERE id = ?`).run(`fit(${ext.external_id}): ${e.message}`, logId);
          }
        }
        // 逐秒流缺口用本地 FIT 解析补齐（颂拓 samples 端点 404 等场景）
        if (!streamsOk && rawRel) {
          try {
            const abs = path.join(config.dataDir, rawRel);
            if (fs.existsSync(abs)) {
              const parsed = await parseFitStreams(fs.readFileSync(abs));
              if (Object.keys(parsed).length) upsertStreams(activityId, parsed as Record<string, number[][]>);
            }
          } catch (e: any) {
            db.prepare(`UPDATE sync_log SET error = ? WHERE id = ?`).run(`fitparse(${ext.external_id}): ${e.message}`, logId);
          }
        }
      }));
    }

    // 健康数据：最近 7 天（首次 60 天）
    const today = new Date().toISOString().slice(0, 10);
    const fromDate = lastSync
      ? new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
      : new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const health = await adapter.getHealth(fromDate, today);
    const healthRows = upsertHealth(sourceId, health);

    finish("ok", { activitiesNew: newCount, activitiesUpdated: updatedCount, healthRows });
    return { source: src.type, ok: true, activitiesNew: newCount, activitiesUpdated: updatedCount, healthRows };
  } catch (e: any) {
    finish("error", { error: e.message });
    return { source: src.type, ok: false, error: e.message, activitiesNew: 0, activitiesUpdated: 0, healthRows: 0 };
  }
}

export async function syncAll(): Promise<SyncResult[]> {
  const sources = db.prepare(`SELECT id FROM sources WHERE enabled = 1`).all() as { id: number }[];
  const results: SyncResult[] = [];
  for (const s of sources) results.push(await syncSource(s.id));
  recomputeMerges();
  recomputeHealthPrimary();
  await runTransfers();
  recomputeMerges();
  return results;
}

let cronTask: { stop: () => void } | null = null;
export function startScheduler() {
  if (cronTask) return;
  const interval = Math.max(1, config.syncIntervalMin);
  import("node-cron").then(({ default: cron }) => {
    cronTask = cron.schedule(`*/${interval} * * * *`, () => {
      syncAll().catch((e) => console.error("[sync] error:", e.message));
    });
    // 每周一 07:00 生成上周训练报告
    cron.schedule("0 7 * * 1", () => {
      import("../coach/weekly.js").then((m) => m.weeklyReportTick().catch((e) => console.error("[weekly]", e.message)));
    });
  });
  // 启动即同步一次
  setTimeout(() => syncAll().catch((e) => console.error("[sync] error:", e.message)), 500);
  // 启动时补跑周报（机器周一关机的情形）
  setTimeout(() => {
    import("../coach/weekly.js").then((m) => m.weeklyReportTick().catch((e) => console.error("[weekly]", e.message)));
  }, 30000);
}
