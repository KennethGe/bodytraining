async function request(path: string, options: RequestInit = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401 && !path.startsWith("/api/auth")) {
    window.location.href = "/login";
    throw new Error("未登录");
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data as any)?.error || `请求失败 ${res.status}`);
  return data;
}

export const api = {
  get: (p: string) => request(p),
  post: (p: string, body?: unknown) => request(p, { method: "POST", body: body != null ? JSON.stringify(body) : undefined }),
  put: (p: string, body?: unknown) => request(p, { method: "PUT", body: body != null ? JSON.stringify(body) : undefined }),
  del: (p: string) => request(p, { method: "DELETE" }),
};

// ---------- 格式化 ----------
export const fmtDuration = (sec?: number | null) => {
  if (sec == null) return "-";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
export const fmtKm = (m?: number | null, digits = 1) => (m == null ? "-" : (m / 1000).toFixed(digits));
export const fmtPace = (secKm?: number | null) => {
  if (secKm == null) return "-";
  const m = Math.floor(secKm / 60), s = Math.round(secKm % 60);
  return `${m}'${String(s).padStart(2, "0")}"`;
};
export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const SPORT_LABEL: Record<string, string> = {
  running: "跑步", cycling: "骑行", swimming: "游泳", hiking: "徒步", other: "其他",
};
export const SPORT_ICON: Record<string, string> = {
  running: "🏃", cycling: "🚴", swimming: "🏊", hiking: "🥾", other: "⚡",
};
export const METRIC_LABEL: Record<string, string> = {
  sleep_min: "睡眠(分)", resting_hr: "静息心率", hrv_ms: "HRV(ms)", steps: "步数",
  stress: "压力", body_battery: "身体电量", spo2: "血氧%",
};
