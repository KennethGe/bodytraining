export type Sport = "running" | "cycling" | "swimming" | "hiking" | "other";

export interface ActivitySummary {
  externalId: string;
  sport: Sport;
  name: string;
  startTime: string; // ISO UTC
  durationSec: number;
  distanceM?: number;
  avgHr?: number;
  maxHr?: number;
  avgPaceSecKm?: number;
  avgPower?: number;
  maxPower?: number;
  ascentM?: number;
  calories?: number;
  trainingLoad?: number;
  vo2max?: number;
  detail?: Record<string, unknown>;
}

// 逐秒/逐点明细：普通流 [ [t秒偏移, 值], ... ]；GPS [ [lat, lon, alt], ... ]
export type StreamPoints = number[][];
export type ActivityStreams = Partial<
  Record<"gps" | "hr" | "pace" | "power" | "cadence" | "altitude", StreamPoints>
>;

export interface HealthDay {
  date: string; // YYYY-MM-DD
  metrics: Record<string, number>; // sleep_min | resting_hr | hrv_ms | steps | stress | body_battery
  samples?: Record<string, unknown>; // 明细样本 JSON
}

export interface SyncAdapter {
  type: string; // sources.type
  label: string;
  available(): { ok: boolean; reason?: string };
  listActivities(sinceIso: string | null): Promise<ActivitySummary[]>;
  getStreams(externalId: string): Promise<ActivityStreams>;
  getHealth(fromDate: string, toDate: string): Promise<HealthDay[]>;
  pushActivity?(fitPath: string | null, activity: ActivitySummary): Promise<{ externalId: string }>;
  pushWorkout?(filePath: string | null, workout: unknown, date: string): Promise<{ externalId: string }>;
  /** 下载原始 FIT 文件（真相之源，供重放/解析） */
  getRawFit?(externalId: string): Promise<Buffer | null>;
}
