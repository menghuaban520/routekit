#!/usr/bin/env python3
"""Read-only, loopback-only bridge for a user's existing Mihomo controller."""
import argparse
import ipaddress
import json
import math
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ALLOWED_ORIGINS = {
    "https://routekit.menghuaban520.workers.dev",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:4178",
}


def controller_url(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise ValueError("controller 必须是 loopback HTTP(S) 地址，不接受 URL 凭证")
    try:
        if not ipaddress.ip_address(parsed.hostname or "").is_loopback:
            raise ValueError()
        parsed.port
    except ValueError:
        raise ValueError("controller 只允许 127.0.0.1 或 ::1 等 loopback IP") from None
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("controller 地址不能包含路径、查询或片段")
    return value.rstrip("/")


def origin_url(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("origin 需为精确 HTTP(S) 来源，例如 https://your-site.example")
    return value


def nonnegative(value):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or value < 0 or value > 9007199254740991 or not math.isfinite(value):
        raise ValueError("Mihomo 返回了无效计数")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Monitor:
    def __init__(self, controller, secret="", token=None, origins=None):
        self.controller = controller_url(controller)
        self.secret = secret
        self.token = token or secrets.token_urlsafe(32)
        self.origins = set(origins or ALLOWED_ORIGINS)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.previous = {}
        self.previous_at = None
        self.sample_session = None
        self.lock = threading.Lock()

    def reset_baseline(self):
        with self.lock:
            self.previous, self.previous_at = {}, None

    def read(self, endpoint, line=False):
        # Only these two fixed GET endpoints can be reached through the bridge.
        if endpoint not in ("/traffic", "/connections"):
            raise ValueError("不支持的 controller 端点")
        headers = {"Accept": "application/json"}
        if self.secret:
            headers["Authorization"] = "Bearer " + self.secret
        request = urllib.request.Request(self.controller + endpoint, headers=headers)
        limit = 65536 if line else 2 * 1024 * 1024
        with self.opener.open(request, timeout=5) as response:
            raw = response.readline(limit + 1) if line else response.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("Mihomo 返回内容过大")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Mihomo 返回内容格式无效")
        return value

    def snapshot(self, sample_session="internal"):
        with self.lock:
            traffic = self.read("/traffic", line=True)
            connections = self.read("/connections")
            now = time.monotonic()
            elapsed = None if self.previous_at is None else now - self.previous_at
            if sample_session != self.sample_session or elapsed is None or elapsed > 10:
                self.previous = {}
                elapsed = None
            rows = connections.get("connections")
            if rows is None:
                rows = []
            if not isinstance(rows, list) or len(rows) > 10000:
                raise ValueError("Mihomo 连接列表格式无效或过大")
            groups, current = {}, {}
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                    raise ValueError("Mihomo 连接格式无效")
                path = row.get("chains", [])
                if not isinstance(path, list) or not all(isinstance(part, str) for part in path):
                    raise ValueError("Mihomo 链路格式无效")
                # Retain the actual chain so chained proxies are not double-counted.
                name = " → ".join(part[:200] for part in path[:16]) or "未标记链路"
                upload, download = nonnegative(row.get("upload")), nonnegative(row.get("download"))
                group = groups.setdefault(name, {"name": name, "connections": 0, "uploadedBytes": 0, "downloadedBytes": 0})
                group["connections"] += 1
                group["uploadedBytes"] += upload
                group["downloadedBytes"] += download
                old = self.previous.get(row["id"])
                if elapsed and elapsed > 0 and old and old[0] == name and upload >= old[1] and download >= old[2]:
                    group["uploadBytesPerSecond"] = group.get("uploadBytesPerSecond", 0) + (upload - old[1]) / elapsed
                    group["downloadBytesPerSecond"] = group.get("downloadBytesPerSecond", 0) + (download - old[2]) / elapsed
                current[row["id"]] = (name, upload, download)
            result = {
                "source": "mihomo",
                "observedAt": datetime.now(timezone.utc).isoformat(),
                "uploadBytesPerSecond": nonnegative(traffic.get("up")),
                "downloadBytesPerSecond": nonnegative(traffic.get("down")),
                "uploadedBytes": nonnegative(connections.get("uploadTotal")),
                "downloadedBytes": nonnegative(connections.get("downloadTotal")),
                "chains": list(groups.values()),
            }
            self.previous, self.previous_at = current, now
            self.sample_session = sample_session
            return result


def handler_for(monitor):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log tokens, controller credentials or traffic details.

        def allowed_origin(self):
            return self.headers.get("Origin") in monitor.origins

        def send_json(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(body)))
            if self.allowed_origin():
                self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            requested_headers = {item.strip().lower() for item in self.headers.get("Access-Control-Request-Headers", "").split(",") if item.strip()}
            if self.path != "/v1/snapshot" or not self.allowed_origin() or self.headers.get("Access-Control-Request-Method") != "GET" or not requested_headers.issubset({"authorization", "x-routekit-session"}):
                self.send_json(403, {"error": "来源或预检请求不允许"})
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "GET")
            self.send_header("Access-Control-Allow-Headers", "Authorization, X-RouteKit-Session")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def do_GET(self):
            if self.path != "/v1/snapshot":
                self.send_json(404, {"error": "不存在的端点"})
                return
            if not self.allowed_origin():
                self.send_json(403, {"error": "网页来源未授权"})
                return
            provided = self.headers.get("Authorization", "")
            if not secrets.compare_digest(provided.encode(), ("Bearer " + monitor.token).encode()):
                self.send_json(401, {"error": "会话令牌不正确，请从本地监测器终端重新复制"})
                return
            sample_session = self.headers.get("X-RouteKit-Session", "")
            if not 8 <= len(sample_session) <= 64 or not all(char.isascii() and (char.isalnum() or char == "-") for char in sample_session):
                self.send_json(400, {"error": "采样会话无效，请重新开始监测"})
                return
            try:
                self.send_json(200, monitor.snapshot(sample_session))
            except urllib.error.HTTPError as error:
                detail = "Mihomo 未授权，请核对监测器使用的 controller secret" if error.code in (401, 403) else "Mihomo controller 请求失败；监测器拒绝重定向"
                error.close()
                monitor.reset_baseline()
                self.send_json(502, {"error": detail})
            except (OSError, ValueError, urllib.error.URLError):
                monitor.reset_baseline()
                self.send_json(502, {"error": "无法读取本地 Mihomo，请确认它已运行并启用 external-controller"})

        def do_POST(self):
            self.send_json(405, {"error": "监测器只支持读取"})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--controller", default="http://127.0.0.1:9090")
    parser.add_argument("--secret-file", help="Mihomo controller secret 的 UTF-8 文件；也可用 ROUTEKIT_MIHOMO_SECRET 环境变量")
    parser.add_argument("--origin", action="append", default=[], help="附加精确网页来源，用于自行部署的网站")
    args = parser.parse_args()
    try:
        secret = Path(args.secret_file).read_text(encoding="utf-8").strip() if args.secret_file else os.environ.get("ROUTEKIT_MIHOMO_SECRET", "")
        if "\r" in secret or "\n" in secret or len(secret) > 4096:
            raise ValueError("controller secret 格式无效")
        monitor = Monitor(args.controller, secret, origins=ALLOWED_ORIGINS | {origin_url(value) for value in args.origin})
        server = ThreadingHTTPServer(("127.0.0.1", 8766), handler_for(monitor))
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print("RouteKit 只读监测器：http://127.0.0.1:8766", flush=True)
    print("会话令牌：" + monitor.token, flush=True)
    print("仅在本机运行；将令牌粘贴到 RouteKit。Ctrl+C 停止。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
