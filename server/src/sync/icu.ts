import { config } from "../config.js";
import type { ActivityStreams, ActivitySummary, HealthDay, SyncAdapter, Sport } from "./types.js";

// Intervals.icu 接力通道：Suunto 官方合作伙伴同步到 ICU 后，用个人 API Key 读取。
// 认证：Basic（尝试三种排列，首次成功后缓存）。
const BASE = "https://intervals.icu/api/v1/athlete/0";

let authHeader: string | null = null;

function basic(user: string, pass: string) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function icuGet<T = any>(path: string): Promise<T> {
  const key = config.icu.apiKey;
  const schemes = authHeader
    ? [authHeader]
    : [basic("API_KEY", key), basic(key, ""), `Bearer ${key}`];
  let lastErr = "";
  for (const auth of schemes) {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: auth } });
    if (res.status === 401 || res.status === 403) {
      lastErr = `auth ${res.status}`;
      continue;
    }
    if (!res.ok) throw new Error(`ICU GET ${path} -> ${res.status}`);
    authHeader = auth;
    return (await res.json()) as T;
  }
  throw new Error(`Intervals.icu 认证失败（${lastErr}），请检查 ICU_API_KEY`);
}

function mapSport(s: string | undefined): Sport {
  const v = (s || "").toLowerCase();
  if (v.includes("run")) return "running";
  if (v.includes("ride") || v.includes("cycl") || v.includes("bike")) return "cycling";
  if (v.includes("swim")) return "swimming";
  if (v.includes("hik") || v.includes("walk")) return "hiking";
  return "other";
}

export const icuAdapter: SyncAdapter = {
  type: "icu",
  label: "Intervals.icu（颂拓接力）",
  available() {
    if (!config.icu.apiKey) return { ok: false, reason: "未配置 ICU_API_KEY（intervals.icu 设置页底部）" };
    return { ok: true };
  },
  async listActivities(sinceIso) {
    const oldest = sinceIso ? sinceIso.slice(0, 10) : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const newest = new Date().toISOString().slice(0, 10);
    const list = await icuGet<any[]>(`/activities?oldest=${oldest}&newest=${newest}`);
    return (Array.isArray(list) ? list : [])
      .filter((a) => a && (a.source === "SUUNTO" || a.suunto || !config.garmin.email || true))
      .map((a) => {
        const startMs = Date.parse(a.start_time_local || a.startTimeLocal || a.start_time || 0);
        const durationSec = Math.round(Number(a.moving_time ?? a.elapsed_time ?? a.duration ?? 0) / 1000);
        const distanceM = a.distance != null ? Number(a.distance) * (Number(a.distance) < 1000 ? 1000 : 1) : undefined;
        return {
          externalId: String(a.id),
          sport: mapSport(a.sport || a.type),
          name: String(a.name || a.sport || "ICU 活动"),
          startTime: new Date(startMs).toISOString(),
          durationSec,
          distanceM,
          avgHr: a.average_hr ?? a.avg_hr ?? undefined,
          maxHr: a.max_hr ?? undefined,
          avgPaceSecKm:
            distanceM && durationSec && mapSport(a.sport) === "running"
              ? Math.round(durationSec / (distanceM / 1000))
              : undefined,
          avgPower: a.average_power ?? a.avg_power ?? undefined,
          maxPower: a.max_power ?? undefined,
          ascentM: a.elevation_gain ?? a.ascent ?? undefined,
          calories: a.calories ?? undefined,
          trainingLoad: a.icu_training_load ?? a.training_load ?? undefined,
          vo2max: undefined,
          detail: { ...a, via: "intervals.icu" },
        } satisfies ActivitySummary;
      });
  },
  async getStreams(externalId) {
    try {
      const s = await icuGet<any>(`/activities/${externalId}/streams`);
      const streams: ActivityStreams = {};
      const t: number[] = s.time || [];
      const pair = (vals: number[] | undefined, transform?: (v: number) => number): number[][] =>
        (vals || []).map((v, i) => [Math.round((t[i] ?? i * 1000) / 1000), transform ? transform(v) : v]);
      if (s.latlng?.length) streams.gps = s.latlng;
      if (s.hr?.length) streams.hr = pair(s.hr);
      if (s.speed?.length) streams.pace = pair(s.speed, (v) => +(v * 3.6).toFixed(1));
      if (s.power?.length) streams.power = pair(s.power);
      if (s.alt?.length) streams.altitude = pair(s.alt);
      if (s.cadence?.length) streams.cadence = pair(s.cadence);
      return streams;
    } catch {
      return {};
    }
  },
  async getHealth(fromDate, toDate) {
    const list = await icuGet<any[]>(`/wellness?oldest=${fromDate}&newest=${toDate}`);
    return (Array.isArray(list) ? list : []).map((w) => ({
      date: String(w.id || w.date || "").slice(0, 10),
      metrics: {
        sleep_min: w.sleepSecs != null ? Math.round(w.sleepSecs / 60) : undefined,
        resting_hr: w.restingHR ?? undefined,
        hrv_ms: w.hrv ?? undefined,
        steps: w.steps ?? undefined,
        weight_kg: w.weight != null ? +(w.weight / 1000).toFixed(1) : undefined,
      } as Record<string, number>,
      samples: { icu: { sleepScore: w.sleepScore, hrv: w.hrv, restingHR: w.restingHR } },
    })) as HealthDay[];
  },
  async pushWorkout(_file, workout: any, date: string) {
    // 计划课程写入 ICU 日历（是否下发到手表取决于 ICU 与 Suunto 的同步能力）
    const key = config.icu.apiKey;
    const auth = authHeader || basic("API_KEY", key);
    const res = await fetch(`${BASE}/events/bulk?upsert=true`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          category: "WORKOUT",
          start_date_local: `${date}T09:00:00`,
          name: workout?.title || "训练",
          external_id: `bt_${date}_${workout?.title || ""}`,
          workout_doc: JSON.stringify(workout?.steps || []),
        },
      ]),
    });
    if (!res.ok) throw new Error(`ICU events -> ${res.status}`);
    return { externalId: `icu_${date}` };
  },
};
