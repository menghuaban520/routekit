import { looksLikeClashYaml, readClashSubscription } from "./clash-import";

/** Local-only node import. References: SIP002, v2rayN VMess share links, Xray #716. */
export type ProxyNode = {
  id: string;
  name: string;
  protocol: "ss" | "vmess" | "vless" | "trojan" | "socks5" | "http" | "https";
  server: string;
  port: number;
  uri: string;
};
export type SubscriptionResult = {
  nodes: ProxyNode[];
  errors: string[];
  warnings: string[];
};
export type SsNodeInput = {
  name: string;
  server: string;
  port: number;
  method: string;
  password: string;
};

const MAX_SIZE = 2 * 1024 * 1024;
const MAX_NODES = 500;
const MAX_LINE = 16 * 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const METHODS = new Set([
  "aes-128-gcm",
  "aes-192-gcm",
  "aes-256-gcm",
  "chacha20-ietf-poly1305",
  "xchacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
  "aes-128-cfb",
  "aes-192-cfb",
  "aes-256-cfb",
  "aes-128-ctr",
  "aes-192-ctr",
  "aes-256-ctr",
  "chacha20",
  "chacha20-ietf",
  "salsa20",
  "rc4-md5",
]);
const TRANSPORTS = new Set([
  "tcp",
  "raw",
  "kcp",
  "ws",
  "http",
  "h2",
  "quic",
  "grpc",
  "httpupgrade",
  "splithttp",
  "xhttp",
]);
const KNOWN_PARAMS = new Set([
  "plugin",
  "type",
  "security",
  "encryption",
  "sni",
  "peer",
  "alpn",
  "fp",
  "flow",
  "pbk",
  "sid",
  "spx",
  "host",
  "path",
  "serviceName",
  "authority",
  "mode",
  "headerType",
  "seed",
  "quicSecurity",
  "key",
  "allowInsecure",
  "insecure",
  "packetEncoding",
  "ech",
  "extra",
  "mux",
  "ed",
  "tfo",
  "udp",
  "obfs",
  "obfs-host",
]);

