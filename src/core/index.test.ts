import { describe, expect, it } from "vitest";
import {
  APP_CATALOG,
  CLIENTS,
  compileProfile,
  createProfile,
  fileName,
  getConfigExporter,
  parseProfile,
  serializeProfile,
  validateDomain,
} from "./index";

describe("Shadowrocket compiler", () => {
  it("generates one final rule and explicit encrypted primary/fallback DNS", () => {
    const result = compileProfile(createProfile());
    expect(result.errors).toEqual([]);
    expect(result.content).toContain("[General]\n");
    expect(result.content).toContain(
      "dns-server = https://dns.alidns.com/dns-query, https://doh.pub/dns-query",
    );
    expect(result.content).toContain(
      "fallback-dns-server = https://dns.alidns.com/dns-query, https://doh.pub/dns-query",
    );
    expect(result.content).toContain("dns-direct-system = false");
    expect(result.content).toContain(
      "udp-policy-not-supported-behaviour = REJECT",
    );
    expect(result.content.match(/^FINAL,/gm)).toHaveLength(1);
    expect(result.content.trim().endsWith("FINAL,PROXY")).toBe(true);
    expect(result.content).not.toContain("[Proxy]");
    expect(
      result.warnings.some((item) => item.includes("不能证明无泄漏")),
    ).toBe(true);
  });

  it("keeps LAN before overrides, overrides before apps, CN after apps and FINAL last", () => {
    const profile = createProfile();
    profile.rules.push({
      id: "override",
      type: "DOMAIN",
      value: "www.kugou.com",
      policy: "PROXY",
    });
    const { content } = compileProfile(profile);
    const keys = [
      "IP-CIDR,192.168.0.0/16",
      "DOMAIN,www.kugou.com,PROXY",
      "DOMAIN-SUFFIX,kugou.com,DIRECT",
      "GEOIP,CN,DIRECT",
      "FINAL,PROXY",
    ];
    const indices = keys.map((key) => content.indexOf(key));
    expect(indices.every((index) => index > 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it("lets an earlier custom suffix win a duplicate app suffix without conflicting duplicate output", () => {
    const profile = createProfile();
    profile.rules.push({
      id: "override",
      type: "DOMAIN-SUFFIX",
      value: "kugou.com",
      policy: "PROXY",
    });
    const result = compileProfile(profile);
    expect(result.content).toContain("DOMAIN-SUFFIX,kugou.com,PROXY");
    expect(result.content).not.toContain("DOMAIN-SUFFIX,kugou.com,DIRECT");
    expect(result.warnings.some((item) => item.includes("存在不同策略"))).toBe(
      true,
    );
  });

  it("honors domestic, final, IPv6, and LAN selections", () => {
    const profile = createProfile();
    profile.domesticPolicy = "PROXY";
    profile.finalPolicy = "DIRECT";
    profile.bypassLan = false;
    profile.dns.ipv6 = true;
    const { content } = compileProfile(profile);
    expect(content).toContain("GEOIP,CN,PROXY\nFINAL,DIRECT");
    expect(content).not.toContain("192.168.0.0/16");
    expect(content).toContain("ipv6 = true");
  });

  it("uses no-resolve for custom IPv4/IPv6 rules so they do not force DNS queries", () => {
    const profile = createProfile();
    profile.rules.push({
      id: "v4",
      type: "IP-CIDR",
      value: "203.0.113.0/24",
      policy: "PROXY",
    });
    profile.rules.push({
      id: "v6",
      type: "IP-CIDR6",
      value: "2001:db8::/32",
      policy: "REJECT",
    });
    expect(compileProfile(profile).content).toContain(
      "IP-CIDR,203.0.113.0/24,PROXY,no-resolve",
    );
    expect(compileProfile(profile).content).toContain(
      "IP-CIDR6,2001:db8::/32,REJECT,no-resolve",
    );
  });

  it.each([
    "300.0.0.1/24",
    "10.0.0.0/33",
    "10.0.0.0/-1",
    "10.0.0.0",
    "01.2.3.4/24",
  ])("rejects invalid IPv4 CIDR %s", (value) => {
    const profile = createProfile();
    profile.rules = [{ id: "bad", type: "IP-CIDR", value, policy: "DIRECT" }];
    expect(compileProfile(profile).errors.length).toBeGreaterThan(0);
    expect(compileProfile(profile).content).toBe("");
  });

  it.each(["2001:db8::/129", "2001:::1/64", "10.0.0.0/24", "fe80::1%en0/64"])(
    "rejects invalid IPv6 CIDR %s",
    (value) => {
      const profile = createProfile();
      profile.rules = [
        { id: "bad", type: "IP-CIDR6", value, policy: "DIRECT" },
      ];
      expect(compileProfile(profile).errors.length).toBeGreaterThan(0);
    },
  );

  it("converts internationalized domains to ASCII safely", () => {
    const profile = createProfile();
    profile.rules = [
      {
        id: "idn",
        type: "DOMAIN-SUFFIX",
        value: "例子.中国",
        policy: "DIRECT",
      },
    ];
    expect(validateDomain("例子.中国")).toBe(true);
    expect(compileProfile(profile).content).toContain(
      "DOMAIN-SUFFIX,xn--fsqu00a.xn--fiqs8s,DIRECT",
    );
  });

  it.each([
    "https://kugou.com",
    "kugou.com\nFINAL,DIRECT",
    "kugou.com,PROXY",
    "kugou.com#x",
    "*.kugou.com",
    "a..com",
    "-bad.com",
    "127.0.0.1",
    "a/b.com",
  ])("rejects domain injection or malformed domain %s", (value) => {
    expect(validateDomain(value)).toBe(false);
    const profile = createProfile();
    profile.apps[0].domains = [value];
    expect(compileProfile(profile).content).toBe("");
  });

  it("supports custom encrypted resolvers and warns about plaintext DNS", () => {
    const profile = createProfile();
    profile.dns = {
      mode: "custom",
      servers: "tls://1.1.1.1, quic://dns.adguard-dns.com, 223.5.5.5",
      ipv6: false,
    };
    const result = compileProfile(profile);
    expect(result.errors).toEqual([]);
    expect(result.content).toContain(
      "tls://1.1.1.1, quic://dns.adguard-dns.com, 223.5.5.5",
    );
    expect(result.warnings.some((item) => item.includes("明文"))).toBe(true);
  });

  it("accepts DNS separated by newlines, commas, and Windows line endings without emitting multiline fields", () => {
    const profile = createProfile();
    profile.dns.mode = "custom";
    profile.dns.servers =
      "https://dns.google/dns-query\r\nhttps://doh.pub/dns-query, 223.5.5.5\n\n";
    const result = compileProfile(profile);
    expect(result.errors).toEqual([]);
    expect(result.content).toContain(
      "dns-server = https://dns.google/dns-query, https://doh.pub/dns-query, 223.5.5.5\n",
    );
    expect(result.content.match(/^dns-server = /gm)).toHaveLength(1);
  });

  it("enforces the 8 DNS limit across both separators", () => {
    const profile = createProfile();
    profile.dns.mode = "custom";
    profile.dns.servers = Array.from(
      { length: 9 },
      (_, index) => `1.1.1.${index + 1}`,
    ).join("\n");
    expect(
      compileProfile(profile).errors.some((error) => error.includes("1–8")),
    ).toBe(true);
    expect(compileProfile(profile).content).toBe("");
  });

  it("rejects DNS field injection after a valid newline-delimited address", () => {
    const profile = createProfile();
    profile.dns.mode = "custom";
    profile.dns.servers =
      "https://dns.google/dns-query\ndns-direct-system = true";
    expect(compileProfile(profile).content).toBe("");
  });

  it("warns about broad suffix shadowing and preserves the user rule order", () => {
    const profile = createProfile();
    profile.apps = [];
    profile.rules = [
      {
        id: "parent",
        type: "DOMAIN-SUFFIX",
        value: "example.com",
        policy: "DIRECT",
      },
      {
        id: "child",
        type: "DOMAIN-SUFFIX",
        value: "sub.example.com",
        policy: "PROXY",
      },
    ];
    const result = compileProfile(profile);
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("sub.example.com") && warning.includes("范围重叠"),
      ),
    ).toBe(true);
    expect(result.content).toContain(
      "DOMAIN-SUFFIX,example.com,DIRECT\nDOMAIN-SUFFIX,sub.example.com,PROXY",
    );
  });

  it("warns for an earlier exact domain and later parent suffix with a different policy", () => {
    const profile = createProfile();
    profile.apps = [];
    profile.rules = [
      {
        id: "child",
        type: "DOMAIN",
        value: "sub.example.com",
        policy: "PROXY",
      },
      {
        id: "parent",
        type: "DOMAIN-SUFFIX",
        value: "example.com",
        policy: "DIRECT",
      },
    ];
    expect(
      compileProfile(profile).warnings.some((warning) =>
        warning.includes("范围重叠"),
      ),
    ).toBe(true);
  });

  it("does not confuse suffix boundaries or same-policy nesting with conflicting overlap", () => {
    const profile = createProfile();
    profile.apps = [];
    profile.bypassLan = false;
    profile.rules = [
      {
        id: "one",
        type: "DOMAIN-SUFFIX",
        value: "example.com",
        policy: "DIRECT",
      },
      {
        id: "two",
        type: "DOMAIN-SUFFIX",
        value: "otherexample.com",
        policy: "PROXY",
      },
      {
        id: "three",
        type: "DOMAIN",
        value: "sub.example.com",
        policy: "DIRECT",
      },
    ];
    expect(
      compileProfile(profile).warnings.some((warning) =>
        warning.includes("范围重叠"),
      ),
    ).toBe(false);
  });

  it("warns about custom network rules shadowed by LAN protection", () => {
    const profile = createProfile();
    profile.rules = [
      { id: "lan", type: "IP-CIDR", value: "192.168.1.0/24", policy: "PROXY" },
    ];
    expect(
      compileProfile(profile).warnings.some(
        (warning) =>
          warning.includes("192.168.0.0/16") && warning.includes("范围重叠"),
      ),
    ).toBe(true);
  });

  it("detects masked IPv4 overlap even when a host address is entered", () => {
    const profile = createProfile();
    profile.apps = [];
    profile.bypassLan = false;
    profile.rules = [
      {
        id: "broad",
        type: "IP-CIDR",
        value: "203.0.113.17/24",
        policy: "DIRECT",
      },
      {
        id: "narrow",
        type: "IP-CIDR",
        value: "203.0.113.250/32",
        policy: "PROXY",
      },
    ];
    expect(
      compileProfile(profile).warnings.some((warning) =>
        warning.includes("范围重叠"),
      ),
    ).toBe(true);
  });

  it("detects compressed IPv6 network overlap, including /0", () => {
    const profile = createProfile();
    profile.apps = [];
    profile.bypassLan = false;
    profile.rules = [
      { id: "all", type: "IP-CIDR6", value: "::/0", policy: "REJECT" },
      {
        id: "doc",
        type: "IP-CIDR6",
        value: "2001:db8::1/128",
        policy: "PROXY",
      },
    ];
    expect(
      compileProfile(profile).warnings.some((warning) =>
        warning.includes("范围重叠"),
      ),
    ).toBe(true);
  });

  it("does not report disjoint network ranges", () => {
    const profile = createProfile();
    profile.apps = [];
    profile.bypassLan = false;
    profile.rules = [
      {
        id: "one",
        type: "IP-CIDR",
        value: "198.51.100.0/24",
        policy: "DIRECT",
      },
      { id: "two", type: "IP-CIDR", value: "203.0.113.0/24", policy: "PROXY" },
      { id: "v6", type: "IP-CIDR6", value: "::/0", policy: "REJECT" },
    ];
    expect(
      compileProfile(profile).warnings.some((warning) =>
        warning.includes("范围重叠"),
      ),
    ).toBe(false);
  });

  it.each([
    "https://dns.google/dns-query\n[Proxy]",
    "ftp://dns.example.com",
    "tls://dns.example.com/some/path",
    "https://user:pass@dns.example.com",
    "",
    "https://dns.google/dns-query#unknown=1",
  ])("rejects unsafe or unsupported DNS %s", (servers) => {
    const profile = createProfile();
    profile.dns.mode = "custom";
    profile.dns.servers = servers;
    expect(compileProfile(profile).errors.length).toBeGreaterThan(0);
  });

  it("validates allowlisted General and Hosts lines", () => {
    const profile = createProfile();
    profile.general =
      "# My comment\nprivate-ip-answer = true\nicmp-auto-reply = false";
    profile.hosts = "router.local = 192.168.1.1\nexample.com = 2001:db8::1";
    const { content, errors } = compileProfile(profile);
    expect(errors).toEqual([]);
    expect(content).toContain(
      "private-ip-answer = true\nicmp-auto-reply = false",
    );
    expect(content).toContain(
      "[Host]\nrouter.local = 192.168.1.1\nexample.com = 2001:db8::1",
    );
  });

  it.each([
    "[Proxy]\nx = ss,server,123",
    "dns-server = true",
    "private-ip-answer = true\nprivate-ip-answer = false",
    "unsupported-key = true",
  ])("rejects unsafe General input %s", (general) => {
    const profile = createProfile();
    profile.general = general;
    expect(compileProfile(profile).content).toBe("");
  });

  it.each([
    "[MITM]\nenable = true",
    "example.com = https://evil.example",
    "example.com = 999.1.1.1",
    "example.com = 1.1.1.1\nexample.com = 8.8.8.8",
  ])("rejects malformed Hosts %s", (hosts) => {
    const profile = createProfile();
    profile.hosts = hosts;
    expect(compileProfile(profile).content).toBe("");
  });

  it("does not mutate shared catalog defaults", () => {
    const profile = createProfile();
    profile.apps[0].domains.push("custom.example");
    expect(createProfile().apps[0].domains).not.toContain("custom.example");
    expect(APP_CATALOG[0].domains).not.toContain("custom.example");
  });
});

describe("local backups and filenames", () => {
  it("roundtrips the entire supported profile", () => {
    const profile = createProfile();
    profile.rules = [
      { id: "one", type: "DOMAIN", value: "example.com", policy: "REJECT" },
    ];
    profile.hosts = "router.local = 192.168.1.1";
    expect(parseProfile(serializeProfile(profile))).toEqual(profile);
  });

  it("rejects non-JSON, incompatible version/client, unknown fields and wrong primitives", () => {
    expect(() => parseProfile("[General]")).toThrow("JSON");
    for (const patch of [
      { version: 2 },
      { client: "clash" },
      { password: "x" },
      { bypassLan: "true" },
      { name: "x\n[Rule]" },
    ]) {
      expect(() =>
        parseProfile(JSON.stringify({ ...createProfile(), ...patch })),
      ).toThrow();
    }
  });

  it("rejects oversized and duplicate entries before import", () => {
    expect(() => parseProfile(" ".repeat(512 * 1024 + 1))).toThrow("512 KB");
    const profile = createProfile();
    profile.apps.push(profile.apps[0]);
    expect(() => parseProfile(JSON.stringify(profile))).toThrow("ID");
  });

  it("rejects hidden section injection on import and export", () => {
    const profile = createProfile();
    profile.hosts = "[Proxy]\nserver=secret";
    expect(() => parseProfile(JSON.stringify(profile))).toThrow("Hosts");
    expect(() => serializeProfile(profile)).toThrow("Hosts");
  });

  it("produces a safe extensionless filename", () => {
    expect(fileName("../hello/world.conf")).toBe("helloworld");
    expect(fileName("我的配置.conf")).toBe("我的配置");
    expect(fileName("CON")).toBe("routekit");
    expect(fileName("...")).toBe("routekit");
    expect(fileName("a".repeat(100)).length).toBe(64);
  });
});

describe("client exporter registry", () => {
  it("registers only implemented clients and derives their download format from the adapter", () => {
    expect(getConfigExporter("shadowrocket")?.extension).toBe(".conf");
    expect(getConfigExporter("clash")).toBeUndefined();
    expect(getConfigExporter("v2rayn")).toBeUndefined();
    expect(
      CLIENTS.filter((client) => client.available).map((client) => client.id),
    ).toEqual(["shadowrocket"]);
  });

  it("serializes normalized rules through the Shadowrocket adapter", () => {
    const exporter = getConfigExporter("shadowrocket")!;
    const result = exporter.serialize({
      servers: ["system"],
      ipv6: false,
      general: [],
      hosts: [],
      rules: [
        {
          type: "DOMAIN",
          value: "example.com",
          policy: "DIRECT",
          noResolve: false,
        },
        { type: "FINAL", value: "", policy: "PROXY", noResolve: false },
      ],
    });
    expect(result).toContain(
      "[Rule]\nDOMAIN,example.com,DIRECT\nFINAL,PROXY\n",
    );
  });
});
