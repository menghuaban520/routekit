import type { ProxyNode } from "../subscriptions";

// Only mappings documented by Mihomo/Xray are accepted. See docs/probe.md for
// share-format sources; this deliberately shares the local probe's strict scope.
export type ProxyOptions = {
  type: "ss" | "vmess" | "vless" | "trojan" | "socks5" | "http";
  server: string; port: number; username?: string; password?: string;
  cipher?: string; uuid?: string; alterId?: number; tls?: boolean;
  servername?: string; clientFingerprint?: string; alpn?: string[];
  reality?: { publicKey: string; shortId: string };
  network?: "tcp" | "ws" | "grpc";
  ws?: { path: string; host?: string }; grpc?: { serviceName: string };
  flow?: string; udp?: boolean; tfo?: boolean;
};
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const CIPHERS = new Set(["aes-128-gcm", "aes-192-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "xchacha20-ietf-poly1305", "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305"]);
function fail(message: string): never { throw new Error(message); }
function text(value: unknown, empty = false): string {
  if (typeof value !== "string" || value.length > 4096 || CONTROL.test(value) || (!empty && !value)) fail("节点包含无效文本字段");
  return value;
}
function decode(value: string): string {
  try { return text(decodeURIComponent(value), true); } catch { return fail("节点 URL 编码无效"); }
}
function base64(value: string): string {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    if (!/^[A-Za-z0-9+/]+$/.test(normalized)) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0)));
  } catch { return fail("节点 Base64 编码无效"); }
}
function options(url: URL, allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) fail("节点包含暂不支持或重复的参数；未忽略连接设置");
    result[key] = text(value, true);
  }
  return result;
}
function host(value: string): string {
  if (!value || /[\s/?#@,\\]/.test(value) || CONTROL.test(value)) fail("节点 TLS 主机名无效");
  try { return new URL(`https://${value.includes(":") && !value.startsWith("[") ? `[${value}]` : value}`).hostname.replace(/^\[|\]$/g, ""); }
  catch { return fail("节点 TLS 主机名无效"); }
}
function flags(proxy: ProxyOptions, values: Record<string, unknown>) {
  for (const key of ["udp", "tfo"] as const) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (![true, false, "true", "false", "0", "1", 0, 1].includes(value as boolean)) fail("节点 UDP / TCP Fast Open 设置无效");
    proxy[key] = value === true || value === "true" || value === "1" || value === 1;
  }
}
function transport(proxy: ProxyOptions, value: Record<string, string>) {
  const network = value.type || "tcp";
  if (!["tcp", "ws", "grpc"].includes(network) || !["", "none"].includes(value.headerType || "")) fail("此导出仅支持普通 TCP、WebSocket 或 gRPC，不支持该传输/伪装方式");
  if (value.mode && value.mode !== "gun") fail("暂不支持此 gRPC 模式");
  proxy.network = network as ProxyOptions["network"];
  if (network === "ws") {
    if (value.serviceName || value.mode || (value.path && !value.path.startsWith("/"))) fail("WebSocket 包含无效路径或不适用的 gRPC 参数");
    proxy.ws = { path: value.path || "/", ...(value.host ? { host: value.host } : {}) };
  } else if (network === "grpc") {
    if (value.host || value.path) fail("gRPC 不能可靠转换 host/path，请使用 serviceName");
    proxy.grpc = { serviceName: value.serviceName || "" };
  } else if (value.host || value.path || value.serviceName || value.mode) fail("普通 TCP 包含无法应用的传输参数");
}
function tls(proxy: ProxyOptions, value: Record<string, string>, trojan = false) {
  if (!["0", "false", ""].includes(value.allowInsecure || "") || !["0", "false", ""].includes(value.insecure || "")) fail("导出不允许关闭 TLS 证书验证");
  const security = value.security || (trojan ? "tls" : "none");
  if (!["none", "tls", "reality"].includes(security) || (trojan && security !== "tls")) fail("暂不支持此 TLS / 安全类型");
  proxy.tls = security !== "none";
  if (security === "none") {
    if (["sni", "fp", "alpn", "pbk", "sid"].some(key => value[key])) fail("未启用 TLS 的节点包含 TLS 参数");
    return;
  }
  if (value.sni) proxy.servername = host(value.sni);
  if (value.fp) {
    if (!["chrome", "firefox", "safari", "ios", "android", "edge", "random", "randomized", "360", "qq"].includes(value.fp)) fail("暂不支持此 TLS 客户端指纹");
    proxy.clientFingerprint = value.fp;
  }
  if (value.alpn) {
    proxy.alpn = value.alpn.split(",");
    if (proxy.alpn.some(item => !["h2", "http/1.1"].includes(item))) fail("暂不支持此 ALPN 设置");
  }
  if (security === "reality") {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.pbk || "") || !/^(?:[\da-f]{2}){0,8}$/i.test(value.sid || "")) fail("Reality 公钥或 short-id 格式无效");
    proxy.reality = { publicKey: value.pbk, shortId: value.sid || "" };
    proxy.clientFingerprint ||= "chrome";
  } else if (value.pbk || value.sid) fail("Reality 参数与安全类型不一致");
}
export function parseProxyOptions(node: ProxyNode): ProxyOptions {
  try {
    const proxy: ProxyOptions = { type: node.protocol === "https" ? "http" : node.protocol, server: node.server, port: node.port };
    if (node.protocol === "vmess") {
      const data = JSON.parse(base64(node.uri.slice(8).split("#")[0])) as Record<string, unknown>;
      const allowed = ["v", "ps", "add", "port", "id", "aid", "scy", "net", "type", "host", "path", "tls", "sni", "alpn", "fp", "udp", "tfo", "insecure", "allowInsecure"];
      if (!data || Array.isArray(data) || typeof data !== "object" || Object.keys(data).some(key => !allowed.includes(key))) fail("VMess 包含暂不支持的字段");
      if (String(data.v ?? "2") !== "2") fail("仅支持 VMess v2 分享格式");
      proxy.uuid = text(data.id);
      if (!UUID.test(proxy.uuid)) fail("VMess UUID 无效");
      if (!/^\d{1,5}$/.test(String(data.aid ?? 0)) || Number(data.aid ?? 0) > 65535) fail("VMess alterId 无效");
      proxy.alterId = Number(data.aid ?? 0);
      proxy.cipher = text(data.scy || "auto");
      if (!["auto", "aes-128-gcm", "chacha20-poly1305", "none", "zero"].includes(proxy.cipher)) fail("暂不支持此 VMess 加密方式");
      const value = Object.fromEntries(["net", "type", "host", "path", "tls", "sni", "alpn", "fp", "insecure", "allowInsecure"].map(key => [key, text(data[key] ?? "", true)]));
      transport(proxy, { type: value.net, headerType: value.type || "none", host: value.host, path: value.net === "grpc" ? "" : value.path, serviceName: value.net === "grpc" ? value.path : "" });
      tls(proxy, { ...value, security: value.tls });
      flags(proxy, data);
      return proxy;
    }
    const url = new URL(node.uri);
    if (url.pathname && url.pathname !== "/") fail("节点 URI 包含无法应用的路径");
    if (node.protocol === "ss") {
      flags(proxy, options(url, ["udp", "tfo"]));
      const auth = decode(url.username);
      const info = url.password ? `${auth}:${decode(url.password)}` : base64(auth);
      const colon = info.indexOf(":");
      proxy.cipher = info.slice(0, colon);
      proxy.password = text(info.slice(colon + 1));
      if (colon < 1 || !CIPHERS.has(proxy.cipher)) fail("暂不支持此 Shadowsocks 加密方式；插件不会被忽略");
    } else if (node.protocol === "vless" || node.protocol === "trojan") {
      const value = options(url, ["type", "security", "sni", "fp", "alpn", "pbk", "sid", "flow", "encryption", "host", "path", "serviceName", "headerType", "mode", "allowInsecure", "insecure", "udp", "tfo"]);
      flags(proxy, value);
      if (url.password) fail("节点认证字段格式无效");
      if (node.protocol === "vless") {
        proxy.uuid = text(decode(url.username));
        if (!UUID.test(proxy.uuid)) fail("VLESS UUID 无效");
        if (value.encryption && value.encryption !== "none") fail("暂不支持此 VLESS encryption 设置");
      } else {
        if (Object.hasOwn(value, "encryption") || Object.hasOwn(value, "flow")) fail("Trojan 包含不适用的 VLESS 参数");
        proxy.password = text(decode(url.username));
      }
      transport(proxy, value);
      tls(proxy, value, node.protocol === "trojan");
      if (value.flow) {
        if (value.flow !== "xtls-rprx-vision" || proxy.network !== "tcp" || !proxy.tls) fail("暂不支持此 VLESS flow 组合");
        proxy.flow = value.flow;
      }
    } else {
      const value = options(url, node.protocol === "https" ? ["sni", "alpn", "insecure", "allowInsecure", "tfo"] : node.protocol === "socks5" ? ["udp", "tfo"] : ["tfo"]);
      flags(proxy, value);
      if (url.username || url.password) {
        proxy.username = text(decode(url.username));
        proxy.password = text(decode(url.password), true);
      }
      if (node.protocol === "https") {
        tls(proxy, { ...value, security: "tls" });
      }
    }
    return proxy;
  } catch (error) {
    if (error instanceof Error && !["SyntaxError", "TypeError", "URIError"].includes(error.name)) throw error;
    return fail("节点 URI 无效或包含暂不支持的分享格式");
  }
}
export function toMihomoProxy(node: ProxyNode, alias: string): Record<string, unknown> {
  const p = parseProxyOptions(node);
  const result: Record<string, unknown> = { name: alias, type: p.type, server: p.server, port: p.port };
  for (const key of ["username", "password", "cipher", "uuid", "alterId", "network", "flow"] as const) if (p[key] !== undefined) result[key] = p[key];
  if (p.udp !== undefined) result.udp = p.udp;
  if (p.tfo !== undefined) result.tfo = p.tfo;
  if (p.type === "vmess" || p.type === "vless" || p.type === "http" && p.tls) result.tls = p.tls ?? false;
  if (p.tls) result["skip-cert-verify"] = false;
  if (p.servername) result[p.type === "trojan" || p.type === "http" ? "sni" : "servername"] = p.servername;
  if (p.clientFingerprint) result["client-fingerprint"] = p.clientFingerprint;
  if (p.alpn) result.alpn = p.alpn;
  if (p.ws) result["ws-opts"] = { path: p.ws.path, ...(p.ws.host ? { headers: { Host: p.ws.host } } : {}) };
  if (p.grpc) result["grpc-opts"] = { "grpc-service-name": p.grpc.serviceName };
  if (p.reality) result["reality-opts"] = { "public-key": p.reality.publicKey, "short-id": p.reality.shortId };
  return result;
}
