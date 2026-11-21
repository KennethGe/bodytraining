import { config } from "../config.js";
import { kvGet, kvSet } from "../db.js";
import type { ActivityStreams, ActivitySummary, HealthDay, SyncAdapter, Sport } from "./types.js";

// Strava 接力通道（混合方案）：Suunto 官方自动同步到 Strava 后，用官方 OAuth 读取。
// 只读颂拓源活动（device_name/external_id 含 suunto），避免与佳明直连重复计数。
// Strava 提供逐秒流 + laps，但无原始 FIT、无睡眠/HRV 健康数据。
const API = "https://www.strava.com/api/v3";
const OAUTH_TOKEN = "https://www.strava.com/oauth/token";
const KV_TOKEN = "strava_token";
const KV_LAPS = "strava_laps_";

interface StravaToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  athlete?: string;
}

function loadToken(): StravaToken | null {
  const raw = kvGet(KV_TOKEN);
  if (raw) {
    try { return JSON.parse(raw) as StravaToken; } catch { /* fallthrough */ }
  }
  if (config.strava.refreshToken) {
    return { access_token: "", refresh_token: config.strava.refreshToken, expires_at: 0 };
  }
  return null;
}

function saveToken(t: StravaToken) {
  kvSet(KV_TOKEN, JSON.stringify(t));
}

async function postToken(body: Record<string, string>): Promise<any> {
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Strava oauth/token -> ${res.status}`);
  return res.json();
}

async function refresh(t: StravaToken): Promise<StravaToken> {
  const j = await postToken({
    client_id: config.strava.clientId,
    client_secret: config.strava.clientSecret,
    refresh_token: t.refresh_token,
    grant_type: "refresh_token",
  });
  const nt: StravaToken = {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? t.refresh_token,
    expires_at: Number(j.expires_at ?? Math.floor(Date.now() / 1000) + 21600),
    athlete: t.athlete ?? (j.athlete ? `${j.athlete.firstname ?? ""} ${j.athlete.lastname ?? ""}`.trim() : undefined),
  };
  saveToken(nt);
  return nt;
}

async function accessToken(): Promise<string> {
  let t = loadToken();
  if (!t) throw new Error("Strava 未连接（设置页连接）");
  const now = Math.floor(Date.now() / 1000);
  if (!t.access_token || t.expires_at - 60 <= now) t = await refresh(t);
  return t.access_token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiGet<T = any>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken();
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      // 读限流 100/15min：短等待重试一次，长等待放弃本轮（下次同步再补）
      const retry = Number(res.headers.get("retry-after") ?? 0);
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
      const wait = retry > 0 ? retry : Math.max(0, reset - Math.floor(Date.now() / 1000));
      if (attempt === 0 && wait > 0 && wait <= 60) { await sleep(wait * 1000); continue; }
      throw new Error(`Strava 限流 429（${wait}s 后恢复），本轮跳过`);
    }
    if (res.status === 401) {
      const t = loadToken();
      if (t && attempt === 0) { await refresh(t); continue; }
    }
    if (!res.ok) throw new Error(`Strava GET ${path} -> ${res.status}`);
    await sleep(150); // 礼貌间隔
    return (await res.json()) as T;
  }
  throw new Error(`Strava GET ${path} 重试耗尽`);
}

function mapSport(s: string | undefined): Sport {
  const v = (s || "").toLowerCase();
  if (v.includes("run")) return "running";
  if (v.includes("ride") || v.includes("cycl") || v.includes("bike")) return "cycling";
  if (v.includes("swim")) return "swimming";
  if (v.includes("hik") || v.includes("walk")) return "hiking";
  return "other";
}

function isSuuntoOrigin(a: any): boolean {
  return /suunto/i.test(String(a.device_name ?? "")) || /suunto/i.test(String(a.external_id ?? ""));
}

async function lapsFor(id: string): Promise<any[]> {
  const cached = kvGet(KV_LAPS + id);
  if (cached) { try { return JSON.parse(cached); } catch { /* refetch */ } }
  try {
    const laps = await apiGet<any[]>(`/activities/${id}/laps`);
    const arr = Array.isArray(laps) ? laps : [];
    kvSet(KV_LAPS + id, JSON.stringify(arr));
    return arr;
  } catch {
    return [];
  }
}

// ---- OAuth 连接（供设置路由调用）----
export function stravaAuthUrl(redirectUri: string): string {
  const p = new URLSearchParams({
    client_id: config.strava.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    approval_prompt: "auto",
    scope: "read,activity:read_all",
  });
  return `https://www.strava.com/oauth/authorize?${p}`;
}

