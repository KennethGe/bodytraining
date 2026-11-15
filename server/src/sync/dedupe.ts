import { db } from "../db.js";
import type { ActivitySummary } from "./types.js";

export function fingerprint(a: Pick<ActivitySummary, "sport" | "startTime" | "durationSec" | "distanceM">): string {
  // 粗指纹：类型 + 开始时间(取到10分钟桶) 用于快速候选筛选
  const t = new Date(a.startTime).getTime();
  return `${a.sport}:${Math.floor(t / 600000)}`;
}

interface DbAct {
  id: number;
  source_id: number;
  sport: string;
  start_time: string;
  duration_sec: number;
  distance_m: number | null;
  merged_into: number | null;
  transferred: number;
}

function isDup(a: DbAct, b: DbAct): boolean {
  // 注：transferred 副本也要与源活动合并展示（防回环由 transfer.ts 的 transferred=0 过滤保证）
  if (a.sport !== b.sport) return false;
  const dt = Math.abs(new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  if (dt > 2 * 60 * 1000) return false;
  const durDiff = Math.abs(a.duration_sec - b.duration_sec) / Math.max(a.duration_sec, b.duration_sec, 1);
  if (durDiff > 0.02) return false;
  if (a.distance_m != null && b.distance_m != null && a.distance_m > 0 && b.distance_m > 0) {
    const distDiff = Math.abs(a.distance_m - b.distance_m) / Math.max(a.distance_m, b.distance_m);
    if (distDiff > 0.02) return false;
  }
  return true;
}

/** 全量重算合并组：每个跨源重复组保留 priority 最小的源作为主记录，其余 merged_into 指向主记录 */
export function recomputeMerges(): number {
  const acts = db.prepare(`SELECT * FROM activities`).all() as DbAct[];
  const sourcePriority = new Map<number, number>(
    (db.prepare(`SELECT id, priority FROM sources`).all() as { id: number; priority: number }[]).map(
      (s) => [s.id, s.priority]
    )
  );
  // union-find
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const a of acts) parent.set(a.id, a.id);

  // 按指纹桶分组比较（桶含相邻10分钟窗口）
  const byBucket = new Map<string, DbAct[]>();
  for (const a of acts) {
    const t = new Date(a.start_time).getTime();
    for (const off of [-1, 0, 1]) {
      const key = `${a.sport}:${Math.floor(t / 600000) + off}`;
      const list = byBucket.get(key) || [];
      list.push(a);
      byBucket.set(key, list);
    }
  }
  const seenPairs = new Set<string>();
  for (const list of byBucket.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.source_id === b.source_id) continue;
        const pk = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
        if (seenPairs.has(pk)) continue;
        seenPairs.add(pk);
        if (isDup(a, b)) union(a.id, b.id);
      }
    }
  }

  const groups = new Map<number, DbAct[]>();
  for (const a of acts) {
    const r = find(a.id);
    const g = groups.get(r) || [];
    g.push(a);
    groups.set(r, g);
  }

  let merged = 0;
  const upd = db.prepare(`UPDATE activities SET merged_into = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const g of groups.values()) {
      if (g.length < 2) {
        if (g[0].merged_into !== null) upd.run(null, g[0].id);
        continue;
      }
      const primary = g.slice().sort(
        (x, y) =>
          (x.transferred - y.transferred) || // 互导副本永远不做主记录
          ((sourcePriority.get(x.source_id) ?? 999) - (sourcePriority.get(y.source_id) ?? 999)) ||
          x.id - y.id
      )[0];
      for (const a of g) {
        const target = a.id === primary.id ? null : primary.id;
        if (a.merged_into !== target) {
          upd.run(target, a.id);
          merged++;
        }
      }
    }
  });
  tx();
  return merged;
}
