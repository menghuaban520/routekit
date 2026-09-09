import importlib.util
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location("routekit_monitor", Path(__file__).parents[2] / "public" / "routekit_monitor.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ORIGIN = "http://127.0.0.1:4178"
TOKEN = "fixture-only-monitor-token"


class ControllerFixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.calls.append(self.path)
        if self.headers.get("Authorization") != "Bearer fixture-controller-secret":
            self.send_response(401)
            self.end_headers()
            return
        if self.server.redirect:
            self.send_response(302)
            self.send_header("Location", "https://example.com/must-not-follow")
            self.end_headers()
            return
        if self.path == "/traffic":
            self.server.counter += 1
            value = {"up": 2048, "down": 4096}
        elif self.path == "/connections":
            value = {"uploadTotal": 8000, "downloadTotal": 16000, "connections": [{"id": "fixture-connection", "chains": ["测试 Tokyo", "PROXY"], "upload": self.server.counter * 1000, "download": self.server.counter * 2000, "metadata": {"host": "private-test.example", "destinationIP": "203.0.113.2"}}]}
        else:
            self.send_response(404)
            self.end_headers()
            return
        body = (json.dumps(value) + "\n").encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def fixture_controller():
    server = ThreadingHTTPServer(("127.0.0.1", 0), ControllerFixture)
    server.counter, server.calls, server.redirect = 0, [], False
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.controller = fixture_controller()
        self.monitor = module.Monitor("http://127.0.0.1:" + str(self.controller.server_port), "fixture-controller-secret", token=TOKEN, origins={ORIGIN})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), module.handler_for(self.monitor))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.controller.shutdown()
        self.controller.server_close()

    def request(self, method="GET", path="/v1/snapshot", origin=ORIGIN, token=TOKEN, extra=None):
        headers = {"Origin": origin, "Authorization": "Bearer " + token, "X-RouteKit-Session": "test-session-1", **(extra or {})}
        request = urllib.request.Request("http://127.0.0.1:" + str(self.server.server_port) + path, headers=headers, method=method)
        try:
            return self.opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            return error

    def test_origin_and_token_are_both_required(self):
        with self.request(origin="https://untrusted.example") as response:
            self.assertEqual(response.status, 403)
            self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))
        with self.request(token="wrong") as response:
            self.assertEqual(response.status, 401)
        self.assertEqual(self.controller.calls, [])

    def test_private_network_preflight_is_exact(self):
        with self.request(method="OPTIONS", extra={"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,x-routekit-session", "Access-Control-Request-Private-Network": "true"}) as response:
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers["Access-Control-Allow-Private-Network"], "true")
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], ORIGIN)
        with self.request(method="OPTIONS", extra={"Access-Control-Request-Method": "DELETE"}) as response:
            self.assertEqual(response.status, 403)

    def test_fixed_read_only_endpoint(self):
        for method, path in [("POST", "/v1/snapshot"), ("GET", "/v1/snapshot?url=https://example.com"), ("GET", "/configs")]:
            with self.request(method=method, path=path) as response:
                self.assertIn(response.status, [404, 405])
        self.assertEqual(self.controller.calls, [])

    def test_snapshot_uses_actual_counts_and_omits_sensitive_metadata(self):
        with self.request() as response:
            raw = response.read().decode()
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        data = json.loads(raw)
        self.assertEqual(data["downloadBytesPerSecond"], 4096)
        self.assertEqual(data["chains"][0]["downloadedBytes"], 2000)
        self.assertNotIn("downloadBytesPerSecond", data["chains"][0])
        self.assertNotIn("private-test", raw)
        self.assertNotIn("fixture-controller-secret", raw)
        self.assertEqual(self.controller.calls, ["/traffic", "/connections"])

    def test_chain_rates_need_two_samples_and_counter_reset_is_not_negative(self):
        self.monitor.snapshot()
        data = self.monitor.snapshot()
        self.assertGreater(data["chains"][0]["downloadBytesPerSecond"], 0)
        self.controller.counter = -1
        data = self.monitor.snapshot()
        self.assertNotIn("downloadBytesPerSecond", data["chains"][0])

    def test_controller_redirect_is_rejected(self):
        self.controller.redirect = True
        with self.request() as response:
            self.assertEqual(response.status, 502)
        self.assertEqual(self.controller.calls, ["/traffic"])

    def test_restart_long_gap_and_failure_reset_the_rate_baseline(self):
        self.monitor.snapshot("session-1")
        self.assertIn("downloadBytesPerSecond", self.monitor.snapshot("session-1")["chains"][0])
        self.assertNotIn("downloadBytesPerSecond", self.monitor.snapshot("session-2")["chains"][0])
        self.monitor.previous_at -= 60
        self.assertNotIn("downloadBytesPerSecond", self.monitor.snapshot("session-2")["chains"][0])
        self.monitor.snapshot("test-session-1")
        self.controller.redirect = True
        with self.request() as response:
            self.assertEqual(response.status, 502)
        self.controller.redirect = False
        self.assertNotIn("downloadBytesPerSecond", self.monitor.snapshot("test-session-1")["chains"][0])

    def test_loopback_controller_only_and_no_url_secrets(self):
        for value in ["https://example.com", "http://192.168.1.1:9090", "http://localhost:9090", "http://u:p@127.0.0.1", "http://127.0.0.1/configs", "http://127.0.0.1?x=1", "ftp://127.0.0.1"]:
            with self.assertRaises(ValueError, msg=value):
                module.controller_url(value)
        self.assertEqual(module.controller_url("http://[::1]:9090"), "http://[::1]:9090")

    def test_malformed_and_unknown_counts_are_rejected(self):
        for value in [None, True, -1, "1024", float("nan"), float("inf"), 10 ** 400]:
            with self.assertRaises(ValueError):
                module.nonnegative(value)


if __name__ == "__main__":
    if "--serve-fixture" in sys.argv:
        controller = fixture_controller()
        monitor = module.Monitor("http://127.0.0.1:" + str(controller.server_port), "fixture-controller-secret", token=TOKEN, origins={ORIGIN})
        server = ThreadingHTTPServer(("127.0.0.1", 8766), module.handler_for(monitor))
        print("fixture-ready", flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
            controller.shutdown()
            controller.server_close()
    else:
        unittest.main()
