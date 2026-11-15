import { useEffect, useState } from "react";
import { Moon, Heart, Activity, Footprints, BatteryCharging, Brain, AlertTriangle } from "lucide-react";
import { api } from "../api";
import Chart, { axisStyle, PALETTE } from "../components/Chart";

const METRICS = [
  { key: "sleep_min", label: "睡眠", icon: Moon, color: "#6366f1", fmt: (v: number) => `${Math.floor(v / 60)}h${String(v % 60).padStart(2, "0")}m` },
  { key: "resting_hr", label: "静息心率", icon: Heart, color: "#e11d48", fmt: (v: number) => `${Math.round(v)}` },
  { key: "hrv_ms", label: "HRV", icon: Activity, color: "#059669", fmt: (v: number) => `${Math.round(v)}` },
  { key: "steps", label: "步数", icon: Footprints, color: "#d97706", fmt: (v: number) => v >= 10000 ? `${(v / 10000).toFixed(1)}万` : `${Math.round(v)}` },
  { key: "stress", label: "压力", icon: Brain, color: "#f97316", fmt: (v: number) => `${Math.round(v)}` },
  { key: "body_battery", label: "身体电量", icon: BatteryCharging, color: "#0ea5e9", fmt: (v: number) => `${Math.round(v)}` },
];

export default function Health() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    setData(null);
    api.get(`/api/health?days=${days}`).then(setData).catch(console.error);
  }, [days]);

  if (!data) return <div className="text-slate-400 text-sm p-4">加载中…</div>;

  const todayMap: Record<string, number> = {};
  for (const t of data.today) todayMap[t.metric] = t.value;

  const lineOption = (metric: string, color: string) => {
    const s = data.series[metric] || [];
    return {
      xAxis: { type: "category", data: s.map((p: any) => p.date.slice(5)), ...axisStyle(), boundaryGap: false },
      yAxis: { type: "value", scale: true, ...axisStyle() },
      series: [{
        type: "line", data: s.map((p: any) => p.value), showSymbol: false, smooth: 0.35,
        lineStyle: { width: 2, color },
        areaStyle: { opacity: 0.08, color },
      }],
    } as any;
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title">健康状态</h1>
          <p className="text-sm text-slate-400 mt-0.5">来自主数据源 · 异常自动提示</p>
        </div>
        <div className="flex bg-slate-100 rounded-xl p-1 gap-0.5">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                days === d ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {d} 天
            </button>
          ))}
        </div>
      </div>

      {data.alerts?.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-1.5">
          {data.alerts.map((a: string, i: number) => (
            <div key={i} className="flex items-start gap-2 text-sm text-amber-800">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />{a}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {METRICS.map((m) => {
          const v = todayMap[m.key];
          const Icon = m.icon;
          return (
            <div key={m.key} className="card !p-4">
              <div className="flex items-center gap-2 text-[11px] text-slate-400 font-medium">
                <span className="flex items-center justify-center w-6 h-6 rounded-lg" style={{ background: `${m.color}14`, color: m.color }}>
                  <Icon size={13} />
                </span>
                今日{m.label}
              </div>
              <div className="num text-2xl font-bold mt-2" style={{ color: v != null ? m.color : "#cbd5e1" }}>
                {v != null ? m.fmt(v) : "—"}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {METRICS.map((m) => (data.series[m.key]?.length ?? 0) > 1 && (
          <div key={m.key} className="card">
            <h2 className="card-title">{m.label}趋势</h2>
            <Chart option={lineOption(m.key, m.color)} height={170} />
          </div>
        ))}
      </div>

      <p className="text-[11px] text-slate-400 leading-relaxed">
        每个指标展示"主数据源"数值（按数据源优先级自动选取），可在 设置 → 数据源 调整优先级或禁用来源。
      </p>
    </div>
  );
}
