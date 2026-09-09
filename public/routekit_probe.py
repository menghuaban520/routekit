#!/usr/bin/env python3
"""RouteKit local node probe. Python 3.10+, standard library only. MIT License.

Credentials stay in memory and a private temporary mihomo configuration. Only
fixed HTTPS test destinations are contacted; no system proxy settings are changed.
"""
import argparse
import base64
import binascii
import datetime as dt
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid

MAX_JOB_BYTES = 2 * 1024 * 1024
HELPER_API_VERSION = 1
MAX_DOWNLOAD = 5_000_000
IP_API_INTERVAL = 1.2
ALLOWED_HOSTS = {'www.gstatic.com', 'api.ipapi.is', 'speed.cloudflare.com'}
PROTOCOLS = {'ss', 'vmess', 'vless', 'trojan', 'socks5', 'http', 'https'}
CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]')


class ProbeError(Exception):
    """Only fixed, credential-free messages may be used here."""


class ProbeCancelled(Exception):
    """Cooperative cancellation; never converted to a failed-node result."""


def check_cancel(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise ProbeCancelled()


class HttpFailure(ProbeError):
    def __init__(self, status):
        self.status = status
        super().__init__('检测端点返回 HTTP 错误。')


def clean_text(value, limit=1024, empty=False):
    if not isinstance(value, str) or len(value) > limit or CONTROL.search(value) or (not empty and not value):
        raise ProbeError('节点包含无效文本字段。')
    return value


def decode64(value):
    try:
        value = value.rstrip('=')
        if not re.fullmatch(r'[A-Za-z0-9_+/\-]+', value):
            raise ValueError()
        return base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True).decode('utf-8')
    except (ValueError, UnicodeError, binascii.Error):
        raise ProbeError('节点的 Base64 编码无效。') from None


def decoded(value):
    try:
        if re.search(r'%(?![0-9A-Fa-f]{2})', value):
            raise ValueError()
        return clean_text(urllib.parse.unquote(value, errors='strict'), 4096, empty=True)
    except (UnicodeError, ValueError):
        raise ProbeError('节点的 URL 编码无效。') from None


def host_name(value):
    clean_text(value, 253)
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        try:
            host = value.rstrip('.').encode('idna').decode('ascii').lower()
            if len(host) > 253 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part) for part in host.split('.')):
                raise ValueError()
            return host
        except (ValueError, UnicodeError):
            raise ProbeError('节点服务器主机名无效。') from None


def port_number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not re.fullmatch(r'[0-9]{1,5}', str(value)):
        raise ProbeError('节点端口无效。')
    value = int(value)
    if not 1 <= value <= 65535:
        raise ProbeError('节点端口无效。')
    return value


def query_options(query, allowed):
    try:
        if re.search(r'%(?![0-9A-Fa-f]{2})', query):
            raise ValueError()
        pairs = urllib.parse.parse_qsl(query, keep_blank_values=True, strict_parsing=True, max_num_fields=30, errors='strict')
    except (ValueError, UnicodeError):
        raise ProbeError('节点的查询参数格式无效。') from None
    result = {}
    for key, value in pairs:
        clean_text(value, 4096, empty=True)
        if key not in allowed or key in result:
            raise ProbeError('节点包含暂不支持或重复的参数；未降级连接。')
        result[key] = value
    return result


def require_uuid(value):
    try:
        return str(uuid.UUID(clean_text(value, 36)))
    except (ValueError, AttributeError):
        raise ProbeError('VMess / VLESS 需要有效 UUID。') from None


def transport(proxy, network, host='', path='', service='', header='none', mode=''):
    if network not in {'tcp', 'ws', 'grpc'} or header not in {'', 'none'}:
        raise ProbeError('暂不支持此传输或伪装方式；仅支持普通 TCP、WebSocket、gRPC。')
    if mode not in {'', 'gun'}:
        raise ProbeError('暂不支持此 gRPC 模式。')
    proxy['network'] = network
    if network == 'ws':
        if service or mode:
            raise ProbeError('WebSocket 包含不适用的 gRPC 参数。')
        if path and not path.startswith('/'):
            raise ProbeError('WebSocket 路径必须以斜线开头。')
        proxy['ws-opts'] = {'path': path or '/'}
        if host:
            proxy['ws-opts']['headers'] = {'Host': clean_text(host)}
    elif network == 'grpc':
        if host or path:
            raise ProbeError('gRPC 的 host/path 参数不能可靠转换，请使用 serviceName。')
        proxy['grpc-opts'] = {'grpc-service-name': service}
    elif host or path or service or mode:
        raise ProbeError('普通 TCP 包含无法应用的传输参数；未忽略这些参数。')


