import { Composer, Lexer, Parser, isAlias, isMap, isScalar, isSeq, type Document } from "yaml";

/** Node import only. References: Mihomo proxy/TLS/transport docs, yaml@2 API. */
type Fields = Record<string, unknown>;
export type ClashImport = {
  entries: { uri: string; index: number }[];
  errors: string[];
  warnings: string[];
};

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const BASE = ["name", "type", "server", "port", "udp", "tfo"];
const TLS = ["tls", "alpn", "skip-cert-verify"];
const TRANSPORT = ["network", "ws-opts", "grpc-opts"];

class ClashImportError extends Error {}
function fail(message: string): never { throw new ClashImportError(message); }
function fieldName(key: string): string {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) ? key : "（字段名无效）";
}
function fields(value: unknown, label: string): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} 必须是键值对象`);
  return value as Fields;
}
function allowed(value: Fields, keys: string[], label = "节点") {
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  if (unknown.length)
    fail(`${label} 字段 ${unknown.slice(0, 8).map(fieldName).join("、")} 暂不能无损转换；该节点未导入`);
}
function string(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || value.length > 4096 || CONTROL.test(value))
    fail(`${label} 必须是有效文本；数字密码或 short-id 请在 YAML 中加引号`);
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} 必须是 true 或 false`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value)))
    fail(`${label} 必须是整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    fail(`${label} 超出有效范围`);
  return number;
}
function base64(value: string): string {
  return btoa(Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join(""));
}

function nodeUri(input: unknown): string {
  const item = fields(input, "节点");
  const type = string(item.type, "type");
  const extra = type === "ss" ? ["cipher", "password"]
    : type === "vmess" ? ["uuid", "alterId", "cipher", "servername", "client-fingerprint", ...TLS, ...TRANSPORT]
    : type === "vless" ? ["uuid", "flow", "encryption", "packet-encoding", "servername", "client-fingerprint", "reality-opts", ...TLS, ...TRANSPORT]
    : type === "trojan" ? ["password", "sni", "client-fingerprint", ...TLS, ...TRANSPORT]
    : type === "http" ? ["username", "password", "sni", ...TLS]
    : type === "socks5" ? ["username", "password"] : null;
  if (!extra) fail("暂不支持此 Clash 节点协议；支持 SS、VMess、VLESS、Trojan、SOCKS5 和 HTTP(S)");
  allowed(item, [...BASE, ...extra]);
  const name = string(item.name, "name"), server = string(item.server, "server");
  if (name.length > 200) fail("节点名称不能超过 200 字符");
  // Validate before URL construction so embedded userinfo/path cannot alter the endpoint.
  if (/[\s/\\?#@%]/.test(server) || (server.includes(":") && !/^\[?[\da-f:.]+\]?$/i.test(server)))
    fail("server 必须是域名或 IP 地址");
  const port = integer(item.port, "port", 1, 65535);
  const host = server.includes(":") && !server.startsWith("[") ? `[${server}]` : server;
  const endpoint = `${host}:${port}`, fragment = `#${encodeURIComponent(name)}`;
  const params = new URLSearchParams();
  // Mihomo's omitted UDP flag means false, unlike many URI consumers' defaults.
  if (type !== "http") params.set("udp", item.udp === undefined ? "0" : boolean(item.udp, "udp") ? "1" : "0");
  else if (item.udp !== undefined) fail("HTTP 节点的 udp 字段暂不能无损转换");
  if (item.tfo !== undefined) params.set("tfo", boolean(item.tfo, "tfo") ? "1" : "0");

  if (type === "ss") {
    const cipher = string(item.cipher, "cipher"), password = string(item.password, "password");
    return `ss://${encodeURIComponent(cipher)}:${encodeURIComponent(password)}@${endpoint}/?${params}${fragment}`;
  }

  if (type === "socks5" || type === "http") {
    let credentials = "";
    if (item.username !== undefined || item.password !== undefined) {
      const username = string(item.username, "username");
      credentials = `${encodeURIComponent(username)}${item.password === undefined ? "" : `:${encodeURIComponent(string(item.password, "password", true))}`}@`;
    }
    const tls = type === "http" && item.tls !== undefined && boolean(item.tls, "tls");
    if (type === "http") tlsParams(item, params, tls, "sni");
    return `${tls ? "https" : type}://${credentials}${endpoint}${params.size ? `?${params}` : ""}${fragment}`;
  }

  const network = item.network === undefined ? "tcp" : string(item.network, "network");
  if (!["tcp", "ws", "grpc"].includes(network)) fail("network 暂仅能无损转换 tcp、ws 和 grpc");
  params.set("type", network);
  if (item["ws-opts"] !== undefined) {
    if (network !== "ws") fail("ws-opts 与 network 不一致");
    const options = fields(item["ws-opts"], "ws-opts");
    allowed(options, ["path", "headers"], "ws-opts");
    if (options.path !== undefined) {
      const path = string(options.path, "ws-opts.path");
      if (!path.startsWith("/")) fail("WebSocket path 必须以 / 开头");
      params.set("path", path);
    }
    if (options.headers !== undefined) {
      const headers = fields(options.headers, "ws-opts.headers");
      allowed(headers, ["Host", "host"], "ws-opts.headers");
      if (Object.keys(headers).length > 1) fail("WebSocket Host 头重复");
      const hostHeader = headers.Host ?? headers.host;
      if (hostHeader !== undefined) params.set("host", string(hostHeader, "WebSocket Host"));
    }
  }
  if (item["grpc-opts"] !== undefined) {
    if (network !== "grpc") fail("grpc-opts 与 network 不一致");
    const options = fields(item["grpc-opts"], "grpc-opts");
    allowed(options, ["grpc-service-name"], "grpc-opts");
    if (options["grpc-service-name"] !== undefined)
      params.set("serviceName", string(options["grpc-service-name"], "gRPC service name", true));
  }

  const tls = item.tls === undefined ? type === "trojan" : boolean(item.tls, "tls");
  if (type === "trojan" && !tls) fail("Trojan 不能关闭 TLS");
  params.set("security", tls ? "tls" : "none");
  tlsParams(item, params, tls, type === "trojan" ? "sni" : "servername");
  if (item["client-fingerprint"] !== undefined) {
    if (!tls) fail("client-fingerprint 需要启用 TLS");
    params.set("fp", string(item["client-fingerprint"], "client-fingerprint"));
  }
  if (type === "vless") {
    if (item.encryption !== undefined) {
      const encryption = string(item.encryption, "encryption", true);
      if (!["", "none"].includes(encryption)) fail("VLESS encryption 暂不能无损转换");
      params.set("encryption", "none");
    }
    if (item.flow !== undefined) params.set("flow", string(item.flow, "flow", true));
    if (item["packet-encoding"] !== undefined) {
      const encoding = string(item["packet-encoding"], "packet-encoding", true);
      if (!["", "xudp", "packetaddr"].includes(encoding)) fail("packet-encoding 无效");
      params.set("packetEncoding", encoding);
    }
    if (item["reality-opts"] !== undefined) {
      if (!tls) fail("reality-opts 需要 tls: true");
      const reality = fields(item["reality-opts"], "reality-opts");
      allowed(reality, ["public-key", "short-id"], "reality-opts");
      params.set("security", "reality");
      params.set("pbk", string(reality["public-key"], "Reality public-key"));
      if (reality["short-id"] !== undefined)
        params.set("sid", string(reality["short-id"], "Reality short-id", true));
    }
  }

  if (type === "vmess") {
    const data: Fields = {
      v: "2", ps: name, add: server, port: String(port), id: string(item.uuid, "uuid"),
      aid: String(item.alterId === undefined ? 0 : integer(item.alterId, "alterId", 0, 65535)),
      scy: item.cipher === undefined ? "auto" : string(item.cipher, "cipher"),
      net: network, tls: tls ? "tls" : "", type: "none", udp: params.get("udp"),
    };
    for (const key of ["sni", "alpn", "fp", "tfo", "host"]) if (params.has(key)) data[key] = params.get(key)!;
    if (params.has("allowInsecure")) data.insecure = params.get("allowInsecure")!;
    if (network === "grpc") data.path = params.get("serviceName") || "";
    else if (params.has("path")) data.path = params.get("path")!;
    return `vmess://${base64(JSON.stringify(data))}`;
  }
  const credential = string(type === "vless" ? item.uuid : item.password, type === "vless" ? "uuid" : "password");
  return `${type}://${encodeURIComponent(credential)}@${endpoint}?${params}${fragment}`;
}

