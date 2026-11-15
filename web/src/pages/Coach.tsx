import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bot, Plus, Image as ImageIcon, Mic, Square, Send, KeyRound, Wrench, MessageSquare } from "lucide-react";
import { api } from "../api";

interface Msg { id: number; role: string; content: string }

const SUGGESTIONS = [
  "分析我今天的跑步质量课",
  "最近一周我的恢复状态怎么样？",
  "帮我制定 8 周后的半马训练计划",
];

export default function Coach() {
  const [params] = useSearchParams();
  const [configured, setConfigured] = useState(true);
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState("");
  const [trace, setTrace] = useState<string[] | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get("/api/coach/status").then((s: any) => setConfigured(s.configured));
    api.get("/api/coach/sessions").then(setSessions);
    const actId = params.get("activity");
    if (actId) setInput(`请分析活动 #${actId}（用工具获取详情，重点评估当日质量课结构）`);
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  const openSession = async (id: number) => {
    setSessionId(id);
    setMsgs(await api.get(`/api/coach/sessions/${id}/messages`) as Msg[]);
    setTrace(null); setErr("");
  };
  const newSession = () => { setSessionId(null); setMsgs([]); setTrace(null); setErr(""); };

  const finish = (res: any, userText: string) => {
    setSessionId(res.sessionId);
    setMsgs((m) => [...m, { id: Date.now() + 1, role: "assistant", content: res.reply }]);
    if (res.toolTrace?.length) setTrace(res.toolTrace);
    api.get("/api/coach/sessions").then(setSessions);
    void userText;
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setErr(""); setTrace(null); setInput("");
    const uid = Date.now();
    setMsgs((m) => [...m, { id: uid, role: "user", content: text }]);
    setBusy(true);
    try {
      finish(await api.post("/api/coach/chat", { sessionId, text }), text);
    } catch (e: any) {
      setErr(e.message);
      setMsgs((m) => m.filter((x) => x.id !== uid));
      setInput(text);
    } finally { setBusy(false); }
  };

  const onImage = async (f: File) => {
    const dataUrl: string = await new Promise((res) => {
      const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(f);
    });
    setBusy(true); setErr(""); setTrace(null);
    const uid = Date.now();
    setMsgs((m) => [...m, { id: uid, role: "user", content: `📷 ${input.trim() || "[图片]"}` }]);
    try {
      finish(await api.post("/api/coach/chat", { sessionId, text: input.trim() || undefined, imageDataUrl: dataUrl }), "");
      setInput("");
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const toggleRecord = async () => {
    if (recording) { recorder.current?.stop(); setRecording(false); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "",
      });
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const buf = await new Blob(chunks, { type: "audio/webm" }).arrayBuffer();
        let bin = "";
        new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
        setBusy(true); setErr("");
        try {
          const res: any = await api.post("/api/coach/transcribe", { audioBase64: btoa(bin), format: "webm" });
          setInput((v) => (v ? v + " " : "") + res.text);
        } catch (e: any) { setErr("语音转写失败：" + e.message); } finally { setBusy(false); }
      };
      recorder.current = mr;
      mr.start();
      setRecording(true);
    } catch { setErr("无法访问麦克风"); }
  };

  return (
    <div className="flex gap-4 h-[calc(100vh-8.5rem)] md:h-[calc(100vh-7rem)]">
      {/* 会话列表（桌面） */}
      <div className="hidden md:flex flex-col w-52 shrink-0 gap-1.5 overflow-y-auto">
        <button className="btn w-full mb-2" onClick={newSession}><Plus size={14} /> 新对话</button>
        {sessions.map((s) => (
          <button key={s.id} onClick={() => openSession(s.id)}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl text-left text-[13px] truncate transition-colors ${
              sessionId === s.id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-white hover:text-slate-800"}`}>
            <MessageSquare size={13} className="shrink-0" />
            <span className="truncate">{s.title || "未命名对话"}</span>
          </button>
        ))}
      </div>

      {/* 聊天区 */}
      <div className="flex-1 card !p-0 flex flex-col min-h-0 overflow-hidden">
        {!configured && (
          <div className="px-4 py-3 bg-amber-50 border-b border-amber-100 flex items-start gap-2.5 text-[13px] text-amber-800">
            <KeyRound size={15} className="mt-0.5 shrink-0 text-amber-500" />
            <span>未配置 AI：在项目根目录 <code className="bg-amber-100 px-1 rounded">.env</code> 设置 <code className="bg-amber-100 px-1 rounded">DASHSCOPE_API_KEY</code> 后重启服务（千问 OpenAI 兼容模式）。</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5 space-y-4">
          {msgs.length === 0 && !busy && (
            <div className="h-full flex flex-col items-center justify-center text-center px-4">
              <span className="flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 mb-4">
                <Bot size={26} />
              </span>
              <h2 className="font-bold text-slate-800">AI 教练</h2>
              <p className="text-xs text-slate-400 mt-1 mb-5">基于你的佳明/颂拓数据分析训练与恢复，支持图片和语音输入</p>
              <div className="flex flex-col gap-2 w-full max-w-xs">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => setInput(s)}
                    className="text-left text-[13px] text-slate-500 bg-slate-50 hover:bg-slate-100 rounded-xl px-3.5 py-2.5 transition-colors">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m) => (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "assistant" && (
                <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600 mr-2 mt-1 shrink-0">
                  <Bot size={14} />
                </span>
              )}
              <div className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-slate-900 text-white rounded-br-md"
                  : "bg-slate-100 text-slate-800 rounded-bl-md"}`}>
                {m.content}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600"><Bot size={14} /></span>
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: "300ms" }} />
              </span>
            </div>
          )}
          {trace && (
            <details className="text-[11px] text-slate-400 pl-9">
              <summary className="cursor-pointer flex items-center gap-1 hover:text-slate-600"><Wrench size={11} /> 工具调用 {trace.length} 次</summary>
              <pre className="mt-1 whitespace-pre-wrap bg-slate-50 rounded-lg p-2.5">{trace.join("\n")}</pre>
            </details>
          )}
          {err && <div className="text-[13px] text-red-600 bg-red-50 rounded-xl px-3.5 py-2.5">{err}</div>}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-slate-100 p-3 flex gap-2 items-end bg-white/60">
          <button className="md:hidden btn-outline btn-sm shrink-0" onClick={newSession}><Plus size={13} /></button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => e.target.files?.[0] && onImage(e.target.files[0])} />
          <button className="btn-outline shrink-0 !rounded-xl !p-2.5" title="发送图片" onClick={() => fileRef.current?.click()} disabled={busy}>
            <ImageIcon size={15} />
          </button>
          <button className={`shrink-0 !rounded-xl !p-2.5 transition-colors ${
              recording ? "bg-red-600 text-white animate-pulse" : "btn-outline"}`}
            title={recording ? "停止录音" : "语音输入"} onClick={toggleRecord} disabled={busy}>
            {recording ? <Square size={14} /> : <Mic size={15} />}
          </button>
          <textarea className="input flex-1 resize-none !rounded-xl" rows={1} placeholder="问教练任何问题…"
            value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button className="btn-accent shrink-0 !rounded-xl !p-2.5" onClick={send} disabled={busy || !input.trim()}>
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
