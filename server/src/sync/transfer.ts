import { db } from "../db.js";
import { getAdapter } from "./engine.js";

/** 同步后执行互导规则：源活动 → 目标账号（按运动分类）。防回环：transferred 活动不参与。 */
export async function runTransfers(): Promise<{ transferred: number; failed: number }> {
  const rules = db.prepare(
    `SELECT r.*, s.type AS source_type2, s.id AS source_id FROM transfer_rules r
     JOIN sources s ON s.type = r.source_type WHERE r.enabled = 1`
  ).all() as any[];
  if (!rules.length) return { transferred: 0, failed: 0 };

  const targetSrc = (type: string) => db.prepare(`SELECT * FROM sources WHERE type = ?`).get(type);
  const logIns = db.prepare(
    `INSERT INTO transfer_log (rule_id, activity_id, target_type, status, error, target_external_id) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const alreadyOk = new Set(
    (db.prepare(`SELECT activity_id, target_type FROM transfer_log WHERE status = 'ok'`).all() as any[]).map(
      (r) => `${r.activity_id}:${r.target_type}`
    )
  );

  let transferred = 0, failed = 0;
  for (const rule of rules) {
    const sports = JSON.parse(rule.sports) as string[];
    const target = targetSrc(rule.target_type) as any;
    if (!target) continue;
    const targetAdapter = getAdapter(rule.target_type);
    const avail = targetAdapter?.available();
    const acts = db.prepare(
      `SELECT * FROM activities WHERE source_id = ? AND transferred = 0 AND merged_into IS NULL`
    ).all(rule.source_id) as any[];

    for (const a of acts) {
      if (!sports.includes(a.sport)) continue;
      if (alreadyOk.has(`${a.id}:${rule.target_type}`)) continue;
      if (!targetAdapter?.pushActivity) {
        logIns.run(rule.id, a.id, rule.target_type, "failed", "目标数据源不支持写入", null);
        failed++;
        continue;
      }
      if (avail && !avail.ok) {
        logIns.run(rule.id, a.id, rule.target_type, "failed", avail.reason, null);
        failed++;
        continue;
      }
      try {
        const summary = {
          externalId: a.external_id, sport: a.sport, name: a.name, startTime: a.start_time,
          durationSec: a.duration_sec, distanceM: a.distance_m,
        } as any;
        const res = await targetAdapter.pushActivity(a.raw_path, summary);
        // 在本地库为目标源创建 transferred 副本（列表与源活动查重合并为一条）
        db.prepare(
          `INSERT OR IGNORE INTO activities (source_id, external_id, sport, name, start_time, duration_sec,
             distance_m, avg_hr, max_hr, avg_pace_sec_km, ascent_m, calories, training_load,
             transferred, transfer_origin, fingerprint, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '{}')`
        ).run(
          target.id, res.externalId, a.sport, `${a.name}（互导）`, a.start_time, a.duration_sec,
          a.distance_m, a.avg_hr, a.max_hr, a.avg_pace_sec_km, a.ascent_m, a.calories, a.training_load,
          a.fingerprint, a.fingerprint
        );
        logIns.run(rule.id, a.id, rule.target_type, "ok", null, res.externalId);
        transferred++;
      } catch (e: any) {
        logIns.run(rule.id, a.id, rule.target_type, "failed", e.message, null);
        failed++;
      }
    }
  }
  return { transferred, failed };
}
