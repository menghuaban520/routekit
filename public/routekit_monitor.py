#!/usr/bin/env python3
"""Authenticated loopback bridge: read existing Mihomo or run isolated node probes."""
import argparse
import copy
import importlib.util
import ipaddress
import json
import math
import os
import secrets
import signal
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ALLOWED_ORIGINS = {
    "https://routekit.menghuaban520.workers.dev",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:4178",
}
MAX_JOB_BYTES = 2 * 1024 * 1024
ACTIVE_JOB_STATUSES = {"running", "cancelling"}


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_probe():
    """Load only the sibling script, never a module name or path from the page."""
    path = Path(__file__).resolve().with_name("routekit_probe.py")
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location("routekit_helper_probe", path)
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(module)
    except (OSError, ImportError, SyntaxError):
        return None
    finally:
        sys.dont_write_bytecode = previous
    return module if getattr(module, "HELPER_API_VERSION", None) == 1 else None


def find_core(explicit=None):
    # Only local CLI input or known installed executable locations are trusted.
    candidates = [explicit] if explicit else [
        shutil.which("mihomo"),
        "/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo",
        "/opt/homebrew/bin/mihomo", "/usr/local/bin/mihomo", "/usr/bin/mihomo",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(shutil.which(candidate) or candidate).expanduser()
        try:
            path = path.resolve(strict=True)
            if path.is_file() and os.access(path, os.X_OK):
                return str(path)
        except OSError:
            pass
    return None


class JobConflict(Exception):
    pass


class ProbeJobs:
    """One worker owns credentials; public state contains only validated results."""
    def __init__(self, executable=None, probe=None, runner=None):
        self.executable = executable
        self.probe = probe
        self.runner = runner or (probe.run_job if probe else None)
        self.lock = threading.Lock()
        self.current = None
        self.cancel_event = None
        self.thread = None
        self.closing = False

    @property
    def available(self):
        return bool(self.executable and self.probe and self.runner)

    def capabilities(self):
        reason = None
        if not self.probe:
            reason = "请将新版 routekit_probe.py 下载到助手脚本的同一目录。"
        elif not self.executable:
            reason = "未找到本机 Mihomo；请重新运行助手并用 --core 指定已安装内核。"
        capability = {"available": self.available, "maxNodes": 100, "maxBodyBytes": MAX_JOB_BYTES, "maxDownloadBytes": 5_000_000}
        if reason:
            capability["reason"] = reason
        return {"version": 1, "source": "routekit-local-helper", "monitor": True,
                "probe": capability, "currentJob": self.snapshot()}

    def snapshot(self, identifier=None):
        with self.lock:
            if not self.current or (identifier is not None and identifier != self.current["id"]):
                return None
            return copy.deepcopy(self.current)

    def start(self, job):
        if not self.available:
            raise RuntimeError("本地节点检测尚不可用。")
        nodes, _ = self.probe.validate_job(job)
        with self.lock:
            if self.closing or self.current and self.current["status"] in ACTIVE_JOB_STATUSES:
                raise JobConflict()
            now = utc_now()
            self.current = {"id": str(uuid.uuid4()), "status": "running", "createdAt": now,
                            "updatedAt": now, "total": len(nodes), "completed": 0, "phase": "preparing",
                            "report": {"version": 1, "source": "routekit-local-probe", "generatedAt": now, "results": []}}
            self.cancel_event = threading.Event()
            self.thread = threading.Thread(target=self._run, args=(copy.deepcopy(job), self.current["id"], self.cancel_event), daemon=False)
            initial = copy.deepcopy(self.current)
            self.thread.start()
            return initial

    def _run(self, job, identifier, cancel_event):
        status, error = "completed", None
        def progress(rows, current_node_id=None, phase="checking"):
            with self.lock:
                if self.current["id"] != identifier:
                    return
                now = utc_now()
                self.current["completed"] = len(rows)
                self.current["updatedAt"] = now
                self.current["report"] = {"version": 1, "source": "routekit-local-probe", "generatedAt": now, "results": copy.deepcopy(rows)}
                if self.current["status"] != "cancelling":
                    self.current["phase"] = phase
                self.current.pop("currentNodeId", None)
                if current_node_id is not None:
                    self.current["currentNodeId"] = current_node_id
        try:
            with tempfile.TemporaryDirectory(prefix="routekit-helper-job-") as directory:
                self.runner(job, Path(directory) / "results.json", self.executable,
                            cancel_event=cancel_event, progress=progress, quiet=True)
        except self.probe.ProbeCancelled:
            status = "cancelled"
        except BaseException:
            # Never forward exceptions that could contain URIs, paths or secrets.
            status, error = "failed", "本地检测异常，临时核心已进入清理。请核对内核版本后重试。"
        finally:
            job.clear()
            with self.lock:
                self.current.update(status="cancelled" if cancel_event.is_set() else status,
                                    phase="finished", updatedAt=utc_now())
                self.current.pop("currentNodeId", None)
                if error and not cancel_event.is_set():
                    self.current["error"] = error

    def cancel(self, identifier):
        with self.lock:
            if not self.current or identifier != self.current["id"]:
                return None
            if self.current["status"] in ACTIVE_JOB_STATUSES:
                self.current.update(status="cancelling", phase="cleanup", updatedAt=utc_now())
                self.cancel_event.set()
            return copy.deepcopy(self.current)

    def close(self):
        with self.lock:
            self.closing = True
            if self.current and self.current["status"] in ACTIVE_JOB_STATUSES:
                self.current.update(status="cancelling", phase="cleanup", updatedAt=utc_now())
                self.cancel_event.set()
            thread = self.thread
        if thread is not None:
            thread.join()


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
    def __init__(self, controller, secret="", token=None, origins=None, jobs=None):
        self.controller = controller_url(controller)
        self.secret = secret
        self.token = token or secrets.token_urlsafe(32)
        self.origins = set(origins or ALLOWED_ORIGINS)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.previous = {}
        self.previous_at = None
        self.sample_session = None
        self.lock = threading.Lock()
        self.jobs = jobs or ProbeJobs()

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

        def authorized(self):
            if not self.allowed_origin():
                self.send_json(403, {"error": "网页来源未授权"})
                return False
            provided = self.headers.get("Authorization", "")
            if not secrets.compare_digest(provided.encode(), ("Bearer " + monitor.token).encode()):
                self.send_json(401, {"error": "会话令牌不正确，请从本地助手终端重新复制"})
                return False
            return True

        def route(self):
            if self.path in {"/v1/snapshot", "/v1/capabilities"}:
                return {"GET"}, None
            if self.path == "/v1/probe/jobs":
                return {"POST"}, None
            prefix = "/v1/probe/jobs/"
            if self.path.startswith(prefix):
                identifier = self.path[len(prefix):]
                try:
                    if str(uuid.UUID(identifier)) == identifier:
                        return {"GET", "DELETE"}, identifier
                except (ValueError, AttributeError):
                    pass
            return set(), None

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
            methods, _ = self.route()
            if not self.allowed_origin() or self.headers.get("Access-Control-Request-Method") not in methods or not requested_headers.issubset({"authorization", "x-routekit-session", "content-type"}):
                self.send_json(403, {"error": "来源或预检请求不允许"})
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", ", ".join(sorted(methods)))
            self.send_header("Access-Control-Allow-Headers", "Authorization, X-RouteKit-Session, Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def do_GET(self):
            methods, identifier = self.route()
            if "GET" not in methods:
                self.send_json(404, {"error": "不存在的端点"})
                return
            if not self.authorized():
                return
            if self.path == "/v1/capabilities":
                self.send_json(200, monitor.jobs.capabilities())
                return
            if identifier is not None:
                state = monitor.jobs.snapshot(identifier)
                self.send_json(200 if state else 404, state or {"error": "任务不存在或已被新任务替代。"})
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
            if self.path != "/v1/probe/jobs":
                self.send_json(405, {"error": "此端点不支持写入"})
                return
            if not self.authorized():
                return
            if not monitor.jobs.available:
                self.send_json(503, {"error": "本地节点检测尚不可用，请查看助手能力说明。"})
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                self.send_json(400, {"error": "任务正文必须为 application/json。"})
                return
            length = self.headers.get("Content-Length", "")
            if self.headers.get("Transfer-Encoding") or not length.isascii() or not length.isdigit() or len(length) > 10:
                self.send_json(400, {"error": "任务需要有效的 Content-Length，不接受分块请求。"})
                return
            length = int(length)
            if length > MAX_JOB_BYTES:
                self.send_json(413, {"error": "检测任务不能超过 2 MiB。"})
                return
            if not length:
                self.send_json(400, {"error": "检测任务正文为空。"})
                return
            try:
                self.connection.settimeout(10)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError()
                job = json.loads(raw.decode("utf-8"))
                monitor.jobs.probe.validate_job(job)
            except (OSError, ValueError, UnicodeError, monitor.jobs.probe.ProbeError):
                self.send_json(400, {"error": "检测任务格式无效；仅接受 RouteKit 的 1–100 个节点与受支持检测选项。"})
                return
            try:
                self.send_json(202, monitor.jobs.start(job))
            except JobConflict:
                self.send_json(409, {"error": "已有任务正在执行或清理，请等待完成后再开始。", "job": monitor.jobs.snapshot()})
            except (OSError, RuntimeError):
                self.send_json(503, {"error": "本地检测暂时无法启动，请检查助手与内核。"})

        def do_DELETE(self):
            methods, identifier = self.route()
            if "DELETE" not in methods:
                self.send_json(405, {"error": "此端点不支持删除"})
                return
            if not self.authorized():
                return
            state = monitor.jobs.cancel(identifier)
            self.send_json(202 if state else 404, state or {"error": "任务不存在或已被新任务替代。"})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--controller", default="http://127.0.0.1:9090")
    parser.add_argument("--secret-file", help="Mihomo controller secret 的 UTF-8 文件；也可用 ROUTEKIT_MIHOMO_SECRET 环境变量")
    parser.add_argument("--origin", action="append", default=[], help="附加精确网页来源，用于自行部署的网站")
    parser.add_argument("--core", help="可选：已安装的 Mihomo 路径；不下载，不改变现有内核或系统代理")
    args = parser.parse_args()
    try:
        secret = Path(args.secret_file).read_text(encoding="utf-8").strip() if args.secret_file else os.environ.get("ROUTEKIT_MIHOMO_SECRET", "")
        if "\r" in secret or "\n" in secret or len(secret) > 4096:
            raise ValueError("controller secret 格式无效")
        probe = load_probe()
        core = find_core(args.core)
        if args.core and not core:
            raise ValueError("--core 未指向本机可执行文件。")
        monitor = Monitor(args.controller, secret, origins=ALLOWED_ORIGINS | {origin_url(value) for value in args.origin}, jobs=ProbeJobs(core, probe))
        server = ThreadingHTTPServer(("127.0.0.1", 8766), handler_for(monitor))
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print("RouteKit 本地助手：http://127.0.0.1:8766", flush=True)
    print("会话令牌：" + monitor.token, flush=True)
    print("仅在本机运行；将令牌粘贴到 RouteKit。Ctrl+C 停止。", flush=True)
    print("节点实测：" + ("可用，收到授权任务后才启动隔离内核。" if monitor.jobs.available else "不可用，请将检测脚本放在同目录并安装 Mihomo。"), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        monitor.jobs.close()
        server.server_close()


if __name__ == "__main__":
    def stop_on_signal(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop_on_signal)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, stop_on_signal)
    main()
