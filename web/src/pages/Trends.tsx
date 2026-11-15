import { useEffect, useState } from "react";
import { api } from "../api";
import Chart, { axisStyle, PALETTE } from "../components/Chart";
import { sportLabel, SPORT_META } from "../components/SportIcon";

const RANGES: [string, string][] = [["week", "4 周"], ["month", "90 天"], ["year", "1 年"]];

export default function Trends() {
  const [range, setRange] = useState("month");
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    setData(null);
    api.get(`/api/trends?range=${range}`).then(setData).catch(console.error);
  }, [range]);

  if (!data) return <div className="text-slate-400 text-sm p-4">加载中…</div>;
  const weeks = (Object.entries(data.weeks) as [string, any][]).sort((a, b) => a[0].localeCompare(b[0]));

  const totals = weeks.reduce((s, w) => ({
    km: s.km + w[1].distance / 1000, h: s.h + w[1].duration / 3600, load: s.load + w[1].load, n: s.n + w[1].count,
  }), { km: 0, h: 0, load: 0, n: 0 });

  const barOption = (values: number[], color: string, name: string) => ({
    xAxis: { type: "category", data: weeks.map((w) => w[0].slice(5)), ...axisStyle() },
    yAxis: { type: "value", ...axisStyle() },
    series: [{
      name, type: "bar", data: values, barMaxWidth: 26,
      itemStyle: { color, borderRadius: [6, 6, 2, 2] },
    }],
  });

  const sportPie = Object.entries(data.sports).map(([k, v]) => ({
    name: sportLabel(k), value: Math.round((v as number) / 60),
    itemStyle: { color: SPORT_META[k]?.color || PALETTE.slate },
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title">趋势</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            合计 <b className="num text-slate-600">{totals.km.toFixed(0)}</b> km ·{" "}
            <b className="num text-slate-600">{totals.h.toFixed(1)}</b> h ·{" "}
            <b className="num text-slate-600">{totals.n}</b> 次训练
          </p>
        </div>
        <div className="flex bg-slate-100 rounded-xl p-1 gap-0.5">
          {RANGES.map(([k, l]) => (
            <button key={k} onClick={() => setRange(k)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                range === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="card-title">周距离 · km</h2>
          <Chart option={barOption(weeks.map((w) => +(w[1].distance / 1000).toFixed(1)), PALETTE.blue, "km") as any} height={200} />
        </div>
        <div className="card">
          <h2 className="card-title">周时长 · 小时</h2>
          <Chart option={barOption(weeks.map((w) => +(w[1].duration / 3600).toFixed(1)), PALETTE.accent, "h") as any} height={200} />
        </div>
        <div className="card">
          <h2 className="card-title">周训练负荷</h2>
          <Chart option={barOption(weeks.map((w) => w[1].load), PALETTE.amber, "负荷") as any} height={200} />
        </div>
        <div className="card">
          <h2 className="card-title">运动类型分布 · 分钟</h2>
          <Chart option={{
            tooltip: { trigger: "item" },
            legend: { bottom: 0, icon: "circle", itemWidth: 8, textStyle: { fontSize: 11, color: "#64748b" } },
            series: [{
              type: "pie", radius: ["52%", "74%"], center: ["50%", "44%"],
              itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
              label: { show: false }, data: sportPie,
            }],
          } as any} height={200} />
        </div>
      </div>
    </div>
  );
}
