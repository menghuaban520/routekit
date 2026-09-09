import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseSubscription, proxyNodeIdentity, serializeNodes } from "./subscriptions";
import { parseProxyOptions, toMihomoProxy } from "./adapters/proxy-options";

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";
const base = { name: "演示节点", server: "proxy.example.com", port: 443 };
const ss = { ...base, type: "ss", cipher: "aes-256-gcm", password: "p:@/#? 密码" };
function parse(nodes: unknown[], rest = {}) {
  return parseSubscription(stringify({ proxies: nodes, ...rest }));
}
function vmessData(uri: string) { return JSON.parse(Buffer.from(uri.slice(8), "base64").toString("utf8")); }

describe("Clash/Mihomo subscription node import", () => {
  it("imports all seven protocols and preserves credentials, TLS and explicit UDP defaults", () => {
    const result = parse([
      ss,
      { ...base, type: "vmess", uuid: UUID, alterId: 0, cipher: "auto", udp: true },
      { ...base, type: "vless", uuid: UUID, tls: false },
      { ...base, type: "trojan", password: "a:b@c/ 密码", sni: "tls.example.com" },
      { ...base, type: "socks5", username: "a:b", password: "p@ss", udp: false },
      { ...base, type: "http", username: "test", password: "p@ss" },
      { ...base, type: "http", tls: true, sni: "tls.example.com", alpn: ["h2", "http/1.1"], "skip-cert-verify": false },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.nodes.map(node => node.protocol)).toEqual(["ss", "vmess", "vless", "trojan", "socks5", "http", "https"]);
    expect(result.nodes[0].uri).toContain("udp=0");
    expect(vmessData(result.nodes[1].uri).udp).toBe("1");
    expect(new URL(result.nodes[3].uri).username).toBe(encodeURIComponent("a:b@c/ 密码"));
    const https = new URL(result.nodes[6].uri);
    expect(https.searchParams.get("sni")).toBe("tls.example.com");
    expect(https.searchParams.get("alpn")).toBe("h2,http/1.1");
    expect(https.searchParams.get("allowInsecure")).toBe("0");
    const restored = parseSubscription(serializeNodes(result.nodes));
    expect(restored.errors).toEqual([]);
    expect(restored.nodes.map(proxyNodeIdentity)).toEqual(result.nodes.map(proxyNodeIdentity));
  });

  it("preserves WS, gRPC, Reality, TLS verification, fingerprints and TFO", () => {
    const result = parse([
      { ...base, type: "vmess", uuid: UUID, tls: true, network: "ws", servername: "tls.example.com", alpn: ["http/1.1"], "client-fingerprint": "chrome", "skip-cert-verify": true, tfo: false, "ws-opts": { path: "/v?ed=1", headers: { Host: "cdn.example.com" } } },
      { ...base, type: "vmess", uuid: UUID, network: "grpc", "grpc-opts": { "grpc-service-name": "service/test" } },
      { ...base, type: "vless", uuid: UUID, network: "grpc", tls: true, servername: "tls.example.com", flow: "xtls-rprx-vision", "client-fingerprint": "firefox", "reality-opts": { "public-key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "short-id": "aabb" }, "grpc-opts": { "grpc-service-name": "my service" }, tfo: true },
      { ...base, type: "trojan", password: "test", network: "ws", "ws-opts": { path: "/ws", headers: { host: "cdn.example.com" } } },
    ]);
    expect(result.errors).toEqual([]);
    expect(vmessData(result.nodes[0].uri)).toMatchObject({ net: "ws", path: "/v?ed=1", host: "cdn.example.com", sni: "tls.example.com", fp: "chrome", insecure: "1", tfo: "0", alpn: "http/1.1" });
    expect(vmessData(result.nodes[1].uri)).toMatchObject({ net: "grpc", path: "service/test" });
    const reality = new URL(result.nodes[2].uri);
    expect(Object.fromEntries(reality.searchParams)).toMatchObject({ security: "reality", sid: "aabb", serviceName: "my service", fp: "firefox", tfo: "1" });
    expect(result.warnings.join(" ")).toContain("关闭了证书验证");
  });

  it("accepts document/list JSON, flow YAML, quoted keys and Base64-wrapped YAML", () => {
    const fixtures = [stringify({ proxies: [ss] }), stringify([ss]), JSON.stringify({ proxies: [ss] }), JSON.stringify([ss]), `'proxies':\n  - {name: A, type: ss, server: proxy.example.com, port: 8388, cipher: aes-256-gcm, password: secret}`];
    for (const yaml of fixtures) {
      for (const text of [yaml, Buffer.from(yaml).toString("base64")]) {
        const result = parseSubscription(text);
        expect(result.errors).toEqual([]);
        expect(result.nodes).toHaveLength(1);
      }
    }
  });

  it("warns that full-config rules, groups, providers, DNS and settings are not imported", () => {
    const result = parse([ss], { "proxy-groups": [], rules: ["MATCH,DIRECT"], "proxy-providers": { remote: { type: "http", url: "https://provider.invalid/private-token" } }, dns: { enable: true }, "mixed-port": 7890 });
    expect(result.nodes).toHaveLength(1);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/策略组.*未导入/);
    expect(result.warnings.join(" ")).toContain("分流规则");
    expect(result.warnings.join(" ")).toContain("远程订阅未读取");
    expect(result.warnings.join(" ")).toContain("DNS");
    expect(JSON.stringify(result.warnings)).not.toContain("private-token");
  });

  it("gives provider-only guidance without fetching remote URLs", () => {
    const result = parseSubscription("proxy-providers:\n  remote:\n    type: http\n    url: https://provider.invalid/secret\n");
    expect(result.nodes).toEqual([]);
    expect(result.errors[0]).toContain("请从订阅方下载实际节点内容");
    expect(result.errors.join(" ")).not.toContain("secret");
  });

  it("reports unsupported fields per node and retains other valid nodes", () => {
    const result = parse([
      { ...ss, plugin: "v2ray-plugin", "plugin-opts": { tls: true } },
      { ...base, type: "vless", uuid: UUID, network: "ws", "ws-opts": { headers: { Authorization: "super-secret" } } },
      { ...base, type: "vmess", uuid: UUID, "authenticated-length": false },
      { ...base, type: "trojan", password: "super-secret", fingerprint: "super-secret" },
      { ...ss, "dialer-proxy": "parent", smux: { enabled: false } },
      ss,
    ]);
    expect(result.nodes).toHaveLength(1);
    expect(result.errors).toHaveLength(5);
    expect(result.errors[0]).toContain("第 1 个 YAML 节点");
    expect(result.errors[1]).toContain("ws-opts.headers");
    expect(result.errors.join(" ")).not.toContain("super-secret");
  });

  it.each([
    { ...base, type: "vless", uuid: UUID, network: "h2" },
    { ...base, type: "vless", uuid: UUID, tls: true, "reality-opts": { "public-key": "bad", "short-id": "aa" } },
    { ...base, type: "vless", uuid: UUID, tls: true, "reality-opts": { "public-key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "short-id": 1122 } },
    { ...base, type: "vless", uuid: UUID, network: "tcp", "ws-opts": { path: "/" } },
    { ...base, type: "trojan", password: "test", tls: false },
    { ...base, type: "vmess", uuid: UUID, tls: true, alpn: ["h2,http/1.1"] },
    { ...base, type: "socks5", tls: true },
    { ...ss, password: 123456 },
    { ...ss, server: "user@proxy.example.com" },
    { ...ss, udp: "true" },
    { ...ss, port: "443.1" },
  ])("rejects ambiguous or invalid node fields %#", (node) => {
    const result = parse([node]);
    expect(result.nodes).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it("preserves SS 2022 keys, IPv6 and name-independent canonical identities", () => {
    const config = { ...ss, cipher: "2022-blake3-aes-128-gcm", password: Buffer.alloc(16).toString("base64"), server: "2001:4860:4860::8888" };
    const result = parse([config, { ...config, name: "renamed" }, { ...config, password: Buffer.alloc(16, 1).toString("base64") }]);
    expect(result.errors).toEqual([]);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].server).toBe("2001:4860:4860::8888");
    expect(result.warnings.join(" ")).toContain("合并 1 个");
  });

  it("round-trips the actual Mihomo exporter without losing supported connection options", () => {
    const first = parse([
      ss,
      { ...base, type: "vmess", uuid: UUID, tls: true, network: "ws", "skip-cert-verify": false, servername: "sni.example.com", "client-fingerprint": "chrome", "ws-opts": { path: "/ws", headers: { Host: "cdn.example.com" } } },
      { ...base, type: "vless", uuid: UUID, tls: true, network: "tcp", flow: "xtls-rprx-vision", "reality-opts": { "public-key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "short-id": "aabb" }, tfo: false },
      { ...base, type: "trojan", password: "test", network: "grpc", "grpc-opts": { "grpc-service-name": "example" } },
      { ...base, type: "socks5", username: "test", password: "test", udp: true },
      { ...base, type: "http", username: "test", password: "test", tfo: false },
      { ...base, type: "http", tls: true, sni: "tls.example.com", alpn: ["http/1.1"] },
    ]);
    expect(first.errors).toEqual([]);
    const emitted = first.nodes.map((node, index) => toMihomoProxy(node, `roundtrip-${index}`));
    const second = parseSubscription(stringify({ proxies: emitted }));
    expect(second.errors).toEqual([]);
    expect(second.nodes.map(parseProxyOptions)).toEqual(first.nodes.map(parseProxyOptions));
  });

  it.each([
    "proxies: []\nproxies: []",
    "proxies: [!private {name: secret}]",
    "proxies: [&node {name: A, type: ss}, *node]",
    "base: &base {password: secret}\nproxies:\n  - <<: *base",
    "proxies: []\nconstructor: {prototype: {polluted: true}}",
    'proxies: [{"__proto__": {"polluted": true}}]',
    "proxies: []\n? [compound, key]\n: value",
    "proxies: []\n---\nproxies: []",
    "proxies: []\nextra: " + "[".repeat(40) + "0" + "]".repeat(40),
    "proxies: []\nextra: " + "[".repeat(10000) + "0" + "]".repeat(10000),
    'proxies: [{name: "secret\\u0000", type: ss}]',
  ])("safely rejects dangerous YAML structures %#", (yaml) => {
    const result = parseSubscription(yaml);
    expect(result.nodes).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(" ")).not.toContain("secret");
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("does not expose YAML parser source snippets containing passwords", () => {
    const result = parseSubscription("proxies:\n  - name: test\n    password: super-private-token\n    password: [\n");
    expect(result.nodes).toEqual([]);
    expect(result.errors.join(" ")).not.toContain("super-private-token");
  });

  it("enforces the existing 2 MiB and 500-node budgets", () => {
    expect(parseSubscription("proxies: []\n#" + "x".repeat(2 * 1024 * 1024)).errors[0]).toContain("2 MB");
    const result = parse(Array.from({ length: 501 }, (_, index) => ({ ...ss, name: `n${index}`, port: index + 1 })));
    expect(result.nodes).toHaveLength(500);
    expect(result.errors).toContain("最多支持 500 个节点，剩余 YAML 节点未导入");
  });
});
