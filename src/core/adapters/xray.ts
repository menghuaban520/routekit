import type { ConfigExporter, ExportModel } from "../types";
import type { ProxyNode } from "../subscriptions";
import { parseProxyOptions } from "./proxy-options";
import { rejectClientGeneral } from "./clash";

// https://xtls.github.io/config/outbounds/ ; publicKey is retained by Xray's
// config parser as the backward-compatible alias of REALITY password.
export function toXrayOutbound(node: ProxyNode, alias: string): Record<string, unknown> {
  const p = parseProxyOptions(node);
  const stream: Record<string, unknown> = { network: p.network || "tcp", security: p.reality ? "reality" : p.tls ? "tls" : "none" };
  if (p.tfo !== undefined) stream.sockopt = { tcpFastOpen: p.tfo };
  if (p.tls && !p.reality) stream.tlsSettings = { allowInsecure: false, ...(p.servername ? { serverName: p.servername } : {}), ...(p.clientFingerprint ? { fingerprint: p.clientFingerprint } : {}), ...(p.alpn ? { alpn: p.alpn } : {}) };
  if (p.reality) {
    if (p.alpn) throw new Error("Xray REALITY 不支持此 ALPN 设置，未忽略参数");
    stream.realitySettings = { serverName: p.servername || p.server, fingerprint: p.clientFingerprint || "chrome", publicKey: p.reality.publicKey, shortId: p.reality.shortId };
  }
  if (p.ws) stream.wsSettings = { path: p.ws.path, ...(p.ws.host ? { headers: { Host: p.ws.host } } : {}) };
  if (p.grpc) stream.grpcSettings = { serviceName: p.grpc.serviceName, multiMode: false };
  const endpoint = { address: p.server, port: p.port };
  let protocol: string = p.type, settings: Record<string, unknown>;
  if (p.type === "ss") {
    if (!["aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "xchacha20-ietf-poly1305", "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305"].includes(p.cipher!)) throw new Error("Xray 不支持此 Shadowsocks 加密方式，未替换算法");
    protocol = "shadowsocks";
    settings = { servers: [{ ...endpoint, method: p.cipher, password: p.password }] };
  } else if (p.type === "vmess" || p.type === "vless") {
    if (p.type === "vmess" && p.alterId !== 0) throw new Error("Xray 此导出只支持 VMess AEAD（alterId=0），无法保真转换原节点 alterId");
    if (p.type === "vmess" && p.cipher === "zero") throw new Error("Xray 暂不转换 VMess zero 加密方式");
    settings = { vnext: [{ ...endpoint, users: [{ id: p.uuid, ...(p.type === "vmess" ? { security: p.cipher } : { encryption: "none", ...(p.flow ? { flow: p.flow } : {}) }) }] }] };
  } else if (p.type === "trojan") settings = { servers: [{ ...endpoint, password: p.password }] };
  else {
    protocol = p.type === "socks5" ? "socks" : "http";
    settings = { servers: [{ ...endpoint, ...(p.username !== undefined ? { users: [{ user: p.username, pass: p.password }] } : {}) }] };
  }
  return { tag: alias, protocol, settings, streamSettings: stream };
}
function dnsServers(model: ExportModel): string[] {
  return model.servers.map(server => {
    if (server === "system") return "localhost";
    if (/^(tls|quic):/.test(server)) throw new Error("Xray 此导出支持 IP、系统 DNS 或 HTTPS DoH；请将 DNS 的 TLS/QUIC 地址改为受支持格式");
    return server;
  });
}
export const xrayExporter: ConfigExporter = {
  id: "v2rayn", name: "v2rayN / Xray", extension: ".json", parseGeneral: rejectClientGeneral,
  serialize(model) {
    const sources = model.sources ?? [];
    const final = model.rules.at(-1);
    if (final?.type !== "FINAL") throw new Error("配置缺少最终规则");
    if (model.rules.some(rule => (rule.target ?? rule.policy) === "PROXY")) throw new Error("请先在默认代理或对应应用/规则中选择节点，再导出 v2rayN / Xray 配置");
    const outbounds: Record<string, unknown>[] = [
      ...sources.map(source => toXrayOutbound(source.node, source.alias)),
      { tag: "DIRECT", protocol: "freedom", settings: { domainStrategy: model.ipv6 ? "UseIP" : "UseIPv4" } },
      { tag: "REJECT", protocol: "blackhole", settings: {} },
      { tag: "ROUTEKIT-DNS-BOOTSTRAP", protocol: "freedom", settings: { domainStrategy: "AsIs" } },
    ];
    const finalTarget = final.target ?? final.policy;
    const defaultIndex = outbounds.findIndex(outbound => outbound.tag === finalTarget);
    if (defaultIndex < 0) throw new Error("最终代理节点不存在，请重新选择默认节点");
    outbounds.unshift(...outbounds.splice(defaultIndex, 1));
    const disabledUdp = new Set(sources.filter(source => parseProxyOptions(source.node).udp === false).map(source => source.alias));
    const rules = model.rules.flatMap(rule => {
      const base = { type: "field", outboundTag: rule.target ?? rule.policy };
      let mapped: Record<string, unknown>;
      switch (rule.type) {
        case "DOMAIN": mapped = { ...base, domain: [`full:${rule.value}`] }; break;
        case "DOMAIN-SUFFIX": mapped = { ...base, domain: [`domain:${rule.value}`] }; break;
        case "DOMAIN-KEYWORD": mapped = { ...base, domain: [`keyword:${rule.value}`] }; break;
        case "IP-CIDR": case "IP-CIDR6": mapped = { ...base, ip: [rule.value] }; break;
        case "GEOIP": mapped = { ...base, ip: [`geoip:${rule.value.toLowerCase()}`] }; break;
        case "FINAL": mapped = { ...base, network: "tcp,udp" }; break;
        default: throw new Error("Xray 规则类型不受支持");
      }
      // Xray has no per-outbound udp=false switch. Preserve it by rejecting
      // only UDP that would select this exact route, including FINAL.
      return disabledUdp.has(base.outboundTag) ? [{ ...mapped, network: "udp", outboundTag: "REJECT" }, mapped] : [mapped];
    });
    return JSON.stringify({
      log: { loglevel: "warning" },
      dns: { tag: "dns-internal", servers: dnsServers(model), hosts: Object.fromEntries(model.hosts.map(host => [`full:${host.hostname}`, host.address])), queryStrategy: model.ipv6 ? "UseIP" : "UseIPv4" },
      inbounds: [
        { tag: "socks-in", listen: "127.0.0.1", port: 10808, protocol: "socks", settings: { auth: "noauth", udp: true } },
        { tag: "http-in", listen: "127.0.0.1", port: 10809, protocol: "http", settings: {} },
      ],
      outbounds,
      routing: { domainStrategy: "IPOnDemand", rules: [{ type: "field", inboundTag: ["dns-internal"], outboundTag: "ROUTEKIT-DNS-BOOTSTRAP" }, ...rules] },
    }, null, 2) + "\n";
  },
};
