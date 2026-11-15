import FitFileParserModule from "fit-file-parser";
import type { ActivityStreams } from "./types.js";

const mod: any = FitFileParserModule as any;
const FitFileParser: any = mod.FitFileParser || mod.default?.FitFileParser || mod.default || mod;

/** 从 FIT 二进制（或 Garmin 偶尔返回的 TCX XML）解析逐秒流 */
export async function parseFitStreams(buf: Buffer): Promise<ActivityStreams> {
  const head = buf.subarray(0, 64).toString("latin1");
  if (head.includes("<?xml") || head.includes("<TrainingCenterDatabase")) return parseTcxStreams(buf);
  return parseFitBinary(buf);
}

/** TCX（TrainingCenterDatabase XML）→ 逐秒流；Speed 单位 m/s，转 km/h 与 FIT 路径一致 */
export function parseTcxStreams(buf: Buffer): ActivityStreams {
  const xml = buf.toString("utf8");
  const hr: number[][] = [], pace: number[][] = [], cad: number[][] = [], alt: number[][] = [], gps: number[][] = [];
  let t0: number | null = null;
  const tpRe = /<Trackpoint[\s>][\s\S]*?(?:<\/Trackpoint>|\/>)/g;
  const num = (s: string, tag: string): number | null => {
    const m = s.match(new RegExp(`<${tag}[^>]*>([\\d.eE+-]+)</${tag}>`));
    return m ? Number(m[1]) : null;
  };
  let m: RegExpExecArray | null;
  while ((m = tpRe.exec(xml))) {
    const tp = m[0];
    const tm = tp.match(/<Time>([^<]+)<\/Time>/);
    if (!tm) continue;
    const ts = new Date(tm[1]).getTime();
    if (Number.isNaN(ts)) continue;
    if (t0 == null) t0 = ts;
    const t = Math.round((ts - t0) / 1000);
    const lat = num(tp, "LatitudeDegrees");
    const lon = num(tp, "LongitudeDegrees");
    const altV = num(tp, "AltitudeMeters");
    const hrV = num(tp, "HeartRateBpm");
    const cadV = num(tp, "Cadence");
    const spV = num(tp, "Speed");
    if (lat != null && lon != null) gps.push([+lat.toFixed(6), +lon.toFixed(6)]);
    if (altV != null) alt.push([t, +altV.toFixed(1)]);
    if (hrV != null) hr.push([t, Math.round(hrV)]);
    if (cadV != null) cad.push([t, Math.round(cadV)]);
    if (spV != null) pace.push([t, +(spV * 3.6).toFixed(1)]);
  }
  const out: ActivityStreams = {};
  if (gps.length) out.gps = gps;
  if (hr.length) out.hr = hr;
  if (pace.length) out.pace = pace;
  if (cad.length) out.cadence = cad;
  if (alt.length) out.altitude = alt;
  return out;
}

async function parseFitBinary(buf: Buffer): Promise<ActivityStreams> {
  const parser = new FitFileParser({ mode: "both", speedUnit: "km/h", lengthUnit: "km" });
  const data: any = await new Promise((resolve, reject) => {
    parser.parse(buf, (err: any, obj: any) => (err ? reject(err) : resolve(obj)));
  });
  const act = data?.activities?.[0];
  const samples: any[] = act?.samples?.length ? act.samples : data?.records || [];
  if (!samples.length) return {};
  const hr: number[][] = [], pace: number[][] = [], power: number[][] = [], cad: number[][] = [], alt: number[][] = [], gps: number[][] = [];
  let t0: number | null = null;
  for (const s of samples) {
    const ts = s.timestamp ? new Date(s.timestamp).getTime() : null;
    if (ts == null) continue;
    if (t0 == null) t0 = ts;
    const t = Math.round((ts - t0) / 1000);
    const hrV = s.heartRate ?? s.heart_rate;
    const spV = s.speed ?? s.enhancedSpeed;
    const pwV = s.power ?? s.enhancedPower;
    const cadV = s.cadence ?? s.runCadence ?? s.bikeCadence;
    const altV = s.altitude ?? s.enhancedAltitude;
    const latV = s.latitude ?? s.positionLat;
    const lonV = s.longitude ?? s.positionLong;
    if (hrV != null) hr.push([t, Math.round(hrV)]);
    if (spV != null) pace.push([t, +Number(spV).toFixed(1)]); // km/h（speedUnit 已设）
    if (pwV != null) power.push([t, Math.round(pwV)]);
    if (cadV != null) cad.push([t, Math.round(cadV)]);
    if (altV != null) alt.push([t, +Number(altV).toFixed(1)]);
    if (latV != null && lonV != null) {
      const norm = (v: number) => (Math.abs(v) > 1000 ? v / 1e7 : v); // semicircles → degrees 兜底
      gps.push([+norm(latV).toFixed(6), +norm(lonV).toFixed(6)]);
    }
  }
  const out: ActivityStreams = {};
  if (gps.length) out.gps = gps;
  if (hr.length) out.hr = hr;
  if (pace.length) out.pace = pace;
  if (power.length) out.power = power;
  if (cad.length) out.cadence = cad;
  if (alt.length) out.altitude = alt;
  return out;
}

