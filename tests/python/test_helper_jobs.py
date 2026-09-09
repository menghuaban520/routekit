"""Real HTTP contract tests using bounded, offline job workers."""
import base64
import importlib.util
import json
from pathlib import Path
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("routekit_job_helper", Path(__file__).parents[2] / "public" / "routekit_monitor.py")
helper = importlib.util.module_from_spec(spec)
previous = sys.dont_write_bytecode
try:
    sys.dont_write_bytecode = True
    spec.loader.exec_module(helper)
finally:
    sys.dont_write_bytecode = previous
probe = helper.load_probe()
ORIGIN, TOKEN = "http://127.0.0.1:4178", "fixture-authentication-token"


def job():
    credentials = base64.urlsafe_b64encode(b"aes-128-gcm:fixture-private-password").decode()
    return {"version": 1, "options": {"speedTest": False, "downloadBytes": 1000000, "timeoutSeconds": 3},
            "nodes": [{"id": name, "name": "Fixture " + name, "server": "node.example.com", "port": 443,
                       "protocol": "ss", "uri": "ss://" + credentials + "@node.example.com:443"} for name in ["alpha", "beta"]]}


class ControlledRunner:
    def __init__(self):
        self.started = threading.Event()
        self.finish = threading.Event()
        self.cleanup_started = threading.Event()
        self.allow_cleanup = threading.Event()
        self.output = None
        self.calls = 0

    def __call__(self, value, output, executable, *, cancel_event, progress, quiet):
        self.calls += 1
        self.output = output
        assert executable == "/fixture/mihomo" and quiet
        row = probe.base_result(value["nodes"][0])
        row.update(status="ok", latencyMs=42, exitIp="8.8.8.8")
        progress([row], value["nodes"][1]["id"], "checking")
        self.started.set()
        while not self.finish.wait(.01):
            if cancel_event.is_set():
                self.cleanup_started.set()
                if not self.allow_cleanup.wait(5):
                    raise AssertionError("fixture cleanup release missing")
                raise probe.ProbeCancelled()
        second = probe.base_result(value["nodes"][1])
        second["error"] = "安全样本检测失败。"
        progress([row, second], None, "cleanup")
        return [row, second]


