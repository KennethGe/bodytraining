import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { config } from "../config.js";
import { db } from "../db.js";
import { kvGet, kvSet } from "../db.js";
import { suuntoLogin, suuntoDispatcher, SUUNTO_UA, type SuuntoSession } from "./suunto-auth.js";
import type { ActivityStreams, ActivitySummary, HealthDay, SyncAdapter, Sport } from "./types.js";

// 自研 Sports Tracker 客户端：login2 签名登录（suunto-auth）+ STTAuthorization 会话调用。
// 全部请求走 suuntoDispatcher（可配代理绕过区域封锁）。

const BASE = "https://api.sports-tracker.com/apiserver/v1";
const KV_SESSION = "suunto_session";

async function getSession(): Promise<SuuntoSession> {
  const cached = kvGet(KV_SESSION);
  if (cached) {
    try { return JSON.parse(cached) as SuuntoSession; } catch { /* re-login */ }
  }
  // 免登录通道 1：suuntool 会话文件（可从已登录机器拷贝）
  const file = config.suunto.sessionFile || path.join(os.homedir(), ".config", "suuntool", "session.json");
  if (fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf-8"));
      const key = j.SessionKey || j.sessionKey || j.sessionkey || j.session_key;
      if (key) {
        const s: SuuntoSession = {
          sessionkey: key,
          username: j.Username || j.username || "",
          email: j.Email || j.email || config.suunto.email,
          userKey: j.UserKey || j.userKey || "",
          country: j.Country || j.country || "",
        };
        return s; // 不写 kv：始终以文件为准，便于整体替换
      }
    } catch { /* fallthrough */ }
  }
  // 免登录通道 2：环境变量会话密钥
  if (config.suunto.sessionKey) {
    const s: SuuntoSession = {
      sessionkey: config.suunto.sessionKey,
      username: "", email: config.suunto.email, userKey: "", country: "",
    };
    return s;
  }
  const s = await suuntoLogin(config.suunto.email, config.suunto.password);
  kvSet(KV_SESSION, JSON.stringify(s));
  return s;
}

async function apiGet<T = any>(path: string, retry = true): Promise<T> {
  const session = await getSession();
  const res = await fetch(`${BASE}/${path}`, {
    headers: {
      "user-agent": SUUNTO_UA,
      "accept-language": "en",
      STTAuthorization: session.sessionkey,
    },
  });
  if (res.status === 401 && retry) {
    kvSet(KV_SESSION, "");
    return apiGet<T>(path, false);
  }
  if (!res.ok) throw new Error(`Suunto GET ${path} -> ${res.status}`);
  const body = (await res.json()) as any;
  return (body.payload ?? body) as T;
}

function mapSport(_name: string | undefined, typeId?: number): Sport {
  switch (typeId) {
    case 1: case 22: case 53: return "running";
    case 2: case 10: case 52: return "cycling";
    case 21: case 85: return "swimming";
    case 0: case 11: case 24: case 70: return "hiking";
  }
  return "other";
}

const TYPE_NAMES: Record<number, string> = {
  0: "步行", 1: "跑步", 2: "骑行", 10: "山地骑", 11: "徒步", 21: "游泳", 22: "越野跑",
  52: "室内骑行", 53: "跑步机", 68: "多项运动", 70: "徒步", 74: "铁三", 85: "公开水域",
};

