import { useEffect, useState } from "react";
import { CalendarDays, Send, Trash2, Check, ChevronDown, Sparkles } from "lucide-react";
import { api } from "../api";
import { SportIcon, sportLabel, SPORT_META } from "../components/SportIcon";

interface Workout {
  id: number; plan_id: number; date: string; sport: string; title: string;
  steps: string; push_target: string | null; push_status: string; push_error: string | null;
}
interface Plan { id: number; goal: string; start_date: string; weeks: number; status: string }

const STATUS = {
  pending: { label: "待推送", cls: "bg-slate-100 text-slate-500" },
  pushed: { label: "已推送", cls: "bg-emerald-50 text-emerald-700" },
  failed: { label: "失败", cls: "bg-red-50 text-red-600" },
  expired: { label: "已过期", cls: "bg-slate-100 text-slate-400" },
} as const;

const WEEKDAY = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function WorkoutCard({ w, compact, updateWorkout, push, remove, setMsg }: {
  w: Workout; compact?: boolean;
  updateWorkout: (w: Workout, patch: Record<string, unknown>) => void;
  push: (w: Workout) => void;
  remove: (w: Workout) => void;
  setMsg: (m: string) => void;
}) {
  const st = STATUS[w.push_status as keyof typeof STATUS] || STATUS.pending;
  const wd = WEEKDAY[(new Date(w.date + "T00:00:00").getDay() + 6) % 7];
  return (
    <div className={compact ? "rounded-xl border border-slate-200/70 bg-white p-2.5 space-y-2" : "card !p-4 space-y-2"}>
      <div className={`flex items-center gap-2 ${compact ? "flex-col !items-stretch" : "flex-wrap"}`}>
        {!compact && <SportIcon sport={w.sport} />}
        {compact && (
          <div className="flex items-center justify-between">
            <SportIcon sport={w.sport} size={14} />
            <span className={`chip !px-1.5 !py-0 !text-[10px] ${st.cls}`}>{st.label}</span>
          </div>
        )}
        {!compact && (
          <div className="text-center w-12 shrink-0">
            <div className="text-[10px] text-slate-400">{wd}</div>
            <div className="num text-sm font-bold">{w.date.slice(5).replace("-", "/")}</div>
          </div>
        )}
        <input className={`input font-semibold ${compact ? "!py-1 !text-xs" : "!w-48"}`} value={w.title}
          onChange={(e) => updateWorkout(w, { title: e.target.value })} />
        {!compact && (
          <>
            <select className="input !w-24" value={w.sport} onChange={(e) => updateWorkout(w, { sport: e.target.value })}>
              {Object.entries(SPORT_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
            <select className="input !w-32" value={w.push_target || "garmin"} onChange={(e) => updateWorkout(w, { pushTarget: e.target.value })}>
              <option value="garmin">→ 佳明</option>
              <option value="suunto">→ 颂拓</option>
            </select>
            <span className={`chip ${st.cls}`}>{st.label}</span>
          </>
        )}
        <div className={`${compact ? "flex gap-1" : "ml-auto flex gap-2"}`}>
          {compact && (
            <select className="input !py-1 !px-1.5 !text-[10px] flex-1 min-w-0" value={w.push_target || "garmin"} onChange={(e) => updateWorkout(w, { pushTarget: e.target.value })}>
              <option value="garmin">佳明</option>
              <option value="suunto">颂拓</option>
            </select>
          )}
          <button className={compact ? "btn btn-sm !px-2 shrink-0" : "btn btn-sm"} onClick={() => push(w)} title="推送">
            <Send size={12} />{compact ? null : " 推送"}
          </button>
          <button className="btn-danger btn-sm !px-2 shrink-0" onClick={() => remove(w)} title="删除"><Trash2 size={12} /></button>
        </div>
      </div>
      {w.push_error && <p className="text-xs text-red-500">{w.push_error}</p>}
      <details className="text-xs text-slate-400">
        <summary className="cursor-pointer flex items-center gap-1 hover:text-slate-600">
          <ChevronDown size={12} /> 课程步骤 JSON
        </summary>
        <textarea className="input font-mono !text-xs mt-2" rows={compact ? 3 : 4} defaultValue={w.steps}
          onBlur={(e) => {
            try { JSON.parse(e.target.value); updateWorkout(w, { steps: e.target.value }); }
            catch { setMsg("步骤 JSON 格式错误，未保存"); }
          }} />
      </details>
    </div>
  );
}

export default function Plans() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [msg, setMsg] = useState("");

  const openPlan = (id: number) => api.get(`/api/plans/${id}`).then(setSel);
  const load = () => api.get("/api/plans").then((p: Plan[]) => {
    setPlans(p);
    if (p.length) openPlan(p[0].id);
  });
  useEffect(() => { load(); }, []);

  const updateWorkout = async (w: Workout, patch: Record<string, unknown>) => {
    await api.put(`/api/plan-workouts/${w.id}`, patch);
    openPlan(w.plan_id);
  };
  const push = async (w: Workout) => {
    setMsg("");
    try { await api.post(`/api/plan-workouts/${w.id}/push`); setMsg(`✓ 已推送「${w.title}」`); }
    catch (e: any) { setMsg(`推送失败：${e.message}`); }
    openPlan(w.plan_id);
  };
  const remove = async (w: Workout) => { await api.del(`/api/plan-workouts/${w.id}`); openPlan(w.plan_id); };
  const activate = async (p: Plan) => { await api.post(`/api/plans/${p.id}/activate`); load(); openPlan(p.id); };

  const byWeek: [string, Workout[]][] = [];
  for (const w of sel?.workouts || []) {
    const d = new Date(w.date + "T00:00:00");
    const ws = new Date(d.getTime() - ((d.getDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
    let g = byWeek.find((x) => x[0] === ws);
    if (!g) { g = [ws, []]; byWeek.push(g); }
    g[1].push(w);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">训练计划</h1>
        <p className="text-sm text-slate-400 mt-0.5 flex items-center gap-1.5">
          <Sparkles size={13} className="text-emerald-500" />
          在 AI 教练对话中描述目标生成计划草稿，确认后逐课推送到手表
        </p>
      </div>

      {msg && <div className="chip bg-slate-900 !text-white text-sm !px-4 !py-2 rounded-xl">{msg}</div>}

      {plans.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {plans.map((p) => (
            <button key={p.id} onClick={() => openPlan(p.id)}
              className={`shrink-0 card !p-3 !rounded-xl text-sm font-medium transition-colors ${
                sel?.plan.id === p.id ? "border-slate-900 bg-slate-900 text-white" : "hover:border-slate-300"}`}>
              {p.goal}
              <span className={`ml-2 text-[10px] ${sel?.plan.id === p.id ? "text-slate-300" : "text-slate-400"}`}>
                {p.status === "active" ? "进行中" : "草稿"}
              </span>
            </button>
          ))}
        </div>
      )}

      {!sel && (
        <div className="card text-center py-16">
          <CalendarDays size={36} className="mx-auto text-slate-200 mb-3" />
          <p className="text-sm text-slate-400">暂无计划</p>
          <p className="text-xs text-slate-300 mt-1">去 AI 教练页说"帮我制定一个 8 周半马训练计划"</p>
        </div>
      )}

      {sel && (
        <>
          <div className="card flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-bold text-lg tracking-tight">{sel.plan.goal}</h2>
              <p className="text-xs text-slate-400 mt-1">
                开始 {sel.plan.start_date} · {sel.plan.weeks} 周 · {sel.workouts.length} 课 ·{" "}
                {sel.plan.status === "active" ? <span className="text-emerald-600 font-medium">进行中</span> : <span className="text-amber-600 font-medium">草稿</span>}
              </p>
            </div>
            {sel.plan.status === "draft" && (
              <button className="btn-accent" onClick={() => activate(sel.plan)}><Check size={15} /> 确认启用</button>
            )}
          </div>

          {byWeek.map(([weekStart, ws], wi) => (
            <div key={weekStart}>
              <h3 className="text-xs font-bold text-slate-400 tracking-wide mb-2.5 pl-1">第 {wi + 1} 周 · {weekStart.slice(5)} 起</h3>
              {/* 桌面：周历七列；移动：堆叠 */}
              <div className="hidden lg:grid grid-cols-7 gap-2">
                {WEEKDAY.map((wd, di) => {
                  const dayWorkouts = ws.filter((w) => (new Date(w.date + "T00:00:00").getDay() + 6) % 7 === di);
                  return (
                    <div key={wd} className="min-h-32 rounded-2xl bg-white/60 border border-slate-200/60 p-2 space-y-2">
                      <div className="text-[10px] font-semibold text-slate-400 text-center pb-1 border-b border-slate-100">{wd}</div>
                      {dayWorkouts.length === 0 && <div className="text-center text-[10px] text-slate-200 pt-6">休息</div>}
                      {dayWorkouts.map((w) => (
                        <WorkoutCard key={w.id} w={w} updateWorkout={updateWorkout} push={push} remove={remove} setMsg={setMsg} compact />
                      ))}
                    </div>
                  );
                })}
              </div>
              <div className="lg:hidden space-y-2.5">
                {ws.map((w) => (
                  <WorkoutCard key={w.id} w={w} updateWorkout={updateWorkout} push={push} remove={remove} setMsg={setMsg} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