class HelperJobsHttpTests(unittest.TestCase):
    def setUp(self):
        self.runner = ControlledRunner()
        self.jobs = helper.ProbeJobs("/fixture/mihomo", probe, self.runner)
        self.monitor = helper.Monitor("http://127.0.0.1:9090", token=TOKEN, origins={ORIGIN}, jobs=self.jobs)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), helper.handler_for(self.monitor))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.runner.allow_cleanup.set()
        self.jobs.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, method="GET", path="/v1/capabilities", data=None, origin=ORIGIN, token=TOKEN, headers=None):
        combined = {"Origin": origin, "Authorization": "Bearer " + token, **(headers or {})}
        if data is not None and not isinstance(data, bytes):
            data = json.dumps(data).encode()
            combined.setdefault("Content-Type", "application/json")
        request = urllib.request.Request("http://127.0.0.1:" + str(self.server.server_port) + path, data=data, headers=combined, method=method)
        try:
            response = self.opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None, response.headers

    def wait_status(self, identifier, expected):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status, body, _ = self.request(path="/v1/probe/jobs/" + identifier)
            if status == 200 and body["status"] == expected:
                return body
            time.sleep(.01)
        self.fail("job did not reach " + expected)

    def start(self):
        status, body, _ = self.request("POST", "/v1/probe/jobs", job())
        self.assertEqual(status, 202)
        self.assertTrue(self.runner.started.wait(2))
        return body["id"]

    def test_capabilities_progress_and_page_reload_recovery_have_no_credentials(self):
        status, capability, headers = self.request()
        self.assertEqual(status, 200)
        self.assertTrue(capability["probe"]["available"])
        self.assertEqual(capability["probe"]["maxNodes"], 100)
        self.assertIsNone(capability["currentJob"])
        self.assertEqual(headers["Cache-Control"], "no-store")
        identifier = self.start()
        _, capability, _ = self.request()
        state = capability["currentJob"]
        self.assertEqual(state["id"], identifier)
        self.assertEqual(state["completed"], 1)
        self.assertEqual(state["currentNodeId"], "beta")
        self.assertEqual(state["report"]["results"][0]["nodeId"], "alpha")
        for private in ["fixture-private-password", "ss://", "uri", TOKEN, "/fixture/mihomo"]:
            self.assertNotIn(private, json.dumps(state))
        self.runner.finish.set()
        completed = self.wait_status(identifier, "completed")
        self.assertEqual(completed["completed"], 2)
        self.assertEqual(completed["phase"], "finished")
        self.assertFalse(self.runner.output.parent.exists())

    def test_cancel_stays_cancelling_until_cleanup_finishes_and_preserves_results(self):
        identifier = self.start()
        status, cancelling, _ = self.request("DELETE", "/v1/probe/jobs/" + identifier)
        self.assertEqual(status, 202)
        self.assertEqual(cancelling["status"], "cancelling")
        self.assertTrue(self.runner.cleanup_started.wait(2))
        self.assertTrue(self.runner.output.parent.exists())
        _, capability, _ = self.request()
        self.assertEqual(capability["currentJob"]["status"], "cancelling")
        status, conflict, _ = self.request("POST", "/v1/probe/jobs", job())
        self.assertEqual(status, 409)
        self.assertEqual(conflict["job"]["id"], identifier)
        self.runner.allow_cleanup.set()
        cancelled = self.wait_status(identifier, "cancelled")
        self.assertEqual(cancelled["completed"], 1)
        self.assertEqual(len(cancelled["report"]["results"]), 1)
        self.assertFalse(self.runner.output.parent.exists())
        self.assertEqual(self.runner.calls, 1)

    def test_all_job_methods_require_origin_and_token_before_work(self):
        identifier = str(uuid.uuid4())
        for method, path, data in [("GET", "/v1/capabilities", None), ("POST", "/v1/probe/jobs", job()),
                                   ("GET", "/v1/probe/jobs/" + identifier, None), ("DELETE", "/v1/probe/jobs/" + identifier, None)]:
            with self.subTest(method=method, path=path):
                self.assertEqual(self.request(method, path, data, token="wrong")[0], 401)
                status, _, headers = self.request(method, path, data, origin="https://untrusted.example")
                self.assertEqual(status, 403)
                self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        self.assertEqual(self.runner.calls, 0)

    def test_preflight_is_exact_for_post_delete_and_private_network_access(self):
        for method, path in [("POST", "/v1/probe/jobs"), ("DELETE", "/v1/probe/jobs/" + str(uuid.uuid4()))]:
            status, _, headers = self.request("OPTIONS", path, headers={"Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": "authorization,content-type", "Access-Control-Request-Private-Network": "true"})
            self.assertEqual(status, 204)
            self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")
            self.assertIn(method, headers["Access-Control-Allow-Methods"])
        self.assertEqual(self.request("OPTIONS", "/v1/capabilities", headers={"Access-Control-Request-Method": "DELETE"})[0], 403)
        self.assertEqual(self.request("OPTIONS", "/v1/probe/jobs", headers={"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-command"})[0], 403)

    def test_body_limits_unknown_fields_and_paths_are_rejected(self):
        status, _, _ = self.request("POST", "/v1/probe/jobs", b"{}", headers={"Content-Type": "application/json", "Content-Length": str(helper.MAX_JOB_BYTES + 1)})
        self.assertEqual(status, 413)
        bad = job()
        bad["core"] = "/must-not-execute"
        self.assertEqual(self.request("POST", "/v1/probe/jobs", bad)[0], 400)
        bad = job()
        bad["nodes"] *= 51
        self.assertEqual(self.request("POST", "/v1/probe/jobs", bad)[0], 400)
        self.assertEqual(self.request("POST", "/v1/probe/jobs", b"{broken", headers={"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/v1/probe/jobs?core=bad", job())[0], 405)
        self.assertEqual(self.request(path="/v1/probe/jobs/../../config")[0], 404)
        self.assertEqual(self.runner.calls, 0)

    def test_unavailable_probe_does_not_disable_monitor_capabilities(self):
        self.monitor.jobs = helper.ProbeJobs()
        _, capability, _ = self.request()
        self.assertFalse(capability["probe"]["available"])
        self.assertTrue(capability["monitor"])
        self.assertEqual(self.request("POST", "/v1/probe/jobs", job())[0], 503)

    def test_worker_exception_is_redacted_and_temporary_directory_is_removed(self):
        output_directory = []
        def failure(value, output, executable, **kwargs):
            output_directory.append(output.parent)
            raise RuntimeError("ss://private-password@node.example.com " + TOKEN)
        self.jobs.runner = failure
        status, initial, _ = self.request("POST", "/v1/probe/jobs", job())
        self.assertEqual(status, 202)
        failed = self.wait_status(initial["id"], "failed")
        self.assertNotIn("private-password", json.dumps(failed))
        self.assertNotIn(TOKEN, json.dumps(failed))
        self.assertTrue(failed["error"])
        self.assertFalse(output_directory[0].exists())

    def test_shutdown_waits_for_worker_cleanup_and_blocks_new_jobs(self):
        identifier = self.start()
        shutdown = threading.Thread(target=self.jobs.close)
        shutdown.start()
        self.assertTrue(self.runner.cleanup_started.wait(2))
        self.assertTrue(shutdown.is_alive())
        self.assertEqual(self.jobs.snapshot(identifier)["status"], "cancelling")
        self.assertTrue(self.runner.output.parent.exists())
        with self.assertRaises(helper.JobConflict):
            self.jobs.start(job())
        self.runner.allow_cleanup.set()
        shutdown.join(3)
        self.assertFalse(shutdown.is_alive())
        self.assertEqual(self.jobs.snapshot(identifier)["status"], "cancelled")
        self.assertFalse(self.runner.output.parent.exists())


class CooperativeProbeTests(unittest.TestCase):
    def test_cancel_during_core_validation_stops_child_and_removes_private_config(self):
        event = threading.Event()
        class Process:
            returncode = None
            terminated = False
            directory = None
            def __init__(self, *args, **kwargs):
                self.directory = Path(kwargs["cwd"])
                self.asserted_private = (self.directory / "probe.json").stat().st_mode & 0o777 == 0o600
                event.set()
            def poll(self): return self.returncode
            def terminate(self): self.terminated = True
            def wait(self, **kwargs): self.returncode = -15
        processes = []
        def start(*args, **kwargs):
            child = Process(*args, **kwargs)
            processes.append(child)
            return child
        core = probe.Core("/fixture/mihomo", [probe.parse_node(job()["nodes"][0], "NODE_1")])
        core.cancel_event = event
        with patch.object(probe.subprocess, "Popen", side_effect=start), self.assertRaises(probe.ProbeCancelled):
            with core:
                self.fail("cancelled validation must not start the proxy core")
        self.assertEqual(len(processes), 1)
        self.assertTrue(processes[0].terminated)
        self.assertTrue(processes[0].asserted_private)
        self.assertFalse(processes[0].directory.exists())

    def test_run_job_cancel_retains_finished_nodes_and_exits_core(self):
        event, exited, seen = threading.Event(), [], []
        class Core:
            rejected = set()
            def __init__(self, *_): pass
            def __enter__(self): return self
            def __exit__(self, *_): exited.append(True)
            def select(self, *_): pass
        def request(core, host, *args, **kwargs):
            if host == "api.ipapi.is":
                return b'{"ip":"8.8.8.8"}', 17, .01
            return b"", 0, .01
        def progress(rows, current_node_id, phase):
            seen.append(len(rows))
            if len(rows) == 1:
                event.set()
        import tempfile
        with tempfile.TemporaryDirectory() as directory, patch.object(probe, "proxy_get", side_effect=request), patch.object(probe, "server_ips", return_value=[]):
            path = Path(directory) / "result.json"
            with self.assertRaises(probe.ProbeCancelled):
                probe.run_job(job(), path, "/fixture/mihomo", core_factory=Core, cancel_event=event, progress=progress, quiet=True)
            self.assertEqual(len(json.loads(path.read_text())["results"]), 1)
        self.assertTrue(exited)
        self.assertIn(1, seen)


if __name__ == "__main__":
    unittest.main()
