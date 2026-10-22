#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""scout/config.yaml 的受控读写（行级编辑，保留注释与键顺序）。

红线：
  * 只允许改白名单里的键（见 ALLOWED_PATHS）；
  * 绝不整篇 yaml.dump 重写；
  * 写前备份到 data/backups/config.<时间戳>.yaml（只留最近 20 份）；
  * 写后重新解析 + 语义校验，失败立即用备份回滚；
  * 原子写：同目录临时文件 + os.replace。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

import yaml

BACKUP_KEEP = 20
KEY_RE = re.compile(r"^(\s*)([A-Za-z0-9_\-]+)(\s*:\s*)(.*)$")
TIME_RE = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

#: 精确白名单（GUI 真正暴露的标量）。
ALLOWED_PATHS = {
    "report.focus.topic",
    "report.focus.until",
    "report.focus.note",
    "report.max_items",
    "run.time",
    "run.force",
    "limits.total_candidates",
    "limits.reads_max",
    "limits.snippet_chars",
    "limits.per_source_limit",
    "sources.github_search.on",
    "sources.github_search.since_days",
    "sources.github_search.stars_min",
    "sources.awesome.on",
    "sources.releases.on",
    "sources.hn.on",
    "sources.bili.on",
    "sources.bili.search.on",
    "sources.bili.search.max_items",
    "sources.bili.search.keywords",
    "sources.bili.search.subtitle",
    "sources.bili.search.min_play",
    "sources.bili.search.max_days",
}
#: 只读来源配置里允许 GUI 展示的字段（不写）。
READ_SOURCES = ("github_search", "awesome", "releases", "hn", "bili")


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def config_path(root: Path) -> Path:
    return Path(root) / "config.yaml"


def backups_dir(root: Path) -> Path:
    return Path(root) / "data" / "backups"


def _indent(line: str) -> int:
    if not line.strip():
        return -1
    return len(line) - len(line.lstrip(" "))


def _is_comment(line: str) -> bool:
    return line.lstrip().startswith("#")


def _split_comment(rest: str) -> tuple[str, str]:
    """把 `值` 和行尾注释分开（引号内的 # 不算注释）。"""
    quote = ""
    for i, ch in enumerate(rest):
        if quote:
            if ch == quote and (i == 0 or rest[i - 1] != "\\"):
                quote = ""
        elif ch in ("'", '"'):
            quote = ch
        elif ch == "#" and i > 0 and rest[i - 1] in " \t":
            value = rest[:i].rstrip()
            return value, rest[len(value):]
    return rest, ""


def _format_scalar(value, old_raw: str | None = None) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if value is None:
        return "null"
    text = str(value)
    quote = ""
    if old_raw:
        stripped = old_raw.strip()
        if stripped[:1] in ("'", '"'):
            quote = stripped[0]
    if not quote:
        # 含特殊字符/空串/像布尔数字的，统一用双引号，最稳。
        if text == "" or re.search(r"[:：#\[\]{}&*!|>'\"%@`,]", text) or text != text.strip() or text.lower() in ("true", "false", "null", "yes", "no", "on", "off"):
            quote = '"'
    if quote == "'":
        return "'" + text.replace("'", "''") + "'"
    if quote == '"':
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


SUBTITLE_MODES = ("prefer", "require", "off")


def _subtitle_mode(value) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in SUBTITLE_MODES else "prefer"


def _format_flow_list(value: list) -> str:
    """单行 flow list：["a", "b"]；中文原样，引号/反斜杠由 json 转义。"""
    return json.dumps([str(item) for item in value], ensure_ascii=False)


def _resolve(lines: list[str], path: tuple[str, ...]):
    """返回 (行号, 该层的子缩进)；找不到返回 (None, 该层缩进)。"""
    search_from = 0
    indent = 0
    index = None
    for segment in path:
        found = None
        i = search_from
        while i < len(lines):
            line = lines[i]
            if not line.strip() or _is_comment(line):
                i += 1
                continue
            ind = _indent(line)
            if ind < indent:
                break
            if ind == indent:
                match = KEY_RE.match(line.rstrip("\r\n"))
                if match and match.group(2) == segment:
                    found = i
                    break
            i += 1
        if found is None:
            return None, indent
        index = found
        search_from = found + 1
        indent = _child_indent(lines, found, indent)
    return index, indent