function tlsParams(item: Fields, params: URLSearchParams, tls: boolean, nameKey: string) {
  if (item[nameKey] !== undefined) {
    if (!tls) fail(`${nameKey} 需要启用 TLS`);
    params.set("sni", string(item[nameKey], nameKey));
  }
  if (item.alpn !== undefined) {
    if (!tls) fail("alpn 需要启用 TLS");
    if (!Array.isArray(item.alpn) || !item.alpn.length || item.alpn.length > 16)
      fail("alpn 必须是非空文本列表，最多 16 项");
    const alpn = item.alpn.map(value => string(value, "alpn"));
    if (alpn.some(value => !/^[a-zA-Z0-9./-]+$/.test(value))) fail("ALPN 参数无效");
    params.set("alpn", alpn.join(","));
  }
  if (item["skip-cert-verify"] !== undefined) {
    const insecure = boolean(item["skip-cert-verify"], "skip-cert-verify");
    if (!tls && insecure) fail("skip-cert-verify 需要启用 TLS");
    params.set("allowInsecure", insecure ? "1" : "0");
  }
}

export function looksLikeClashYaml(text: string): boolean {
  return /^[\[{]/.test(text) || /^(?:---|%YAML|%TAG)(?:\s|$)/m.test(text)
    || /^\s*(?:-\s+)?(?:[a-zA-Z_][\w-]*|"[^"\n]+"|'[^'\n]+')\s*:(?=\s|$)/m.test(text);
}

export function readClashSubscription(text: string): ClashImport {
  const result: ClashImport = { entries: [], errors: [], warnings: [] };
  try {
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) fail("订阅内容不能超过 2 MB");
    // Stop deep/oversized CST construction before recursive AST composition.
    const parser = new Parser();
    function* tokens() {
      let count = 0;
      for (const lexeme of new Lexer().lex(text)) {
        if (++count > 200000) fail("YAML 结构过大，无法安全读取");
        yield* parser.next(lexeme);
        if (parser.stack.length > 34) fail("YAML 嵌套不能超过 32 层");
      }
      yield* parser.end();
    }
    const composer = new Composer({
      version: "1.2", schema: "core", merge: false, customTags: [],
      uniqueKeys: true, strict: true, prettyErrors: false, logLevel: "error",
    });
    let doc: Document.Parsed | undefined;
    for (const candidate of composer.compose(tokens(), true, text.length)) {
      if (doc) fail("YAML 只能包含一个文档；请检查文件格式");
      doc = candidate;
    }
    if (!doc) fail("YAML 文档为空");
    if (doc.errors.length || doc.warnings.length) {
      const issue = doc.errors[0] || doc.warnings[0];
      const reason = issue.code === "DUPLICATE_KEY" ? "存在重复键"
        : issue.code === "MULTIPLE_DOCS" ? "只能包含一个文档"
        : issue.code === "RESOURCE_EXHAUSTION" ? "嵌套过深"
        : "语法、版本或标签不受支持";
      // Parser messages may contain subscription secrets; expose a reason, never its source excerpt.
      fail(`YAML ${reason}；请检查文件格式`);
    }
    const stack = [{ node: doc.contents as unknown, depth: 0 }];
    let visited = 0;
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (++visited > 100000) fail("YAML 结构过大，最多支持 100000 个结构项");
      if (depth > 32) fail("YAML 嵌套不能超过 32 层");
      if (isAlias(node)) fail("YAML 暂不支持 alias 引用；请展开锚点后导入");
      if (isMap(node) || isSeq(node) || isScalar(node)) {
        if (node.tag && !["tag:yaml.org,2002:str", "tag:yaml.org,2002:int", "tag:yaml.org,2002:float", "tag:yaml.org,2002:bool", "tag:yaml.org,2002:null", "tag:yaml.org,2002:map", "tag:yaml.org,2002:seq"].includes(node.tag))
          fail("YAML 不支持自定义 tag");
        if (isMap(node)) {
          for (const pair of node.items) {
            if (!isScalar(pair.key) || typeof pair.key.value !== "string") fail("YAML 字段名必须是文本");
            if (["__proto__", "prototype", "constructor", "<<"].includes(pair.key.value))
              fail("YAML 不允许原型属性或 merge 合并键");
            stack.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
          }
        } else if (isSeq(node)) for (const item of node.items) stack.push({ node: item, depth: depth + 1 });
        else if (typeof node.value === "string" && CONTROL.test(node.value)) fail("YAML 文本包含控制字符");
      }
    }
    const document: unknown = doc.toJS({ maxAliasCount: 0 });
    let proxies: unknown;
    if (Array.isArray(document)) proxies = document;
    else {
      const config = fields(document, "Clash YAML 顶层");
      proxies = config.proxies;
      if ("proxy-groups" in config) result.warnings.push("仅导入节点：原 YAML 策略组（proxy-groups）未导入，请在分流配置中重新选择节点。");
      if ("rules" in config || "rule-providers" in config || "sub-rules" in config)
        result.warnings.push("原 YAML 分流规则及规则集未导入，请在分流配置中重新设置。");
      if ("proxy-providers" in config)
        result.warnings.push("proxy-providers 中的远程订阅未读取；请另行导入其节点内容，网页不会自动抓取。");
      if (Object.keys(config).some(key => !["proxies", "proxy-groups", "rules", "rule-providers", "sub-rules", "proxy-providers"].includes(key)))
        result.warnings.push("此处只导入 proxies 节点；原 YAML 的 DNS、连接设置和其他顶层配置未导入。");
      if (proxies === undefined && "proxy-providers" in config)
        fail("此文件仅引用 proxy-providers，未包含 proxies 节点；请从订阅方下载实际节点内容后导入。");
    }
    if (!Array.isArray(proxies)) fail("Clash YAML 需要 proxies 节点数组，或直接提供节点数组");
    if (!proxies.length) fail("Clash YAML 的 proxies 节点列表为空");
    if (proxies.length > 500) result.errors.push("最多支持 500 个节点，剩余 YAML 节点未导入");
    for (let index = 0; index < Math.min(500, proxies.length); index++) {
      try { result.entries.push({ uri: nodeUri(proxies[index]), index }); }
      catch (error) { result.errors.push(`第 ${index + 1} 个 YAML 节点：${error instanceof ClashImportError ? error.message : "节点参数格式无效，未导入"}`); }
    }
  } catch (error) {
    result.errors.push(error instanceof ClashImportError ? error.message : "YAML 内容过深或格式无效，无法安全读取");
  }
  return result;
}
