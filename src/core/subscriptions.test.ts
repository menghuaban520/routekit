import { describe, expect, it } from "vitest";
import {
  createSsNode,
  parseSubscription,
  redactSubscriptionUrl,
  serializeNodes,
  validateSubscriptionUrl,
} from "./subscriptions";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const base64 = (value: string) => Buffer.from(value).toString("base64");
const ss = (password = "test-password", name = "香港") =>
  `ss://${base64(`aes-256-gcm:${password}`)}@proxy.example.com:8388#${encodeURIComponent(name)}`;
const vmess = (overrides = {}) =>
  `vmess://${base64(JSON.stringify({ v: "2", ps: "VMess 示例", add: "proxy.example.com", port: "443", id: UUID, aid: "0", net: "ws", path: "/socket", tls: "tls", ...overrides }))}`;

describe("local subscription import", () => {
  it("imports SIP002 SS, VMess JSON, VLESS, Trojan and authenticated proxy URLs", () => {
    const result = parseSubscription(
      [
        ss(),
        vmess(),
        `vless://${UUID}@proxy.example.com:443?encryption=none&security=tls&type=ws&path=%2Fvless#VLESS`,
        "trojan://pass%3Aword%40x@proxy.example.com:443?sni=cdn.example.com#Trojan",
        "socks5://user:pass@192.168.1.1:1080#SOCKS",
        "http://user:pass@proxy.example.com:8080#HTTP",
        "https://proxy.example.com:443#HTTPS",
      ].join("\n"),
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes.map((node) => node.protocol)).toEqual([
      "ss",
      "vmess",
      "vless",
      "trojan",
      "socks5",
      "http",
      "https",
    ]);
    expect(result.nodes[0].name).toBe("香港");
    expect(result.nodes[0].port).toBe(8388);
    expect(result.nodes.every((node) => UUIDPattern(node.id))).toBe(true);
  });

  it("supports standard and URL-safe base64 whole subscriptions with wrapped lines", () => {
    const text = [ss("one", "一"), ss("two", "二")].join("\n");
    for (const encoding of [
      base64(text),
      Buffer.from(text).toString("base64url"),
    ]) {
      const result = parseSubscription(
        encoding.match(/.{1,64}/g)!.join("\r\n"),
      );
      expect(result.errors).toEqual([]);
      expect(result.nodes).toHaveLength(2);
    }
  });

  it("accepts legacy SS whole-authority encoding and emits SIP002", () => {
    const result = parseSubscription(
      `ss://${base64("aes-256-gcm:legacy@proxy.example.com:8388")}#Legacy`,
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes[0].uri).toContain("@proxy.example.com:8388#Legacy");
    expect(result.warnings.some((warning) => warning.includes("SIP002"))).toBe(
      true,
    );
  });

  it("supports SS plain percent-encoded credentials and retains plugin parameters", () => {
    const result = parseSubscription(
      "ss://aes-256-gcm:p%3Aa%40ss@proxy.example.com:8388/?plugin=v2ray-plugin%3Btls%3Bhost%3Dcdn.example.com#Plugin",
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes[0].uri).toContain(
      "plugin=v2ray-plugin%3Btls%3Bhost%3Dcdn.example.com",
    );
    expect(result.warnings.some((warning) => warning.includes("插件"))).toBe(
      true,
    );
  });

  it("supports valid SS 2022 keys and rejects Base64-encoded SS 2022 userinfo", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    const item = createSsNode({
      name: "2022",
      server: "proxy.example.com",
      port: 443,
      method: "2022-blake3-aes-256-gcm",
      password: key,
    });
    expect(item.uri).toContain("ss://2022-blake3-aes-256-gcm:");
    expect(parseSubscription(item.uri).errors).toEqual([]);
    expect(
      parseSubscription(
        `ss://${base64(`2022-blake3-aes-256-gcm:${key}`)}@proxy.example.com:443`,
      ).nodes,
    ).toEqual([]);
    expect(() =>
      createSsNode({
        name: "bad",
        server: "proxy.example.com",
        port: 443,
        method: "2022-blake3-aes-256-gcm",
        password: "short",
      }),
    ).toThrow();
  });

  it("deduplicates the same connection with different remarks without merging different passwords", () => {
    const result = parseSubscription(
      [ss("one", "First"), ss("one", "Second"), ss("two", "First")].join("\n"),
    );
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((node) => node.name)).toEqual(["First", "First"]);
    expect(result.warnings.some((warning) => warning.includes("合并 1"))).toBe(
      true,
    );
  });

  it("deduplicates VMess independent of remark and object property ordering", () => {
    const result = parseSubscription(
      [
        vmess({ ps: "First" }),
        vmess({ ps: "Second" }),
        vmess({ id: "550e8400-e29b-41d4-a716-446655440001" }),
      ].join("\n"),
    );
    expect(result.nodes).toHaveLength(2);
  });

  it("retains query parameters in node identity", () => {
    const first = `vless://${UUID}@proxy.example.com:443?security=tls&type=ws&path=%2Fa`;
    const second = `vless://${UUID}@proxy.example.com:443?security=tls&type=ws&path=%2Fb`;
    expect(parseSubscription(`${first}\n${second}`).nodes).toHaveLength(2);
  });

  it("reports erroneous lines and keeps valid nodes without printing credentials in errors", () => {
    const result = parseSubscription(
      `${ss()}\nvless://super-secret@proxy.example.com:443\n${vmess()}`,
    );
    expect(result.nodes).toHaveLength(2);
    expect(result.errors[0]).toContain("第 2 行");
    expect(result.errors.join("")).not.toContain("super-secret");
  });

  it.each([
    "proxies:\n  - name: example\n    type: ss",
    "mixed-port: 7890\nproxies: []",
  ])("reports invalid or empty YAML node lists, including Base64 YAML: %s", (yaml) => {
    for (const value of [yaml, base64(yaml)])
      expect(parseSubscription(value).errors[0]).toMatch(/YAML|server/);
  });

  it("handles comments and blank lines", () => {
    expect(parseSubscription(`# Examples\n\n  ${ss()}\n`).nodes).toHaveLength(
      1,
    );
  });

  it.each([
    `vless://not-a-uuid@proxy.example.com:443`,
    "trojan://@proxy.example.com:443",
    "trojan://pass@proxy.example.com:0",
    "socks5://proxy.example.com:65536",
    "socks5://proxy.example.com",
    "http://proxy.example.com:abc",
    "http://proxy.example.com/path",
    "http://127.1:8080",
    "http://user:pass@bad_host.example:8080",
    "trojan://pass@proxy.example.com:443#bad%0Aname",
    `vless://${UUID}@proxy.example.com:443?security=invalid`,
    `vless://${UUID}@proxy.example.com:443?type=invalid`,
    `vless://${UUID}@proxy.example.com:443?security=tls&security=none`,
    `vless://${UUID}@proxy.example.com:443?path=%0A%5BProxy%5D`,
    `vless://${UUID}@proxy.example.com:443?sid=abc`,
    `vless://${UUID}@proxy.example.com:443?pbk=abc`,
    `vless://${UUID}@proxy.example.com:443?insecure=maybe`,
    `vless://${UUID}@proxy.example.com:443?path=%zz`,
    "ss://!!!@proxy.example.com:443",
    "ss://not-a-method:password@proxy.example.com:443",
    "hysteria2://secret@proxy.example.com:443",
  ])("rejects malformed or unsupported link %s", (link) => {
    const result = parseSubscription(link);
    expect(result.nodes).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it.each([
    { id: "bad" },
    { aid: -1 },
    { port: "443abc" },
    { insecure: "maybe" },
    { path: ["unexpected"] },
    { ps: "bad\nname" },
  ])("validates VMess parameters %s", (overrides) => {
    expect(parseSubscription(vmess(overrides)).nodes).toEqual([]);
  });

  it("warns about client extensions without silently discarding their data", () => {
    const result = parseSubscription(
      `vless://${UUID}@proxy.example.com:443?futureOption=encoded%20value`,
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes[0].uri).toContain("futureOption=encoded%20value");
    expect(
      result.warnings.some((warning) => warning.includes("扩展参数")),
    ).toBe(true);
  });

  it("supports IPv6 node addresses and internationalized server names", () => {
    const result = parseSubscription(
      "trojan://pass@[2001:db8::1]:443#IPv6\nhttp://例子.中国:8080",
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes[0].server).toBe("2001:db8::1");
    expect(result.nodes[1].server).toBe("xn--fsqu00a.xn--fiqs8s");
  });

  it("enforces the 2 MB and 500 node bounds", () => {
    expect(
      parseSubscription("a".repeat(2 * 1024 * 1024 + 1)).errors[0],
    ).toContain("2 MB");
    const result = parseSubscription(
      Array.from({ length: 501 }, (_, index) => ss(`pass-${index}`)).join("\n"),
    );
    expect(result.nodes).toHaveLength(500);
    expect(result.errors.some((error) => error.includes("500"))).toBe(true);
  });

  it("does not count duplicate links toward the 500-node limit", () => {
    const result = parseSubscription(
      Array.from({ length: 501 }, () => ss()).join("\n"),
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("exports credentials only through an explicit node serialization", () => {
    const nodes = parseSubscription(`${ss()}\n${vmess()}`).nodes;
    const exported = serializeNodes(nodes);
    expect(exported.trim().split("\n")).toHaveLength(2);
    expect(parseSubscription(exported).errors).toEqual([]);
    expect(parseSubscription(exported).nodes.map((node) => node.uri)).toEqual(
      nodes.map((node) => node.uri),
    );
    expect(() =>
      serializeNodes([
        { ...nodes[0], uri: "http://proxy.example.com:8080\n[Proxy]" },
      ]),
    ).toThrow();
  });

  it("creates SS links with reserved password characters and IPv6 safely", () => {
    const node = createSsNode({
      name: "我的节点 #1",
      server: "2001:db8::1",
      port: 8388,
      method: "aes-256-gcm",
      password: "a@b:c/d?e#f",
    });
    expect(node.server).toBe("2001:db8::1");
    expect(node.uri).toContain("@[2001:db8::1]:8388#");
    expect(parseSubscription(node.uri).nodes[0].name).toBe("我的节点 #1");
  });
});

describe("subscription URL validation and redaction", () => {
  it.each([
    "https://sub.example.com/api/v1/client/subscribe?token=secret",
    "https://1.1.1.1/sub",
    "https://[2606:4700:4700::1111]/sub",
  ])("accepts an HTTPS public address %s", (value) => {
    expect(validateSubscriptionUrl(value)).toBe(true);
  });

  it.each([
    "http://sub.example.com",
    "https://user:pass@sub.example.com/sub",
    "https://sub.example.com/#secret",
    "https://localhost/sub",
    "https://foo.local/sub",
    "https://internal/sub",
    "https://127.0.0.1/sub",
    "https://127.1/sub",
    "https://2130706433/sub",
    "https://0x7f000001/sub",
    "https://10.0.0.1/sub",
    "https://172.16.1.1/sub",
    "https://192.168.1.1/sub",
    "https://169.254.169.254/sub",
    "https://100.64.0.1/sub",
    "https://[::1]/sub",
    "https://[::ffff:127.0.0.1]/sub",
    "https://[fc00::1]/sub",
    "https://[fe80::1]/sub",
    "https://[2001:db8::1]/sub",
    "https://sub.example.com/%0d%0asecret",
    "https://sub.example.com:0/sub",
    "https://sub.example.com:65536/sub",
  ])(
    "rejects private, malformed or credential-bearing subscription URL %s",
    (value) => {
      expect(validateSubscriptionUrl(value)).toBe(false);
    },
  );

  it("redacts tokens in userinfo, paths, query values and fragments", () => {
    const redacted = redactSubscriptionUrl(
      "https://user:secret@sub.example.com/another-secret/sub?token=third-secret#fourth-secret",
    );
    expect(redacted).toBe("https://sub.example.com/…");
    expect(redacted).not.toContain("secret");
    expect(redactSubscriptionUrl("not-a-url-secret")).toBe("无效订阅地址");
  });
});

function UUIDPattern(value: string): boolean {
  return /^[a-f0-9-]{36}$/.test(value);
}
