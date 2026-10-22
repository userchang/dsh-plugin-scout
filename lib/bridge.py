#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-plugin-scout 的 Python 桥。

只做三件事：
  1. 复用 scout 自己的采集/写日报逻辑（不复制、不改 scout 任何文件）；
  2. 把插件设置页里的采集源开关、单轮上限、渠道覆盖到一份临时配置；
  3. 按插件配置的渠道分发，或者发一条【测试】消息。

输出约定：stdout 最后一行必须是单个 JSON；任何密钥都不打印。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

_root_env = os.environ.get("SCOUT_ROOT", "").strip()
if not _root_env:
    print(json.dumps({"ok": False, "error":
        "SCOUT_ROOT 未设置：请在情报员日报设置页填写 scout 工程根目录"}))
    sys.exit(2)
ROOT = Path(_root_env).resolve()
TZ = "Asia/Shanghai"

# 不往 scout/__pycache__ 里写字节码：红线要求 __pycache__ 只读。
sys.dont_write_bytecode = True


def _scrub(text: str) -> str:
    """把环境变量里的密钥值从错误文本里抹掉。"""
    out = str(text or "")
    for key in ("DEEPSEEK_API_KEY", "GITHUB_TOKEN", "BILI_SESSDATA", "FEISHU_WEBHOOK"):
        value = os.environ.get(key) or ""
        if len(value) >= 8 and value in out:
            out = out.replace(value, "***")
    return out[:400]


def _fail(error: str, **extra) -> dict:
    payload = {"ok": False, "error": _scrub(error)}
    payload.update(extra)
    # 失败也必须在 scout/logs/daily.log 留一行，否则外部看起来就像"定时器没触发"。
    # 延迟 import：bridge 顶部不依赖 scout 的 sys.path；日志失败绝不能影响返回值。
    try:
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import run_daily  # noqa: E402

        run_daily.daily_log(f"exit {payload.get('state') or 'failed'} {payload['error']}")
    except Exception:  # noqa: BLE001
        pass
    return payload


def _channels() -> list[dict]:
    raw = os.environ.get("SCOUT_CHANNELS") or "[]"
    try:
        items = json.loads(raw)
    except Exception:  # noqa: BLE001
        return []
    out = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not item.get("url"):
            continue
        out.append({
            "name": str(item.get("name") or "未命名渠道"),
            "type": "webhook" if item.get("type") == "webhook" else "feishu",
            "url": str(item["url"]),
            "keyword": str(item.get("keyword") or "情报"),
            "secret": str(item.get("secret") or ""),
            "headers": str(item.get("headers") or ""),
            "limit": int(item.get("limit") or 20),
        })
    return out


def _effective_config() -> dict:
    """直接读 scout 的 config.yaml（唯一真相源）。

    不再生成任何影子配置：设置页已经把白名单字段写回 config.yaml 本身。
    这里只在**内存里**关掉 scout 自己的飞书推送与 scp 同步（日报由插件按渠道发），
    绝不回写文件。
    """
    sys.path.insert(0, str(ROOT))
    import sources  # noqa: E402

    cfg = sources.load_config()
    cfg.setdefault("notify", {}).setdefault("feishu", {})["on"] = False
    cfg.setdefault("sync", {})["enabled"] = False
    return cfg


def _short_text(response) -> str:
    try:
        text = str(getattr(response, "text", "") or "").strip()
    except Exception:  # noqa: BLE001
        return ""
    return text[:200].replace("\n", " ")


def _json_code(body: dict):
    """返回 (label, code, msg)；兼容飞书 code / 企微、钉钉 errcode。"""
    label = None
    code = None
    for key in ("code", "errcode", "Code", "ErrCode"):
        if key in body:
            label = "errcode" if key.lower() == "errcode" else "code"
            code = body.get(key)
            break
    msg = ""
    for key in ("msg", "errmsg", "message", "Message"):
        value = body.get(key)
        if isinstance(value, str) and value.strip():
            msg = value.strip()
            break
    return label, code, msg


