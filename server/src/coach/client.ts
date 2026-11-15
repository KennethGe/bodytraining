import { config } from "../config.js";
import { db } from "../db.js";
import { getCoachPrompt } from "./prompt.js";
import * as D from "./data.js";

export const aiConfigured = () => Boolean(config.ai.apiKey);

/** 单轮纯文本调用（周报等场景） */
export async function plainChat(system: string, user: string): Promise<string> {
  const res = await chatCompletions({
    model: config.ai.chatModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices?.[0]?.message?.content || "";
}

interface ChatMessage { role: string; content: any; tool_calls?: any[]; tool_call_id?: string; name?: string }

async function chatCompletions(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.ai.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DashScope ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ---------- 工具定义 ----------
const tools = [
  {
    type: "function",
    function: {
      name: "get_recent_activities",
      description: "获取最近训练活动列表（已查重合并的主记录）",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "最近天数，默认14" },
          sport: { type: "string", enum: ["all", "running", "cycling", "swimming", "hiking", "other"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_activity_analysis",
      description: "获取单次活动的详细分析数据：心率区间分布、每分钟心率/配速/功率序列、汇总指标",
      parameters: {
        type: "object",
        properties: { activity_id: { type: "number" } },
        required: ["activity_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_day_run_structure",
      description: "获取某天所有跑步分段（用于识别热身/质量课/冷身结构）",
      parameters: {
        type: "object",
        properties: { date: { type: "string", description: "YYYY-MM-DD" } },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_health_summary",
      description: "获取健康日汇总（睡眠/静息心率/HRV/步数/压力/身体电量），仅主数据源",
      parameters: {
        type: "object",
        properties: { days: { type: "number", description: "最近天数，默认7" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_training_load",
      description: "获取每日训练负荷序列（用于计算急性/慢性负荷比 ACWR）",
      parameters: {
        type: "object",
        properties: { days: { type: "number", description: "默认42" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_write",
      description: "把用户的目标、伤病、偏好、装备等重要事实写入长期记忆",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "短横线命名，如 injury-knee / goal-marathon" },
          content: { type: "string" },
        },
        required: ["key", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_list",
      description: "列出长期记忆",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_profile",
      description: "获取用户档案（身高体重年龄、最大/静息心率、目标）",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "创建训练计划（用户确认后才会推送到手表）。workouts 为结构化课程数组：[{date:YYYY-MM-DD, sport:running|cycling|swimming|other, title, steps:[{type:warmup|interval|recovery|cooldown|steady, durationSec|distanceM, targetHrZone:1-5, targetPowerW?, note?}]}]",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string" },
          start_date: { type: "string", description: "YYYY-MM-DD" },
          weeks: { type: "number" },
          workouts: { type: "array", items: { type: "object" } },
        },
        required: ["goal", "start_date", "workouts"],
      },
    },
  },
];

function execTool(name: string, args: any): string {
  try {
    switch (name) {
      case "get_recent_activities":
        return JSON.stringify(
          D.recentActivities(args.days ?? 14, args.sport).map((a) => ({
            id: a.id, sport: a.sport, name: a.name, start: a.start_time,
            durationMin: Math.round(a.duration_sec / 60),
            distanceKm: a.distance_m ? +(a.distance_m / 1000).toFixed(2) : null,
            avgHr: a.avg_hr, load: a.training_load,
          }))
        );
      case "get_activity_analysis": {
        const a = D.activityById(args.activity_id);
        if (!a) return "活动不存在";
        return JSON.stringify({ activity: a, stats: D.activityStats(a.id) });
      }
      case "get_day_run_structure":
        return JSON.stringify(D.daySessionStructure(args.date) ?? { note: "当天少于两段跑步记录" });
      case "get_health_summary":
        return JSON.stringify(D.healthSummary(args.days ?? 7));
      case "get_training_load":
        return JSON.stringify(D.trainingLoadSeries(args.days ?? 42));
      case "memory_write":
        D.memoryWrite(args.key, args.content);
        return "已写入长期记忆";
      case "memory_list":
        return JSON.stringify(D.memoryList());
      case "get_profile":
        return JSON.stringify(D.getProfile());
      case "create_plan": {
        const info = db.prepare(
          `INSERT INTO plans (goal, start_date, weeks) VALUES (?, ?, ?)`
        ).run(args.goal, args.start_date, args.weeks ?? Math.ceil((args.workouts?.length ?? 7) / 7));
        const planId = info.lastInsertRowid as number;
        const ins = db.prepare(
          `INSERT INTO plan_workouts (plan_id, date, sport, title, steps) VALUES (?, ?, ?, ?, ?)`
        );
        for (const w of args.workouts || []) {
          ins.run(planId, w.date, w.sport || "other", w.title || "训练", JSON.stringify(w.steps || []));
        }
        return JSON.stringify({ planId, note: "计划已创建为草稿，需用户在计划页确认后推送" });
      }
      default:
        return `未知工具 ${name}`;
    }
  } catch (e: any) {
    return `工具执行失败：${e.message}`;
  }
}

// ---------- 会话上下文 ----------
const MAX_HISTORY = 30;

function buildSystemPrompt(): string {
  const profile = D.getProfile() as any;
  const memories = D.memoryList() as any[];
  const recent = D.recentActivities(7).slice(0, 10).map((a) =>
    `${a.start_time.slice(0, 10)} ${a.sport} ${a.name} ${Math.round(a.duration_sec / 60)}min ${a.distance_m ? (a.distance_m / 1000).toFixed(1) + "km" : ""}`
  );
  return [
    getCoachPrompt(),
    `\n# 当前用户档案\n${JSON.stringify(profile)}`,
    memories.length ? `\n# 长期记忆\n${memories.map((m) => `- ${m.key}: ${m.content}`).join("\n")}` : "",
    recent.length ? `\n# 最近7天活动（详情用工具查询）\n${recent.join("\n")}` : "",
    `\n# 当前日期\n${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean).join("\n");
}

async function compressHistory(sessionId: number, history: ChatMessage[]) {
  if (history.length <= MAX_HISTORY) return history;
  const old = history.slice(0, history.length - MAX_HISTORY);
  const keep = history.slice(history.length - MAX_HISTORY);
  const prevSummary = (db.prepare(`SELECT summary FROM chat_sessions WHERE id = ?`).get(sessionId) as any)?.summary || "";
  let summary = prevSummary;
  try {
    const res = await chatCompletions({
      model: config.ai.chatModel,
      messages: [
        { role: "system", content: "把之前的对话压缩成要点摘要（用户情况、讨论过什么、结论），中文，300字内。已有摘要需合并。" },
        { role: "user", content: `已有摘要：${prevSummary || "无"}\n\n新对话：\n${old.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 500) : "[多模态]"}`).join("\n")}` },
      ],
    });
    summary = res.choices?.[0]?.message?.content || prevSummary;
  } catch { /* 压缩失败则丢弃旧消息 */ }
  db.prepare(`UPDATE chat_sessions SET summary = ? WHERE id = ?`).run(summary, sessionId);
  return [
    ...(summary ? [{ role: "system", content: `# 之前对话摘要\n${summary}` } as ChatMessage] : []),
    ...keep,
  ];
}

export interface ChatInput {
  sessionId: number;
  text?: string;
  imageDataUrl?: string; // 图片输入（qwen-vl）
}

export async function coachChat(input: ChatInput): Promise<{ reply: string; toolTrace: string[] }> {
  if (!aiConfigured()) throw new Error("AI_NOT_CONFIGURED");
  const { sessionId } = input;

  // 用户消息（文本 / 图片多模态）
  let userContent: any = input.text || "";
  let model = config.ai.chatModel;
  if (input.imageDataUrl) {
    model = config.ai.vlModel;
    userContent = [
      { type: "image_url", image_url: { url: input.imageDataUrl } },
      { type: "text", text: input.text || "请分析这张图片（可能是训练数据截图或照片）" },
    ];
  }
  db.prepare(`INSERT INTO chat_messages (session_id, role, content, attachments) VALUES (?, 'user', ?, ?)`)
    .run(sessionId, typeof userContent === "string" ? userContent : input.text || "[图片]",
      input.imageDataUrl ? JSON.stringify([{ type: "image", stored: "inline" }]) : null);

  const rows = db.prepare(
    `SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT 60`
  ).all(sessionId) as any[];
  let history: ChatMessage[] = rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  history = await compressHistory(sessionId, history);

  const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt() }, ...history];
  const toolTrace: string[] = [];

  for (let round = 0; round < 8; round++) {
    const res = await chatCompletions({ model, messages, tools });
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error("模型返回为空");
    messages.push(msg);
    if (!msg.tool_calls?.length) {
      const reply = msg.content || "";
      db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)`).run(sessionId, reply);
      db.prepare(`UPDATE chat_sessions SET updated_at = datetime('now'), title = COALESCE(title, ?) WHERE id = ?`)
        .run((input.text || "对话").slice(0, 30), sessionId);
      return { reply, toolTrace };
    }
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function?.arguments || "{}");
      toolTrace.push(`${tc.function?.name}(${JSON.stringify(args).slice(0, 120)})`);
      const result = execTool(tc.function?.name || "", args);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'tool', ?)`)
        .run(sessionId, `${tc.function?.name} => ${result.slice(0, 2000)}`);
    }
  }
  throw new Error("工具调用轮数超限");
}

/** 语音转写：浏览器录音（webm/opus）→ qwen ASR */
export async function transcribeAudio(audioBase64: string, format = "webm"): Promise<string> {
  if (!aiConfigured()) throw new Error("AI_NOT_CONFIGURED");
  const res = await chatCompletions({
    model: config.ai.asrModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: `data:;base64,${audioBase64}`, format } },
          { type: "text", text: "请把这段语音原样转写成文字，不要添加任何内容。" },
        ],
      },
    ],
  });
  const text = res.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("转写结果为空");
  return text;
}
