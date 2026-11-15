import { useMemo } from "react";
import { MapPin } from "lucide-react";

// SVG 轨迹图：不依赖外部瓦片服务，离线可用，风格统一
export default function GpsMap({ points, height = 300 }: { points: number[][]; height?: number }) {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const lats = points.map((p) => p[0]);
    const lons = points.map((p) => p[1]);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const pad = 24;
    const W = 1000, H = 420;
    const sx = (lon: number) =>
      pad + ((lon - minLon) / Math.max(1e-9, maxLon - minLon)) * (W - pad * 2);
    const sy = (lat: number) =>
      H - pad - ((lat - minLat) / Math.max(1e-9, maxLat - minLat)) * (H - pad * 2);
    // 抽稀到 ~600 点
    const step = Math.max(1, Math.floor(points.length / 600));
    const pts: [number, number][] = [];
    for (let i = 0; i < points.length; i += step) pts.push([sx(points[i][1]), sy(points[i][0])]);
    const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    return {
      d,
      start: pts[0],
      end: pts[pts.length - 1],
      km: null as null,
    };
  }, [points]);

  if (!path) {
    return (
      <div className="flex flex-col items-center justify-center text-slate-300" style={{ height }}>
        <MapPin size={28} />
        <span className="text-xs mt-2">无 GPS 轨迹</span>
      </div>
    );
  }

  return (
    <div className="relative bg-slate-50/60" style={{ height }}>
      <svg viewBox="0 0 1000 420" preserveAspectRatio="xMidYMid meet" className="w-full h-full">
        <defs>
          <linearGradient id="trackGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#059669" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
        </defs>
        <path d={path.d} fill="none" stroke="url(#trackGrad)" strokeWidth={5}
          strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
        <circle cx={path.start[0]} cy={path.start[1]} r={9} fill="#059669" stroke="#fff" strokeWidth={3} />
        <circle cx={path.end[0]} cy={path.end[1]} r={9} fill="#e11d48" stroke="#fff" strokeWidth={3} />
      </svg>
      <span className="absolute left-4 top-3 chip bg-white border border-slate-200 text-slate-500 shadow-sm">
        <span className="w-2 h-2 rounded-full bg-emerald-500" /> 起点
        <span className="w-2 h-2 rounded-full bg-rose-500 ml-2" /> 终点
      </span>
    </div>
  );
}
