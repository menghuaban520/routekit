"""Offline regression tests: no real subscriptions, external services or proxy core."""
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

SPEC = importlib.util.spec_from_file_location('routekit_probe', Path(__file__).resolve().parents[2] / 'public' / 'routekit_probe.py')
probe = importlib.util.module_from_spec(SPEC)
_bytecode_setting = sys.dont_write_bytecode
try:
    # public/ is shipped verbatim by Vite; do not create deployable .pyc assets.
    sys.dont_write_bytecode = True
    SPEC.loader.exec_module(probe)
finally:
    sys.dont_write_bytecode = _bytecode_setting
UUID = '00000000-0000-4000-8000-000000000001'


def b64(text):
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip('=')


def node(uri=None, protocol='ss', identifier='a', server='example.com', port=443):
    return {'id': identifier, 'name': '测试节点 ' + identifier, 'protocol': protocol,
            'server': server, 'port': port,
            'uri': uri or 'ss://' + b64('aes-128-gcm:fixture-secret') + '@example.com:443#sample'}


def job(nodes=None, **options):
    return {'version': 1, 'nodes': nodes or [node()], 'options': options}


class ParserTests(unittest.TestCase):
    def parse(self, candidate):
        return probe.parse_node(candidate, 'NODE_1')

    def test_sip002_and_legacy_ss_preserve_password(self):
        for uri, expected in [
            ('ss://' + b64('aes-128-gcm:hello:world') + '@example.com:443', 'hello:world'),
            ('ss://aes-128-gcm:hello%3Aworld@example.com:443/', 'hello:world'),
            ('ss://' + b64('aes-128-gcm:hello%world@example.com:443'), 'hello%world'),
        ]:
            with self.subTest(uri=uri):
                parsed = self.parse(node(uri))
                self.assertEqual(parsed['password'], expected)
                self.assertEqual(parsed['server'], 'example.com')
                self.assertEqual(parsed['type'], 'ss')

    def test_ss_plugin_and_unrecognized_cipher_never_downgrade(self):
        for uri in [node()['uri'].split('#')[0] + '/?plugin=v2ray-plugin',
                    'ss://' + b64('unrecognized:fixture-secret') + '@example.com:443']:
            with self.assertRaises(probe.ProbeError):
                self.parse(node(uri))

    def test_vless_reality_vision_mapping(self):
        uri = f'vless://{UUID}@example.com:443?security=reality&sni=example.net&pbk=' + 'A' * 43 + '&sid=ab12&fp=chrome&flow=xtls-rprx-vision&type=tcp'
        parsed = self.parse(node(uri, 'vless'))
        self.assertEqual(parsed['reality-opts'], {'public-key': 'A' * 43, 'short-id': 'ab12'})
        self.assertEqual(parsed['flow'], 'xtls-rprx-vision')
        self.assertTrue(parsed['tls'])
        self.assertFalse(parsed['skip-cert-verify'])

    def test_vless_ws_and_grpc_mapping(self):
        ws = self.parse(node(f'vless://{UUID}@example.com:443?security=tls&type=ws&host=front.example.com&path=%2Fproxy', 'vless'))
        self.assertEqual(ws['ws-opts'], {'path': '/proxy', 'headers': {'Host': 'front.example.com'}})
        grpc = self.parse(node(f'vless://{UUID}@example.com:443?security=tls&type=grpc&serviceName=test', 'vless'))
        self.assertEqual(grpc['grpc-opts'], {'grpc-service-name': 'test'})

    def test_vmess_ws_and_grpc_share_format(self):
        data = {'v': '2', 'ps': 'fixture', 'add': 'example.com', 'port': '443', 'id': UUID,
                'aid': '0', 'scy': 'auto', 'net': 'ws', 'type': 'none', 'path': '/ws', 'tls': 'tls', 'sni': 'example.net'}
        parsed = self.parse(node('vmess://' + b64(json.dumps(data)), 'vmess'))
        self.assertEqual(parsed['uuid'], UUID)
        self.assertEqual(parsed['ws-opts']['path'], '/ws')
        data.update(net='grpc', path='service')
        parsed = self.parse(node('vmess://' + b64(json.dumps(data)), 'vmess'))
        self.assertEqual(parsed['grpc-opts']['grpc-service-name'], 'service')

    def test_trojan_http_https_socks5(self):
        trojan = self.parse(node('trojan://secret%3Aword@example.com:443?security=tls&sni=tls.example.com', 'trojan'))
        self.assertEqual(trojan['password'], 'secret:word')
        self.assertEqual(trojan['sni'], 'tls.example.com')
        for protocol in ('http', 'https', 'socks5'):
            with self.subTest(protocol=protocol):
                parsed = self.parse(node(f'{protocol}://test:secret%40word@example.com:443', protocol))
                self.assertEqual(parsed['password'], 'secret@word')
                self.assertEqual(parsed['type'], 'http' if protocol == 'https' else protocol)
                self.assertFalse(parsed['skip-cert-verify'])
                self.assertEqual(parsed.get('tls', False), protocol == 'https')

    def test_unsupported_and_unsafe_parameters_are_rejected(self):
        parameters = ['type=xhttp', 'type=tcp&headerType=http', 'security=tls&allowInsecure=1',
                      'type=tcp&path=%2Fsecret', 'security=none&sni=example.com',
                      'type=ws&type=tcp', 'type=ws&unknown=secret', 'type=ws&host=bad%0Aheader',
                      'type=ws&host=bad%ZZ', 'security=tls&flow=unknown']
        for parameters_string in parameters:
            with self.subTest(parameters=parameters_string), self.assertRaises(probe.ProbeError):
                self.parse(node(f'vless://{UUID}@example.com:443?' + parameters_string, 'vless'))

    def test_metadata_cannot_misidentify_the_server(self):
        for candidate in [node(server='other.example'), node(port=8443), node(protocol='vless')]:
            with self.assertRaises(probe.ProbeError):
                self.parse(candidate)

    def test_ipv6_server_and_strict_job_limits(self):
        candidate = node('http://test:secret@[2001:db8::1]:443', 'http', server='2001:db8::1')
        self.assertEqual(self.parse(candidate)['server'], '2001:db8::1')
        for options in ({'downloadBytes': 5_000_001}, {'downloadBytes': True}, {'speedTest': 'true'},
                        {'timeoutSeconds': 2}, {'timeoutSeconds': float('nan')}, {'timeoutSeconds': 16}):
            with self.assertRaises(probe.ProbeError):
                probe.validate_job(job(**options))
        with self.assertRaises(probe.ProbeError):
            probe.validate_job(job([node(), node()]))
        self.assertFalse(probe.validate_job(job())[1]['speedTest'])


