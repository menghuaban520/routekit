import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { existsSync, copyFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compileProfile, createProfile, parseProfile, serializeProfile, type ClientId } from "../index";
import { parseSubscription, type ProxyNode } from "../subscriptions";
import { nodeRoutingSupport, routingNodeBundle } from "../node-routing";
import { diagnoseBatch } from "../diagnostics";
import { toMihomoProxy } from "./proxy-options";
import { toXrayOutbound } from "./xray";

const uuid = "11111111-1111-4111-8111-111111111111";
const secret = "fixture, # : password 中文";
function node(uri: string, id = "alpha"): ProxyNode {
  const imported = parseSubscription(uri);
  expect(imported.errors).toEqual([]);
  expect(imported.nodes).toHaveLength(1);
  return { ...imported.nodes[0], id };
}
const ss = () => node(`ss://${btoa("aes-256-gcm:fixture-password")}@node.example.com:443#Fixture`);
const http = () => node(`http://fixture:${encodeURIComponent(secret)}@[2001:db8::1]:8080#IPv6`, "beta");
function profile(client: ClientId) {
  const profile = createProfile();
  profile.client = client;
  profile.nodeRouting = { nodes: [ss(), http()], defaultNodeId: "alpha", appNodeIds: { youtube: "beta" } };
  profile.hosts = "router.local = 192.168.1.1";
  profile.rules = [{ id: "special", type: "DOMAIN", value: "special.example.com", policy: "PROXY" }];
  profile.nodeRouting.ruleNodeIds = { special: "beta" };
  return profile;
}
const samples = [
  ss(),
  node("vmess://" + btoa(JSON.stringify({ v: "2", ps: "VMess", add: "vmess.example.com", port: "443", id: uuid, aid: "0", scy: "auto", net: "ws", type: "none", host: "edge.example.com", path: "/tunnel", tls: "tls", sni: "tls.example.com", alpn: "http/1.1", fp: "chrome" })), "vmess"),
  node(`vless://${uuid}@vless.example.com:443?type=grpc&security=tls&sni=tls.example.com&serviceName=fixture#VLESS`, "vless"),
  node("trojan://fixture-password@trojan.example.com:443?type=ws&security=tls&path=%2Fsocket&sni=tls.example.com#Trojan", "trojan"),
  node("socks5://fixture:password@socks.example.com:1080#SOCKS", "socks"),
  http(),
  node("https://fixture:password@https.example.com:443#HTTPS", "https"),
];