def _generic_failure(status: int, label: str, code, msg: str) -> dict:
    if str(code) == "19021" or "19021" in str(code):
        error = f"飞书返回 code={code}：报文格式不对，检查渠道类型（应选“飞书自定义机器人”）"
        if msg:
            error += f"；飞书 msg：{msg}"
    elif msg:
        error = f"返回 {label}={code}：{msg}"
    else:
        error = f"返回 {label}={code}"
    return {"http_status": status, "error": error, "code": code, "msg": msg}


def _post_generic(channel: dict, payload: dict) -> dict:
    """通用 Webhook 发送：不能只看 HTTP 200。

    飞书/企微/钉钉会把业务错误放在 200 JSON 的 code/errcode 里，
    这里必须解析；非 JSON 的 2xx 才直接按成功处理。
    """
    import requests

    headers = {"Content-Type": "application/json"}
    if channel.get("headers"):
        try:
            extra = json.loads(channel["headers"])
            if isinstance(extra, dict):
                headers.update({str(k): str(v) for k, v in extra.items()})
        except Exception:  # noqa: BLE001
            pass
    try:
        response = requests.post(channel["url"], json=payload, headers=headers, timeout=10)
    except requests.RequestException as exc:  # noqa: BLE001
        return {"http_status": 0, "error": f"网络错误：{type(exc).__name__}"}

    status = response.status_code
    try:
        body = response.json()
    except ValueError:
        body = None

    if status < 200 or status >= 300:
        detail = _short_text(response)
        if isinstance(body, dict):
            label, code, msg = _json_code(body)
            if code is not None:
                return _generic_failure(status, label or "code", code, msg)
            detail = msg or detail
        return {
            "http_status": status,
            "error": f"HTTP {status}" + (f"：{detail}" if detail else ""),
            "msg": detail,
        }

    if isinstance(body, dict):
        label, code, msg = _json_code(body)
        if code is not None:
            if str(code).strip() in ("0", "0.0"):
                return {"http_status": status, "error": None, "code": 0}
            return _generic_failure(status, label or "code", code, msg)
        # 没有 code/errcode 的 JSON 视为通用 ACK；但显式 ok/success=false 仍判失败。
        if body.get("ok") is False or body.get("success") is False:
            detail = msg or "Webhook 返回 JSON 标记失败"
            return {"http_status": status, "error": detail, "msg": detail}
        return {"http_status": status, "error": None}

    # 非 JSON 的 2xx（或空 body）按成功处理。
    return {"http_status": status, "error": None}


def _humanize_feishu_error(error: str, http_status: int = 0) -> str:
    """把 scout notify 的 feishu_<code>:<msg> 转成人话。"""
    text = str(error or "")
    import re

    match = re.search(r"feishu_(-?\d+)\s*:\s*(.*)", text)
    if match:
        code, msg = match.group(1), match.group(2).strip()
        if code == "19021":
            text = f"飞书返回 code={code}：报文格式不对，检查渠道类型（应选“飞书自定义机器人”）"
            return text + (f"；飞书 msg：{msg}" if msg else "")
        return f"飞书返回 code={code}：" + (msg or "发送失败")
    if text == "network":
        return "网络错误：连接不到 Webhook"
    return text or f"发送失败（HTTP {http_status}）"