def _child_indent(lines: list[str], parent_index: int | None, parent_indent: int) -> int:
    if parent_index is None:
        return 0
    i = parent_index + 1
    while i < len(lines):
        if not lines[i].strip() or _is_comment(lines[i]):
            i += 1
            continue
        ind = _indent(lines[i])
        if ind > parent_indent:
            return ind
        break
    return parent_indent + 2


def _block_end(lines: list[str], parent_index: int | None, parent_indent: int) -> int:
    if parent_index is None:
        return len(lines)
    i = parent_index + 1
    last = parent_index + 1
    while i < len(lines):
        if not lines[i].strip():
            i += 1
            continue
        if _indent(lines[i]) <= parent_indent:
            break
        last = i + 1
        i += 1
    return last


def _replace_scalar(line: str, value) -> str:
    body = line.rstrip("\r\n")
    ending = line[len(body):]
    match = KEY_RE.match(body)
    if not match:
        raise ValueError(f"无法识别的配置行：{body!r}")
    prefix = body[: match.start(4)]
    old_value, comment = _split_comment(match.group(4))
    new_value = _format_flow_list(value) if isinstance(value, list) else _format_scalar(value, old_value)
    if comment and not comment.startswith((" ", "\t")):
        comment = " " + comment
    return prefix + new_value + comment + ending


def _key_line(key: str, value, indent: int) -> str:
    rendered = _format_flow_list(value) if isinstance(value, list) else _format_scalar(value)
    return " " * indent + key + ": " + rendered + "\n"


def _set_scalar(lines: list[str], path: tuple[str, ...], value) -> None:
    index, _ = _resolve(lines, path)
    if index is not None:
        lines[index] = _replace_scalar(lines[index], value)
        return
    parent = path[:-1]
    if parent:
        parent_index, _ = _resolve(lines, parent)
        if parent_index is None:
            raise ValueError(f"父级键不存在：{'.'.join(parent)}")
        parent_indent = _indent(lines[parent_index])
    else:
        parent_index, parent_indent = None, -2
    indent = _child_indent(lines, parent_index, parent_indent)
    block_end = _block_end(lines, parent_index, parent_indent)
    lines.insert(block_end, _key_line(path[-1], value, indent))


def _insert_focus(lines: list[str], values: dict) -> None:
    report_index, _ = _resolve(lines, ("report",))
    if report_index is None:
        raise ValueError("config.yaml 缺少 report 段")
    report_indent = _indent(lines[report_index])
    block_end = _block_end(lines, report_index, report_indent)
    child_indent = _child_indent(lines, report_index, report_indent)
    block = [" " * child_indent + "focus:\n"]
    for key in ("topic", "until", "note"):
        if values.get(key) not in (None, ""):
            block.append(" " * (child_indent + 2) + key + ": " + _format_scalar(values[key]) + "\n")
    lines[block_end:block_end] = block


def _delete_block(lines: list[str], path: tuple[str, ...]) -> None:
    index, _ = _resolve(lines, path)
    if index is None:
        return
    indent = _indent(lines[index])
    # 顺手删掉紧贴在块上方、同缩进的注释（例如「# v1.20 …本期聚焦…」），
    # 避免删了值还留一句描述旧 focus 的注释；更上层的段落注释不动。
    while index > 0:
        prev = lines[index - 1]
        if _is_comment(prev) and _indent(prev) == indent:
            del lines[index - 1]
            index -= 1
        else:
            break
    del lines[index]
    while index < len(lines):
        if not lines[index].strip():
            break  # 保留块后的空行
        if _indent(lines[index]) > indent:
            del lines[index]
            continue
        break


