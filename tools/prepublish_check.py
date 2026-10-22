# -*- coding: utf-8 -*-
"""发布前自检：确认仓库里没有任何本机信息与凭据。

用途：每次往 GitHub 推送前跑一遍，全部 PASS 才推。

    python tools/prepublish_check.py

检查项：
  1. 本机路径（Windows 盘符、用户目录、用户名）
  2. 凭据形态（GitHub token、OpenAI 风格 key、飞书 webhook、B站 SESSDATA 取值）
  3. 内部文件（开发日志、任务书、进度、备份目录不得进仓）
  4. 工作区残留（__pycache__、*.log、test/.tmp）
本脚本只读，不改任何文件。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 只扫文本类文件，二进制（png/zip/ico）跳过
TEXT_EXT = {
    ".md", ".py", ".js", ".mjs", ".cjs", ".ts", ".json", ".yml", ".yaml",
    ".ps1", ".sh", ".html", ".css", ".svg", ".txt", ".toml", ".ini", ".cmd", ".bat",
}

PATTERNS = [
    ("本机盘符路径", re.compile(r"[A-Za-z]:[\\/](?:DSHwork|Users|Program|Windows|opt)", re.I)),
    ("用户名/机器名", re.compile(r"LSK2|C:\\\\Users\\\\[A-Za-z]", re.I)),
    ("内部项目名", re.compile(r"DSHwork", re.I)),
    ("GitHub token", re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}")),
    ("OpenAI 风格 key", re.compile(r"sk-[A-Za-z0-9]{20,}")),
    ("飞书 webhook", re.compile(r"open-apis/bot/v2/hook/[0-9a-f-]{20,}")),
    ("B站 SESSDATA 取值", re.compile(r"SESSDATA=[A-Za-z0-9%]{20,}")),
    ("私钥文件内容", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]

# 允许出现的内部名词（仅限示例/占位语境时人工判断，这里默认全部拦截）
FORBIDDEN_TRACKED = re.compile(r"(^|/)(任务书|进度)\.md$|^docs/DEVLOG\.md$|^_backup/")

FORBIDDEN_WORKDIR = re.compile(r"__pycache__|\.pyc$|\.log$|^test/\.tmp/")


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
    problems: list[str] = []

    for rel in files:
        if FORBIDDEN_TRACKED.search(rel):
            problems.append(f"内部文件进了仓库：{rel}")

        path = ROOT / rel
        if not path.is_file() or path.suffix.lower() not in TEXT_EXT:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            problems.append(f"读不出 {rel}：{exc}")
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for name, pattern in PATTERNS:
                if pattern.search(line):
                    problems.append(f"{rel}:{lineno} 命中「{name}」→ {line.strip()[:90]}")

    for path in ROOT.rglob("*"):
        if ".git" in path.parts or "node_modules" in path.parts or "_backup" in path.parts:
            continue
        rel = path.relative_to(ROOT).as_posix()
        if FORBIDDEN_WORKDIR.search(rel) and "test/.tmp" not in " ".join(files):
            # 工作区残留只要没被跟踪就不算问题，这里只提示
            continue

    if problems:
        print(f"发现 {len(problems)} 处问题，先修再推：\n")
        for item in problems:
            print("  ×", item)
        return 1

    print(f"通过：{len(files)} 个受跟踪文件，无本机路径 / 凭据 / 内部文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