class FakeCore:
    events = []
    rejected = set()
    mixed_port, proxy_auth = 12345, 'test:temporary'
    def __init__(self, _executable, proxies):
        self.proxies = proxies
    def __enter__(self):
        self.events.append('enter')
        return self
    def __exit__(self, *_):
        self.events.append('exit')
    def select(self, name):
        self.events.append(name)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.output = Path(self.tmp.name) / 'result.json'
        FakeCore.events = []
        FakeCore.rejected = set()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(patch.object(probe, 'server_ips', return_value=['192.0.2.1']))
        self.stack.enter_context(patch.object(probe.time, 'sleep'))

    def request(self, _core, host, _path, _maximum, _timeout, **_kwargs):
        FakeCore.events.append(host)
        if host == 'api.ipapi.is':
            return json.dumps({'ip': '8.8.8.8', 'company': 'Google LLC', 'asn': 'AS15169 Google LLC',
                               'city': 'Mountain View', 'country': 'United States', 'lat': 37.4, 'lon': -122.1}).encode(), 200, .2
        return b'', 125000 if host == 'speed.cloudflare.com' else 0, .25

    def run_fixture(self, candidate=None, request=None, **kwargs):
        with patch.object(probe, 'proxy_get', side_effect=request or self.request):
            return probe.run_job(candidate or job(), self.output, '/fake/mihomo', core_factory=FakeCore, **kwargs)

    def test_defaults_measure_real_exit_not_entry_and_never_download_speed_body(self):
        rows = self.run_fixture()
        self.assertEqual(rows[0]['status'], 'ok')
        self.assertEqual(rows[0]['exitIp'], '8.8.8.8')
        self.assertEqual(rows[0]['serverIps'], ['192.0.2.1'])
        self.assertEqual(rows[0]['latencyMs'], 250)
        self.assertEqual(rows[0]['ipType'], 'unknown')
        self.assertNotIn('speedMbps', rows[0])
        self.assertNotIn('speed.cloudflare.com', FakeCore.events)
        content = self.output.read_text()
        self.assertNotIn('fixture-secret', content)
        self.assertNotIn('ss://', content)
        self.assertEqual(json.loads(content)['source'], 'routekit-local-probe')

    def test_selector_is_serial_and_speed_uses_received_bytes_and_elapsed_time(self):
        rows = self.run_fixture(job([node(identifier='a'), node(identifier='b')], speedTest=True, downloadBytes=125000))
        self.assertEqual(FakeCore.events, ['enter', 'NODE_1', 'www.gstatic.com', 'api.ipapi.is', 'speed.cloudflare.com',
                                         'NODE_2', 'www.gstatic.com', 'api.ipapi.is', 'speed.cloudflare.com', 'exit'])
        self.assertEqual(rows[0]['downloadedBytes'], 125000)
        self.assertEqual(rows[0]['speedMbps'], 4.0)

    def test_rate_limit_stops_subsequent_ip_calls_without_fake_exit(self):
        calls = []
        def request(core, host, *args, **kwargs):
            calls.append(host)
            if host == 'api.ipapi.is':
                raise probe.HttpFailure(429)
            return self.request(core, host, *args, **kwargs)
        rows = self.run_fixture(job([node(identifier='a'), node(identifier='b')]), request=request)
        self.assertEqual(calls.count('api.ipapi.is'), 1)
        self.assertTrue(all(row['status'] == 'error' and 'exitIp' not in row for row in rows))
        self.assertTrue(all('latencyMs' in row for row in rows))

    def test_unsupported_node_does_not_block_supported_nodes(self):
        rows = self.run_fixture(job([node('ss://' + b64('aes-128-gcm:fixture-secret') + '@example.com:443/?plugin=obfs', identifier='bad'), node(identifier='ok')]))
        self.assertEqual([row['status'] for row in rows], ['error', 'ok'])
        self.assertEqual(FakeCore.events[1], 'NODE_2')

    def test_ip_service_failure_falls_back_to_measured_cloudflare_exit_with_attribution(self):
        def request(core, host, path, *args, **kwargs):
            if host == 'api.ipapi.is':
                raise ssl.SSLError('fixture TLS failure')
            if path == '/cdn-cgi/trace':
                return b'ip=8.8.4.4\nloc=US\ncolo=SJC\n', 34, .2
            return self.request(core, host, path, *args, **kwargs)
        rows = self.run_fixture(request=request)
        self.assertEqual(rows[0]['status'], 'ok')
        self.assertEqual(rows[0]['exitIp'], '8.8.4.4')
        self.assertEqual(rows[0]['country'], 'US')
        self.assertNotIn('asn', rows[0])
        self.assertNotIn('city', rows[0])
        self.assertNotIn('speedMbps', rows[0])
        self.assertTrue(any('Cloudflare trace' in text for text in rows[0]['warnings']))

    def test_core_rejection_is_per_node(self):
        FakeCore.rejected = {'NODE_1'}
        rows = self.run_fixture(job([node(identifier='bad'), node(identifier='ok')]))
        self.assertEqual([row['status'] for row in rows], ['error', 'ok'])
        self.assertNotIn('NODE_1', FakeCore.events)

    def test_cancel_keeps_completed_rows_and_closes_core(self):
        calls = 0
        def request(core, host, *args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise KeyboardInterrupt()
            return self.request(core, host, *args, **kwargs)
        with self.assertRaises(KeyboardInterrupt):
            self.run_fixture(job([node(identifier='a'), node(identifier='b')]), request=request)
        self.assertEqual(len(json.loads(self.output.read_text())['results']), 1)
        self.assertEqual(FakeCore.events[-1], 'exit')

    def test_optional_key_is_only_sent_to_ip_api_and_never_exported(self):
        paths = []
        def request(core, host, path, *args, **kwargs):
            paths.append((host, path))
            return self.request(core, host, path, *args, **kwargs)
        self.run_fixture(request=request, ip_api_key='fixture-key&secret')
        self.assertIn(('api.ipapi.is', '/?key=fixture-key%26secret'), paths)
        self.assertNotIn('fixture-key', self.output.read_text())
        self.assertTrue(all('fixture-key' not in path for host, path in paths if host != 'api.ipapi.is'))

    def test_errors_do_not_echo_exception_credentials_or_invent_speed(self):
        def request(_core, _host, *_args, **_kwargs):
            raise OSError('secret-should-never-be-exported')
        rows = self.run_fixture(job(speedTest=True), request=request)
        self.assertEqual(rows[0]['status'], 'error')
        self.assertNotIn('speedMbps', rows[0])
        self.assertNotIn('secret-should-never-be-exported', self.output.read_text())


class TransportTests(unittest.TestCase):
    def test_https_uses_explicit_local_connect_and_certificate_validation(self):
        connection = MagicMock()
        response = connection.getresponse.return_value
        response.status = 200
        response.getheader.return_value = '3'
        response.isclosed.return_value = False
        response.read1.side_effect = [b'abc', b'']
        with patch.object(probe.http.client, 'HTTPSConnection', return_value=connection) as constructor:
            body, count, elapsed = probe.proxy_get(FakeCore, 'api.ipapi.is', '/', 100, 3)
        self.assertEqual((body, count), (b'abc', 3))
        self.assertGreaterEqual(elapsed, 0)
        self.assertEqual(constructor.call_args.args, ('127.0.0.1', 12345))
        context = constructor.call_args.kwargs['context']
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(connection.set_tunnel.call_args.args, ('api.ipapi.is', 443))
        self.assertEqual(connection.close.call_count, 1)

    def test_small_completed_body_does_not_touch_a_closed_socket(self):
        connection = MagicMock()
        response = connection.getresponse.return_value
        response.status = 200
        response.getheader.return_value = '3'
        response.isclosed.side_effect = [False, True]
        response.read1.return_value = b'abc'
        connection.sock.settimeout.side_effect = [None, OSError('bad file descriptor')]
        with patch.object(probe.http.client, 'HTTPSConnection', return_value=connection):
            body, count, _ = probe.proxy_get(FakeCore, 'api.ipapi.is', '/', 100, 3)
        self.assertEqual((body, count), (b'abc', 3))
        connection.sock.settimeout.assert_called_once()
        response.read1.assert_called_once()

    def test_redirects_and_oversized_responses_fail_closed(self):
        for status, length in [(302, '0'), (200, '5000001')]:
            connection = MagicMock()
            response = connection.getresponse.return_value
            response.status, response.getheader.return_value = status, length
            with patch.object(probe.http.client, 'HTTPSConnection', return_value=connection), self.assertRaises(probe.ProbeError):
                probe.proxy_get(FakeCore, 'speed.cloudflare.com', '/__down?bytes=100', 100, 3)
            response.read1.assert_not_called()
            connection.close.assert_called_once()

    def test_core_is_private_no_system_tun_or_direct_fallback(self):
        parsed = probe.parse_node(node(), 'NODE_1')
        config = probe.core_config([parsed], 10000, 10001, 'secret', 'user:secret')
        self.assertEqual(config['bind-address'], '127.0.0.1')
        self.assertEqual(config['external-controller'], '127.0.0.1:10001')
        self.assertFalse(config['allow-lan'])
        self.assertFalse(config['tun']['enable'])
        self.assertEqual(config['rules'], ['MATCH,PROBE'])
        self.assertEqual(config['proxy-groups'][0]['proxies'], ['NODE_1'])

    def test_core_closes_process_and_removes_config_on_failure(self):
        process = MagicMock()
        process.poll.return_value = None
        parsed = probe.parse_node(node(), 'NODE_1')
        core = probe.Core('/fake/mihomo', [parsed])
        with patch.object(probe.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)), \
             patch.object(probe.subprocess, 'Popen', return_value=process), \
             patch.object(core, 'controller', return_value={'version': 'fixture'}):
            with self.assertRaises(RuntimeError):
                with core:
                    directory = Path(core.directory.name)
                    self.assertEqual((directory / 'probe.json').stat().st_mode & 0o777, 0o600)
                    raise RuntimeError('fixture cancellation')
        process.terminate.assert_called_once()
        self.assertFalse(directory.exists())

    def test_anonymous_metadata_does_not_infer_residential_from_isp(self):
        row = probe.ip_info({'ip': '8.8.8.8', 'company': {'name': 'Example', 'type': 'isp'},
                             'asn': {'asn': 12345, 'org': 'Example', 'type': 'isp'},
                             'location': {'country': 'Example', 'latitude': 12, 'longitude': 24}})
        self.assertEqual(row['ipType'], 'unknown')
        self.assertEqual(row['asn'], 'AS12345')
        with self.assertRaises(probe.ProbeError):
            probe.ip_info({'ip': '192.168.1.1'})

    def test_trace_does_not_accept_private_duplicate_or_malformed_addresses(self):
        for body in [b'ip=192.168.1.1\nloc=US', b'ip=invalid\nloc=US', b'ip=8.8.8.8\nip=1.1.1.1']:
            with self.assertRaises(probe.ProbeError):
                probe.trace_info(body)
        self.assertNotIn('country', probe.trace_info(b'ip=8.8.8.8\nloc=US<script>'))


if __name__ == '__main__':
    unittest.main()
