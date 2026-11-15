import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db.js";
import { kvGet } from "../db.js";
import type { ActivityStreams, ActivitySummary, HealthDay, SyncAdapter, Sport } from "./types.js";

// Garmin 美区账号走非官方通道：Python sidecar（garminconnect 库）输出 JSON，TS 侧解析。
// 需要本机 python3 + `pip install garminconnect`；未配置凭据时该源自动禁用。

const SIDECAR = path.join(config.root, "sidecar", "garmin_sync.py");
const VENV_PY = path.join(config.root, "sidecar", ".venv", "bin", "python3");

function runSidecar(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const py = fs.existsSync(VENV_PY) ? VENV_PY : "python3";
    const mfa = kvGet("garmin_mfa_code");
    const child = spawn(py, [SIDECAR, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(mfa ? { GARMIN_MFA_CODE: mfa } : {}) },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`无法启动 sidecar python：${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim().split("\n").slice(-3).join(" | ") || `sidecar 退出码 ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error("sidecar 输出解析失败")); }
    });
  });
}

function mapSport(s: string | undefined, name?: string): Sport {
  const v = ((s || "") + " " + (name || "")).toLowerCase();
  if (v.includes("run") || v.includes("跑步")) return "running";
  if (v.includes("cycl") || v.includes("rid") || v.includes("bike") || v.includes("biking") || v.includes("骑行") || v.includes("自行车")) return "cycling";
  if (v.includes("swim") || v.includes("游泳")) return "swimming";
  if (v.includes("hik") || v.includes("walk") || v.includes("徒步") || v.includes("健走")) return "hiking";
  return "other";
}

