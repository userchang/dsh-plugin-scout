# -*- coding: utf-8 -*-
"""config_io 的离线单测（不碰真实 scout 目录）。"""
from __future__ import annotations

import shutil
import sys
import unittest
import uuid
from pathlib import Path

LIB = Path(__file__).resolve().parents[1] / "lib"
sys.path.insert(0, str(LIB))

import config_io  # noqa: E402

FIXTURE = """# 顶部注释一
# 顶部注释二
model: deepseek-flash

run:
  time: "19:00"          # 时间注释
  peak_guard: true

limits:
  total_candidates: 40
  reads_max: 20
  snippet_chars: 800
  per_source_limit: 30

sources:
  github_search:
    on: true
    since_days: 7
    stars_min: 50
    keywords:
      groups:
        - name: A
          on: true

  bili:
    on: true
    max_lookup: 3
    search:
      on: true
      keywords: ["AI agent", "AI 编程"]
      max_items: 6
      min_play: 5000
      max_days: 14
      subtitle: prefer

report:
  max_items: 6
  # focus 注释
  focus:
    topic: "旧主题"
    until: "2026-10-22"
    note: "旧备注"

notify:
  feishu:
    on: true
"""


class ConfigIoTest(unittest.TestCase):
    def setUp(self):
        # 不用 tempfile.mkdtemp：本机沙箱下新目录会带受限 ACL，写不进去。
        self.root = Path(__file__).resolve().parent / ".tmp" / ("case-" + uuid.uuid4().hex)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "config.yaml").write_text(FIXTURE, encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def text(self):
        return (self.root / "config.yaml").read_text(encoding="utf-8")

    def comments(self, text=None):
        return [line for line in (text or self.text()).splitlines() if line.lstrip().startswith("#")]

    def test_reads_boolean_on_keys(self):
        values = config_io.load(self.root)["values"]
        self.assertTrue(values["sources"]["github_search"]["on"])
        self.assertTrue(values["sources"]["bili"]["on"])
        self.assertEqual(values["sources"]["github_search"]["since_days"], 7)

    def test_reads_bili_search_config(self):
        values = config_io.load(self.root)["values"]
        search = values["sources"]["bili"]["search"]
        self.assertTrue(search["on"])
        self.assertEqual(search["keywords"], ["AI agent", "AI 编程"])
        self.assertEqual(search["max_items"], 6)
        self.assertEqual(search["min_play"], 5000)
        self.assertEqual(search["max_days"], 14)
        self.assertEqual(search["subtitle"], "prefer")

    def test_bili_search_whitelist_roundtrip(self):
        before = self.text()
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {
                "sources.bili.search.on": False,
                "sources.bili.search.max_items": 4,
            },
        })
        self.assertTrue(result["ok"], result)
        after = self.text()
        self.assertEqual(self.comments(before), self.comments(after))
        loaded = config_io.load(self.root)["values"]["sources"]["bili"]["search"]
        self.assertFalse(loaded["on"])
        self.assertEqual(loaded["max_items"], 4)
        self.assertEqual(loaded["keywords"], ["AI agent", "AI 编程"])
        self.assertEqual(loaded["min_play"], 5000)
        self.assertEqual(loaded["max_days"], 14)
        self.assertEqual(loaded["subtitle"], "prefer")

    def test_bili_search_subtitle_roundtrip_and_preserved_on_other_saves(self):
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {"sources.bili.search.subtitle": "require"},
        })
        self.assertTrue(result["ok"], result)
        self.assertEqual(
            config_io.load(self.root)["values"]["sources"]["bili"]["search"]["subtitle"],
            "require",
        )
        # 保存其他字段时不能误删 subtitle 行。
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {"sources.bili.search.max_items": 5},
        })
        self.assertTrue(result["ok"], result)
        self.assertIn("subtitle: require", self.text())
        self.assertEqual(
            config_io.load(self.root)["values"]["sources"]["bili"]["search"]["subtitle"],
            "require",
        )

    def test_bili_search_subtitle_read_falls_back_to_prefer(self):
        (self.root / "config.yaml").write_text(
            self.text().replace("subtitle: prefer", "subtitle: sometimes"),
            encoding="utf-8",
        )
        self.assertEqual(
            config_io.load(self.root)["values"]["sources"]["bili"]["search"]["subtitle"],
            "prefer",
        )

    def test_bili_search_subtitle_invalid_falls_back_to_prefer(self):
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {"sources.bili.search.subtitle": "sometimes"},
        })
        self.assertTrue(result["ok"], result)
        self.assertIn("subtitle: prefer", self.text())
        self.assertEqual(
            config_io.load(self.root)["values"]["sources"]["bili"]["search"]["subtitle"],
            "prefer",
        )

    def test_bili_search_min_play_and_max_days_roundtrip(self):
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {
                "sources.bili.search.min_play": 12345,
                "sources.bili.search.max_days": 7,
            },
        })
        self.assertTrue(result["ok"], result)
        loaded = config_io.load(self.root)["values"]["sources"]["bili"]["search"]
        self.assertEqual(loaded["min_play"], 12345)
        self.assertEqual(loaded["max_days"], 7)
        self.assertEqual(loaded["subtitle"], "prefer")

    def test_bili_search_min_play_and_max_days_bounds(self):
        for key, bad in (
            ("sources.bili.search.min_play", -1),
            ("sources.bili.search.min_play", 1_000_001),
            ("sources.bili.search.max_days", 0),
            ("sources.bili.search.max_days", 181),
        ):
            before = self.root.joinpath("config.yaml").read_bytes()
            result = config_io.save(self.root, {
                "expectedSha256": config_io.load(self.root)["sha256"],
                "set": {key: bad},
            })
            self.assertFalse(result["ok"], (key, bad, result))
            self.assertTrue(result.get("rolledBack"), (key, bad, result))
            self.assertEqual(before, self.root.joinpath("config.yaml").read_bytes())

    def test_bili_search_keywords_flow_list_roundtrip(self):
        before_text = self.text()
        before_lines = before_text.splitlines(keepends=True)
        keywords = ["AI agent", "中文 引号\"测试", "C:\\path"]
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {"sources.bili.search.keywords": keywords},
        })
        self.assertTrue(result["ok"], result)
        after_text = self.text()
        after_lines = after_text.splitlines(keepends=True)
        self.assertEqual(len(before_lines), len(after_lines), "关键词行替换不应增删行")
        self.assertEqual(self.comments(before_text), self.comments(after_text), "注释行数不应变化")
        changed = [(old, new) for old, new in zip(before_lines, after_lines) if old != new]
        self.assertEqual(len(changed), 1, f"只应改关键词行，实际={changed}")
        self.assertIn("keywords:", changed[0][1])
        self.assertIn("中文 引号\\\"测试", changed[0][1])
        self.assertIn("C:\\\\path", changed[0][1])
        loaded = config_io.load(self.root)["values"]["sources"]["bili"]["search"]
        self.assertEqual(loaded["keywords"], keywords)
        self.assertEqual(loaded["max_items"], 6)
        self.assertEqual(loaded["min_play"], 5000)
        self.assertEqual(loaded["max_days"], 14)

    def test_bili_search_keywords_too_long_rejected(self):
        before = self.root.joinpath("config.yaml").read_bytes()
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {"sources.bili.search.keywords": ["x" * 41]},
        })
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("rolledBack"))
        self.assertEqual(before, self.root.joinpath("config.yaml").read_bytes())

    def test_bili_search_keywords_too_many_rejected(self):
        before = self.root.joinpath("config.yaml").read_bytes()
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {"sources.bili.search.keywords": [f"k{i}" for i in range(11)]},
        })
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("rolledBack"))
        self.assertEqual(before, self.root.joinpath("config.yaml").read_bytes())

    def test_bili_search_keywords_empty_allowed(self):
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {"sources.bili.search.keywords": []},
        })
        self.assertTrue(result["ok"], result)
        self.assertEqual(
            config_io.load(self.root)["values"]["sources"]["bili"]["search"]["keywords"],
            [],
        )

    def test_set_time_preserves_comments_and_order(self):
        before = self.text()
        result = config_io.save(self.root, {"expectedSha256": config_io.load(self.root)["sha256"],
                                            "set": {"run.time": "20:30"}})
        self.assertTrue(result["ok"], result)
        after = self.text()
        self.assertIn('time: "20:30"          # 时间注释', after)
        self.assertEqual(self.comments(before), self.comments(after))
        # 只允许改这一行；其余行顺序/内容全部一致
        self.assertEqual(before.replace('"19:00"', '"20:30"'), after)
        self.assertTrue((self.root / "data" / "backups").is_dir())

    def test_insert_focus_when_missing(self):
        text = self.text().replace("""  # focus 注释
  focus:
    topic: "旧主题"
    until: "2026-10-22"
    note: "旧备注"
""", "")
        (self.root / "config.yaml").write_text(text, encoding="utf-8")
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {
                "report.focus.topic": "新主题：TTS",
                "report.focus.until": "2026-10-30",
                "report.focus.note": "优先语音",
            },
        })
        self.assertTrue(result["ok"], result)
        after = self.text()
        self.assertIn("focus:", after)
        self.assertIn('topic: "新主题：TTS"', after)
        loaded = config_io.load(self.root)["values"]["focus"]
        self.assertEqual(loaded["topic"], "新主题：TTS")
        self.assertEqual(self.comments(text), self.comments(after))

    def test_delete_focus_removes_whole_block(self):
        result = config_io.save(self.root, {"expectedSha256": config_io.load(self.root)["sha256"],
                                            "deleteFocus": True, "set": {}})
        self.assertTrue(result["ok"], result)
        after = self.text()
        self.assertNotIn("focus", after)
        self.assertIn("max_items: 6", after)
        self.assertIsNone(config_io.load(self.root)["values"]["focus"])
        # 顶部注释保留；focus 上方那行注释随块一起删除
        self.assertEqual(["# 顶部注释一", "# 顶部注释二"], self.comments(after))

    def test_save_boolean_on_keys_verifies_yaml11_true(self):
        # PyYAML 把未加引号的 `on` 解析成 True；写后校验必须兼容。
        result = config_io.save(self.root, {
            "expectedSha256": config_io.load(self.root)["sha256"],
            "set": {
                "sources.github_search.on": False,
                "sources.github_search.since_days": 13,
                "report.max_items": 9,
            },
        })
        self.assertTrue(result["ok"], result)
        values = config_io.load(self.root)["values"]
        self.assertFalse(values["sources"]["github_search"]["on"])
        self.assertEqual(values["sources"]["github_search"]["since_days"], 13)
        self.assertEqual(values["report"]["max_items"], 9)
        self.assertNotIn("rolledBack", result)

    def test_conflict_does_not_overwrite(self):
        before = self.root.joinpath("config.yaml").read_bytes()
        result = config_io.save(self.root, {"expectedSha256": "deadbeef", "set": {"run.time": "20:30"}})
        self.assertFalse(result["ok"])
        self.assertTrue(result["conflict"])
        self.assertEqual(before, self.root.joinpath("config.yaml").read_bytes())

    def test_invalid_time_rolls_back(self):
        before = self.root.joinpath("config.yaml").read_bytes()
        result = config_io.save(self.root, {"expectedSha256": config_io.load(self.root)["sha256"],
                                            "set": {"run.time": "25:99"}})
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("rolledBack"))
        self.assertEqual(before, self.root.joinpath("config.yaml").read_bytes())
        backups = list((self.root / "data" / "backups").glob("config.*.yaml"))
        self.assertEqual(len(backups), 1)

    def test_whitelist_rejects_deep_structure(self):
        before = self.root.joinpath("config.yaml").read_bytes()
        result = config_io.save(self.root, {"expectedSha256": config_io.load(self.root)["sha256"],
                                            "set": {"sources.github_search.keywords.groups": []}})
        self.assertFalse(result["ok"])
        self.assertIn("不允许修改", result["error"])
        self.assertEqual(before, self.root.joinpath("config.yaml").read_bytes())

    def test_backups_pruned_to_20(self):
        folder = self.root / "data" / "backups"
        folder.mkdir(parents=True)
        for i in range(25):
            (folder / f"config.20200101-0000{i:02d}.yaml").write_text("old", encoding="utf-8")
        result = config_io.save(self.root, {"expectedSha256": config_io.load(self.root)["sha256"],
                                            "set": {"report.max_items": 5}})
        self.assertTrue(result["ok"], result)
        self.assertLessEqual(len(list(folder.glob("config.*.yaml"))), 20)

    def test_unsets_nothing_else(self):
        data = self.root.joinpath("config.yaml").read_bytes()
        config_io.save(self.root, {"expectedSha256": config_io.load(self.root)["sha256"],
                                   "set": {"report.max_items": 8}})
        after = self.root.joinpath("config.yaml").read_bytes()
        self.assertIn(b"  max_items: 8", after)
        self.assertEqual(after.count(b"max_items: 8"), 1)
        self.assertEqual(after.count(b"max_items: 6"), 1)
        self.assertEqual(len(after), len(data))


if __name__ == "__main__":
    unittest.main()