def _send_report(markdown: str, date: str, channels: list[dict]) -> dict:
    sys.path.insert(0, str(ROOT))
    from sources import OUT_DIR  # noqa: E402
    from report import notify as notify_mod  # noqa: E402

    sent = failed = 0
    detail = []
    for channel in channels:
        before_sent = before_failed = 0
        try:
            if channel["type"] == "feishu":
                ledger = OUT_DIR / f"{date}.push.{channel['name']}.json"
                result = notify_mod.notify_report(
                    markdown,
                    date,
                    webhook=channel["url"],
                    per_report_push=channel["limit"],
                    interval=1.0,
                    dry_run=False,
                    ledger_file=ledger,
                )
                before_sent = int(result.get("sent") or 0)
                before_failed = int(result.get("failed") or 0)
            else:
                entries = notify_mod.split_entries(markdown)
                chunks = entries[: channel["limit"]] or [markdown]
                for chunk in chunks:
                    outcome = _post_generic(channel, {"text": f"【{channel['keyword']}】{date}\n{chunk}"})
                    if outcome["error"] is None:
                        before_sent += 1
                    else:
                        before_failed += 1
                        break
        except Exception as exc:  # noqa: BLE001
            before_failed += 1
            detail.append({"name": channel["name"], "ok": False, "error": type(exc).__name__})
            failed += before_failed
            continue
        sent += before_sent
        failed += before_failed
        detail.append({"name": channel["name"], "ok": before_failed == 0, "sent": before_sent})
    return {"sent": sent, "failed": failed, "dry_run": False, "channels": detail}


def _test(args) -> dict:
    sys.path.insert(0, str(ROOT))
    from report import notify as notify_mod  # noqa: E402

    channels = _channels()
    if args.name:
        channels = [c for c in channels if c["name"] == args.name]
        if not channels:
            return _fail(f"没有叫「{args.name}」的渠道（或未启用）")
    if not channels:
        return _fail("还没有配置任何渠道。去 设置 → 情报员日报 → 渠道 添加一个。")

    text = f"【测试】情报员日报插件连通性测试 {datetime.now().strftime('%H:%M')}"
    results = []
    ok_all = True
    for channel in channels:
        if channel["type"] == "feishu":
            result = notify_mod.notify_heartbeat(webhook=channel["url"], text=text, dry_run=False)
            item = result["items"][0] if result.get("items") else {}
            ok = bool(result.get("ok"))
            results.append({
                "name": channel["name"],
                "ok": ok,
                "http_status": item.get("http_status", 0),
                **({} if ok else {"error": _humanize_feishu_error(str(item.get("error") or ""), int(item.get("http_status") or 0))}),
            })
        else:
            outcome = _post_generic(channel, {"text": text})
            ok = outcome["error"] is None
            results.append({
                "name": channel["name"],
                "ok": ok,
                "http_status": outcome["http_status"],
                **({} if ok else {"error": str(outcome["error"])}),
            })
        ok_all = ok_all and results[-1]["ok"]
    return {"ok": ok_all, "channels": results}


