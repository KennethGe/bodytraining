import crypto from "node:crypto";
import { ProxyAgent } from "undici";
import { config } from "../config.js";

// 仅颂拓流量使用的 dispatcher：配置 SUUNTO_PROXY 时走代理（绕过区域封锁）
let dispatcher: ProxyAgent | null = null;
export function suuntoDispatcher(): ProxyAgent | undefined {
  if (!config.suunto.proxy) return undefined;
  if (!dispatcher) dispatcher = new ProxyAgent(config.suunto.proxy);
  return dispatcher;
}

// 移植自 suuntool（APK com.stt.android.suunto v6.8.13 提取的密钥管线）：
// login2 需要 totp + timestamp + salt + signature（SHA-256）表单字段与 App UA。
const PKG = "com.stt.android.suunto";
const APP_VERSION_CODE = "6008013";
export const SUUNTO_UA = `${PKG}/${APP_VERSION_CODE}`;

const LOGIN_KEY_PARTS = [
  "FBkubDYmN28bWVQLLTsWFxcmaRB",
  "fN2AqIBc/IRAoNgshbxgnOGUVGlU3LC0xL0AuXXXXMXY",
  "RWQ4zIi0PWz4hekc1QGNTPlciNhEKV1teYSIkDGYY",
];
const TOTP_KEY_PARTS = [
  "FBkubDYmN28bWVQLLTsWWhI+NAtILCNlPQc5Y",
  "BgiMRYjKA99Jj4HHFIqLmomOFttBQchNzcZU0QrODcDWz4hekc1QGNTPlciNhEKGl5GPDkzFyVX",
];
const TOTP_OBFUSCATION_KEY = "Bh8nsTyCeC0Ql2drMen78awk84AE3ZxW";

const dec = new TextDecoder("utf-8", { fatal: false });
const enc = new TextEncoder();

function utf8Replace(bytes: Buffer): string {
  // 等价 Java new String(bytes, UTF-8)：非法序列 → U+FFFD
  return dec.decode(bytes);
}

function keyObfuscator(s: string, pkg: string): Buffer {
  const k = enc.encode(s);
  const p = enc.encode(pkg);
  const out = Buffer.alloc(k.length);
  for (let i = 0; i < k.length; i++) out[i] = k[i] ^ p[i % p.length];
  return out;
}

function deriveObfuscatedSecret(parts: string[], pkg: string): string {
  const raw = Buffer.from(parts.join(""), "base64");
  const mid = enc.encode(utf8Replace(raw));
  return utf8Replace(keyObfuscator(dec.decode(mid), pkg));
}

export function deriveLoginSecret(): string {
  return deriveObfuscatedSecret(LOGIN_KEY_PARTS, PKG);
}

function deriveTotpMaster(): string {
  return deriveObfuscatedSecret(TOTP_KEY_PARTS, TOTP_OBFUSCATION_KEY);
}

export function generateTotp(salt: string, nowMs = Date.now()): string {
  const master = deriveTotpMaster();
  const pwd = Buffer.from(master, "utf8").map((b) => b & 0xff);
  const key = crypto.pbkdf2Sync(pwd, Buffer.from(salt, "utf8"), 100, 32, "sha1");
  const counter = Math.floor(nowMs / 30000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", key).update(buf).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

export function signParams(path: string, params: [string, string][]): string {
  let s = "POST&" + path;
  for (const [k, v] of params) s += `&${k}=${v}`;
  s += "&secret=" + deriveLoginSecret();
  return crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("base64url");
}

export interface SuuntoSession {
  sessionkey: string;
  username: string;
  email: string;
  userKey: string;
  country: string;
}

export async function suuntoLogin(email: string, password: string): Promise<SuuntoSession> {
  const totp = generateTotp(email);
  const ts = String(Date.now());
  const salt = crypto.randomBytes(16).toString("base64url");
  const signature = signParams("login2", [
    ["l", email],
    ["p", password],
    ["totp", totp],
  ]);
  const form = new URLSearchParams();
  form.set("l", email);
  form.set("p", password);
  form.set("totp", totp);
  form.set("timestamp", ts);
  form.set("salt", salt);
  form.set("signature", signature);

  const res = await fetch("https://api.sports-tracker.com/apiserver/v1/login2", {
    method: "POST",
    body: form,
    headers: {
      "user-agent": SUUNTO_UA,
      "accept-language": "en",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-login-email-verification-enabled": "true",
    },
    ...(suuntoDispatcher() ? { dispatcher: suuntoDispatcher() as any } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Suunto login2 ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as SuuntoSession;
}
