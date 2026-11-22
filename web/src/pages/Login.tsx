import { useState } from "react";
import { Lock } from "lucide-react";
import { api } from "../api";

export default function Login({ onOk }: { onOk: () => void }) {
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api.post("/api/auth/login", { password: pwd });
      onOk();
    } catch (e: any) {
      setErr(e.message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-4 bg-[#1a1a1a]">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-3xl p-8 shadow-2xl space-y-5">
        <div className="text-center">
          <img src="/app-icon.png" alt="BodyTraining" className="inline-flex w-14 h-14 rounded-2xl mb-4" />
          <h1 className="text-xl font-bold tracking-tight">BodyTraining</h1>
          <p className="text-xs text-slate-400 mt-1">个人训练 · 数据 · AI 教练</p>
        </div>
        <div>
          <label className="label">访问密码</label>
          <div className="relative">
            <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="password" className="input !pl-9 !py-2.5" value={pwd}
              onChange={(e) => setPwd(e.target.value)} autoFocus placeholder="输入密码" />
          </div>
        </div>
        {err && <p className="text-[13px] text-red-600 bg-red-50 rounded-xl px-3.5 py-2.5">{err}</p>}
        <button className="btn-accent w-full !py-2.5" disabled={busy}>{busy ? "登录中…" : "登录"}</button>
      </form>
    </div>
  );
}
