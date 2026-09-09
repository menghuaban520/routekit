import { validateDomain } from "./index";

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];
export type DnsQuery = { display: string; name: string; type: DnsRecordType | "PTR" };
export type DnsAnswer = { name: string; type: string; ttl: number; data: string };
export type DnsResult = { status: number; message: string; answers: DnsAnswer[]; authenticated: boolean };

const DNS_TYPES: Record<number, string> = { 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT", 28: "AAAA", 65: "HTTPS" };

/** Query a fixed public resolver, never the user-entered host itself. */
export function prepareDnsQuery(value: string, type: DnsRecordType): DnsQuery {
  const raw = value.trim();
  if (!raw || raw.length > 253 || /[\s/@?#\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(raw))
    throw new Error("请只填公网域名或 IP，不含协议、端口、路径或订阅链接。");
  if (/^[\d.]+$/.test(raw)) {
    const parts = raw.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255))
      throw new Error("IPv4 格式无效，请使用四段十进制地址。");
    const [a, b, c] = parts.map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)))
      throw new Error("请填写公网 IP；局域网、回环与保留地址不发送到公共 DNS。");
    return { display: raw, name: `${parts.reverse().join(".")}.in-addr.arpa`, type: "PTR" };
  }
  if (raw.includes(":")) {
    if (!/^[a-f\d:.[\]]+$/i.test(raw)) throw new Error("IPv6 格式无效；不支持端口或区域标识。");
    let canonical: string;
    try { canonical = new URL(`https://[${raw.replace(/^\[|\]$/g, "")}]/`).hostname.slice(1, -1); }
    catch { throw new Error("IPv6 格式无效；请只填地址。"); }
    if (!/^[23]/.test(canonical) || /^2001:db8(?::|$)/.test(canonical))
      throw new Error("请填写公网 IPv6；局域网、回环与保留地址不发送到公共 DNS。");
    const [left, right] = canonical.split("::");
    const leading = left ? left.split(":") : [], trailing = right ? right.split(":") : [];
    const groups = right === undefined ? leading : [...leading, ...Array(8 - leading.length - trailing.length).fill("0"), ...trailing];
    return { display: canonical, name: `${groups.map((group: string) => group.padStart(4, "0")).join("").split("").reverse().join(".")}.ip6.arpa`, type: "PTR" };
  }
  if (!validateDomain(raw)) throw new Error("域名格式无效，例如 example.com；不要填写网址或节点链接。");
  const hostname = new URL(`https://${raw}`).hostname.replace(/\.$/, "").toLowerCase();
  if (!hostname.includes(".") || /\.(?:local|localhost|internal|lan|home|invalid|test)$/.test(hostname) || hostname === "home.arpa" || hostname.endsWith(".home.arpa"))
    throw new Error("请填写公网域名；本地域名不发送到公共 DNS。");
  return { display: hostname, name: hostname, type };
}

export function dnsQueryUrl(query: DnsQuery) {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", query.name);
  url.searchParams.set("type", query.type);
  return url.href;
}

export function parseDnsResponse(value: unknown): DnsResult {
  if (!value || typeof value !== "object" || !("Status" in value) || !Number.isInteger(value.Status) || Number(value.Status) < 0 || Number(value.Status) > 15)
    throw new Error("DNS 服务返回了无法识别的数据，请稍后重试。");
  const response = value as { Status: number; AD?: boolean; Answer?: unknown };
  if (response.Answer !== undefined && (!Array.isArray(response.Answer) || response.Answer.length > 100))
    throw new Error("DNS 答复记录超出预期，未显示结果。");
  const answers = ((response.Answer ?? []) as unknown[]).map((item): DnsAnswer => {
    if (!item || typeof item !== "object") throw new Error("DNS 记录格式无效。");
    const row = item as Record<string, unknown>;
    if (typeof row.name !== "string" || row.name.length > 254 || typeof row.data !== "string" || row.data.length > 4096 || typeof row.type !== "number" || !Number.isInteger(row.type) || typeof row.TTL !== "number" || !Number.isInteger(row.TTL) || row.TTL < 0 || row.TTL > 2_147_483_647)
      throw new Error("DNS 记录格式无效。");
    return { name: row.name, type: DNS_TYPES[row.type] ?? `TYPE${row.type}`, ttl: row.TTL, data: row.data };
  });
  const messages: Record<number, string> = {
    0: answers.length ? `查到 ${answers.length} 条记录` : "查询成功，但没有这一类型的记录。IP 没有 PTR 记录很常见。",
    1: "查询格式被 DNS 服务拒绝，请检查输入。",
    2: "DNS 服务解析失败（SERVFAIL）；可能与上游解析或 DNSSEC 验证有关，请稍后重试。",
    3: "此名称不存在（NXDOMAIN），请检查拼写；IP 可能未设置反向记录。",
    5: "DNS 服务拒绝此查询（REFUSED）。",
  };
  return { status: response.Status, message: messages[response.Status] ?? `DNS 服务返回状态 ${response.Status}，尚未取得有效答复。`, answers: response.Status === 0 ? answers : [], authenticated: response.AD === true };
}

export function networkFailure(phase: "connection" | "latency" | "speed" | "dns", reason: unknown): string {
  const names = { connection: "出口查询", latency: "HTTPS 延迟", speed: "下载测速", dns: "主机查询" };
  if (reason instanceof DOMException && reason.name === "TimeoutError")
    return `${names[phase]}超时。检查当前连接与该目标的分流规则后重试；超时不能单独判断是哪一跳故障。`;
  if (reason instanceof DOMException && reason.name === "AbortError")
    return `${names[phase]}已停止，未完成的数据不作结论。`;
  if (reason instanceof TypeError) {
    const targets = { connection: "本站网络信息接口", latency: "speed.cloudflare.com", speed: "speed.cloudflare.com", dns: "cloudflare-dns.com" };
    return `${names[phase]}无法连接 ${targets[phase]}。请检查网络、浏览器拦截和该域名的分流规则；浏览器无法进一步区分 DNS、TLS 与连接故障。`;
  }
  return reason instanceof Error ? reason.message : `${names[phase]}未完成，请重试。`;
}