export async function stravaExchangeCode(code: string, redirectUri: string): Promise<StravaToken> {
  const j = await postToken({
    client_id: config.strava.clientId,
    client_secret: config.strava.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const t: StravaToken = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Number(j.expires_at ?? Math.floor(Date.now() / 1000) + 21600),
    athlete: j.athlete ? `${j.athlete.firstname ?? ""} ${j.athlete.lastname ?? ""}`.trim() : undefined,
  };
  saveToken(t);
  return t;
}

export function stravaStatus(): { connected: boolean; athlete?: string; configured: boolean } {
  const configured = Boolean(config.strava.clientId && config.strava.clientSecret);
  const t = loadToken();
  return { connected: Boolean(t?.refresh_token), athlete: t?.athlete, configured };
}

export function stravaDisconnect(): void {
  kvSet(KV_TOKEN, "");
}

export const stravaAdapter: SyncAdapter = {
  type: "strava",
  label: "Strava（颂拓接力）",
  available() {
    if (!config.strava.clientId || !config.strava.clientSecret)
      return { ok: false, reason: "未配置 STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET" };
    if (!loadToken()) return { ok: false, reason: "未连接 Strava（设置页点连接并授权）" };
    return { ok: true };
  },
  async listActivities(sinceIso) {
    const after = sinceIso ? Math.floor(new Date(sinceIso).getTime() / 1000) : undefined;
    const out: ActivitySummary[] = [];
    for (let page = 1; page <= 20; page++) {
      const qs = new URLSearchParams({ per_page: "200", page: String(page) });
      if (after) qs.set("after", String(after));
      const list = await apiGet<any[]>(`/athlete/activities?${qs}`);
      const arr = Array.isArray(list) ? list : [];
      if (!arr.length) break;
      for (const a of arr) {
        if (!isSuuntoOrigin(a)) continue; // 只取颂拓源，佳明走直连
        const sport = mapSport(a.sport_type ?? a.type);
        const distanceM = a.distance != null ? Number(a.distance) : undefined;
        const durationSec = Math.round(Number(a.moving_time ?? a.elapsed_time ?? 0));
        out.push({
          externalId: String(a.id),
          sport,
          name: String(a.name || a.sport_type || "Strava 活动"),
          startTime: new Date(a.start_date).toISOString(),
          durationSec,
          distanceM,
          avgHr: a.average_heartrate ?? undefined,
          maxHr: a.max_heartrate ?? undefined,
          avgPaceSecKm:
            sport === "running" && distanceM && durationSec
              ? Math.round(durationSec / (distanceM / 1000))
              : undefined,
          avgPower: a.average_watts ?? undefined,
          maxPower: a.max_watts ?? undefined,
          ascentM: a.total_elevation_gain != null ? Math.round(Number(a.total_elevation_gain)) : undefined,
          calories: a.calories ?? undefined,
          trainingLoad: a.suffer_score ?? undefined,
          detail: { ...a, laps: await lapsFor(String(a.id)), via: "strava" },
        });
      }
      if (arr.length < 200) break;
    }
    return out;
  },
  async getStreams(externalId) {
    try {
      const keys = "time,distance,latlng,altitude,heartrate,watts,cadence,velocity_smooth";
      const raw = await apiGet<any>(
        `/activities/${externalId}/streams?keys=${keys}&key_by_type=true&resolution=high`
      );
      const by: Record<string, any> = {};
      if (Array.isArray(raw)) {
        for (const s of raw) by[s.type] = s.data ?? [];
      } else if (raw && typeof raw === "object") {
        // key_by_type=true 返回 { heartrate: {data:[...]}, ... } 对象形态
        for (const [k, v] of Object.entries(raw)) by[k] = (v as any)?.data ?? [];
      }
      const t: number[] = by.time ?? [];
      const streams: ActivityStreams = {};
      const pair = (vals: number[] | undefined, transform?: (v: number) => number): number[][] =>
        (vals ?? []).map((v, i) => [Math.round(t[i] ?? i), transform ? transform(v) : v]);
      if (by.latlng?.length) streams.gps = by.latlng;
      if (by.heartrate?.length) streams.hr = pair(by.heartrate);
      if (by.velocity_smooth?.length) streams.pace = pair(by.velocity_smooth, (v) => +(v * 3.6).toFixed(1));
      if (by.watts?.length) streams.power = pair(by.watts);
      if (by.cadence?.length) streams.cadence = pair(by.cadence);
      if (by.altitude?.length) streams.altitude = pair(by.altitude);
      return streams;
    } catch (e: any) {
      console.log("[strava] getStreams failed:", externalId, e?.message);
      return {};
    }
  },
  async getHealth(_fromDate, _toDate) {
    return []; // Strava 不提供睡眠/HRV/静息心率
  },
  async getRawFit(_externalId) {
    return null; // Strava API 无原始上传文件下载
  },
};