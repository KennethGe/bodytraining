import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Bot, Layers, Heart, Timer, Route as RouteIcon, Flame, Mountain, Gauge, TrendingUp, Activity as ActivityIcon } from "lucide-react";
import { api, fmtDate, fmtDuration, fmtKm, fmtPace } from "../api";
import Chart, { axisStyle, PALETTE } from "../components/Chart";
import GpsMap from "../components/GpsMap";
import { SportIcon, sportLabel } from "../components/SportIcon";

const ZONE_COLORS = ["#cbd5e1", "#7dd3fc", "#6ee7b7", "#fcd34d", "#fb7185"];
const ZONE_NAMES = ["Z1 恢复", "Z2 有氧", "Z3 节奏", "Z4 阈值", "Z5 极限"];

function Metric({ icon, label, value, unit }: { icon?: React.ReactNode; label: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-white/50 flex items-center gap-1">{icon}{label}</span>
      <span className="num text-2xl md:text-3xl font-semibold text-white">
        {value}
        {unit && <span className="text-xs font-medium text-white/40 ml-1">{unit}</span>}
      </span>
    </div>
  );
}

export default function ActivityDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<any>(null);
  const [streams, setStreams] = useState<Record<string, number[][]>>({});
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get(`/api/activities/${id}`).then(setDetail).catch((e) => setErr(e.message));
    api.get(`/api/activities/${id}/streams`).then(setStreams).catch(console.error);
  }, [id]);

  if (err) return <div className="card text-red-600 text-sm">{err}</div>;
  if (!detail) return <div className="text-slate-400 text-sm p-4">加载中…</div>;

  const a = detail.activity;
  const st = detail.stats;
  const isRide = a.sport === "cycling";

  const lineOption = (pts: number[][], color: string, name: string, invert = false) => ({
    xAxis: { type: "category", data: pts.map((p) => `${Math.floor(p[0] / 60)}'`), ...axisStyle(), boundaryGap: false },
    yAxis: { type: "value", scale: !invert, inverse: invert, ...axisStyle(), nameStyle: { color: "#94a3b8", fontSize: 10 } },
    series: [{
      name, type: "line", data: pts.map((p) => p[1]), showSymbol: false, smooth: 0.3,
      lineStyle: { width: 2, color },
      areaStyle: { opacity: 0.3, color, origin: invert ? "end" : "auto" },
    }],
  });

  return (
    <div className="space-y-4">
      <button className="flex items-center gap-1 text-sm text-slate-400 hover:text-slate-700 transition-colors" onClick={() => navigate(-1)}>
        <ArrowLeft size={15} /> 返回
      </button>

      {/* 头卡 */}
      <div className="panel-dark">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3.5">
            <SportIcon sport={a.sport} size={22} />
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">{a.name}</h1>
              <p className="text-[13px] text-white/50 mt-0.5 flex items-center gap-2 flex-wrap">
                {fmtDate(a.start_time)} · {sportLabel(a.sport)}
                {detail.sources?.length > 1 && (
                  <span className="chip !py-0.5 bg-white/10 text-white/80">
                    <Layers size={11} /> {detail.sources.join(" + ")} 已合并
                  </span>
                )}
              </p>
            </div>
          </div>
          <button className="btn-accent" onClick={() => navigate(`/coach?activity=${a.id}`)}>
            <Bot size={15} /> AI 分析本次活动
          </button>
        </div>

        <div className="grid grid-cols-3 md:grid-cols-5 gap-x-4 gap-y-5 mt-6">
          <Metric icon={<RouteIcon size={11} />} label="距离" value={fmtKm(a.distance_m, isRide ? 1 : 2)} unit="km" />
          <Metric icon={<Timer size={11} />} label="时长" value={fmtDuration(a.duration_sec)} />
          <Metric icon={<Heart size={11} className="text-rose-400" />} label="平均心率" value={a.avg_hr ? `${a.avg_hr}` : "—"} unit={a.avg_hr ? "bpm" : undefined} />
          <Metric icon={<Gauge size={11} />} label={isRide ? "均速" : "均配速"}
            value={isRide ? (st.avgPaceSecKm ? `${st.avgPaceSecKm}` : "—") : fmtPace(a.avg_pace_sec_km)}
            unit={isRide ? "km/h" : a.avg_pace_sec_km ? "/km" : undefined} />
          <Metric icon={<Mountain size={11} />} label="爬升" value={a.ascent_m != null ? `${Math.round(a.ascent_m)}` : "—"} unit={a.ascent_m != null ? "m" : undefined} />
          {isRide && <Metric icon={<TrendingUp size={11} />} label="平均功率" value={st.avgPower ? `${st.avgPower}` : "—"} unit={st.avgPower ? "W" : undefined} />}
          <Metric icon={<Flame size={11} />} label="卡路里" value={a.calories ? `${Math.round(a.calories)}` : "—"} unit={a.calories ? "kcal" : undefined} />
          <Metric icon={<ActivityIcon size={11} />} label="训练负荷" value={a.training_load ? `${Math.round(a.training_load)}` : "—"} />
          <Metric icon={<Heart size={11} />} label="最大心率" value={a.max_hr ? `${a.max_hr}` : "—"} unit={a.max_hr ? "bpm" : undefined} />
        </div>

        {st.hrZonePct && (
          <div className="mt-6">
            <div className="text-[11px] text-white/50 mb-2">心率区间分布（储备心率法）</div>
            <div className="flex h-2.5 rounded-full overflow-hidden gap-0.5">
              {st.hrZonePct.map((p: number, i: number) => p > 0 && (
                <div key={i} style={{ width: `${p}%`, background: ZONE_COLORS[i] }} title={`${ZONE_NAMES[i]}: ${p}%`} />
              ))}
            </div>
            <div className="flex gap-4 mt-2 flex-wrap">
              {st.hrZonePct.map((p: number, i: number) => (
                <span key={i} className="text-[11px] text-white/50 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: ZONE_COLORS[i] }} />
                  {ZONE_NAMES[i]} <b className="num text-white">{p}%</b>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px] items-start">
        {/* 左：图表流 */}
        <div className="space-y-4 min-w-0">
          {streams.hr?.length > 0 && (
            <div className="card">
              <h2 className="card-title">心率 · 每分钟均值</h2>
              <Chart option={lineOption(st.hrPerMin, PALETTE.red, "bpm") as any} />
            </div>
          )}
          {streams.pace?.length > 0 && (
            <div className="card">
              <h2 className="card-title">{isRide ? "速度 · km/h" : "配速 · 秒/公里"}</h2>
              <Chart option={lineOption(st.pacePerMin, PALETTE.accent, isRide ? "km/h" : "配速", !isRide) as any} />
            </div>
          )}
          {streams.power?.length > 0 && (
            <div className="card">
              <h2 className="card-title">功率 · 每分钟均值</h2>
              <Chart option={lineOption(st.powerPerMin, PALETTE.amber, "W") as any} />
            </div>
          )}
          {streams.altitude?.length > 0 && (
            <div className="card">
              <h2 className="card-title">海拔剖面</h2>
              <Chart option={lineOption(streams.altitude.filter((_: number[], i: number) => i % 12 === 0), PALETTE.slate, "m") as any} height={160} />
            </div>
          )}
        </div>

        {/* 右：轨迹 + 来源（桌面吸顶） */}
        <div className="space-y-4 lg:sticky lg:top-8 min-w-0">
          <div className="card !p-0 overflow-hidden">
            <GpsMap points={streams.gps || []} height={280} />
          </div>
          {detail.sources?.length > 1 && (
            <div className="card !p-4">
              <h2 className="card-title !mb-2">数据来源（已查重合并）</h2>
              <div className="flex flex-wrap gap-1.5">
                {detail.sources.map((s: string) => (
                  <span key={s} className="chip bg-slate-100 text-slate-600"><Layers size={11} /> {s}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