def _check(field: str) -> dict:
    """凭据校验：只发最小请求，结果只给一句人话。"""
    import requests

    token = os.environ.get("GITHUB_TOKEN") or ""
    if field == "github":
        if not token:
            return _fail("缺 GITHUB_TOKEN：去 设置 → 情报员日报 → 凭据 → GitHub token 配置")
        try:
            response = requests.get(
                "https://api.github.com/rate_limit",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
                timeout=10,
            )
        except requests.RequestException as exc:  # noqa: BLE001
            return _fail(f"网络错误：{type(exc).__name__}")
        if response.status_code != 200:
            return _fail(f"GitHub 返回 HTTP {response.status_code}（token 无效或权限不足）")
        core = (response.json().get("resources") or {}).get("core") or {}
        kind = "classic（有 scope 头）" if response.headers.get("x-oauth-scopes") is not None else "fine-grained"
        return {"ok": True, "detail": f"GitHub 配额 {core.get('remaining')}/{core.get('limit')}，token 类型：{kind}"}

    if field == "deepseek":
        key = os.environ.get("DEEPSEEK_API_KEY") or ""
        if not key:
            return _fail("缺 DEEPSEEK_API_KEY：去 设置 → 情报员日报 → 凭据 → DeepSeek API Key 配置")
        try:
            response = requests.get(
                "https://api.deepseek.com/models",
                headers={"Authorization": f"Bearer {key}"},
                timeout=10,
            )
        except requests.RequestException as exc:  # noqa: BLE001
            return _fail(f"网络错误：{type(exc).__name__}")
        if response.status_code != 200:
            return _fail(f"DeepSeek 返回 HTTP {response.status_code}（Key 无效或额度不足）")
        models = [m.get("id") for m in (response.json().get("data") or []) if isinstance(m, dict)]
        return {"ok": True, "detail": f"Key 可用，可见模型 {len(models)} 个（如 {models[0] if models else 'n/a'}）"}

    if field == "bili":
        cookie = os.environ.get("BILI_SESSDATA") or ""
        if not cookie:
            return _fail("缺 BILI_SESSDATA（可选）：不填则该源自动禁用")
        try:
            response = requests.get(
                "https://api.bilibili.com/x/web-interface/nav",
                headers={"Cookie": f"SESSDATA={cookie}", "User-Agent": "Mozilla/5.0"},
                timeout=10,
            )
        except requests.RequestException as exc:  # noqa: BLE001
            return _fail(f"网络错误：{type(exc).__name__}")
        body = response.json() if response.content else {}
        if body.get("code") == 0:
            return {"ok": True, "detail": f"B站登录态有效：{body.get('data', {}).get('uname') or '已登录'}"}
        return _fail("B站登录态无效或已过期（code=%s）" % body.get("code"))

    if field == "ecs":
        try:
            ecs = json.loads(os.environ.get("SCOUT_ECS") or "{}")
        except Exception:  # noqa: BLE001
            ecs = {}
        host, user, key_path = ecs.get("host"), ecs.get("user"), ecs.get("keyPath")
        if not host or not user or not key_path:
            return _fail("ECS 同步未配齐：需要 host / user / 私钥路径")
        if not Path(key_path).is_file():
            return _fail(f"私钥文件不存在：{key_path}")
        import subprocess

        try:
            completed = subprocess.run(
                ["ssh", "-i", key_path, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                 "-o", "StrictHostKeyChecking=accept-new", f"{user}@{host}", "true"],
                capture_output=True, text=True, timeout=15,
            )
        except Exception as exc:  # noqa: BLE001
            return _fail(f"ssh 调用失败：{type(exc).__name__}")
        if completed.returncode == 0:
            return {"ok": True, "detail": f"ssh 探活成功：{user}@{host}"}
        return _fail(f"ssh 探活失败（rc={completed.returncode}）")

    return _fail(f"未知校验项：{field}")


def _config_load() -> dict:
    import config_io

    return config_io.load(ROOT)


