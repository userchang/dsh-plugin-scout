# -*- coding: utf-8 -*-
"""发布前自检：确认仓库里没有任何本机信息与凭据。

用途：每次往 GitHub 推送前跑一遍，全部 PASS 才推。

    python tools/prepublish_check.py

检查三类内容：
  1. 本机信息——用户目录路径、盘符工程路径、自定义敏感词
  2. 凭据形态——GitHub token、OpenAI 风格 key、飞书 webhook、B站 SESSDATA、私钥
  3. 内部文件与产物——开发日志、任务书、进度、备份目录、缓存

自定义敏感词（本机目录名、用户名等）不写进仓库，放在仓库根目录的
`.prepublish.local`（已 gitignore，一行一个），或用环境变量
PREPUBLISH_TERMS="foo,bar" 传入。

本脚本只读，不改任何文件。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL_TERMS = ROOT / ".prepublish.local"

TEXT_EXT = {
    ".md", ".py", ".js", ".mjs", ".cjs", ".ts", ".json", ".yml", ".yaml",
    ".ps1", ".sh", ".html", ".css", ".svg", ".txt", ".toml", ".ini", ".cmd", ".bat",
}

# 通用形态：任何项目都适用，不含任何具体机器信息
GENERIC_PATTERNS = [
    ("用户目录路径", re.compile(r"[A-Za-z]:[\\/]{1,2}Users[\\/]", re.I)),
    ("盘符工程路径", re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}[\w.-]+[\\/]{1,2}[\w.-]+")),
    ("GitHub token", re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}")),
    ("OpenAI 风格 key", re.compile(r"sk-[A-Za-z0-9]{20,}")),
    ("飞书 webhook", re.compile(r"open-apis/bot/v2/hook/[0-9a-f-]{20,}")),
    ("B站 SESSDATA 取值", re.compile(r"SESSDATA=[A-Za-z0-9%]{16,}")),
    ("私钥文件内容", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]

FORBIDDEN_TRACKED = re.compile(r"(^|/)(任务书|进度)\.md$|^docs/DEVLOG\.md$|^_backup/|^test/\.tmp/")


def load_terms() -> list[str]:
    terms = [t.strip() for t in (os.environ.get("PREPUBLISH_TERMS") or "").split(",") if t.strip()]
    if LOCAL_TERMS.is_file():
        for line in LOCAL_TERMS.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                terms.append(line)
    return sorted(set(terms))


def tracked_files() -> list[str]:
    try:
        out = subprocess.run(
            ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout
    except Exception as exc:  # noqa: BLE001
        print(f"× 读不到 git 文件列表（不是仓库或未初始化）：{exc}")
        sys.exit(2)
    return [line for line in out.splitlines() if line.strip()]


def main() -> int:
    files = tracked_files()
    terms = load_terms()
    patterns = list(GENERIC_PATTERNS) + [
        (f"自定义敏感词「{t}」", re.compile(re.escape(t), re.I)) for t in terms
    ]

    problems: list[str] = []
    for rel in files:
        if FORBIDDEN_TRACKED.search(rel):
            problems.append(f"内部文件进了仓库：{rel}")
            continue
        path = ROOT / rel
        if not path.is_file() or path.suffix.lower() not in TEXT_EXT:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            problems.append(f"读不出 {rel}：{exc}")
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for name, pattern in patterns:
                if pattern.search(line):
                    problems.append(f"{rel}:{lineno} 命中「{name}」→ {line.strip()[:90]}")

    if problems:
        print(f"发现 {len(problems)} 处问题，先修再推：\n")
        for item in problems:
            print("  ×", item)
        return 1

    scope = f"{len(files)} 个受跟踪文件"
    extra = f"，自定义敏感词 {len(terms)} 条" if terms else ""
    print(f"通过：{scope}{extra}，无本机路径 / 凭据 / 内部文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
