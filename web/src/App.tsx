import { NavLink, Navigate, Route, Routes, useNavigate, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { Activity, TrendingUp, HeartPulse, CalendarDays, Bot, Settings, Dumbbell, RefreshCw } from "lucide-react";
import { api } from "./api";
import Login from "./pages/Login";
import Activities from "./pages/Activities";
import ActivityDetail from "./pages/ActivityDetail";
import Trends from "./pages/Trends";
import Health from "./pages/Health";
import Plans from "./pages/Plans";
import Coach from "./pages/Coach";
import SettingsPage from "./pages/Settings";

const NAV = [
  { to: "/activities", label: "活动", icon: Activity },
  { to: "/trends", label: "趋势", icon: TrendingUp },
  { to: "/health", label: "健康", icon: HeartPulse },
  { to: "/plans", label: "计划", icon: CalendarDays },
  { to: "/coach", label: "AI 教练", icon: Bot },
  { to: "/settings", label: "设置", icon: Settings },
];

function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [syncing, setSyncing] = useState(false);
  const current = NAV.find((n) => location.pathname.startsWith(n.to));

  const syncNow = async () => {
    setSyncing(true);
    try { await api.post("/api/sync"); } finally { setSyncing(false); }
  };

  return (
    <div className="h-full flex">
      {/* 桌面侧边栏 */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 bg-white border-r border-slate-200/70">
        <div className="flex items-center gap-2.5 px-5 h-16 border-b border-slate-100">
          <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-slate-900 text-white">
            <Dumbbell size={18} />
          </span>
          <div>
            <div className="font-bold text-[15px] leading-tight tracking-tight">BodyTraining</div>
            <div className="text-[10px] text-slate-400 tracking-wide">个人训练 · 数据 · AI 教练</div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  isActive ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <n.icon size={17} strokeWidth={2} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-slate-100">
          <button className="btn-outline btn-sm w-full" onClick={syncNow} disabled={syncing}>
            <RefreshCw size={13} className={syncing ? "animate-spin" : ""} />
            {syncing ? "同步中…" : "立即同步"}
          </button>
        </div>
      </aside>

      {/* 主区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 移动端顶栏 */}
        <header className="md:hidden flex items-center justify-between px-4 h-14 bg-white/90 backdrop-blur border-b border-slate-200/70 sticky top-0 z-[1000]">
          <div className="flex items-center gap-2">
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-slate-900 text-white">
              <Dumbbell size={14} />
            </span>
            <span className="font-bold text-sm">{current?.label || "BodyTraining"}</span>
          </div>
          <button className="p-2 rounded-lg hover:bg-slate-100 text-slate-500" onClick={syncNow} disabled={syncing}>
            <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
          </button>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-6xl xl:max-w-[1360px] mx-auto px-4 md:px-8 py-5 md:py-8 pb-24 md:pb-8">{children}</div>
        </main>

        {/* 移动端底部 Tab */}
        <nav className="md:hidden fixed bottom-0 inset-x-0 z-[1000] bg-white/95 backdrop-blur border-t border-slate-200/70 flex pb-[env(safe-area-inset-bottom)]">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
                  isActive ? "text-emerald-600" : "text-slate-400"
                }`
              }
            >
              <n.icon size={19} strokeWidth={2} />
              {n.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<{ authRequired: boolean; loggedIn: boolean } | null>(null);

  useEffect(() => {
    api.get("/api/auth/status").then(setAuth);
  }, []);

  if (!auth)
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-400">
          <RefreshCw size={18} className="animate-spin" /> <span className="text-sm">加载中…</span>
        </div>
      </div>
    );

  if (auth.authRequired && !auth.loggedIn) {
    return (
      <Routes>
        <Route path="/login" element={<Login onOk={() => setAuth({ ...auth, loggedIn: true })} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/activities" element={<Layout><Activities /></Layout>} />
      <Route path="/activities/:id" element={<Layout><ActivityDetail /></Layout>} />
      <Route path="/trends" element={<Layout><Trends /></Layout>} />
      <Route path="/health" element={<Layout><Health /></Layout>} />
      <Route path="/plans" element={<Layout><Plans /></Layout>} />
      <Route path="/coach" element={<Layout><Coach /></Layout>} />
      <Route path="/settings" element={<Layout><SettingsPage /></Layout>} />
      <Route path="*" element={<Navigate to="/activities" replace />} />
    </Routes>
  );
}