def _config_save(payload_path: str) -> dict:
    import config_io

    try:
        payload = json.loads(Path(payload_path).read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return _fail(f"保存参数读不出来：{type(exc).__name__}")
    if not isinstance(payload, dict):
        return _fail("保存参数必须是 JSON 对象")
    return config_io.save(ROOT, payload)


def _log_tail(limit: int) -> dict:
    import config_io

    return config_io.tail_log(ROOT, limit)


def _run(args) -> dict:
    started = time.time()
    sys.path.insert(0, str(ROOT))
    import run_daily  # noqa: E402
    from sources import OUT_DIR  # noqa: E402

    cfg = _effective_config()
    date = args.date or datetime.now().strftime("%Y-%m-%d")
    peak_warning = ""

    # 把本期重点是否注入写进 scout 的每日日志（只追加），方便验收与排查。
    focus = (cfg.get("report") or {}).get("focus") or {}
    topic = str(focus.get("topic") or "").strip()
    until = str(focus.get("until") or "").strip()
    if topic and ((not until) or date <= until):
        run_daily.daily_log(f"【本期聚焦】{topic[:60]}")
    elif topic:
        run_daily.daily_log(f"focus expired (until={until}), 不注入【本期聚焦】")
    else:
        run_daily.daily_log("no focus, 不注入【本期聚焦】")

    # 先体检缺什么，别等采集完 4 分钟才报错。v8 起只认设置页，不再回退 snippet。
    missing = []
    targets = []
    if not os.environ.get("DEEPSEEK_API_KEY"):
        missing.append("DEEPSEEK_API_KEY")
        targets.append("凭据")
    if not args.dry_run and not _channels():
        missing.append("分发渠道")
        targets.append("渠道")
    if missing:
        return _fail(
            "缺凭据：" + "、".join(missing) +
            f"。去 设置 → 情报员日报 → {' / '.join(targets)} 配置",
            state="missing_credentials",
            date=date,
            collected="skipped",
            dry_run=args.dry_run,
            peak_warning=peak_warning,
        )

    # 峰时只提示、不阻断：设置页已经把高峰时段展示给用户，用户自己会挑时间。
    # check_peak_hour 仍然保留，用来给面板算"下次可用窗口"；--force 时连提示也不产生。
    if not args.force:
        try:
            run_daily.check_peak_hour(False, None)
        except run_daily.PeakHour as exc:
            peak_warning = str(exc)
            run_daily.daily_log(f"peak_warn: {peak_warning}（峰时不再阻断，继续执行）")

    try:
        collected = run_daily.collect_today(cfg, date)
    except Exception as exc:  # noqa: BLE001
        return _fail(f"采集失败：{type(exc).__name__}", state="collect_failed", date=date, collected="failed", dry_run=args.dry_run, peak_warning=peak_warning)

    # dry_run 只控制"插件发不发"；写报告始终进行，这样 dry-run 也能验收报告路径。
    try:
        built = run_daily.run_for_date(cfg, date, dry_run=True)
    except Exception as exc:  # noqa: BLE001
        return _fail(f"写日报失败：{type(exc).__name__}", state="report_failed", date=date, collected=collected.get("state"), dry_run=args.dry_run, peak_warning=peak_warning)

    if not built.get("ok"):
        return _fail(
            str(built.get("reason") or "日报生成失败"),
            state=built.get("state") or "report_failed",
            date=date,
            collected=collected.get("state"),
            dry_run=args.dry_run,
            peak_warning=peak_warning,
        )

    built_report = built.get("report") or {}
    raw_path = Path(built_report.get("path") or (OUT_DIR / f"{date}.md"))
    if not raw_path.is_absolute():
        raw_path = ROOT / raw_path
    report_path = str(raw_path.resolve())
    notify_result = {"sent": 0, "failed": 0, "dry_run": True, "channels": []}
    if not args.dry_run:
        markdown = Path(report_path).read_text(encoding="utf-8")
        notify_result = _send_report(markdown, date, _channels())

    state, _ = run_daily.classify_outcome(collected.get("state") or "ok", collected, {"ok": notify_result["failed"] == 0}, None)
    elapsed = round(time.time() - started)
    try:
        run_daily.update_run_record(
            date,
            state=state,
            collect_state=collected.get("state") or "ok",
            totals=collected.get("totals") or {},
            notify=notify_result,
            channels=notify_result.get("channels") or [],
            elapsed_seconds=elapsed,
            failure=None,
        )
    except Exception:  # noqa: BLE001
        pass

    run_daily.daily_log(f"exit {state} date={date}" + (" peak_warn=1" if peak_warning else ""))
    return {
        "ok": True,
        "state": state,
        "date": date,
        "collected": collected.get("state") or "ok",
        "notify": notify_result,
        "report_path": report_path,
        "elapsed_seconds": elapsed,
        "peak_warning": peak_warning,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--check", default="")
    parser.add_argument("--config-load", action="store_true")
    parser.add_argument("--config-save", default="")
    parser.add_argument("--log-tail", type=int, default=0)
    parser.add_argument("--date", default="")
    parser.add_argument("--name", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    try:
        if args.config_load:
            payload = _config_load()
        elif args.config_save:
            payload = _config_save(args.config_save)
        elif args.log_tail:
            payload = _log_tail(args.log_tail)
        elif args.check:
            payload = _check(args.check)
        elif args.test:
            payload = _test(args)
        else:
            payload = _run(args)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        payload = _fail(f"bridge 内部错误：{type(exc).__name__}")
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