// Google encoded polyline 解码
function decodePolyline(s: string): number[][] {
  const out: number[][] = [];
  let idx = 0, lat = 0, lng = 0;
  const next = (): number => {
    let shift = 0, result = 0;
    while (idx < s.length) {
      const b = s.charCodeAt(idx++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (idx < s.length) {
    lat += next();
    lng += next();
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

/**
 * 颂拓上传（逆向 com.stt.android.suunto 6.14.5 得到的真实协议）：
 * POST /apiserver/v1/workout  multipart/form-data，三个 part（WorkoutRestApi.saveWorkout）：
 *   - workoutBinary    filename="binary"    application/octet-stream  = FIT 原始文件（可选）
 *   - workoutExtensions filename="extension" application/json;charset=UTF-8 = 扩展 JSON（恒发，无则 "[]"）
 *   - sml              filename="sml.zip"   application/zip           = GZIP('{"Summary":<obj>,"Data":<obj>}')
 * SML gzip 结构来自 SmlGZIPUtils.saveGZipSMLFromSummaryAndSamples：Summary 在前、Data 在后。
 * 注意：当前迁移会话被服务端禁写（523 Workout could not be saved），读取正常；需官方 OAuth 会话才能真正写入。
 */
async function pushActivitySml(fitPath: string | null, activity: any) {
    const row = db.prepare(
      `SELECT id, start_time, distance_m, duration_sec, sport FROM activities WHERE external_id = ? LIMIT 1`
    ).get(activity.externalId) as any;
    if (!row) throw new Error("找不到源活动，无法生成 SML");
    const get = (kind: string): number[][] => {
      const r = db.prepare(`SELECT points FROM activity_streams WHERE activity_id = ? AND kind = ?`).get(row.id, kind) as any;
      return r ? JSON.parse(r.points) : [];
    };
    const hr = get("hr"), pace = get("pace"), power = get("power"), cad = get("cadence"), alt = get("altitude"), gps = get("gps");
    if (!hr.length && !gps.length) throw new Error("源活动缺少逐秒流，无法生成 SML");
    const startMs = new Date(row.start_time).getTime();
    const typeId = activity.sport === "running" ? 1 : activity.sport === "cycling" ? 2 : activity.sport === "swimming" ? 21 : activity.sport === "hiking" ? 11 : 4;
    const D2R = Math.PI / 180;
    const iso = (t: number) => new Date(startMs + t * 1000).toISOString().replace("Z", "+00:00");

    // ---- Data.Samples（逐秒流）----
    const samples: any[] = [
      { Attributes: { "suunto/sml": { Sample: { Events: [{ ArrayBegin: 0, Lap: { Type: "Start" } }] } } }, Source: "bodytraining", TimeISO8601: iso(0) },
      { Attributes: { "suunto/sml": { Sample: { Events: [{ Activity: { ActivityType: typeId, CustomModeId: "3" } }] } } }, Source: "bodytraining", TimeISO8601: iso(0) },
    ];
    const n = Math.max(hr.length, gps.length, pace.length);
    let lastT = 0;
    for (let i = 0; i < n; i++) {
      const t = hr[i]?.[0] ?? gps[i]?.[0] ?? pace[i]?.[0] ?? i;
      lastT = Math.max(lastT, t);
      const sample: any = {};
      if (hr[i]) sample.HR = +(hr[i][1] / 60).toFixed(4);
      if (pace[i]) sample.Speed = +(pace[i][1] / 3.6).toFixed(4);
      if (power[i]) sample.Power = Math.round(power[i][1]);
      if (cad[i]) sample.Cadence = +(cad[i][1] / 60).toFixed(4);
      if (alt[i]) { sample.Altitude = alt[i][1]; sample.GPSAltitude = alt[i][1]; }
      if (gps[i]) { sample.Latitude = +(gps[i][0] * D2R).toFixed(12); sample.Longitude = +(gps[i][1] * D2R).toFixed(12); sample.UTC = iso(t); }
      samples.push({ Attributes: { "suunto/sml": { Sample: sample } }, Source: "bodytraining", TimeISO8601: iso(t) });
    }

    // ---- Summary.Samples（Header 摘要，服务端保存所需）----
    const distM = activity.distanceM ?? row.distance_m ?? 0;
    const durSec = activity.durationSec ?? row.duration_sec ?? lastT;
    const hrVals = hr.map((p) => p[1]).filter((v) => v > 0);
    const avgHr = hrVals.length ? hrVals.reduce((a, b) => a + b, 0) / hrVals.length : undefined;
    const maxHr = hrVals.length ? Math.max(...hrVals) : undefined;
    const altVals = alt.map((p) => p[1]);
    const header: any = {
      Activity: "null",
      ActivityType: typeId,
      DateTime: iso(0),
      Distance: Math.round(distM),
      Duration: +Number(durSec).toFixed(2),
      DeviceLocation: "Unspecified",
      Notes: "",
      IsSupervised: false,
      Device: { Name: "bodytraining", SerialNumber: "0000000000", Info: { HW: "bodytraining", SW: "1.0" } },
      Altitude: altVals.length ? { Max: Math.max(...altVals), Min: Math.min(...altVals) } : { Max: 0, Min: 0 },
      Ascent: altVals.length ? Math.max(0, Math.round(Math.max(...altVals) - altVals[0])) : 0,
      Descent: altVals.length ? Math.max(0, Math.round(altVals[0] - Math.min(...altVals))) : 0,
      Speed: distM && durSec ? { Avg: +(distM / durSec).toFixed(3), Max: +(distM / durSec).toFixed(3) } : undefined,
      Personal: maxHr ? { MaxHR: +(maxHr / 60).toFixed(3) } : undefined,
    };
    if (avgHr) header.HR = { Avg: +(avgHr / 60).toFixed(3), Max: +((maxHr || avgHr) / 60).toFixed(3) };
    const summarySamples = [
      { Attributes: { "suunto/sml": { Header: header } }, Source: "bodytraining", TimeISO8601: iso(Math.round(durSec)) },
    ];

    // ---- 按 SmlGZIPUtils 格式打包：{"Summary":...,"Data":...} 再 gzip ----
    const smlJson = `{"Summary":${JSON.stringify({ Samples: summarySamples })},"Data":${JSON.stringify({ Samples: samples })}}`;
    const smlGz = zlib.gzipSync(Buffer.from(smlJson, "utf8"));

    const session = await getSession();
    const form = new FormData();
    // workoutExtensions 恒发（无扩展则空数组）
    form.append("workoutExtensions", new Blob([Buffer.from("[]")], { type: "application/json;charset=UTF-8" }), "extension");
    // sml（gzip，字段名 sml / 文件名 sml.zip / application/zip）
    form.append("sml", new Blob([smlGz], { type: "application/zip" }), "sml.zip");
    // workoutBinary（可选：有 FIT 原文件则附带）
    const absFit = fitPath ? (path.isAbsolute(fitPath) ? fitPath : path.join(config.dataDir, fitPath)) : null;
    if (absFit && fs.existsSync(absFit)) {
      form.append("workoutBinary", new Blob([fs.readFileSync(absFit)], { type: "application/octet-stream" }), "binary");
    }
    const res = await fetch(`${BASE}/workout`, {
      method: "POST",
      headers: { "user-agent": SUUNTO_UA, "accept-language": "en", STTAuthorization: session.sessionkey },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      const msg = (() => { try { return JSON.parse(text)?.error?.description || text.slice(0, 150); } catch { return text.slice(0, 150); } })();
      throw new Error(`颂拓上传 ${res.status}: ${msg}`);
    }
    const w = JSON.parse(text);
    const key = w?.payload?.key || w?.key;
    if (!key) throw new Error("颂拓上传未返回 key");
    return { externalId: String(key) };
}

export const suuntoAdapter: SyncAdapter = {
  type: "suunto",
  label: "颂拓 Suunto",
  available() {
    const file = config.suunto.sessionFile || path.join(os.homedir(), ".config", "suuntool", "session.json");
    if (fs.existsSync(file) || config.suunto.sessionKey) return { ok: true };
    if (!config.suunto.email || !config.suunto.password)
      return { ok: false, reason: "未连接颂拓：缺少会话文件（~/.config/suuntool/session.json）或 SUUNTO_SESSION_KEY" };
    return { ok: true };
  },
  async listActivities(sinceIso) {
    const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;
    const out: ActivitySummary[] = [];
    let offset = 0;
    const limit = 100;
    for (let page = 0; page < 30; page++) {
      const list = await apiGet<any[]>(`workouts?since=${sinceMs}&limit=${limit}&offset=${offset}`);
      const arr = Array.isArray(list) ? list : [];
      if (!arr.length) break;
      for (const w of arr) {
        const startMs = Number(w.startTime ?? 0);
        const typeId = Number(w.activityId ?? -1);
        const sport = mapSport(undefined, typeId);
        const hr = w.hrdata || {};
        out.push({
          externalId: String(w.key || w.workoutKey || w.id),
          sport,
          name: TYPE_NAMES[typeId] || (w.suuntoTags?.[0] ? String(w.suuntoTags[0]) : `运动 ${typeId}`),
          startTime: new Date(startMs).toISOString(),
          durationSec: Math.round(Number(w.totalTime ?? 0)),
          distanceM: w.totalDistance != null ? Number(w.totalDistance) : undefined,
          avgHr: hr.avg ?? hr.workoutAvgHR ?? undefined,
          maxHr: hr.workoutMaxHR ?? hr.hrmax ?? undefined,
          avgPaceSecKm:
            sport === "running" && w.avgPace != null ? Math.round(Number(w.avgPace) * 60) : undefined,
          avgPower: w.avgPower != null ? Math.round(Number(w.avgPower)) : undefined,
          ascentM: w.totalAscent != null ? Math.round(Number(w.totalAscent)) : undefined,
          calories: w.energyConsumption != null ? Number(w.energyConsumption) : undefined,
          trainingLoad: w.tss != null ? Math.round(Number(w.tss)) : undefined,
          detail: { ...w, via: "sports-tracker" },
        });
      }
      if (arr.length < limit) break;
      offset += limit;
    }
    return out;
  },
  async getStreams(externalId) {
    // 逐秒样本：优先 samples 端点，失败则留空（摘要仍完整）
    try {
      const raw = await apiGet<any>(`workouts/${externalId}/samples`);
      const samples: any[] = Array.isArray(raw) ? raw : raw?.samples || [];
      const streams: ActivityStreams = {};
      const gps: number[][] = [], hr: number[][] = [], pace: number[][] = [], power: number[][] = [], alt: number[][] = [];
      let t0: number | null = null;
      for (const s of samples) {
        const ts = Number(s.time ?? s.timestamp ?? 0);
        if (!t0 && ts) t0 = ts;
        const t = ts && t0 ? Math.round((ts - t0) / 1000) : 0;
        if (s.latitude != null && s.longitude != null) gps.push([+s.latitude / (Math.abs(+s.latitude) > 1000 ? 1e7 : 1), +s.longitude / (Math.abs(+s.longitude) > 1000 ? 1e7 : 1)]);
        if (s.hr != null) hr.push([t, Math.round(Number(s.hr) * (Number(s.hr) < 3 ? 60 : 1))]);
        if (s.speed != null) pace.push([t, +(Number(s.speed) * 3.6).toFixed(1)]);
        if (s.power != null) power.push([t, Math.round(Number(s.power))]);
        if (s.altitude != null) alt.push([t, +Number(s.altitude).toFixed(1)]);
      }
      if (gps.length) streams.gps = gps;
      if (hr.length) streams.hr = hr;
      if (pace.length) streams.pace = pace;
      if (power.length) streams.power = power;
      if (alt.length) streams.altitude = alt;
      return streams;
    } catch {
      // samples 端点 404：用详情里的 Google encoded polyline 解码出轨迹兜底
      try {
        const w = await apiGet<any>(`workouts/${externalId}`);
        if (typeof w?.polyline === "string" && w.polyline) {
          const gps = decodePolyline(w.polyline);
          if (gps.length) return { gps };
        }
      } catch { /* ignore */ }
      return {};
    }
  },
  async getHealth(fromDate, toDate) {
    // 247.sports-tracker.com  gzip NDJSON 时间线：sleep / recovery / activity
    const sinceMs = new Date(fromDate + "T00:00:00Z").getTime();
    const grab = async (stream: string): Promise<any[]> => {
      const session = await getSession();
      const res = await fetch(`https://247.sports-tracker.com/v1/${stream}/export?since=${sinceMs}`, {
        headers: { "user-agent": SUUNTO_UA, "accept-language": "en", STTAuthorization: session.sessionkey },
      });
      if (!res.ok) return [];
      const text = await res.text();
      return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    };
    const [sleep, recovery, activity] = await Promise.all([grab("sleep"), grab("recovery"), grab("activity")]);
    const byDate: Record<string, HealthDay> = {};
    const day = (ts: string) => ts.slice(0, 10);
    for (const s of sleep) {
      const d = (byDate[day(s.timestamp)] ||= { date: day(s.timestamp), metrics: {}, samples: {} });
      const e = s.entryData || {};
      d.metrics.sleep_min = (d.metrics.sleep_min || 0) + Math.round((e.duration || 0) / 60);
      if (e.hrAvg) d.metrics.resting_hr = Math.round(Math.min(d.metrics.resting_hr || 999, e.hrAvg * 60));
      if (e.avgHrv) d.metrics.hrv_ms = Math.round(((d.metrics.hrv_ms || 0) + e.avgHrv) / (d.metrics.hrv_ms ? 2 : 1));
      (d.samples as any).sleep = (d.samples as any).sleep || [];
      (d.samples as any).sleep.push({
        deep: Math.round((e.deepSleepDuration || 0) / 60),
        light: Math.round((e.lightSleepDuration || 0) / 60),
        rem: Math.round((e.remSleepDuration || 0) / 60),
      });
    }
    for (const r of recovery) {
      const d = (byDate[day(r.timestamp)] ||= { date: day(r.timestamp), metrics: {}, samples: {} });
      const e = r.entryData || {};
      if (e.stressState != null) d.metrics.stress = Math.round(((d.metrics.stress || 0) + e.stressState * 20) / (d.metrics.stress ? 2 : 1));
    }
    for (const a of activity) {
      const d = (byDate[day(a.timestamp)] ||= { date: day(a.timestamp), metrics: {}, samples: {} });
      const e = a.entryData || {};
      d.metrics.steps = (d.metrics.steps || 0) + (e.stepCount || 0);
    }
    return Object.values(byDate).filter((d) => d.date <= toDate);
  },
  async getRawFit(externalId) {
    const session = await getSession();
    const res = await fetch(`${BASE.replace("/apiserver/v1", "/apiserver/v1")}/workout/exportFit/${externalId}`, {
      headers: { "user-agent": SUUNTO_UA, "accept-language": "en", STTAuthorization: session.sessionkey },
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  },
  async pushActivity(fitPath, activity) {
    // 协议已逆向自官方 App（见 pushActivitySml 注释）：multipart 三 part + gzip SML。
    // 但迁移会话被服务端禁写：所有上传返回 523 "Workout could not be saved"（读取正常），
    // 与 login2 写封锁同类，需官方 OAuth 会话才能真正写入。此处仍按真实协议发起，透出服务端错误。
    return await pushActivitySml(fitPath ?? null, activity);
  },
  async pushWorkout(_file, workout) {
    // 颂拓结构化课程下发需 SuuntoPlus Guides 打包协议，暂不支持
    void workout;
    throw new Error("颂拓暂不支持课程推送（推送目标请选佳明）");
  },
};