def _semantic_check(values: dict) -> None:
    if "run.time" in values:
        text = str(values["run.time"] or "")
        if not TIME_RE.match(text):
            raise ValueError(f"run.time 必须是 HH:MM（00:00–23:59），收到 {text!r}")
    if "report.focus.until" in values:
        text = str(values["report.focus.until"] or "")
        if text and not DATE_RE.match(text):
            raise ValueError(f"report.focus.until 必须是 YYYY-MM-DD 或空，收到 {text!r}")
    for key in ("report.max_items", "limits.total_candidates", "limits.reads_max",
                "limits.snippet_chars", "limits.per_source_limit",
                "sources.github_search.since_days", "sources.github_search.stars_min",
                "sources.bili.search.max_items", "sources.bili.search.min_play",
                "sources.bili.search.max_days"):
        if key in values and not isinstance(values[key], int):
            raise ValueError(f"{key} 必须是整数")
    if "report.max_items" in values and not (1 <= values["report.max_items"] <= 100):
        raise ValueError("report.max_items 必须在 1–100 之间")
    if "sources.bili.search.max_items" in values and not (1 <= values["sources.bili.search.max_items"] <= 20):
        raise ValueError("sources.bili.search.max_items 必须在 1–20 之间")
    if "sources.bili.search.keywords" in values:
        keywords = values["sources.bili.search.keywords"]
        if not isinstance(keywords, list) or len(keywords) > 10:
            raise ValueError("sources.bili.search.keywords 必须是 0–10 个关键词的列表")
        for word in keywords:
            if not isinstance(word, str) or not word.strip() or len(word.strip()) > 40:
                raise ValueError("sources.bili.search.keywords 的每个词必须是 1–40 字符的非空字符串")
    if "sources.bili.search.subtitle" in values and values["sources.bili.search.subtitle"] not in ("prefer", "require", "off"):
        raise ValueError("sources.bili.search.subtitle 只能是 prefer / require / off")
    if "sources.bili.search.min_play" in values and not (0 <= values["sources.bili.search.min_play"] <= 1_000_000):
        raise ValueError("sources.bili.search.min_play 必须在 0–1000000 之间")
    if "sources.bili.search.max_days" in values and not (1 <= values["sources.bili.search.max_days"] <= 180):
        raise ValueError("sources.bili.search.max_days 必须在 1–180 之间")
    if "limits.total_candidates" in values and values["limits.total_candidates"] < 1:
        raise ValueError("limits.total_candidates 必须大于 0")


def _prune_backups(root: Path) -> None:
    folder = backups_dir(root)
    if not folder.is_dir():
        return
    files = sorted(folder.glob("config.*.yaml"), key=lambda p: p.name)
    for old in files[:-BACKUP_KEEP]:
        try:
            old.unlink()
        except OSError:
            pass


def _on_value(node) -> bool:
    """PyYAML 按 YAML 1.1 会把未加引号的键 `on` 解析成布尔 True，这里兼容两种。"""
    if not isinstance(node, dict):
        return False
    if "on" in node:
        return bool(node["on"])
    return bool(node.get(True))


def _values_from_cfg(cfg: dict) -> dict:
    report = cfg.get("report") or {}
    focus = report.get("focus")
    sources = cfg.get("sources") or {}
    limits = cfg.get("limits") or {}
    return {
        "focus": None if not isinstance(focus, dict) else {
            "topic": str(focus.get("topic") or ""),
            "until": str(focus.get("until") or ""),
            "note": str(focus.get("note") or ""),
        },
        "report": {"max_items": report.get("max_items")},
        "run": {"time": (cfg.get("run") or {}).get("time")},
        "limits": {key: limits.get(key) for key in ("total_candidates", "reads_max", "snippet_chars", "per_source_limit")},
        "sources": {
            name: {
                "on": _on_value(sources.get(name)),
                "since_days": (sources.get(name) or {}).get("since_days"),
                "stars_min": (sources.get(name) or {}).get("stars_min"),
                **(
                    {
                        "search": {
                            "on": _on_value(((sources.get(name) or {}).get("search") or {})),
                            "keywords": list((((sources.get(name) or {}).get("search") or {}).get("keywords") or [])),
                            "max_items": (((sources.get(name) or {}).get("search") or {}).get("max_items")),
                            "min_play": (((sources.get(name) or {}).get("search") or {}).get("min_play")),
                            "max_days": (((sources.get(name) or {}).get("search") or {}).get("max_days")),
                            "subtitle": _subtitle_mode((((sources.get(name) or {}).get("search") or {}).get("subtitle"))),
                        }
                    }
                    if name == "bili"
                    else {}
                ),
            }
            for name in READ_SOURCES
        },
        "sync": {"enabled": bool((cfg.get("sync") or {}).get("enabled"))},
    }


def load(root: Path) -> dict:
    path = config_path(root)
    data = path.read_bytes()
    cfg = yaml.safe_load(data) or {}
    folder = backups_dir(root)
    return {
        "ok": True,
        "path": str(path),
        "mtimeMs": int(path.stat().st_mtime * 1000),
        "sha256": sha256_of(data),
        "values": _values_from_cfg(cfg),
        "backups": len(list(folder.glob("config.*.yaml"))) if folder.is_dir() else 0,
    }