function fail(message: string): never {
  throw new Error(message);
}
function cleanText(
  value: unknown,
  label: string,
  limit = 2048,
  nonempty = true,
): string {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    CONTROL.test(value) ||
    (nonempty && !value)
  )
    fail(`${label}无效或过长`);
  return value;
}
function decode(value: string, label = "链接编码"): string {
  try {
    return cleanText(decodeURIComponent(value), label);
  } catch {
    return fail(`${label}无效`);
  }
}
function encodeBase64(value: string, urlSafe = false): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return urlSafe
    ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    : encoded;
}
function base64Bytes(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(standard)) fail("Base64 编码无效");
  const bare = standard.replace(/=+$/, "");
  if (!bare || bare.length % 4 === 1) fail("Base64 编码无效");
  try {
    const binary = atob(bare + "=".repeat((4 - (bare.length % 4)) % 4));
    if (btoa(binary).replace(/=+$/, "") !== bare) fail("Base64 编码无效");
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return fail("Base64 编码无效");
  }
}
function decodeBase64(value: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(base64Bytes(value));
  } catch {
    return fail("Base64 或 UTF-8 编码无效");
  }
}
function portNumber(value: unknown): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    !/^\d{1,5}$/.test(String(value))
  )
    fail("端口必须是 1–65535 的整数");
  const port = Number(value);
  if (port < 1 || port > 65535) fail("端口必须是 1–65535 的整数");
  return port;
}
function serverName(value: unknown): string {
  const input = cleanText(value, "服务器地址", 253);
  if (/\s|[/\\@?#%,]/.test(input)) fail("服务器地址应为域名或 IP，不含路径");
  const host =
    input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (host.includes(":")) {
    if (!/^[0-9a-f:.]+$/i.test(host)) fail("IPv6 地址无效");
    try {
      return new URL(`http://[${host}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return fail("IPv6 地址无效");
    }
  }
  let canonical: string;
  try {
    canonical = new URL(`https://${host}/`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return fail("服务器域名或 IPv4 地址无效");
  }
  if (
    canonical.length > 253 ||
    canonical
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    fail("服务器域名无效");
  // Reject ambiguous numeric host syntax in node links (e.g. 127.1, octal and hex).
  if (/^\d+(\.\d+){3}$/.test(canonical) && canonical !== host)
    fail("IPv4 地址必须使用完整十进制格式");
  return canonical;
}
function hostPort(server: string, port: number): string {
  return `${server.includes(":") ? `[${server}]` : server}:${port}`;
}
function node(
  protocol: ProxyNode["protocol"],
  server: string,
  port: number,
  name: string,
  uri: string,
): ProxyNode {
  return {
    id: crypto.randomUUID(),
    protocol,
    server,
    port,
    name: name || `${protocol.toUpperCase()} · ${server}`,
    uri,
  };
}
function nodeName(fragment: string): string {
  return fragment ? cleanText(decode(fragment), "节点名称", 200) : "";
}

function validateMethod(method: string, password: string, warnings: string[]) {
  if (!METHODS.has(method)) fail("暂不支持此 Shadowsocks 加密方式");
  cleanText(password, "密码", 2048);
  if (method.startsWith("2022-")) {
    const expected = method === "2022-blake3-aes-128-gcm" ? 16 : 32;
    if (password.split(":").some((key) => base64Bytes(key).length !== expected))
      fail(`此 SS 2022 加密方式需要 ${expected} 字节的 Base64 密钥`);
  } else if (!method.includes("gcm") && !method.includes("poly1305"))
    warnings.push("包含旧版 SS 流加密方式，请核对客户端支持并优先使用 AEAD。");
}

function parseParameters(query: string, warnings: string[]): string {
  if (!query) return "";
  if (query.length > 8192 || /%(?![\da-f]{2})/i.test(query))
    fail("链接参数编码无效或过长");
  const parameters = new URLSearchParams(query),
    entries: [string, string][] = [];
  const seen = new Set<string>();
  if ([...parameters].length > 32) fail("链接参数最多 32 项");
  for (const [key, value] of parameters) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(key) ||
      CONTROL.test(value) ||
      value.length > 4096 ||
      value.includes("\ufffd")
    )
      fail("链接参数名称或内容无效");
    if (seen.has(key)) fail("链接包含重复参数");
    seen.add(key);
    if (key === "type" && !TRANSPORTS.has(value)) fail("不支持此传输类型");
    if (
      key === "security" &&
      !["none", "tls", "reality", "xtls", ""].includes(value)
    )
      fail("传输安全参数无效");
    if (
      ["allowInsecure", "insecure", "udp", "tfo", "mux"].includes(key) &&
      !["0", "1", "true", "false"].includes(value)
    )
      fail("布尔链接参数无效");
    if (
      ["allowInsecure", "insecure"].includes(key) &&
      ["1", "true"].includes(value)
    )
      warnings.push("部分节点关闭了证书验证，请在客户端核对其 TLS 设置。");
    if (["sni", "peer"].includes(key) && value) serverName(value);
    if (key === "sid" && !/^(?:[\da-f]{2}){0,8}$/i.test(value))
      fail("REALITY short ID 必须是最多 16 位的偶数长度十六进制文本");
    if (
      key === "pbk" &&
      (!/^[A-Za-z0-9_-]+={0,2}$/.test(value) ||
        base64Bytes(value).length !== 32)
    )
      fail("REALITY 公钥应为 32 字节 Base64URL");
    if (
      key === "alpn" &&
      value &&
      !/^[a-zA-Z0-9./-]+(?:,[a-zA-Z0-9./-]+)*$/.test(value)
    )
      fail("ALPN 参数无效");
    if (!KNOWN_PARAMS.has(key))
      warnings.push(
        `包含客户端扩展参数 ${key}，已保留，请核对目标客户端支持。`,
      );
    if (key === "plugin")
      warnings.push("包含 SS 插件参数，导入后仍需客户端支持对应插件。");
    entries.push([key, value]);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

function parseSs(uri: string, warnings: string[]): ProxyNode {
  let body = uri.slice(5);
  const hash = body.indexOf("#");
  const name = nodeName(hash >= 0 ? body.slice(hash + 1) : "");
  body = hash >= 0 ? body.slice(0, hash) : body;
  // Legacy SS whole-authority Base64 remains common; normalize it to SIP002.
  if (!body.includes("@")) {
    body = decodeBase64(body);
    if (CONTROL.test(body) || /\s/.test(body)) fail("旧版 SS 链接内容无效");
    warnings.push("已将旧版 SS 整段 Base64 链接转换为 SIP002 格式。");
  }
  const at = body.lastIndexOf("@");
  if (at <= 0) fail("SS 链接缺少凭证或服务器");
  const userinfo = body.slice(0, at),
    tail = body.slice(at + 1);
  let method: string, password: string;
  if (userinfo.includes(":")) {
    const colon = userinfo.indexOf(":");
    method = decode(userinfo.slice(0, colon));
    password = decode(userinfo.slice(colon + 1), "密码编码");
  } else {
    const plain = decodeBase64(userinfo),
      colon = plain.indexOf(":");
    if (colon <= 0) fail("SS 凭证格式无效");
    method = plain.slice(0, colon);
    password = plain.slice(colon + 1);
    if (method.startsWith("2022-"))
      fail("SS 2022 凭证必须使用百分号编码，不能整体 Base64");
  }
  validateMethod(method, password, warnings);
  let parsed: URL;
  try {
    parsed = new URL(`ss://${tail}`);
  } catch {
    return fail("SS 服务器或端口无效");
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname && parsed.pathname !== "/")
  )
    fail("SS 服务器路径无效");
  const server = serverName(parsed.hostname),
    port = portNumber(parsed.port);
  const query = parseParameters(parsed.search.slice(1), warnings);
  const credentials = method.startsWith("2022-")
    ? `${encodeURIComponent(method)}:${encodeURIComponent(password)}`
    : encodeBase64(`${method}:${password}`, true);
  const normalized = `ss://${credentials}@${hostPort(server, port)}${query ? `/?${query}` : ""}${name ? `#${encodeURIComponent(name)}` : ""}`;
  return node("ss", server, port, name, normalized);
}

function parseVmess(uri: string, warnings: string[]): ProxyNode {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(decodeBase64(uri.slice(8)));
  } catch {
    return fail("VMess 需要 Base64 编码的 JSON 配置");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    fail("VMess JSON 必须是对象");
  if (Object.keys(data).length > 40) fail("VMess 参数过多");
  for (const [key, value] of Object.entries(data)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(key) ||
      !["string", "number", "boolean"].includes(typeof value)
    )
      fail("VMess 参数应为简单文本、数字或布尔值");
    cleanText(String(value), "VMess 参数", 4096, false);
  }
  if (!UUID.test(String(data.id ?? ""))) fail("VMess UUID 无效");
  if (data.v !== undefined && String(data.v) !== "2")
    fail("仅支持 VMess v2 分享格式");
  if (data.net !== undefined && !TRANSPORTS.has(String(data.net)))
    fail("VMess 传输类型无效");
  if (data.tls !== undefined && !["", "tls", "none"].includes(String(data.tls)))
    fail("VMess TLS 参数无效");
  if (
    data.aid !== undefined &&
    (!/^\d{1,5}$/.test(String(data.aid)) || Number(data.aid) > 65535)
  )
    fail("VMess alterId 无效");
  if (Number(data.aid) > 0)
    warnings.push("包含非零 alterId 的旧版 VMess 节点，请核对客户端兼容性。");
  if (
    data.scy !== undefined &&
    !["auto", "none", "zero", "aes-128-gcm", "chacha20-poly1305"].includes(
      String(data.scy),
    )
  )
    fail("VMess 加密参数无效");
  if (
    data.insecure !== undefined &&
    !["0", "1", "true", "false"].includes(String(data.insecure))
  )
    fail("VMess insecure 参数无效");
  for (const key of ["udp", "tfo"]) {
    if (data[key] !== undefined && !["0", "1", "true", "false"].includes(String(data[key])))
      fail(`VMess ${key} 参数无效`);
  }
  if (data.alpn !== undefined && data.alpn !== "" && !/^[a-zA-Z0-9./-]+(?:,[a-zA-Z0-9./-]+)*$/.test(String(data.alpn)))
    fail("VMess ALPN 参数无效");
  if (["1", "true"].includes(String(data.insecure)))
    warnings.push("部分节点关闭了证书验证，请在客户端核对其 TLS 设置。");
  const server = serverName(data.add),
    port = portNumber(data.port);
  const name =
    data.ps === undefined ? "" : cleanText(data.ps, "节点名称", 200, false);
  if (data.sni) serverName(data.sni);
  const normalizedData = {
    ...data,
    add: server,
    port: String(port),
    id: String(data.id).toLowerCase(),
  };
  const sorted = Object.fromEntries(
    Object.entries(normalizedData).sort(([a], [b]) => a.localeCompare(b)),
  );
  return node(
    "vmess",
    server,
    port,
    name,
    `vmess://${encodeBase64(JSON.stringify(sorted))}`,
  );
}

function parseUrlNode(uri: string, warnings: string[]): ProxyNode {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return fail("节点链接、服务器或端口无效");
  }
  const protocol = url.protocol.slice(0, -1) as ProxyNode["protocol"];
  if (!["vless", "trojan", "socks5", "http", "https"].includes(protocol))
    fail("不支持此节点协议");
  const authority = uri.slice(uri.indexOf("://") + 3).split(/[/?#]/, 1)[0];
  const endpoint = authority.slice(authority.lastIndexOf("@") + 1);
  const rawHost = endpoint.startsWith("[")
    ? endpoint.slice(0, endpoint.indexOf("]") + 1)
    : endpoint.split(":")[0];
  const server = serverName(rawHost);
  const port = portNumber(
    url.port || (protocol === "http" ? 80 : protocol === "https" ? 443 : ""),
  );
  if (url.pathname && url.pathname !== "/")
    fail("节点地址不能包含路径；传输路径请使用 path 参数");
  const name = nodeName(url.hash.slice(1));
  let credentials = "";
  if (protocol === "vless") {
    const uuid = decode(url.username, "UUID");
    if (!UUID.test(uuid) || url.password)
      fail("VLESS 必须使用有效 UUID，不能另设密码");
    credentials = `${uuid.toLowerCase()}@`;
  } else if (protocol === "trojan") {
    if (url.password) fail("Trojan 密码中的冒号必须进行百分号编码");
    credentials = `${encodeURIComponent(decode(url.username, "Trojan 密码"))}@`;
  } else if (url.username || url.password) {
    const username = decode(url.username, "用户名"),
      password = url.password ? decode(url.password, "密码") : "";
    credentials = `${encodeURIComponent(username)}${url.password ? `:${encodeURIComponent(password)}` : ""}@`;
  }
  const query = parseParameters(url.search.slice(1), warnings);
  if (["socks5", "http", "https"].includes(protocol) && query) {
    const allowed = protocol === "https"
      ? ["sni", "peer", "alpn", "insecure", "allowInsecure", "tfo"]
      : protocol === "socks5" ? ["udp", "tfo"] : ["tfo"];
    if ([...new URLSearchParams(query).keys()].some(key => !allowed.includes(key)))
      fail("SOCKS5/HTTP(S) 节点包含暂不支持的附加参数");
  }
  if (protocol === "http" || protocol === "socks5")
    warnings.push("HTTP 与 SOCKS5 协议本身不提供传输加密，请核对使用场景。");
  const normalized = `${protocol}://${credentials}${hostPort(server, port)}${query ? `?${query}` : ""}${name ? `#${encodeURIComponent(name)}` : ""}`;
  return node(protocol, server, port, name, normalized);
}

function parseNode(uri: string, warnings: string[]): ProxyNode {
  if (
    uri.length > MAX_LINE ||
    CONTROL.test(uri) ||
    /\s|\\/.test(uri) ||
    /%(?![\da-f]{2})/i.test(uri)
  )
    fail("节点链接含空格、控制字符、无效编码或超过 16 KB");
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri);
  if (!match) fail("需要完整的节点链接");
  const protocol = match[1].toLowerCase(),
    normalized = `${protocol}://${uri.slice(match[0].length)}`;
  if (protocol === "ss") return parseSs(normalized, warnings);
  if (protocol === "vmess") return parseVmess(normalized, warnings);
  return parseUrlNode(normalized, warnings);
}

export function proxyNodeIdentity(node: ProxyNode): string {
  if (node.protocol !== "vmess") return node.uri.split("#")[0];
  const data = JSON.parse(decodeBase64(node.uri.slice(8))) as Record<
    string,
    unknown
  >;
  delete data.ps;
  return JSON.stringify(data);
}
export function parseSubscription(input: string): SubscriptionResult {
  const result: SubscriptionResult = { nodes: [], errors: [], warnings: [] };
  if (
    typeof input !== "string" ||
    new TextEncoder().encode(input).length > MAX_SIZE
  ) {
    result.errors.push("订阅内容不能超过 2 MB");
    return result;
  }
  let text = input.replace(/^\uFEFF/, "").trim();
  if (!text) {
    result.errors.push("请粘贴节点链接、Base64 或 Clash/Mihomo YAML 订阅内容");
    return result;
  }
  if (!/^\s*[a-z][a-z0-9+.-]*:\/\//im.test(text) && !looksLikeClashYaml(text)) {
    try {
      text = decodeBase64(text.replace(/\s/g, "")).trim();
    } catch {
      result.errors.push("支持节点链接列表、Base64 或 Clash/Mihomo YAML 订阅；内容无法识别");
      return result;
    }
  }
  const yaml = looksLikeClashYaml(text) ? readClashSubscription(text) : null;
  if (yaml) {
    result.errors.push(...yaml.errors);
    result.warnings.push(...yaml.warnings);
  }
  const lines = text.split(/\r?\n/);
  const entries = yaml ? yaml.entries : lines.slice(0, 10000).map((uri, index) => ({ uri, index }));
  const seen = new Set<string>();
  let duplicates = 0,
    suppressedErrors = 0;
  for (const { uri, index } of entries) {
    const line = uri.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const itemWarnings: string[] = [],
        parsed = parseNode(line, itemWarnings),
        key = proxyNodeIdentity(parsed);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      if (result.nodes.length >= MAX_NODES) {
        result.errors.push("最多支持 500 个节点，剩余内容未导入");
        break;
      }
      seen.add(key);
      result.nodes.push(parsed);
      result.warnings.push(...itemWarnings);
    } catch (error) {
      if (result.errors.length < 100)
        result.errors.push(`第 ${index + 1} ${yaml ? "个 YAML 节点" : "行"}：${(error as Error).message}`);
      else suppressedErrors++;
    }
  }
  if (!yaml && lines.length > 10000)
    result.errors.push("内容超过 10000 行，超出部分未读取");
  if (suppressedErrors)
    result.errors.push(`另有 ${suppressedErrors} 行无效，已省略详细错误`);
  if (duplicates)
    result.warnings.push(
      `已合并 ${duplicates} 个相同连接配置的重复节点；不同凭证会分别保留。`,
    );
  if (result.nodes.length)
    result.warnings.push(
      "已解析链接格式；未测试节点连通性、出口 IP 或客户端兼容性。节点导出文件包含凭证。",
    );
  result.warnings = [...new Set(result.warnings)];
  return result;
}

export function serializeNodes(nodes: ProxyNode[]): string {
  if (!Array.isArray(nodes) || nodes.length > MAX_NODES)
    fail("节点导出最多 500 个");
  const lines = nodes.map((item, index) => {
    if (!item || typeof item.uri !== "string")
      fail(`节点 ${index + 1} 缺少有效链接`);
    return parseNode(item.uri, []).uri;
  });
  const output = lines.length ? `${lines.join("\n")}\n` : "";
  if (new TextEncoder().encode(output).length > MAX_SIZE)
    fail("节点导出不能超过 2 MB");
  return output;
}

export function createSsNode(input: SsNodeInput): ProxyNode {
  const server = serverName(input.server),
    port = portNumber(input.port);
  const name = cleanText(input.name, "节点名称", 200, false);
  const method = cleanText(input.method, "加密方式", 60);
  validateMethod(method, input.password, []);
  const credentials = method.startsWith("2022-")
    ? `${encodeURIComponent(method)}:${encodeURIComponent(input.password)}`
    : encodeBase64(`${method}:${input.password}`, true);
  return parseNode(
    `ss://${credentials}@${hostPort(server, port)}${name ? `#${encodeURIComponent(name)}` : ""}`,
    [],
  );
}

function publicIpv4(host: string): boolean {
  const [a, b, c] = host.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && [0, 2].includes(c)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
function publicHost(host: string): boolean {
  if (host.includes(":")) {
    // Only global unicast literals; exclude documentation, IPv4 tunnels and local forms.
    const canonical = new URL(`https://[${host}]/`).hostname.slice(1, -1);
    const first = parseInt(canonical.split(":")[0], 16);
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      !canonical.startsWith("2001:db8:") &&
      !canonical.startsWith("2001:0:") &&
      !canonical.startsWith("2001::") &&
      !canonical.startsWith("2002:")
    );
  }
  if (/^\d+(\.\d+){3}$/.test(host)) return publicIpv4(host);
  return (
    host.includes(".") &&
    !/(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(
      host,
    )
  );
}

export function validateSubscriptionUrl(value: string): boolean {
  try {
    if (
      typeof value !== "string" ||
      value.length > 8192 ||
      CONTROL.test(value) ||
      /\s|\\/.test(value) ||
      /%(?![\da-f]{2})/i.test(value)
    )
      return false;
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      value.includes("#") ||
      !publicHost(serverName(url.hostname))
    )
      return false;
    if (url.port) portNumber(url.port);
    if (CONTROL.test(decodeURIComponent(url.pathname + url.search)))
      return false;
    return true;
  } catch {
    return false;
  }
}

/** Hide all path/query data: subscription tokens are not necessarily named 'token'. */
export function redactSubscriptionUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname) return "无效订阅地址";
    return `${url.origin}/…`;
  } catch {
    return "无效订阅地址";
  }
}
