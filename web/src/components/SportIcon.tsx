import { Play, Bike, Waves, Mountain, Zap } from "lucide-react";

export const SPORT_META: Record<string, { label: string; icon: any; color: string; bg: string }> = {
  running: { label: "跑步", icon: Play, color: "#059669", bg: "#ecfdf5" },
  cycling: { label: "骑行", icon: Bike, color: "#2563eb", bg: "#eff6ff" },
  swimming: { label: "游泳", icon: Waves, color: "#0891b2", bg: "#ecfeff" },
  hiking: { label: "徒步", icon: Mountain, color: "#d97706", bg: "#fffbeb" },
  other: { label: "其他", icon: Zap, color: "#7c3aed", bg: "#f5f3ff" },
};

export function SportIcon({ sport, size = 18 }: { sport: string; size?: number }) {
  const meta = SPORT_META[sport] || SPORT_META.other;
  const Icon = meta.icon;
  return (
    <span
      className="inline-flex items-center justify-center rounded-xl shrink-0"
      style={{ background: meta.bg, color: meta.color, width: size + 18, height: size + 18 }}
    >
      <Icon size={size} strokeWidth={2.2} />
    </span>
  );
}

export const sportLabel = (s: string) => (SPORT_META[s] || SPORT_META.other).label;