def _verify(parsed, patch: dict) -> None:
    if not isinstance(parsed, dict):
        raise ValueError("写入后 YAML 顶层不是对象")
    for dotted, value in patch.items():
        node = parsed
        for part in dotted.split("."):
            if not isinstance(node, dict):
                raise ValueError(f"写入后找不到 {dotted}")
            # PyYAML 按 YAML 1.1 会把未加引号的键 `on` 解析成布尔 True；
            # 写后校验必须和 _on_value() 一样兼容这两种键。
            key = True if part == "on" and part not in node and True in node else part
            if key not in node:
                raise ValueError(f"写入后找不到 {dotted}")
            node = node[key]
        if isinstance(value, bool):
            if bool(node) != value:
                raise ValueError(f"写入后 {dotted} 的值不对")
        elif isinstance(value, int):
            if int(node) != value:
                raise ValueError(f"写入后 {dotted} 的值不对")
        elif isinstance(value, list):
            if not isinstance(node, list) or [str(item) for item in node] != [str(item) for item in value]:
                raise ValueError(f"写入后 {dotted} 的值不对")
        elif str(node) != str(value):
            raise ValueError(f"写入后 {dotted} 的值不对")


def save(root: Path, payload: dict) -> dict:
    """payload: {expectedSha256?, force?, set?: {path: value}, deleteFocus?: bool}"""
    path = config_path(root)
    data = path.read_bytes()
    current_sha = sha256_of(data)
    expected = payload.get("expectedSha256")
    if expected and expected != current_sha and not payload.get("force"):
        return {
            "ok": False,
            "conflict": True,
            "sha256": current_sha,
            "mtimeMs": int(path.stat().st_mtime * 1000),
            "error": "config.yaml 已被手工修改",
        }

    patch = payload.get("set") or {}
    if not isinstance(patch, dict):
        return {"ok": False, "error": "set 必须是对象"}
    unknown = [key for key in patch if key not in ALLOWED_PATHS]
    if unknown:
        return {"ok": False, "error": "不允许修改的字段：" + "、".join(unknown)}
    delete_focus = bool(payload.get("deleteFocus"))
    if delete_focus:
        for key in ("report.focus.topic", "report.focus.until", "report.focus.note"):
            patch.pop(key, None)
    # 字幕模式非法值按产品约定回退 prefer，而不是拒绝整次保存。
    if "sources.bili.search.subtitle" in patch:
        patch["sources.bili.search.subtitle"] = _subtitle_mode(patch["sources.bili.search.subtitle"])

    lines = data.decode("utf-8").splitlines(keepends=True)
    try:
        if delete_focus:
            _delete_block(lines, ("report", "focus"))
        else:
            focus_keys = {"report.focus.topic", "report.focus.until", "report.focus.note"}
            if focus_keys & set(patch):
                has_focus, _ = _resolve(lines, ("report", "focus"))
                if has_focus is None:
                    present = {key.split(".")[-1]: value for key, value in patch.items() if key in focus_keys}
                    _insert_focus(lines, present)
            for dotted, value in patch.items():
                _set_scalar(lines, tuple(dotted.split(".")), value)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    new_text = "".join(lines)
    folder = backups_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = folder / f"config.{stamp}.yaml"
    suffix = 1
    while backup.exists():
        backup = folder / f"config.{stamp}-{suffix}.yaml"
        suffix += 1
    shutil.copyfile(path, backup)

    tmp = path.with_name(f".config.yaml.{os.getpid()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as handle:
            handle.write(new_text)
        os.replace(tmp, path)
    except Exception as exc:  # noqa: BLE001
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        return {"ok": False, "error": f"写盘失败：{type(exc).__name__}"}

    # 写后校验：YAML 可解析 + 目标值正确 + 语义合法；失败立即用备份回滚。
    try:
        parsed = yaml.safe_load(path.read_bytes())
        _verify(parsed, patch)
        _semantic_check(patch)
        if delete_focus and isinstance(parsed.get("report"), dict) and "focus" in parsed["report"]:
            raise ValueError("删除 report.focus 后仍有残留")
    except Exception as exc:  # noqa: BLE001
        shutil.copyfile(backup, path)
        _prune_backups(root)
        return {"ok": False, "error": f"写入校验失败，已回滚：{exc}", "rolledBack": True}

    _prune_backups(root)
    result = load(root)
    result.update({"ok": True, "backup": str(backup)})
    return result


def tail_log(root: Path, limit: int = 20) -> dict:
    path = Path(root) / "logs" / "daily.log"
    if not path.is_file():
        return {"ok": False, "error": "logs/daily.log 还不存在"}
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return {"ok": True, "lines": lines[-max(1, min(100, limit)):]}