/** 任意来源 FIT → 标准 FIT 重编码（佳明上传服务对非佳明设备的 FIT 兼容性差，需重建 file_id/session/record） */
export async function reencodeFit(buf: Buffer): Promise<Buffer> {
  const sdk: any = await import("@garmin/fitsdk");
  const { Decoder, Encoder, Stream } = sdk;
  const Profile = sdk.Profile;
  const decoded: any = new Decoder(Stream.fromByteArray(buf)).read();
  const records: any[] = decoded?.messages?.recordMesgs || [];
  const session: any = (decoded?.messages?.sessionMesgs || [])[0] || {};
  if (!records.length) throw new Error("FIT 内无 record 数据，无法重编码");
  const FIT_EPOCH = 631065600;
  const toFitSec = (v: any): number | undefined => {
    if (v == null) return undefined;
    if (typeof v === "number" && Number.isFinite(v)) return v > 1e9 ? Math.round(v - FIT_EPOCH) : Math.round(v);
    const ms = new Date(v).getTime();
    return Number.isNaN(ms) ? undefined : Math.round(ms / 1000 - FIT_EPOCH);
  };
  const times = records.map((r) => toFitSec(r.timestamp)).filter((t): t is number => t != null);
  const t0 = times.length ? Math.min(...times) : 0;
  const t1 = times.length ? Math.max(...times) : t0;
  const lats = records.map((r) => r.positionLat).filter((v: any) => v != null);
  const lons = records.map((r) => r.positionLong).filter((v: any) => v != null);
  const alts = records.map((r) => r.enhancedAltitude ?? r.altitude).filter((v: any) => v != null);
  const dists = records.map((r) => r.distance).filter((v: any) => v != null);
  const totalDist = dists.length ? dists[dists.length - 1] : 0;
  const num = (v: any): number | undefined => (v == null || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const encoder = new Encoder();
  encoder.onMesg(Profile.MesgNum.FILE_ID, {
    type: 4, manufacturer: 1, product: 1, serialNumber: 305419896,
    timeCreated: new Date((t0 + FIT_EPOCH) * 1000),
  });
  encoder.onMesg(Profile.MesgNum.SESSION, {
    timestamp: t1, startTime: t0,
    totalElapsedTime: num(session.totalElapsedTime) ?? t1 - t0,
    totalTimerTime: num(session.totalTimerTime) ?? t1 - t0,
    totalDistance: num(session.totalDistance) ?? totalDist,
    avgSpeed: num(session.avgSpeed) ?? (t1 > t0 && totalDist ? totalDist / (t1 - t0) : 0),
    avgHeartRate: num(session.avgHeartRate), maxHeartRate: num(session.maxHeartRate),
    avgCadence: num(session.avgCadence), maxCadence: num(session.maxCadence),
    avgPower: num(session.avgPower), maxPower: num(session.maxPower),
    totalCalories: num(session.totalCalories),
    totalAscent: num(session.totalAscent) ?? (alts.length ? Math.max(0, Math.round(Math.max(...alts) - alts[0])) : 0),
    totalDescent: num(session.totalDescent) ?? (alts.length ? Math.max(0, Math.round(alts[0] - Math.min(...alts))) : 0),
    avgAltitude: alts.length ? alts.reduce((a: number, b: number) => a + b, 0) / alts.length : undefined,
    maxAltitude: alts.length ? Math.max(...alts) : undefined,
    minAltitude: alts.length ? Math.min(...alts) : undefined,
    positionLat: lats.length ? lats[0] : undefined,
    positionLong: lons.length ? lons[0] : undefined,
    numLaps: 1, firstLapIndex: 0,
    sport: session.sport ?? 0, subSport: session.subSport ?? 0,
    trigger: 0,
  });
  encoder.onMesg(Profile.MesgNum.LAP, {
    timestamp: t1, startTime: t0,
    totalElapsedTime: num(session.totalElapsedTime) ?? t1 - t0,
    totalTimerTime: num(session.totalTimerTime) ?? t1 - t0,
    totalDistance: num(session.totalDistance) ?? totalDist,
    lapTrigger: 0, sport: session.sport ?? 0,
    positionLat: lats.length ? lats[0] : undefined,
    positionLong: lons.length ? lons[0] : undefined,
  });
  for (const r of records) {
    encoder.onMesg(Profile.MesgNum.RECORD, {
      timestamp: toFitSec(r.timestamp),
      positionLat: num(r.positionLat),
      positionLong: num(r.positionLong),
      heartRate: num(r.heartRate),
      cadence: num(r.cadence) ?? num(r.runCadence),
      power: num(r.power),
      speed: num(r.enhancedSpeed) ?? num(r.speed),
      altitude: num(r.enhancedAltitude) ?? num(r.altitude),
      distance: num(r.distance),
      temperature: num(r.temperature),
    });
  }
  encoder.onMesg(Profile.MesgNum.ACTIVITY, {
    timestamp: t1, numSessions: 1, type: 1, event: 26, eventType: 4,
    localTimestamp: t1,
  });
  return Buffer.from(encoder.close());
}
