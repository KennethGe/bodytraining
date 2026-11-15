import Database from "better-sqlite3";
import fs from "node:fs";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.rawDir, { recursive: true });

export const db = new Database(config.dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL UNIQUE,            -- garmin | suunto | mock_garmin | mock_suunto
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100, -- 越小越优先
  creds TEXT,                            -- 加密后的凭据 JSON（真实源用 .env，不落库）
  last_sync_at TEXT,
  last_sync_status TEXT,                 -- ok | error | pending
  last_sync_error TEXT
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  sport TEXT NOT NULL,                   -- running | cycling | swimming | hiking | other
  name TEXT,
  start_time TEXT NOT NULL,              -- ISO UTC
  duration_sec REAL NOT NULL,
  distance_m REAL,
  avg_hr REAL, max_hr REAL,
  avg_pace_sec_km REAL,
  avg_power REAL, max_power REAL,
  ascent_m REAL, calories REAL,
  training_load REAL, vo2max REAL,
  raw_path TEXT,                         -- FIT/GPX 原始文件相对路径
  transferred INTEGER NOT NULL DEFAULT 0,-- 互导产生
  transfer_origin TEXT,                  -- 源活动指纹
  merged_into INTEGER REFERENCES activities(id),
  fingerprint TEXT NOT NULL,
  detail_json TEXT,                      -- 源侧完整摘要 JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_act_start ON activities(start_time);
CREATE INDEX IF NOT EXISTS idx_act_fp ON activities(fingerprint);

CREATE TABLE IF NOT EXISTS activity_streams (
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- gps | hr | pace | power | cadence | altitude
  points TEXT NOT NULL,                  -- JSON: [[t,v],...] 或 [[lat,lon,alt,t],...]
  PRIMARY KEY (activity_id, kind)
);

CREATE TABLE IF NOT EXISTS health_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                    -- YYYY-MM-DD
  metric TEXT NOT NULL,                  -- sleep_min | resting_hr | hrv_ms | steps | stress | body_battery | spo2
  value REAL NOT NULL,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  is_primary INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,
  UNIQUE(date, metric, source_id)
);

CREATE TABLE IF NOT EXISTS health_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  samples TEXT NOT NULL,                 -- JSON 明细样本（睡眠分段、逐时 HR 等）
  source_id INTEGER NOT NULL REFERENCES sources(id),
  UNIQUE(date, metric, source_id)
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  summary TEXT,                          -- 超长上下文压缩摘要
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                    -- user | assistant | tool
  content TEXT NOT NULL,
  attachments TEXT,                      -- JSON: [{type:'image'|'audio', path}]
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coach_memory (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coach_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  height_cm REAL, weight_kg REAL, age INTEGER,
  max_hr REAL, resting_hr REAL,
  goal TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL,
  start_date TEXT NOT NULL,
  weeks INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | active | done
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  sport TEXT NOT NULL,
  title TEXT NOT NULL,
  steps TEXT NOT NULL,                   -- 结构化课程 JSON
  push_target TEXT,                      -- garmin | suunto | null
  push_status TEXT NOT NULL DEFAULT 'pending', -- pending | pushed | failed | expired
  push_error TEXT,
  external_id TEXT
);

CREATE TABLE IF NOT EXISTS transfer_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  sports TEXT NOT NULL,                  -- JSON array
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS transfer_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER REFERENCES transfer_rules(id) ON DELETE SET NULL,
  activity_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  status TEXT NOT NULL,                  -- ok | failed | skipped
  error TEXT,
  target_external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  activities_new INTEGER DEFAULT 0,
  activities_updated INTEGER DEFAULT 0,
  health_rows INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// 种子数据：个人档案占位 + 默认主数据源偏好
db.prepare(
  `INSERT OR IGNORE INTO coach_profile (id) VALUES (1)`
).run();

// 迁移：稳定更新检测列
const actCols = db.prepare(`PRAGMA table_info(activities)`).all().map((c: any) => c.name);
if (!actCols.includes("summary_hash")) {
  db.exec(`ALTER TABLE activities ADD COLUMN summary_hash TEXT`);
}

export function kvGet(key: string): string | null {
  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function kvSet(key: string, value: string) {
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}