def tls_options(proxy, security, options, trojan=False):
    if options.get('allowInsecure', '0') not in {'0', 'false'} or options.get('insecure', '0') not in {'0', 'false'}:
        raise ProbeError('检测器不允许关闭 TLS 证书验证。')
    if security not in {'none', 'tls', 'reality'} or (trojan and security != 'tls'):
        raise ProbeError('暂不支持此 TLS / 安全类型。')
    if security == 'none':
        if any(options.get(key) for key in ('sni', 'fp', 'alpn', 'pbk', 'sid')):
            raise ProbeError('未启用 TLS 的节点包含 TLS 参数。')
        proxy['tls'] = False
        return
    if not trojan:
        proxy['tls'] = True
    proxy['skip-cert-verify'] = False
    if options.get('sni'):
        proxy['sni' if trojan else 'servername'] = host_name(options['sni'])
    if options.get('fp'):
        if options['fp'] not in {'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized', '360', 'qq'}:
            raise ProbeError('暂不支持此 TLS 客户端指纹。')
        proxy['client-fingerprint'] = options['fp']
    if options.get('alpn'):
        alpn = options['alpn'].split(',')
        if any(item not in {'h2', 'http/1.1'} for item in alpn):
            raise ProbeError('暂不支持此 ALPN 设置。')
        proxy['alpn'] = alpn
    if security == 'reality':
        key, short = options.get('pbk', ''), options.get('sid', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', key) or not re.fullmatch(r'(?:[0-9a-fA-F]{2}){0,8}', short):
            raise ProbeError('Reality 公钥或 short-id 格式无效。')
        proxy['reality-opts'] = {'public-key': key, 'short-id': short}
        proxy.setdefault('client-fingerprint', 'chrome')
    elif options.get('pbk') or options.get('sid'):
        raise ProbeError('Reality 参数与安全类型不一致。')


def parse_node(node, internal_name):
    """Convert only parameters with an explicit mihomo mapping; never echo URI."""
    uri = clean_text(node['uri'], 16384)
    protocol = node['protocol'].lower()
    protocol = {'shadowsocks': 'ss', 'socks': 'socks5'}.get(protocol, protocol)
    if protocol not in PROTOCOLS:
        raise ProbeError('暂不支持此节点协议。')
    proxy = {'name': internal_name, 'type': 'http' if protocol == 'https' else protocol,
             'udp': False, 'skip-cert-verify': False}
    try:
        if uri.split('://', 1)[0].lower() != protocol:
            raise ProbeError('节点协议与 URI 不一致。')
        if protocol == 'vmess':
            raw = uri[8:].split('#', 1)[0]
            data = json.loads(decode64(raw))
            allowed = {'v', 'ps', 'add', 'port', 'id', 'aid', 'scy', 'net', 'type', 'host', 'path', 'tls', 'sni', 'alpn', 'fp'}
            if not isinstance(data, dict) or set(data) - allowed:
                raise ProbeError('VMess 包含暂不支持的字段。')
            if str(data.get('v', '2')) != '2':
                raise ProbeError('仅支持 VMess v2 分享格式。')
            server, port = host_name(data.get('add')), port_number(data.get('port'))
            proxy.update(uuid=require_uuid(data.get('id')), alterId=0)
            aid = data.get('aid', 0)
            if isinstance(aid, bool) or not re.fullmatch(r'\d{1,5}', str(aid)) or not 0 <= int(aid) <= 65535:
                raise ProbeError('VMess alterId 无效。')
            proxy['alterId'] = int(aid)
            cipher = data.get('scy') or 'auto'
            if cipher not in {'auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'}:
                raise ProbeError('暂不支持此 VMess 加密方式。')
            proxy['cipher'] = cipher
            for key in ('net', 'type', 'host', 'path', 'tls', 'sni', 'alpn', 'fp'):
                clean_text(data.get(key, ''), 4096, empty=True)
            network = data.get('net') or 'tcp'
            # v2rayN's VMess gRPC shares put the service name in path.
            transport(proxy, network, data.get('host', ''), '' if network == 'grpc' else data.get('path', ''),
                      data.get('path', '') if network == 'grpc' else '', data.get('type') or 'none')
            tls_options(proxy, data.get('tls') or 'none', data)
        else:
            legacy_ss = False
            if protocol == 'ss' and '@' not in uri.split('#', 1)[0].split('?', 1)[0]:
                if '?' in uri.split('#', 1)[0]:
                    raise ProbeError('暂不支持此旧版 Shadowsocks 插件格式。')
                uri = 'ss://' + decode64(uri[5:].split('#', 1)[0])
                legacy_ss = True
            parsed = urllib.parse.urlsplit(uri)
            if parsed.path not in {'', '/'}:
                raise ProbeError('节点 URI 包含无法应用的路径。')
            server = host_name(parsed.hostname)
            port = port_number(parsed.port or {'http': 80, 'https': 443, 'socks5': 1080}.get(protocol))
            auth = parsed.netloc.rsplit('@', 1)[0] if '@' in parsed.netloc else ''
            if protocol == 'ss':
                query_options(parsed.query, set())
                credentials = auth if legacy_ss else decoded(auth)
                if ':' not in credentials:
                    credentials = decode64(credentials)
                cipher, password = credentials.split(':', 1)
                if cipher not in {'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305',
                                  'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm',
                                  '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305'}:
                    raise ProbeError('暂不支持此 Shadowsocks 加密方式；插件不会被忽略。')
                proxy.update(cipher=cipher, password=clean_text(password, 4096))
            elif protocol in {'vless', 'trojan'}:
                options = query_options(parsed.query, {'type', 'security', 'sni', 'fp', 'alpn', 'pbk', 'sid', 'flow',
                                                        'encryption', 'host', 'path', 'serviceName', 'headerType',
                                                        'mode', 'allowInsecure', 'insecure'})
                if ':' in auth or not auth:
                    raise ProbeError('节点认证字段格式无效。')
                if protocol == 'vless':
                    proxy['uuid'] = require_uuid(decoded(auth))
                    if options.get('encryption', 'none') not in {'', 'none'}:
                        raise ProbeError('暂不支持此 VLESS encryption 设置。')
                else:
                    if 'encryption' in options or 'flow' in options:
                        raise ProbeError('Trojan 包含不适用的 VLESS 参数。')
                    proxy['password'] = clean_text(decoded(auth), 4096)
                transport(proxy, options.get('type') or 'tcp', options.get('host', ''), options.get('path', ''),
                          options.get('serviceName', ''), options.get('headerType') or 'none', options.get('mode', ''))
                security = options.get('security') or ('tls' if protocol == 'trojan' else 'none')
                tls_options(proxy, security, options, trojan=protocol == 'trojan')
                if options.get('flow'):
                    if options['flow'] != 'xtls-rprx-vision' or proxy['network'] != 'tcp' or security == 'none':
                        raise ProbeError('暂不支持此 VLESS flow 组合。')
                    proxy['flow'] = options['flow']
            else:
                options = query_options(parsed.query, {'sni'} if protocol == 'https' else set())
                if auth:
                    if ':' not in auth:
                        raise ProbeError('HTTP / SOCKS5 认证需要 username:password。')
                    user, password = auth.split(':', 1)
                    proxy.update(username=clean_text(decoded(user)), password=clean_text(decoded(password), 4096, empty=True))
                if protocol == 'https':
                    proxy['tls'] = True
                    if options.get('sni'):
                        proxy['sni'] = host_name(options['sni'])
        if host_name(node['server']) != server or port_number(node['port']) != port:
            raise ProbeError('节点主机或端口与 URI 不一致，请重新导出检测任务。')
        proxy.update(server=server, port=port)
        return proxy
    except ProbeError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        raise ProbeError('节点 URI 无效，或包含未支持的分享格式。') from None


def validate_job(job):
    if not isinstance(job, dict) or job.get('version') != 1 or isinstance(job.get('version'), bool):
        raise ProbeError('检测任务版本无效。')
    if set(job) - {'version', 'nodes', 'options'}:
        raise ProbeError('检测任务包含未知字段。')
    nodes = job.get('nodes')
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= 100:
        raise ProbeError('检测任务需要 1–100 个节点。')
    seen = set()
    for node in nodes:
        if not isinstance(node, dict) or set(node) != {'id', 'name', 'protocol', 'server', 'port', 'uri'}:
            raise ProbeError('检测任务节点字段不完整。')
        clean_text(node['id'], 128)
        clean_text(node['name'], 160)
        clean_text(node['protocol'], 32)
        if node['protocol'] not in PROTOCOLS:
            raise ProbeError('检测任务包含不支持的节点协议。')
        clean_text(node['uri'], 16384)
        host_name(node['server'])
        port_number(node['port'])
        if node['id'] in seen:
            raise ProbeError('节点 ID 不能重复。')
        seen.add(node['id'])
    options = job.get('options', {})
    if not isinstance(options, dict) or set(options) - {'speedTest', 'downloadBytes', 'timeoutSeconds'}:
        raise ProbeError('检测选项无效。')
    speed = options.get('speedTest', False)
    size = options.get('downloadBytes', 1_000_000)
    timeout = options.get('timeoutSeconds', 8)
    if not isinstance(speed, bool) or isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= MAX_DOWNLOAD:
        raise ProbeError('下载样本必须为 1–5,000,000 字节，测速开关必须为布尔值。')
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 3 <= timeout <= 15:
        raise ProbeError('单次请求超时必须在 3–15 秒之间。')
    return nodes, {'speedTest': speed, 'downloadBytes': size, 'timeoutSeconds': timeout}


def reserve_ports():
    # Hold both reservations together to prevent choosing the same port twice.
    with socket.socket() as first, socket.socket() as second:
        first.bind(('127.0.0.1', 0))
        second.bind(('127.0.0.1', 0))
        return first.getsockname()[1], second.getsockname()[1]


def core_config(proxies, mixed_port, controller_port, secret, proxy_auth):
    return {'mixed-port': mixed_port, 'allow-lan': False, 'bind-address': '127.0.0.1',
            'authentication': [proxy_auth], 'external-controller': f'127.0.0.1:{controller_port}',
            'secret': secret, 'mode': 'rule', 'log-level': 'silent', 'ipv6': True,
            'tun': {'enable': False}, 'dns': {'enable': False}, 'profile': {'store-selected': False},
            'geo-auto-update': False, 'proxies': proxies,
            'proxy-groups': [{'name': 'PROBE', 'type': 'select', 'proxies': [p['name'] for p in proxies]}],
            'rules': ['MATCH,PROBE']}


class Core:
    def __init__(self, executable, proxies):
        self.executable, self.proxies = executable, proxies
        self.process, self.directory = None, None
        self.mixed_port, self.controller_port = reserve_ports()
        self.secret = secrets.token_urlsafe(32)
        self.proxy_auth = 'routekit:' + secrets.token_urlsafe(32)
        self.rejected = set()
        self.cancel_event = None

    def controller(self, method, path, payload=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.controller_port, timeout=2)
        try:
            body = None if payload is None else json.dumps(payload).encode()
            connection.request(method, path, body=body, headers={'Authorization': 'Bearer ' + self.secret,
                                                               'Content-Type': 'application/json'})
            response = connection.getresponse()
            result = response.read(65537)
            if len(result) > 65536 or response.status not in {200, 204}:
                raise ProbeError('本地检测核心控制接口失败。')
            return json.loads(result) if result else None
        finally:
            connection.close()

    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory(prefix='routekit-probe-')
        try:
            directory = Path(self.directory.name)
            config_path = directory / 'probe.json'
            env = {key: value for key, value in os.environ.items()
                   if key.lower() not in {'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'safe_paths'}}
            command = [self.executable, '-d', str(directory), '-f', str(config_path)]
            def write_config(proxies):
                config = core_config(proxies, self.mixed_port, self.controller_port, self.secret, self.proxy_auth)
                with config_path.open('w', encoding='utf-8') as output:
                    os.chmod(config_path, 0o600)
                    json.dump(config, output, ensure_ascii=False)
            # A syntactically valid URI can still have an invalid cryptographic
            # key. Isolate -t per node so one bad key cannot abort other nodes.
            for proxy in self.proxies:
                check_cancel(self.cancel_event)
                write_config([proxy])
                if self.cancel_event is None:
                    checked = subprocess.run(command + ['-t'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                             stderr=subprocess.DEVNULL, timeout=15, env=env, cwd=directory)
                    returncode = checked.returncode
                else:
                    checked = subprocess.Popen(command + ['-t'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                               stderr=subprocess.DEVNULL, env=env, cwd=directory)
                    try:
                        deadline = time.monotonic() + 15
                        while checked.poll() is None:
                            check_cancel(self.cancel_event)
                            if time.monotonic() >= deadline:
                                raise ProbeError('节点核心校验超时。')
                            self.cancel_event.wait(.1)
                        returncode = checked.returncode
                    finally:
                        if checked.poll() is None:
                            checked.terminate()
                            try:
                                checked.wait(timeout=3)
                            except subprocess.TimeoutExpired:
                                checked.kill()
                                checked.wait(timeout=3)
                if returncode:
                    self.rejected.add(proxy['name'])
            check_cancel(self.cancel_event)
            valid = [proxy for proxy in self.proxies if proxy['name'] not in self.rejected]
            if not valid:
                return self
            write_config(valid)
            self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                            stderr=subprocess.DEVNULL, env=env, cwd=directory)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                check_cancel(self.cancel_event)
                if self.process.poll() is not None:
                    raise ProbeError('mihomo 启动失败；请检查核心兼容性和本地端口。')
                try:
                    self.controller('GET', '/version')
                    return self
                except (OSError, http.client.HTTPException, ProbeError, ValueError):
                    time.sleep(0.1)
            raise ProbeError('等待本地 mihomo 启动超时。')
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def select(self, name):
        self.controller('PUT', '/proxies/PROBE', {'name': name})
        selected = self.controller('GET', '/proxies/PROBE')
        if not isinstance(selected, dict) or selected.get('now') != name:
            raise ProbeError('无法确认节点切换，已停止该节点检测。')

    def __exit__(self, *_):
        try:
            if self.process and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
        finally:
            if self.directory:
                self.directory.cleanup()


def proxy_get(core, host, path, maximum, timeout, status=200, keep_body=True):
    """Explicit CONNECT: ignores system proxy / NO_PROXY; never follows redirects."""
    if host not in ALLOWED_HOSTS:
        raise ProbeError('不允许的检测端点。')
    cancel_event = getattr(core, 'cancel_event', None)
    check_cancel(cancel_event)
    context = ssl.create_default_context()
    connection = http.client.HTTPSConnection('127.0.0.1', core.mixed_port, timeout=timeout, context=context)
    token = base64.b64encode(core.proxy_auth.encode()).decode('ascii')
    connection.set_tunnel(host, 443, headers={'Proxy-Authorization': 'Basic ' + token})
    started = time.monotonic()
    body, downloaded = [], 0
    try:
        connection.request('GET', path, headers={'User-Agent': 'RouteKit-Local-Probe/1', 'Accept-Encoding': 'identity',
                                                'Connection': 'close', 'Cache-Control': 'no-cache'})
        transport_socket = connection.sock
        response = connection.getresponse()
        check_cancel(cancel_event)
        if response.status != status:
            raise HttpFailure(response.status)
        length = response.getheader('Content-Length')
        if length is not None and (not length.isdigit() or int(length) > maximum):
            raise ProbeError('检测响应超过允许大小。')
        while downloaded < maximum:
            check_cancel(cancel_event)
            if response.isclosed():
                break
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError()
            if transport_socket:
                transport_socket.settimeout(remaining)
            chunk = response.read1(min(65536, maximum - downloaded))
            if not chunk:
                break
            downloaded += len(chunk)
            if keep_body:
                body.append(chunk)
        if length is not None and downloaded != int(length):
            raise ProbeError('检测响应未完整下载。')
        elapsed = time.monotonic() - started
        if elapsed > timeout:
            raise TimeoutError()
        return b''.join(body), downloaded, elapsed
    finally:
        connection.close()


def ip_info(payload):
    if not isinstance(payload, dict) or payload.get('error'):
        raise ProbeError('出口 IP 服务未返回可用数据。')
    try:
        address = ipaddress.ip_address(payload.get('ip', ''))
        if not address.is_global:
            raise ValueError()
    except ValueError:
        raise ProbeError('出口 IP 服务未返回公网地址。') from None
    result = {'exitIp': str(address), 'ipType': 'unknown'}
    location = payload.get('location') if isinstance(payload.get('location'), dict) else payload
    for target, source in [('country', 'country'), ('region', 'state' if 'state' in location else 'region'), ('city', 'city')]:
        value = location.get(source)
        if isinstance(value, str) and len(value) <= 200 and not CONTROL.search(value):
            result[target] = value
    for target, choices, limit in [('latitude', ('latitude', 'lat'), 90), ('longitude', ('longitude', 'lon'), 180)]:
        value = next((location[key] for key in choices if key in location), None)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and abs(value) <= limit:
            result[target] = value
    asn, company = payload.get('asn'), payload.get('company')
    if isinstance(asn, dict):
        number = asn.get('asn')
        if isinstance(number, int) and not isinstance(number, bool) and 0 <= number <= 4294967295:
            result['asn'] = f'AS{number}'
    elif isinstance(asn, str) and re.fullmatch(r'AS\d+(?: [^\x00-\x1f]{1,200})?', asn):
        result['asn'] = asn
    organization = company.get('name') if isinstance(company, dict) else company
    if not organization and isinstance(asn, dict):
        organization = asn.get('org')
    if isinstance(organization, str) and len(organization) <= 200 and not CONTROL.search(organization):
        result['organization'] = organization
    # Ownership 'isp' does not establish residential status. Missing flags stay unknown.
    if payload.get('is_datacenter') is True:
        result['ipType'] = 'datacenter'
    elif payload.get('is_mobile') is True:
        result['ipType'] = 'mobile'
    elif payload.get('is_vpn') is True:
        result['ipType'] = 'vpn'
    elif payload.get('is_proxy') is True or payload.get('is_tor') is True:
        result['ipType'] = 'proxy'
    return result


def trace_info(body):
    try:
        text = body.decode('utf-8')
        fields = {}
        for line in text.splitlines():
            if '=' not in line:
                continue
            key, value = line.split('=', 1)
            if key in {'ip', 'loc'}:
                if key in fields:
                    raise ValueError()
                fields[key] = value
        address = ipaddress.ip_address(fields.get('ip', ''))
        if not address.is_global:
            raise ValueError()
        result = {'exitIp': str(address), 'ipType': 'unknown'}
        if re.fullmatch(r'[A-Z]{2}', fields.get('loc', '')):
            result['country'] = fields['loc']
        return result
    except (ValueError, UnicodeError):
        raise ProbeError('Cloudflare 未返回有效的公网出口 IP。') from None


def atomic_result(path, results):
    value = {'version': 1, 'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z'),
             'results': results, 'source': 'routekit-local-probe'}
    fd, temporary = tempfile.mkstemp(prefix='.routekit-result-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            json.dump(value, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write('\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def base_result(node):
    return {'nodeId': node['id'], 'name': node['name'], 'server': node['server'],
            'protocol': node['protocol'], 'status': 'error'}


def server_ips(server, timeout=3):
    """System DNS resolves only the entry host; it is never an exit-IP probe."""
    try:
        return [str(ipaddress.ip_address(server))]
    except ValueError:
        result = []
        def resolve():
            try:
                addresses = socket.getaddrinfo(server, None, type=socket.SOCK_STREAM)
                result.extend(sorted({str(ipaddress.ip_address(item[4][0])) for item in addresses}))
            except (OSError, ValueError):
                pass
        worker = threading.Thread(target=resolve, daemon=True)
        worker.start()
        worker.join(timeout)
        return result[:20] if not worker.is_alive() else []


def error_message(error, step):
    if isinstance(error, HttpFailure):
        return f'{step}：检测服务返回 HTTP {error.status}。'
    if isinstance(error, ProbeError):
        return f'{step}：{error}'
    if isinstance(error, (TimeoutError, socket.timeout)):
        return f'{step}：请求超时。'
    if isinstance(error, ssl.SSLError):
        return f'{step}：TLS 证书或握手失败；未关闭证书验证。'
    return f'{step}：连接或响应失败。'


def run_job(job, output, executable, core_factory=Core, ip_api_key=None, cancel_event=None, progress=None, quiet=False):
    nodes, options = validate_job(job)
    results, accepted = [], []
    def publish(current_node_id=None, phase='checking'):
        atomic_result(output, results)
        if progress is not None:
            progress(results, current_node_id, phase)
    publish(phase='preparing')
    for index, node in enumerate(nodes):
        check_cancel(cancel_event)
        try:
            accepted.append((node, parse_node(node, f'NODE_{index + 1}')))
        except ProbeError as error:
            result = base_result(node)
            result['error'] = str(error)
            results.append(result)
            publish(phase='preparing')
    publish(phase='preparing')
    if not accepted:
        return results
    ip_allowed, last_ip_request = True, 0.0
    try:
        core_instance = core_factory(executable, [proxy for _, proxy in accepted])
        core_instance.cancel_event = cancel_event
        with core_instance as core:
            for index, (node, proxy) in enumerate(accepted, 1):
                check_cancel(cancel_event)
                publish(node['id'])
                if not quiet:
                    print(f'[{index}/{len(accepted)}] {node["name"]}', flush=True)
                result, errors = base_result(node), []
                if proxy['name'] in core.rejected:
                    result['error'] = 'mihomo 未通过此节点的配置校验；可能是核心版本、密钥或参数不兼容。'
                    results.append(result)
                    publish()
                    continue
                addresses = server_ips(node['server'])
                check_cancel(cancel_event)
                result['warnings'] = ['入口 IP 来自本机系统 DNS，仅供识别服务器；实际出口以经代理查询为准。']
                if addresses:
                    result['serverIps'] = addresses
                else:
                    result['warnings'].append('入口主机解析失败或超时，未填入猜测的入口 IP。')
                if not ip_api_key:
                    result['warnings'].append('匿名 IP 接口不提供完整业务类型标记；类型未知不能证明是住宅或机房。')
                try:
                    core.select(proxy['name'])
                except (OSError, http.client.HTTPException, ProbeError, ValueError) as error:
                    result['error'] = error_message(error, '节点切换')
                    results.append(result)
                    publish()
                    continue
                try:
                    _, _, elapsed = proxy_get(core, 'www.gstatic.com', '/generate_204', 0,
                                              options['timeoutSeconds'], status=204)
                    result['latencyMs'] = round(elapsed * 1000, 2)
                except (OSError, http.client.HTTPException, ProbeError, ValueError) as error:
                    errors.append(error_message(error, 'HTTPS 延迟'))
                ip_problem = ''
                check_cancel(cancel_event)
                if ip_allowed:
                    pause = max(0, IP_API_INTERVAL - (time.monotonic() - last_ip_request))
                    if cancel_event is None:
                        time.sleep(pause)
                    else:
                        cancel_event.wait(pause)
                        check_cancel(cancel_event)
                    last_ip_request = time.monotonic()
                    try:
                        api_path = '/?key=' + urllib.parse.quote(ip_api_key, safe='') if ip_api_key else '/'
                        body, _, _ = proxy_get(core, 'api.ipapi.is', api_path, 262144, options['timeoutSeconds'])
                        result.update(ip_info(json.loads(body)))
                    except (OSError, http.client.HTTPException, ProbeError, ValueError, UnicodeError) as error:
                        if isinstance(error, HttpFailure) and error.status in {403, 429}:
                            ip_allowed = False
                        ip_problem = error_message(error, 'IP 信息服务')
                else:
                    ip_problem = 'IP 信息服务已限流，本轮后续节点不再调用该服务。'
                if 'exitIp' not in result:
                    check_cancel(cancel_event)
                    try:
                        body, _, _ = proxy_get(core, 'speed.cloudflare.com', '/cdn-cgi/trace', 16384, options['timeoutSeconds'])
                        result.update(trace_info(body))
                        result['warnings'].extend([ip_problem, '出口 IP / 国家来自经节点访问的 Cloudflare trace；城市、ASN 与业务类型未获取。'])
                    except (OSError, http.client.HTTPException, ProbeError, ValueError) as error:
                        errors.extend([ip_problem, error_message(error, '出口 IP 备用检测')])
                if options['speedTest']:
                    check_cancel(cancel_event)
                    try:
                        _, count, elapsed = proxy_get(core, 'speed.cloudflare.com',
                                                     f'/__down?bytes={options["downloadBytes"]}',
                                                     options['downloadBytes'], options['timeoutSeconds'], keep_body=False)
                        if not count or elapsed <= 0:
                            raise ProbeError('未收到可用于测速的下载数据。')
                        result.update(downloadedBytes=count, speedMbps=round(count * 8 / elapsed / 1_000_000, 3))
                    except (OSError, http.client.HTTPException, ProbeError, ValueError) as error:
                        errors.append(error_message(error, '下载测速'))
                result['status'] = 'error' if errors else 'ok'
                if errors:
                    result['error'] = ' '.join(errors)
                results.append(result)
                check_cancel(cancel_event)
                publish()
    except (OSError, subprocess.SubprocessError, ProbeError, ValueError) as error:
        completed = {row['nodeId'] for row in results}
        for node, _ in accepted:
            if node['id'] not in completed:
                row = base_result(node)
                row['error'] = error_message(error, '本地核心')
                results.append(row)
        publish(phase='cleanup')
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description='RouteKit 本地节点检测；不修改系统代理，凭证不上传网页。')
    parser.add_argument('--input', required=True, type=Path, help='网页导出的检测任务 JSON（含节点凭证）')
    parser.add_argument('--output', required=True, type=Path, help='检测结果 JSON（不含节点凭证）')
    parser.add_argument('--core', help='已安装 mihomo 的可执行文件路径；不自动下载安装')
    parser.add_argument('--ipapi-key-env', help='可选：从指定环境变量读取已有 ipapi.is API key，不保存到结果')
    args = parser.parse_args(argv)
    try:
        if args.input.resolve() == args.output.resolve():
            raise ProbeError('输入与输出必须使用不同文件。')
        if args.input.stat().st_size > MAX_JOB_BYTES:
            raise ProbeError('检测任务文件不能超过 2 MB。')
        with args.input.open('rb') as source:
            content = source.read(MAX_JOB_BYTES + 1)
        if len(content) > MAX_JOB_BYTES:
            raise ProbeError('检测任务文件不能超过 2 MB。')
        job = json.loads(content)
        validate_job(job)
        ip_api_key = None
        if args.ipapi_key_env:
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', args.ipapi_key_env):
                raise ProbeError('API key 环境变量名称无效。')
            ip_api_key = os.environ.get(args.ipapi_key_env)
            if not ip_api_key or len(ip_api_key) > 512 or CONTROL.search(ip_api_key):
                raise ProbeError('指定的 API key 环境变量为空或格式无效。')
        executable = shutil.which(args.core or 'mihomo')
        if not executable:
            raise ProbeError('未找到 mihomo；请通过 --core 指定现有可执行文件，检测器不会自动安装。')
        results = run_job(job, args.output, executable, ip_api_key=ip_api_key)
        succeeded = sum(row['status'] == 'ok' for row in results)
        print(f'已完成：{succeeded} 个完整成功，{len(results) - succeeded} 个含错误；结果已写入指定文件。')
        return 0 if succeeded == len(results) else 1
    except KeyboardInterrupt:
        print('已取消；已完成节点的结果保留在输出文件，临时核心已关闭。', file=sys.stderr)
        return 130
    except ProbeError as error:
        print(str(error), file=sys.stderr)
        return 2
    except (OSError, ValueError, UnicodeError):
        print('任务文件无法读取、格式无效，或结果文件无法写入。', file=sys.stderr)
        return 2


if __name__ == '__main__':
    def stop_on_signal(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop_on_signal)
    sys.exit(main())
