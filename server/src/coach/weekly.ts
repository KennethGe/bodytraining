import { db, kvGet, kvSet } from "../db.js";
import { aiConfigured, plainChat } from "./client.js";
import { getCoachPrompt } from "./prompt.js";
import { recentActivities, healthSummary, trainingLoadSeries } from "./data.js";

// 周训练报告：每周一自动生成上周报告，存为教练会话；无 AI Key 时跳过。

function mondayOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function currentWeekKey(): string {
  const m = mondayOf(new Date());
  return m.toISOString().slice(0, 10);
}

function lastWeekRange(): { from: string; to: string; key: string } {
  const thisMon = mondayOf(new Date());
  const lastMon = new Date(thisMon.getTime() - 7 * 86400000);
  const lastSun = new Date(thisMon.getTime() - 1);
  return {
    from: lastMon.toISOString().slice(0, 10),
    to: lastSun.toISOString().slice(0, 10),
    key: lastMon.toISOString().slice(0, 10),
  };
}

export async function generateWeeklyReport(force = false): Promise<{ ok: boolean; reason?: string; sessionId?: number }> {
  const { from, to, key } = lastWeekRange();
  if (!force && kvGet("last_weekly_report") === key) return { ok: false, reason: "本周报告已生成" };
  if (!aiConfigured()) return { ok: false, reason: "未配置 DASHSCOPE_API_KEY" };

  const acts = db.prepare(
    `SELECT * FROM activities WHERE merged_into IS NULL AND date(start_time) BETWEEN ? AND ? ORDER BY start_time`
  ).all(from, to) as any[];
  if (!acts.length) return { ok: false, reason: "上周无活动数据" };

  const bySport: Record<string, { n: number; km: number; min: number; load: number }> = {};
  for (const a of acts) {
    const s = (bySport[a.sport] ||= { n: 0, km: 0, min: 0, load: 0 });
    s.n++; s.km += (a.distance_m || 0) / 1000; s.min += a.duration_sec / 60; s.load += a.training_load || (a.duration_sec / 60) * 5;
  }
  const health = healthSummary(10);
  const load = trainingLoadSeries(42);

  const payload = {
    周期: `${from} ~ ${to}`,
    活动: acts.map((a) => ({
      日期: a.start_time.slice(0, 10), 项目: a.sport, 名称: a.name,
      分钟: Math.round(a.duration_sec / 60), km: a.distance_m ? +(a.distance_m / 1000).toFixed(2) : null,
      均心: a.avg_hr, 负荷: a.training_load,
    })),
    分项汇总: bySport,
    健康: health,
    日负荷序列: load,
  };

  const reply = await plainChat(
    `${getCoachPrompt()}\n\n# 任务\n生成上周训练报告。结构：①总量概览 ②质量课与亮点 ③恢复与风险信号 ④下周建议（含量化目标）。中文，简洁，数字说话。`,
    JSON.stringify(payload, null, 1)
  );
  if (!reply) return { ok: false, reason: "模型返回为空" };

  const sid = db.prepare(`INSERT INTO chat_sessions (title) VALUES (?)`).run(`周报 ${key} ~ ${to}`)
    .lastInsertRowid as number;
  db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)`).run(sid, reply);
  kvSet("last_weekly_report", key);
  return { ok: true, sessionId: sid };
}

/** 启动/定时调用：周一且本周未生成则生成 */
export async function weeklyReportTick() {
  const today = new Date();
  if (today.getDay() !== 1) return;
  if (kvGet("last_weekly_report") === currentWeekKey()) return;
  const res = await generateWeeklyReport();
  if (!res.ok && res.reason !== "未配置 DASHSCOPE_API_KEY") {
    console.log("[weekly]", res.reason);
  } else if (res.ok) {
    console.log("[weekly] 周报已生成 session#", res.sessionId);
  }
}