export const garminAdapter: SyncAdapter = {
  type: "garmin",
  label: "佳明 Garmin",
  available() {
    if (!config.garmin.email || !config.garmin.password)
      return { ok: false, reason: "未配置 GARMIN_EMAIL / GARMIN_PASSWORD" };
    return { ok: true };
  },
  async listActivities(sinceIso) {
    const res = await runSidecar([
      "activities",
      "--email", config.garmin.email,
      "--password", config.garmin.password,
      ...(sinceIso ? ["--since", sinceIso] : []),
    ]);
    return (res.activities || []).map((a: any) => ({
      externalId: String(a.activityId),
      sport: mapSport(a.activityType?.typeKey, a.activityName),
      name: a.activityName || "Garmin 活动",
      startTime: new Date(a.startTimeLocal || a.beginTimestamp).toISOString(),
      durationSec: Math.round(a.duration ?? 0), // Garmin duration 单位为秒
      distanceM: a.distance ?? undefined,
      avgHr: a.averageHR ?? undefined,
      maxHr: a.maxHR ?? undefined,
      avgPaceSecKm: a.averageSpeed ? Math.round(1000 / a.averageSpeed) : undefined,
      avgPower: a.avgPower ?? undefined,
      maxPower: a.maxPower ?? undefined,
      ascentM: a.elevationGain ?? undefined,
      calories: a.calories ?? undefined,
      trainingLoad: a.aerobicTrainingEffect ? Math.round(a.aerobicTrainingEffect * 40) : undefined,
      vo2max: a.vO2MaxValue ?? undefined,
      detail: a,
    })) satisfies ActivitySummary[];
  },
  async getStreams(externalId) {
    const res = await runSidecar([
      "streams",
      "--email", config.garmin.email,
      "--password", config.garmin.password,
      "--id", externalId,
    ]);
    return (res.streams || {}) as ActivityStreams;
  },
  async getHealth(fromDate, toDate) {
    const res = await runSidecar([
      "health",
      "--email", config.garmin.email,
      "--password", config.garmin.password,
      "--from", fromDate,
      "--to", toDate,
    ]);
    return (res.days || []) as HealthDay[];
  },
  async pushActivity(fitPath, activity?: any) {
    if (!fitPath) throw new Error("缺少 FIT 原始文件，无法互导到 Garmin");
    // 非佳明设备的 FIT 佳明导入管道兼容性差：统一解码重编码为标准结构
    const { reencodeFit } = await import("./fit-parse.js");
    const raw = fs.readFileSync(fitPath);
    let uploadPath = fitPath;
    try {
      const re = await reencodeFit(raw);
      uploadPath = path.join(config.rawDir, `reencoded_${path.basename(fitPath)}`);
      fs.writeFileSync(uploadPath, re);
    } catch {
      uploadPath = fitPath; // 重编码失败则原样上传兜底
    }
    const date = activity?.startTime ? String(activity.startTime).slice(0, 10) : undefined;
    const duration = activity?.durationSec ? String(Math.round(activity.durationSec)) : undefined;
    try {
      const res = await runSidecar([
        "upload",
        "--email", config.garmin.email,
        "--password", config.garmin.password,
        "--file", uploadPath,
        ...(date ? ["--date", date] : []),
        ...(duration ? ["--duration", duration] : []),
      ]);
      if (res.error) throw new Error(`佳明拒收上传: ${String(res.error).slice(0, 200)}`);
      return { externalId: String(res.activityId || `up_${Date.now()}`) };
    } finally {
      if (uploadPath !== fitPath) fs.rmSync(uploadPath, { force: true });
    }
  },
  async getRawFit(externalId) {
    const dest = path.join(config.rawDir, `garmin_${externalId}.fit`);
    await runSidecar([
      "fit",
      "--email", config.garmin.email,
      "--password", config.garmin.password,
      "--id", externalId,
      "--out", dest,
    ]);
    return fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  },
  async pushWorkout(_file, workout: any, date: string) {
    // 结构化课程 → Garmin workout-service JSON（心率区间按储备心率法换算 bpm）
    const profile = (db.prepare(`SELECT max_hr, resting_hr FROM coach_profile WHERE id = 1`).get() as any) || {};
    const maxHr = profile.max_hr || 185;
    const restHr = profile.resting_hr || 50;
    const zoneBpm = (z: number): [number, number] => {
      const f: [number, number][] = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0]];
      const [lo, hi] = f[Math.min(4, Math.max(0, (z || 2) - 1))];
      return [Math.round(restHr + lo * (maxHr - restHr)), Math.round(restHr + hi * (maxHr - restHr))];
    };
    const SPORT_TYPES: Record<string, any> = {
      running: { sportTypeId: 1, sportTypeKey: "running", displayOrder: 1 },
      cycling: { sportTypeId: 2, sportTypeKey: "cycling", displayOrder: 2 },
      swimming: { sportTypeId: 4, sportTypeKey: "swimming", displayOrder: 5 },
    };
    const STEP_TYPES: Record<string, any> = {
      warmup: { stepTypeId: 1, stepTypeKey: "warmup", displayOrder: 1 },
      cooldown: { stepTypeId: 2, stepTypeKey: "cooldown", displayOrder: 2 },
      interval: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
      recovery: { stepTypeId: 4, stepTypeKey: "recovery", displayOrder: 4 },
      steady: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
    };
    const COND_TIME = { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true };
    const COND_DIST = { conditionTypeId: 3, conditionTypeKey: "distance", displayOrder: 3, displayable: true };
    const HR_TARGET = { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone", displayOrder: 4 };
    const NO_TARGET = { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 };
    const sportType = SPORT_TYPES[workout.sport] || SPORT_TYPES.running;
    let stepOrder = 1;
    const workoutSteps = (workout.steps || []).map((s: any) => {
      const [lo, hi] = zoneBpm(s.targetHrZone);
      const byDistance = !!s.distanceM;
      const step: any = {
        stepId: stepOrder,
        stepOrder: stepOrder,
        stepType: STEP_TYPES[s.type] || STEP_TYPES.interval,
        type: "ExecutableStepDTO",
        description: s.note || "",
        stepAudioNote: null,
        endCondition: byDistance ? COND_DIST : COND_TIME,
        endConditionValue: byDistance ? Math.round(s.distanceM) : Math.round(s.durationSec || 600),
        targetType: s.targetHrZone ? HR_TARGET : NO_TARGET,
      };
      if (s.targetHrZone) {
        step.targetValueOne = lo;
        step.targetValueTwo = hi;
        step.targetValueUnit = null;
      }
      stepOrder += 1;
      return step;
    });
    const estSecs = (workout.steps || []).reduce(
      (t: number, s: any) => t + (s.durationSec || (s.distanceM ? s.distanceM / 3.5 : 0) || 0), 0);
    const payload = {
      sportType,
      subSportType: null,
      workoutName: (workout.title || "训练").slice(0, 40),
      description: "BodyTraining 生成",
      estimatedDistanceUnit: { unitKey: null },
      workoutSegments: [{ segmentOrder: 1, sportType, workoutSteps }],
      avgTrainingSpeed: null,
      estimatedDurationInSecs: Math.round(estSecs) || 0,
      estimatedDistanceInMeters: (workout.steps || []).reduce((d: number, s: any) => d + (s.distanceM || 0), 0) || 0,
      estimateType: null,
    };
    const tmp = path.join(config.rawDir, `workout_${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(payload));
    try {
      const res = await runSidecar([
        "pushworkout",
        "--email", config.garmin.email,
        "--password", config.garmin.password,
        "--file", tmp,
        "--date", date,
      ]);
      if (!res.workoutId) throw new Error("佳明未返回 workoutId");
      return { externalId: String(res.workoutId) };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  },
};
