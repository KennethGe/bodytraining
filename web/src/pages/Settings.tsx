import { useEffect, useState } from "react";
import {
  Database, ArrowLeftRight, Bot, HardDrive, User, RefreshCw, Plus, Play, Trash2,
  Download, RotateCcw, CheckCircle2, XCircle, Clock, Save,
} from "lucide-react";
import { api } from "../api";
import { sportLabel, SPORT_META } from "../components/SportIcon";

function Section({ icon: Icon, title, desc, children }: { icon: any; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="flex items-center gap-2.5 mb-4">
        <span className="flex items-center justify-center w-8 h-8 rounded-xl bg-slate-100 text-slate-600">
          <Icon size={15} />
        </span>
        <div>
          <h2 className="font-bold text-[15px] text-slate-900">{title}</h2>
          {desc && <p className="text-[11px] text-slate-400">{desc}</p>}
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button onClick={onChange} disabled={disabled}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${on ? "bg-accent" : "bg-slate-200"} ${disabled ? "opacity-40" : ""}`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

export default function Settings() {
  const [sources, setSources] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [syncLog, setSyncLog] = useState<any[]>([]);
  const [profile, setProfile] = useState<any>({});
  const [prompt, setPrompt] = useState("");
  const [memory, setMemory] = useState<any[]>([]);
  const [aiStatus, setAiStatus] = useState(true);
  const [msg, setMsg] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [strava, setStrava] = useState<any>({ connected: false, configured: false });
  const [newRule, setNewRule] = useState({ sourceType: "", targetType: "", sports: ["running"] });

  const load = () => {
    api.get("/api/sources").then((s: any[]) => {
      setSources(s);
      setNewRule((r) => ({
        ...r,
        sourceType: r.sourceType || s.find((x) => x.enabled)?.type || "",
        targetType: r.targetType || s.find((x) => x.enabled)?.type || "",
      }));
    });
    api.get("/api/transfer-rules").then(setRules);
    api.get("/api/transfer-log").then(setLogs);
    api.get("/api/sync-log").then(setSyncLog);
    api.get("/api/profile").then(setProfile);
    api.get("/api/coach/prompt").then((r: any) => setPrompt(r.prompt));
    api.get("/api/coach/memory").then(setMemory);
    api.get("/api/coach/status").then((r: any) => setAiStatus(r.configured));
    api.get("/api/strava/status").then(setStrava).catch(() => {});
  };
  useEffect(load, []);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("strava");
    if (q === "connected") { flash("Strava 已连接，回设置页开启同步"); load(); }
    else if (q === "denied") flash("Strava 授权被取消");
    else if (q === "error") flash("Strava 授权交换失败，重试");
    if (q) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  const connectStrava = async () => {
    const r: any = await api.get("/api/strava/auth-url");
    if (r.ok) window.open(r.url, "_blank");
    else flash(r.message || "无法生成 Strava 授权链接");
  };
  const disconnectStrava = async () => {
    await api.post("/api/strava/disconnect");
    load();
    flash("已断开 Strava");
  };

  const submitMfa = async () => {
    await api.post("/api/garmin/mfa", { code: mfaCode });
    setMfaCode("");
    flash("验证码已保存，正在重新同步佳明…");
    const garmin = sources.find((s) => s.type === "garmin");
    if (garmin) await api.post(`/api/sync/${garmin.id}`);
    load();
  };

  const toggleSource = async (s: any) => { await api.put(`/api/sources/${s.id}`, { enabled: !s.enabled }); load(); };
  const syncOne = async (s: any) => { flash(`正在同步 ${s.label}…`); await api.post(`/api/sync/${s.id}`); load(); flash("同步完成"); };

  const addRule = async () => { await api.post("/api/transfer-rules", { ...newRule, enabled: true }); load(); flash("规则已添加"); };
  const toggleRule = async (r: any) => { await api.put(`/api/transfer-rules/${r.id}`, { enabled: !r.enabled }); load(); };
  const delRule = async (r: any) => { await api.del(`/api/transfer-rules/${r.id}`); load(); };
  const runTransfer = async () => {
    flash("互导执行中…");
    const res: any = await api.post("/api/transfer-rules/run");
    load(); flash(`互导完成：成功 ${res.transferred}，失败 ${res.failed}`);
  };

  const savePrompt = async () => { await api.put("/api/coach/prompt", { prompt }); flash("教练 Prompt 已保存，立即生效"); };
  const delMemory = async (key: string) => { await api.del(`/api/coach/memory/${encodeURIComponent(key)}`); load(); };
  const saveProfile = async () => { await api.put("/api/profile", profile); flash("档案已保存"); };
  const replay = async () => {
    if (!confirm("将清空活动与健康数据并全量重新同步，确定？")) return;
    flash("重放中…"); await api.post("/api/data/replay"); load(); flash("重放完成");
  };
  const clearAll = async () => {
    if (!confirm("清空全部活动/健康数据（不可恢复，规则与记忆保留），确定？")) return;
    await api.post("/api/data/clear"); load(); flash("已清空");
  };

  const toggleSport = (sp: string) =>
    setNewRule((r) => ({ ...r, sports: r.sports.includes(sp) ? r.sports.filter((x) => x !== sp) : [...r.sports, sp] }));

  return (
    <div className="space-y-4 max-w-3xl xl:max-w-none xl:grid xl:grid-cols-2 xl:gap-4 xl:items-start">
      <div className="xl:col-span-2">
        <h1 className="page-title">设置</h1>
        <p className="text-sm text-slate-400 mt-0.5">数据源 · 互导 · AI · 数据 · 档案</p>
      </div>
      {msg && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-[13px] px-4 py-2.5 rounded-full z-50 shadow-lg">{msg}</div>
      )}

      <Section icon={Database} title="数据源" desc="同步频率 15 分钟 + 手动；凭据在 .env 配置后自动可用">
        {sources.map((s) => (
          <div key={s.id} className="flex items-center gap-3 flex-wrap py-2.5 border-b border-slate-50 last:border-0">
            <Toggle on={!!s.enabled} onChange={() => toggleSource(s)} disabled={!s.available} />
            <div className="flex-1 min-w-40">
              <div className={`text-sm font-medium ${s.available ? "text-slate-800" : "text-slate-400"}`}>{s.type === "strava" ? "Strava" : s.label}</div>
              <div className="text-[11px] mt-0.5 flex items-center gap-1.5">
                {!s.available && <span className="text-amber-600">{s.unavailable_reason}</span>}
                {s.available && (s.last_sync_status === "ok"
                  ? <span className="text-emerald-600 flex items-center gap-1"><CheckCircle2 size={11} /> {s.last_sync_at?.slice(5, 16).replace("T", " ")}</span>
                  : s.last_sync_status === "error"
                    ? <span className="text-red-500 flex items-center gap-1"><XCircle size={11} /> {s.last_sync_error}</span>
                    : <span className="text-slate-400 flex items-center gap-1"><Clock size={11} /> 未同步</span>)}
              </div>
            </div>
            <button className="btn-outline btn-sm" onClick={() => syncOne(s)} disabled={!s.enabled}>
              <RefreshCw size={12} /> 同步
            </button>
            {String(s.last_sync_error || "").includes("MFA") && (
              <div className="w-full flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                <span className="text-[11px] text-amber-700 shrink-0">佳明需要邮箱 MFA 验证码（查收 Garmin 邮件）：</span>
                <input className="input !w-28 !py-1 !text-xs" value={mfaCode} placeholder="6 位验证码"
                  onChange={(e) => setMfaCode(e.target.value)} />
                <button className="btn btn-sm" onClick={submitMfa} disabled={!mfaCode}>提交并同步</button>
              </div>
            )}
            {s.type === "strava" && (
              <div className="w-full flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-xl px-3 py-2">
                {strava.connected ? (
                  <>
                    <span className="text-[11px] text-orange-800 flex-1">
                      已连接 Strava{strava.athlete ? `（${strava.athlete}）` : ""} · 佳明+颂拓经官方同步汇入（逐秒流+圈）
                    </span>
                    <button className="btn-outline btn-sm" onClick={disconnectStrava}>断开</button>
                  </>
                ) : (
                  <>
                    <span className="text-[11px] text-orange-800 flex-1">
                      {strava.configured
                        ? "连接 Strava，统一汇入佳明与颂拓的官方同步数据"
                        : "先在 .env 配置 STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET（Strava API 应用）"}
                    </span>
                    <button className="btn-accent btn-sm" onClick={connectStrava} disabled={!strava.configured}>连接 Strava</button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        <p className="text-[11px] text-slate-400">同步每 15 分钟自动执行，也可手动立即同步；多源重复活动会自动合并展示。</p>
      </Section>

      {sources.filter((s) => s.enabled).length >= 2 && (
      <Section icon={ArrowLeftRight} title="活动互导" desc="按运动分类把活动从一个账号复制到另一个账号，防回环、自动与源合并">
        <div className="flex items-center gap-2 flex-wrap">
          <select className="input !w-40 !rounded-lg" value={newRule.sourceType} onChange={(e) => setNewRule({ ...newRule, sourceType: e.target.value })}>
            {sources.filter((s) => s.enabled).map((s) => <option key={s.id} value={s.type}>{s.type === "strava" ? "Strava" : s.label}</option>)}
          </select>
          <span className="text-slate-300">→</span>
          <select className="input !w-40 !rounded-lg" value={newRule.targetType} onChange={(e) => setNewRule({ ...newRule, targetType: e.target.value })}>
            {sources.filter((s) => s.enabled && s.type !== newRule.sourceType).map((s) => <option key={s.id} value={s.type}>{s.type === "strava" ? "Strava" : s.label}</option>)}
          </select>
          <div className="flex gap-1.5">
            {Object.keys(SPORT_META).map((k) => (
              <button key={k} onClick={() => toggleSport(k)}
                className={`chip border transition-colors ${newRule.sports.includes(k) ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-500 border-slate-200"}`}>
                {sportLabel(k)}
              </button>
            ))}
          </div>
          <button className="btn btn-sm" onClick={addRule} disabled={!newRule.sports.length || newRule.sourceType === newRule.targetType}>
            <Plus size={12} /> 添加
          </button>
          <button className="btn-outline btn-sm" onClick={runTransfer}><Play size={12} /> 立即执行</button>
        </div>
        {rules.map((r) => (
          <div key={r.id} className="flex items-center gap-3 py-2 border-b border-slate-50 last:border-0 text-sm">
            <Toggle on={!!r.enabled} onChange={() => toggleRule(r)} />
            <span className="text-slate-700">{r.source_type} <span className="text-slate-300 mx-1">→</span> {r.target_type}</span>
            <span className="text-[11px] text-slate-400">{JSON.parse(r.sports).map(sportLabel).join("、")}</span>
            <button className="btn-danger btn-sm ml-auto" onClick={() => delRule(r)}><Trash2 size={12} /></button>
          </div>
        ))}
        {logs.length > 0 && (
          <details className="text-[11px] text-slate-400">
            <summary className="cursor-pointer hover:text-slate-600">最近互导记录（{logs.length}）</summary>
            <div className="mt-2 space-y-1 max-h-40 overflow-y-auto bg-slate-50 rounded-xl p-3">
              {logs.map((l) => (
                <div key={l.id} className={l.status === "ok" ? "text-slate-500" : "text-red-500"}>
                  [{l.status}] {l.activity_name} → {l.target_type} {l.error || ""}
                </div>
              ))}
            </div>
          </details>
        )}
      </Section>
      )}

      <Section icon={Bot} title="AI 教练" desc={`千问 API：${aiStatus ? "已配置" : "未配置（.env 设置 DASHSCOPE_API_KEY）"}`}>
        <div>
          <label className="label">教练 Prompt · data/coach_prompt.md（保存即生效）</label>
          <textarea className="input font-mono !text-xs leading-relaxed" rows={14} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <button className="btn mt-2" onClick={savePrompt}><Save size={13} /> 保存 Prompt</button>
          <button className="btn-outline mt-2 ml-2" onClick={async () => {
            const r: any = await api.post("/api/coach/weekly/run", { force: true });
            flash(r.ok ? "周报已生成，去 AI 教练页查看" : `周报未生成：${r.reason}`);
          }}>📋 生成上周周报</button>
        </div>
        <div>
          <label className="label">长期记忆（教练自动记录；新增可直接在对话中告诉教练）</label>
          {memory.length === 0 && <p className="text-xs text-slate-300 py-2">暂无记忆</p>}
          {memory.map((m) => (
            <div key={m.key} className="flex items-center gap-2 py-2 border-b border-slate-50 last:border-0">
              <span className="font-mono text-[11px] text-slate-400 w-32 truncate shrink-0">{m.key}</span>
              <input className="input !py-1 !text-[13px]" defaultValue={m.content}
                onBlur={(e) => api.put("/api/coach/memory", { key: m.key, content: e.target.value })} />
              <button className="btn-danger btn-sm shrink-0" onClick={() => delMemory(m.key)}><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={HardDrive} title="数据" desc="备份 = SQLite 单文件；重放会用原始数据重新解析入库">
        <div className="flex gap-2 flex-wrap">
          <a className="btn-outline" href="/api/data/backup"><Download size={13} /> 下载数据库备份</a>
          <button className="btn-outline" onClick={replay}><RotateCcw size={13} /> 全量重放</button>
        </div>
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50/50 p-4">
          <div className="text-xs font-semibold text-red-700 mb-1">危险区</div>
          <p className="text-[11px] text-red-600/80 mb-2">清空不可恢复；操作前请先下载数据库备份。</p>
          <button className="btn-danger" onClick={clearAll}><Trash2 size={13} /> 清空活动/健康数据</button>
        </div>
        {syncLog.length > 0 && (
          <details className="text-[11px] text-slate-400">
            <summary className="cursor-pointer hover:text-slate-600">最近同步日志（{syncLog.length}）</summary>
            <div className="mt-2 space-y-1 max-h-40 overflow-y-auto bg-slate-50 rounded-xl p-3">
              {syncLog.map((l) => (
                <div key={l.id}>
                  [{l.status}] {l.label} {l.started_at?.slice(5, 16).replace("T", " ")} · 新 {l.activities_new ?? 0} · 更 {l.activities_updated ?? 0} · 健康 {l.health_rows ?? 0}
                  {l.error ? <span className="text-red-500"> · {l.error}</span> : ""}
                </div>
              ))}
            </div>
          </details>
        )}
      </Section>

      <Section icon={User} title="个人档案" desc="供 AI 分析与训练区间计算（储备心率法）">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            ["height_cm", "身高 cm"], ["weight_kg", "体重 kg"], ["age", "年龄"],
            ["max_hr", "最大心率"], ["resting_hr", "静息心率"],
          ].map(([k, l]) => (
            <div key={k}>
              <label className="label">{l}</label>
              <input type="number" className="input" value={profile[k] ?? ""}
                onChange={(e) => setProfile({ ...profile, [k]: Number(e.target.value) || null })} />
            </div>
          ))}
        </div>
        <div>
          <label className="label">训练目标（注入 AI 上下文）</label>
          <input className="input" value={profile.goal ?? ""} placeholder="如：12月全马 sub-4"
            onChange={(e) => setProfile({ ...profile, goal: e.target.value })} />
        </div>
        <button className="btn" onClick={saveProfile}><Save size={13} /> 保存档案</button>
      </Section>
    </div>
  );
}
