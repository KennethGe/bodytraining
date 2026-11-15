#!/usr/bin/env python3
"""Garmin Connect 非官方同步 sidecar。

依赖: pip install garminconnect
用法:
  garmin_sync.py activities --email E --password P [--since ISO]
  garmin_sync.py streams    --email E --password P --id ACTIVITY_ID
  garmin_sync.py health     --email E --password P --from YYYY-MM-DD --to YYYY-MM-DD
  garmin_sync.py upload     --email E --password P --file /path/to.fit
输出: 单个 JSON 对象到 stdout。
"""
import argparse
import builtins
import json
import os
import sys
from datetime import datetime, timedelta

# 非交互环境注入 MFA 验证码（服务端通过环境变量传入，一次性使用）
if os.environ.get("GARMIN_MFA_CODE"):
    _mfa = os.environ["GARMIN_MFA_CODE"]
    builtins.input = lambda *a, **k: _mfa
else:
    # 没有验证码时绝不阻塞在交互式提示上，直接报 MFA_REQUIRED
    def _no_mfa(*a, **k):
        raise RuntimeError("MFA_REQUIRED: 需要验证码，请在设置页填写后重试")
    builtins.input = _no_mfa

try:
    from garminconnect import Garmin
except ImportError:
    print("missing dependency: pip install garminconnect", file=sys.stderr)
    sys.exit(2)

TOKEN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".garminconnect")
LOCK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".login.lock")


def _acquire_lock(timeout=300):
    # 佳明 refresh token 一次性：并发登录会互相顶掉，进程间必须串行
    import errno, time
    deadline = time.time() + timeout
    while True:
        try:
            fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            return
        except OSError as e:
            if e.errno != errno.EEXIST:
                raise
            try:
                age = time.time() - os.stat(LOCK_PATH).st_mtime
                if age > 300:  # 残留锁自动清理
                    os.unlink(LOCK_PATH)
                    continue
            except FileNotFoundError:
                continue
            if time.time() > deadline:
                raise RuntimeError("garmin sidecar 登录锁等待超时")
            time.sleep(0.5)


def _release_lock():
    try:
        os.unlink(LOCK_PATH)
    except OSError:
        pass


def login(email: str, password: str) -> Garmin:
    try:
        api = Garmin(email=email, password=password, is_cn=False, return_on_start=True)
    except TypeError:
        api = Garmin(email=email, password=password, is_cn=False)
    _acquire_lock()
    try:
        api.login(TOKEN_DIR)  # token 新鲜则直接复用，不触发登录/MFA
    except Exception:
        api.login()
        try:
            api.garth.dump(TOKEN_DIR)
        except Exception:
            pass
    finally:
        _release_lock()
    return api


def cmd_activities(api, args):
    since = args.since
    start = 0
    out = []
    while True:
        acts = api.get_activities(start, 100)
        if not acts:
            break
        for a in acts:
            begin = a.get("beginTimestamp") or a.get("startTimeGMT")
            if since and begin:
                bt = begin if isinstance(begin, str) else datetime.utcfromtimestamp(begin / 1000).isoformat()
                bt = bt.replace(" ", "T")
                if bt < since:
                    return {"activities": out}
            out.append(a)
        start += 100
        if len(acts) < 100:
            break
    return {"activities": out}


def cmd_streams(api, args):
    details = api.get_activity_details(args.id)
    metrics = details.get("metricsDTOList") or []
    streams = {}
    name_map = {
        "directTimestamp": None,
        "directHeartRate": "hr",
        "directSpeed": "pace",
        "directPower": "power",
        "directRunCadence": "cadence",
        "directElevation": "altitude",
        "directLatitude": "lat",
        "directLongitude": "lon",
    }
    cols = {}
    for m in metrics:
        key = m.get("metricsIndex")
        name = name_map.get(key, "skip")
        cols[key] = (name, m.get("metricsDescriptors") or [], m.get("data") or [])
    ts_col = cols.get("directTimestamp")
    times = []
    if ts_col:
        times = [row[0] if row else 0 for row in ts_col[2]]
    t0 = times[0] if times else 0
    lat = [row[0] if row else None for row in cols.get("directLatitude", (0, 0, []))[2]]
    lon = [row[0] if row else None for row in cols.get("directLongitude", (0, 0, []))[2]]
    if lat and lon:
        streams["gps"] = [[la / 1e7 if la and abs(la) > 1000 else la, lo / 1e7 if lo and abs(lo) > 1000 else lo]
                          for la, lo in zip(lat, lon) if la and lo]
    for key in ("directHeartRate", "directSpeed", "directPower", "directRunCadence", "directElevation"):
        col = cols.get(key)
        if not col:
            continue
        name = col[0]
        pts = []
        for i, row in enumerate(col[2]):
            if row and row[0] is not None:
                t = (times[i] - t0) / 1000 if i < len(times) and times[i] else i
                v = row[0]
                if name == "pace":
                    v = round(v * 3.6, 2)  # m/s -> km/h
                pts.append([round(t), round(float(v), 2)])
        if pts:
            streams[name] = pts
    return {"streams": streams}