describe("Mihomo and Xray client exports", () => {
  it.each(["shadowrocket", "clash", "v2rayn"] as const)("round-trips %s profiles and diagnoses the same app/default/explicit bindings", client => {
    const value = profile(client);
    const compiled = compileProfile(value);
    expect(compiled.errors).toEqual([]);
    expect(parseProfile(serializeProfile(value))).toEqual(value);
    const diagnosed = diagnoseBatch(value, "www.youtube.com,8.8.8.8,US\nwww.telegram.org,8.8.8.8,US\nspecial.example.com,8.8.8.8,US\nwww.kugou.com,8.8.8.8,US");
    expect(diagnosed.errors).toEqual([]);
    expect(diagnosed.results.map(row => [row.policy, row.nodeId])).toEqual([["PROXY", "beta"], ["PROXY", "alpha"], ["PROXY", "beta"], ["DIRECT", undefined]]);
    expect(compiled.normalizedRules?.at(-1)?.target).toBe("RK_alpha");
    if (client !== "shadowrocket") expect(routingNodeBundle(value).count).toBe(0);
  });
  it("preserves Mihomo rule ordering, names, credentials, IPv6, hosts and DNS", () => {
    const compiled = compileProfile(profile("clash"));
    const config = parse(compiled.content);
    expect(config["mixed-port"]).toBe(7890);
    expect(config["allow-lan"]).toBe(false);
    expect(config.proxies.find((p: { name: string }) => p.name === "RK_beta")).toMatchObject({ type: "http", password: secret, server: "2001:db8::1" });
    expect(config.rules).toContain("DOMAIN,special.example.com,RK_beta");
    expect(config.rules).toContain("DOMAIN-SUFFIX,youtube.com,RK_beta");
    expect(config.rules).toContain("IP-CIDR,10.0.0.0/8,DIRECT,no-resolve");
    expect(config.rules.slice(-2)).toEqual(["GEOIP,CN,DIRECT", "MATCH,RK_alpha"]);
    expect(config.hosts).toEqual({ "router.local": "192.168.1.1" });
    expect(config.dns.nameserver).toEqual(["https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"]);
    expect(compiled.warnings.join()).toContain("明文引导解析");
  });
  it("uses Xray on-demand DNS and preserves FINAL after explicit rules", () => {
    const compiled = compileProfile(profile("v2rayn"));
    const config = JSON.parse(compiled.content);
    expect(config.outbounds[0].tag).toBe("RK_alpha");
    expect(config.routing.domainStrategy).toBe("IPOnDemand");
    expect(config.routing.rules.at(-2)).toEqual({ type: "field", outboundTag: "DIRECT", ip: ["geoip:cn"] });
    expect(config.routing.rules.at(-1)).toEqual({ type: "field", outboundTag: "RK_alpha", network: "tcp,udp" });
    expect(config.routing.rules).toContainEqual({ type: "field", outboundTag: "RK_beta", domain: ["domain:youtube.com"] });
    expect(config.dns.hosts).toEqual({ "full:router.local": "192.168.1.1" });
    expect(config.dns.queryStrategy).toBe("UseIPv4");
    expect(config.dns.tag).toBe("dns-internal");
    expect(config.routing.rules[0]).toEqual({ type: "field", inboundTag: ["dns-internal"], outboundTag: "ROUTEKIT-DNS-BOOTSTRAP" });
    expect(config.outbounds.find((o: { tag: string }) => o.tag === "ROUTEKIT-DNS-BOOTSTRAP")).toMatchObject({ protocol: "freedom", settings: { domainStrategy: "AsIs" } });
    expect(compiled.warnings.join()).toContain("避免解析循环");
    expect(config.inbounds.map((i: { listen: string; port: number }) => [i.listen, i.port])).toEqual([["127.0.0.1", 10808], ["127.0.0.1", 10809]]);
    expect(config.outbounds.find((o: { tag: string }) => o.tag === "RK_beta").settings.servers[0]).toMatchObject({ address: "2001:db8::1", users: [{ user: "fixture", pass: secret }] });
  });
  it.each(["clash", "v2rayn"] as const)("blocks unresolved PROXY and incompatible general options for %s", client => {
    const missing = createProfile(); missing.client = client;
    expect(compileProfile(missing)).toMatchObject({ content: "", errors: [expect.stringContaining("选择节点")] });
    const value = profile(client); value.general = "icmp-auto-reply = true";
    expect(compileProfile(value).errors.join()).toContain("Shadowrocket 专用");
    expect(compileProfile(value).content).toBe("");
  });
  it("supports all-DIRECT configurations without fabricating proxy nodes", () => {
    for (const client of ["clash", "v2rayn"] as const) {
      const value = createProfile(); value.client = client; value.apps = []; value.finalPolicy = "DIRECT";
      expect(compileProfile(value).errors).toEqual([]);
    }
  });
  it("does not export unused app/rule nodes after deleting or changing them to DIRECT", () => {
    const value = profile("clash");
    value.apps.find(app => app.id === "youtube")!.policy = "DIRECT";
    value.rules = [];
    expect(parse(compileProfile(value).content).proxies.map((p: { name: string }) => p.name)).toEqual(["RK_alpha"]);
  });
  it.each(samples)("maps $protocol connection options into both target structures", item => {
    expect(nodeRoutingSupport(item, "clash")).toMatchObject({ supported: true, mode: "embedded" });
    expect(nodeRoutingSupport(item, "v2rayn")).toMatchObject({ supported: true, mode: "embedded" });
    const mihomo = toMihomoProxy(item, "RK_sample");
    const xray = toXrayOutbound(item, "RK_sample");
    expect(mihomo.server).toBe(item.server);
    expect(xray.tag).toBe("RK_sample");
    if (item.protocol === "vmess") {
      expect(mihomo["ws-opts"]).toEqual({ path: "/tunnel", headers: { Host: "edge.example.com" } });
      expect(xray.streamSettings).toMatchObject({ security: "tls", wsSettings: { path: "/tunnel", headers: { Host: "edge.example.com" } }, tlsSettings: { serverName: "tls.example.com", alpn: ["http/1.1"], fingerprint: "chrome", allowInsecure: false } });
    }
  });
  it("preserves Reality keys and Vision without downgrading parameters", () => {
    const key = "CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const item = node(`vless://${uuid}@node.example.com:443?security=reality&sni=tls.example.com&fp=chrome&pbk=${key}&sid=ab12&flow=xtls-rprx-vision`);
    expect(toMihomoProxy(item, "RK_one")["reality-opts"]).toEqual({ "public-key": key, "short-id": "ab12" });
    expect(toXrayOutbound(item, "RK_one").streamSettings).toMatchObject({ security: "reality", realitySettings: { publicKey: key, shortId: "ab12", serverName: "tls.example.com" } });
  });
  it.each(["plugin=v2ray-plugin", "udp=maybe", "tfo=maybe"])("refuses unsupported SS parameters %s without echoing secrets", query => {
    const original = ss();
    const item = { ...original, uri: original.uri.split("#")[0] + "?" + query };
    const support = nodeRoutingSupport(item, "clash");
    expect(support.supported).toBe(false);
    expect(support.reason).not.toContain("fixture-password");
  });
  it("blocks insecure TLS, unsupported WS extras, Xray alterId and DNS transports", () => {
    for (const extra of ["allowInsecure=1", "ed=2048", "type=xhttp"]) {
      const item = node(`vless://${uuid}@node.example.com:443?security=tls&${extra}`);
      expect(nodeRoutingSupport(item, "clash").supported).toBe(false);
    }
    const legacy = node("vmess://" + btoa(JSON.stringify({ v: "2", add: "node.example.com", port: "443", id: uuid, aid: "2", net: "tcp" })));
    expect(nodeRoutingSupport(legacy, "v2rayn").reason).toContain("alterId");
    const value = profile("v2rayn"); value.dns.mode = "custom"; value.dns.servers = "tls://dns.example.com";
    expect(compileProfile(value).errors.join()).toContain("TLS/QUIC");
  });
  it("marks Xray domain-only routes uncertain before resolving earlier IP rules", () => {
    const result = diagnoseBatch(profile("v2rayn"), "youtube.com");
    expect(result.errors).toEqual([]);
    expect(result.results[0]).toMatchObject({ status: "needs-ip", policy: "unknown" });
    expect(result.results[0].nodeId).toBeUndefined();
    expect(diagnoseBatch(profile("shadowrocket"), "youtube.com").results[0]).toMatchObject({ policy: "PROXY", nodeId: "beta" });
  });
  it("preserves per-node UDP and TFO settings without blocking other routes", () => {
    const selected = ss(); selected.uri = selected.uri.split("#")[0] + "?udp=0&tfo=1";
    expect(toMihomoProxy(selected, "RK_alpha")).toMatchObject({ udp: false, tfo: true });
    expect(toXrayOutbound(selected, "RK_alpha").streamSettings).toMatchObject({ sockopt: { tcpFastOpen: true } });
    const value = profile("v2rayn"); value.nodeRouting!.nodes[0] = selected;
    const compiled = compileProfile(value);
    expect(compiled.errors).toEqual([]);
    const config = JSON.parse(compiled.content);
    const final = config.routing.rules.slice(-2);
    expect(final).toEqual([{ type: "field", outboundTag: "REJECT", network: "udp" }, { type: "field", outboundTag: "RK_alpha", network: "tcp,udp" }]);
    const youtube = config.routing.rules.filter((r: { domain?: string[] }) => r.domain?.includes("domain:youtube.com"));
    expect(youtube).toEqual([{ type: "field", outboundTag: "RK_beta", domain: ["domain:youtube.com"] }]);
    const telegram = config.routing.rules.filter((r: { domain?: string[] }) => r.domain?.includes("domain:telegram.org"));
    expect(telegram).toHaveLength(2);
    expect(telegram[0]).toMatchObject({ network: "udp", outboundTag: "REJECT" });
  });
  it("maps system DNS explicitly and keeps its privacy warning", () => {
    const value = profile("v2rayn"); value.dns.mode = "system";
    const compiled = compileProfile(value);
    expect(JSON.parse(compiled.content).dns.servers).toEqual(["localhost"]);
    expect(compiled.warnings.join()).toContain("系统或明文");
  });
});

const core = "/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo";
const database = "/Applications/Clash Verge.app/Contents/Resources/resources/Country.mmdb";
it.skipIf(!existsSync(core) || !existsSync(database))("validates a seven-protocol export with the installed isolated Mihomo core", () => {
  const value = profile("clash");
  value.apps = samples.map((item, index) => ({ id: `sample${index}`, name: item.name, domains: [`sample${index}.example.com`], policy: "PROXY", color: "#123456", symbol: "P" }));
  value.rules = [];
  value.nodeRouting = { nodes: samples, defaultNodeId: "alpha", appNodeIds: Object.fromEntries(samples.map((item, index) => [`sample${index}`, item.id])) };
  const compiled = compileProfile(value);
  expect(compiled.errors).toEqual([]);
  const directory = mkdtempSync(join(tmpdir(), "routekit-export-syntax-"));
  try {
    copyFileSync(database, join(directory, "Country.mmdb"));
    writeFileSync(join(directory, "config.yaml"), compiled.content, { mode: 0o600 });
    const { status } = spawnSync(core, ["-d", directory, "-f", join(directory, "config.yaml"), "-t"], { timeout: 15000, stdio: "ignore", env: { PATH: process.env.PATH } });
    expect(status).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20000);
