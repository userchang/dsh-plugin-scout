# -*- coding: utf-8 -*-
"""_post_generic 的响应判定：不能只看 HTTP 状态码。"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import requests

LIB = Path(__file__).resolve().parents[1] / "lib"
sys.path.insert(0, str(LIB))

# bridge 模块导入时要求 SCOUT_ROOT 已设置（不再有硬编码兜底路径）
os.environ.setdefault("SCOUT_ROOT", str(Path(__file__).resolve().parents[1] / "test" / ".tmp" / "post-generic-root"))

import bridge  # noqa: E402


class FakeResponse:
    def __init__(self, status_code: int, body=None, text: str = ""):
        self.status_code = status_code
        self._body = body
        self.text = text

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class PostGenericTest(unittest.TestCase):
    def call(self, response):
        with mock.patch.object(requests, "post", return_value=response):
            return bridge._post_generic({"url": "http://mock.invalid/hook", "headers": ""}, {"text": "【测试】"})

    def test_2xx_json_code_zero_is_ok(self):
        result = self.call(FakeResponse(200, {"code": 0, "msg": "success"}))
        self.assertIsNone(result["error"])
        self.assertEqual(result["http_status"], 200)

    def test_2xx_json_code_nonzero_is_failure_with_msg(self):
        result = self.call(FakeResponse(200, {"code": 19021, "msg": "Invalid request body"}))
        self.assertTrue(result["error"])
        self.assertIn("code=19021", result["error"])
        self.assertIn("报文格式不对", result["error"])
        self.assertIn("Invalid request body", result["error"])

    def test_2xx_json_errcode_nonzero_is_failure(self):
        result = self.call(FakeResponse(200, {"errcode": 93000, "errmsg": "invalid webhook url"}))
        self.assertIn("errcode=93000", result["error"])
        self.assertIn("invalid webhook url", result["error"])

    def test_2xx_non_json_is_ok(self):
        result = self.call(FakeResponse(200, ValueError("not json"), text="ok"))
        self.assertIsNone(result["error"])

    def test_non_2xx_is_failure(self):
        result = self.call(FakeResponse(500, ValueError("not json"), text="server error"))
        self.assertIn("HTTP 500", result["error"])
        self.assertIn("server error", result["error"])

    def test_non_2xx_json_keeps_code_msg(self):
        result = self.call(FakeResponse(400, {"code": 19021, "msg": "Invalid request body"}))
        self.assertIn("code=19021", result["error"])
        self.assertIn("Invalid request body", result["error"])


if __name__ == "__main__":
    unittest.main()