def cmd_health(api, args):
    d0 = datetime.strptime(args.date_from, "%Y-%m-%d")
    d1 = datetime.strptime(args.date_to, "%Y-%m-%d")
    days = []
    d = d0
    while d <= d1:
        ds = d.strftime("%Y-%m-%d")
        day = {"date": ds, "metrics": {}}
        try:
            stats = api.get_stats(ds) or {}
            day["metrics"]["steps"] = stats.get("totalSteps") or 0
            day["metrics"]["resting_hr"] = stats.get("restingHeartRate") or 0
        except Exception:
            pass
        try:
            sleep = api.get_sleep_data(ds) or {}
            summary = sleep.get("dailySleepDTO") or {}
            if summary.get("sleepTimeSeconds"):
                day["metrics"]["sleep_min"] = round(summary["sleepTimeSeconds"] / 60)
            stages = []
            for s in sleep.get("sleepMovement") or []:
                pass
            day["samples"] = {"raw_sleep": {k: summary.get(k) for k in
                              ("deepSleepSeconds", "lightSleepSeconds", "remSleepSeconds", "awakeSleepSeconds")}}
        except Exception:
            pass
        try:
            hrv = api.get_hrv_data(ds) or {}
            v = (hrv.get("hrvSummary") or [{}])[0].get("lastNightAvg")
            if v:
                day["metrics"]["hrv_ms"] = v
        except Exception:
            pass
        day["metrics"] = {k: v for k, v in day["metrics"].items() if v}
        if day["metrics"]:
            days.append(day)
        d += timedelta(days=1)
    return {"days": days}


def cmd_upload(api, args):
    import time
    from datetime import datetime as _dt, timedelta

    day = _dt.strptime(args.date, "%Y-%m-%d") if args.date else None
    dur = float(args.duration or 0)
    window = 5  # 前后各扫 5 天，覆盖时区差

    def window_acts():
        if not day:
            return []
        lo = (day - timedelta(days=window)).strftime("%Y-%m-%d")
        hi = (day + timedelta(days=window + 1)).strftime("%Y-%m-%d")
        try:
            return api.get_activities_by_date(lo, hi) or []
        except Exception:
            return []

    def pick(acts, exclude):
        for a in acts:
            aid = str(a.get("activityId"))
            if aid in exclude:
                continue
            d = float(a.get("duration") or 0)
            if dur <= 0 or abs(d - dur) <= max(5.0, dur * 0.02):
                return aid
        return None

    before = {str(a.get("activityId")) for a in window_acts()}
    try:
        resp = api.upload_activity(args.file)
        data = resp.json() if hasattr(resp, "json") else (resp or {})
    except Exception as e:
        if "409" in str(e):  # 文件级查重：之前已导入过
            aid = pick(window_acts(), set())
            if aid:
                return {"activityId": aid, "duplicate": True}
        return {"error": str(e)[:300]}
    details = (data or {}).get("detailedImportResult") or {}
    failures = details.get("failures") or []
    if failures:
        return {"error": json.dumps(failures[0], default=str)[:500]}
    # 202 异步导入：status 接口不可用，轮询"新出现且时长匹配"的活动
    for _ in range(12):
        time.sleep(5)
        aid = pick(window_acts(), before)
        if aid:
            return {"activityId": aid}
    return {"error": "导入结果等待超时", "uploadId": str(details.get("uploadId") or "")}


def cmd_pushworkout(api, args):
    import json as _json
    with open(args.file) as f:
        payload = _json.load(f)
    try:
        created = api.garth.connectapi("/workout-service/workout", method="POST", json=payload)
    except Exception as e:
        body = getattr(getattr(e, "response", None), "text", None)
        return {"error": f"{type(e).__name__}: {e}", "status": getattr(getattr(e, "response", None), "status_code", None), "body": (body or "")[:2000]}
    wid = (created or {}).get("workoutId")
    schedule = None
    if wid and args.date:
        try:
            schedule = api.garth.connectapi(
                f"/workout-service/schedule/{wid}", method="POST", json={"date": args.date}
            )
        except Exception as e:  # 排程失败不阻断创建结果
            schedule = {"error": str(e)}
    return {"workoutId": wid, "schedule": schedule}


def cmd_fit(api, args):
    data = api.download(f"/download-service/files/activity/{args.id}")
    if isinstance(data, str):
        data = data.encode("latin-1")
    data = bytes(data)
    # 下载服务可能返回 zip 包装，取其中第一个 .fit
    if data[:2] == b"PK":
        import io, zipfile
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".fit")]
            data = z.read(names[0]) if names else z.read(z.namelist()[0])
    with open(args.out, "wb") as f:
        f.write(data)
    return {"bytes": len(data)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["activities", "streams", "health", "upload", "fit", "pushworkout"])
    p.add_argument("--email", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--since")
    p.add_argument("--id")
    p.add_argument("--from", dest="date_from")
    p.add_argument("--to", dest="date_to")
    p.add_argument("--file")
    p.add_argument("--out")
    p.add_argument("--date")
    p.add_argument("--duration")
    args = p.parse_args()

    api = login(args.email, args.password)
    if args.command == "activities":
        out = cmd_activities(api, args)
    elif args.command == "streams":
        out = cmd_streams(api, args)
    elif args.command == "health":
        out = cmd_health(api, args)
    elif args.command == "fit":
        out = cmd_fit(api, args)
    elif args.command == "pushworkout":
        out = cmd_pushworkout(api, args)
    else:
        out = cmd_upload(api, args)
    print(json.dumps(out, default=str))


if __name__ == "__main__":
    main()
