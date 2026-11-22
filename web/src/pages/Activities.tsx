import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronRight, Layers, Heart, Timer, Route as RouteIcon } from "lucide-react";
import { api, fmtDuration, fmtKm, fmtPace } from "../api";
import { SportIcon, SPORT_META, sportLabel } from "../components/SportIcon";

interface Act {
  id: number; sport: string; name: string; start_time: string; duration_sec: number;
  distance_m: number | null; avg_hr: number | null; avg_pace_sec_km: number | null;
  avg_power: number | null; source_label: string; merged_sources: number; transferred: number;
  training_load: number | null;
}

const FILTERS = ["all", "running", "cycling", "swimming", "hiking", "other"];

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  const date = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY[d.getDay()]}`;
  if (diff === 0) return `今天 · ${date}`;
  if (diff === 1) return `昨天 · ${date}`;
  return date;
}

function Stat({ icon, value, sub }: { icon: React.ReactNode; value: string; sub?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-slate-600">
      <span className="text-slate-400">{icon}</span>
      <span className="num text-sm font-semibold text-slate-800">{value}</span>
      {sub && <span className="text-[11px] text-slate-500">{sub}</span>}
    </div>
  );
}

export default function Activities() {
  const navigate = useNavigate();
  const [acts, setActs] = useState<Act[]>([]);
  const [sport, setSport] = useState("all");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.get(`/api/activities?sport=${sport}&limit=200`).then((a: Act[]) => { setActs(a); setLoaded(true); }).catch(console.error);
  }, [sport]);

  const groups = useMemo(() => {
    const m = new Map<string, Act[]>();
    for (const a of acts) {
      const key = a.start_time.slice(0, 10);
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(a);
    }
    return [...m.entries()];
  }, [acts]);

  const totals = useMemo(() => ({
    count: acts.length,
    km: acts.reduce((s, a) => s + (a.distance_m || 0), 0) / 1000,
    hr: acts.reduce((s, a) => s + (a.duration_sec || 0), 0) / 3600,
  }), [acts]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">活动</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          共 <span className="num font-semibold text-slate-600">{totals.count}</span> 次训练 ·{" "}
          <span className="num font-semibold text-slate-600">{totals.km.toFixed(0)}</span> km ·{" "}
          <span className="num font-semibold text-slate-600">{totals.hr.toFixed(1)}</span> 小时（当前筛选）
        </p>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setSport(f)}
            className={`shrink-0 chip border transition-colors ${
              sport === f
                ? "bg-accent text-white border-accent"
                : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"
            }`}
          >
            {f === "all" ? "全部" : sportLabel(f)}
          </button>
        ))}
      </div>

      {loaded && acts.length === 0 && (
        <div className="card text-center py-12 text-slate-400 text-sm">暂无数据，点击左下角"立即同步"</div>
      )}

      {/* 桌面：密集表格 */}
      <div className="hidden lg:block card !p-0 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-slate-400 border-b border-slate-100">
              <th className="font-medium px-5 py-3">日期</th>
              <th className="font-medium px-3 py-3">活动</th>
              <th className="font-medium px-3 py-3 text-right">时长</th>
              <th className="font-medium px-3 py-3 text-right">距离</th>
              <th className="font-medium px-3 py-3 text-right">配速/均速</th>
              <th className="font-medium px-3 py-3 text-right">功率</th>
              <th className="font-medium px-3 py-3 text-right">均心</th>
              <th className="font-medium px-3 py-3 text-right">负荷</th>
              <th className="font-medium px-5 py-3 text-right">来源</th>
            </tr>
          </thead>
          <tbody>
            {acts.map((a, i) => {
              const prev = acts[i - 1];
              const newDay = !prev || prev.start_time.slice(0, 10) !== a.start_time.slice(0, 10);
              return (
                <tr key={a.id} onClick={() => navigate(`/activities/${a.id}`)}
                  className={`cursor-pointer hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 ${newDay && i > 0 ? "border-t border-t-slate-200/70" : ""}`}>
                  <td className="px-5 py-2.5 whitespace-nowrap text-slate-500 num">
                    {dayLabel(a.start_time)}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <SportIcon sport={a.sport} size={14} />
                      <span className="font-medium text-slate-800">{a.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right num text-slate-700">{fmtDuration(a.duration_sec)}</td>
                  <td className="px-3 py-2.5 text-right num text-slate-700">{fmtKm(a.distance_m, a.sport === "cycling" ? 1 : 2)}</td>
                  <td className="px-3 py-2.5 text-right num text-slate-700">
                    {a.sport === "cycling" ? (a.avg_pace_sec_km ? `${a.avg_pace_sec_km} km/h` : "—") : a.avg_pace_sec_km ? fmtPace(a.avg_pace_sec_km) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right num text-slate-700">{a.avg_power ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right num text-slate-700">{a.avg_hr ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right num text-slate-500">{a.training_load ? Math.round(a.training_load) : "—"}</td>
                  <td className="px-5 py-2.5 text-right">
                    <span className="chip bg-slate-100 text-slate-600 !px-1.5 !py-0"><Layers size={11} /> {a.merged_sources}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* 移动：分组卡片 */}
      <div className="lg:hidden space-y-4">
        {groups.map(([day, list]) => (
          <div key={day}>
            <div className="text-xs font-semibold text-slate-400 tracking-wide mb-2 pl-1">{dayLabel(list[0].start_time)}</div>
            <div className="space-y-2">
              {list.map((a) => (
                <Link key={a.id} to={`/activities/${a.id}`}
                  className="card lift !p-4 flex items-center gap-3.5 hover:border-slate-300 group">
                  <SportIcon sport={a.sport} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[15px] text-slate-900 truncate">{a.name}</span>
                      {a.merged_sources > 1 && (
                        <span className="chip !px-1.5 !py-0 bg-slate-100 text-slate-600 gap-0.5 shrink-0">
                          <Layers size={11} /> {a.merged_sources}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <Stat icon={<Timer size={13} />} value={fmtDuration(a.duration_sec)} />
                      {a.distance_m != null && (
                        <Stat icon={<RouteIcon size={13} />} value={fmtKm(a.distance_m, a.sport === "cycling" ? 1 : 2)} sub="km" />
                      )}
                      {a.sport === "cycling" && a.avg_power ? (
                        <Stat icon={<span className="text-[10px] font-bold">W</span>} value={`${a.avg_power}`} sub="均功率" />
                      ) : a.avg_pace_sec_km ? (
                        <Stat icon={<span className="text-[10px] font-bold">P</span>} value={fmtPace(a.avg_pace_sec_km)} sub="/km" />
                      ) : null}
                      {a.avg_hr ? <Stat icon={<Heart size={13} className="text-slate-400" />} value={`${a.avg_hr}`} sub="bpm" /> : null}
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-slate-300 group-hover:text-slate-500 transition-colors shrink-0" />
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
