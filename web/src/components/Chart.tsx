import { useEffect, useRef } from "react";
import * as echarts from "echarts";

// 统一图表主题：细网格、无边框坐标轴、系统字体
const BASE: echarts.EChartsOption = {
  textStyle: { fontFamily: "-apple-system, PingFang SC, sans-serif", fontSize: 11 },
  grid: { left: 8, right: 16, top: 28, bottom: 4, containLabel: true },
  tooltip: {
    trigger: "axis",
    backgroundColor: "rgba(15,23,42,0.92)",
    borderWidth: 0,
    textStyle: { color: "#fff", fontSize: 12 },
    axisPointer: { type: "line", lineStyle: { color: "#cbd5e1", width: 1, type: "dashed" } },
  },
};

export const PALETTE = {
  accent: "#fc4c02",
  ink: "#232323",
  blue: "#2563eb",
  red: "#e11d48",
  amber: "#d97706",
  violet: "#94a3b8",
  cyan: "#0891b2",
  slate: "#64748b",
  grid: "#f1f5f9",
};

export function axisStyle() {
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: PALETTE.grid } },
    axisLabel: { color: "#64748b", fontSize: 11 },
  };
}

export default function Chart({ option, height = 240 }: { option: echarts.EChartsOption; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current);
    return () => { ro.disconnect(); chart.current?.dispose(); };
  }, []);

  useEffect(() => {
    chart.current?.setOption({ ...BASE, ...option }, true);
  }, [option]);

  return <div ref={ref} style={{ height, width: "100%" }} />;
}
