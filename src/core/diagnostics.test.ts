import { describe, expect, it, vi } from "vitest";
import { createProfile, type Profile } from "./index";
import { diagnoseBatch, diagnosticsToCsv } from "./diagnostics";

function minimal(): Profile {
  return { ...createProfile(), apps: [], bypassLan: false };
}
function one(text: string, profile = createProfile()) {
  const report = diagnoseBatch(profile, text);
  expect(report.errors).toEqual([]);
  expect(report.results).toHaveLength(1);
  return report.results[0];
}

describe("batch routing diagnostics", () => {
  it("uses exported order: LAN before overrides and overrides before application rules", () => {
    const profile = createProfile();
    profile.rules = [
      {
        id: "custom-network",
        type: "IP-CIDR",
        value: "192.168.1.0/24",
        policy: "PROXY",
      },
      {
        id: "custom-domain",
        type: "DOMAIN",
        value: "www.kugou.com",
        policy: "REJECT",
      },
    ];
    expect(one("www.kugou.com,192.168.1.3,CN", profile).matchRule).toBe(
      "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
    );
    expect(one("www.kugou.com,203.0.113.3,CN", profile).matchRule).toBe(
      "DOMAIN,www.kugou.com,REJECT",
    );
    expect(one("cdn.kugou.com", profile).matchRule).toBe(
      "DOMAIN-SUFFIX,kugou.com,DIRECT",
    );
  });

  it("honors the compiler's duplicate elimination instead of matching raw profile entries", () => {
    const profile = minimal();
    profile.rules = [
      { id: "first", type: "DOMAIN", value: "example.com", policy: "DIRECT" },
      { id: "second", type: "DOMAIN", value: "example.com", policy: "REJECT" },
    ];
    const report = diagnoseBatch(profile, "example.com");
    expect(report.ruleCount).toBe(3);
    expect(report.results[0].policy).toBe("DIRECT");
  });

  it("normalizes case, trailing dots and IDNs while preserving suffix boundaries", () => {
    const profile = minimal();
    profile.rules = [
      { id: "idn", type: "DOMAIN", value: "例子.测试", policy: "REJECT" },
      {
        id: "suffix",
        type: "DOMAIN-SUFFIX",
        value: "Example.com",
        policy: "DIRECT",
      },
    ];
    expect(one("例子.测试", profile).policy).toBe("REJECT");
    expect(one("SUB.EXAMPLE.COM.", profile).policy).toBe("DIRECT");
    expect(one("notexample.com,8.8.8.8,US", profile).matchRule).toBe(
      "FINAL,PROXY",
    );
  });

  it("matches DOMAIN exactly and DOMAIN-KEYWORD as a substring only for domain targets", () => {
    const profile = minimal();
    profile.rules = [
      { id: "exact", type: "DOMAIN", value: "example.com", policy: "DIRECT" },
      {
        id: "keyword",
        type: "DOMAIN-KEYWORD",
        value: "example",
        policy: "REJECT",
      },
    ];
    expect(one("example.com", profile).policy).toBe("DIRECT");
    expect(one("sub.example.com", profile).policy).toBe("REJECT");
    expect(one("8.8.8.8,US", profile).matchRule).toBe("FINAL,PROXY");
  });

  it("masks IPv4 host bits and checks range boundaries", () => {
    const profile = minimal();
    profile.rules = [
      {
        id: "range",
        type: "IP-CIDR",
        value: "203.0.113.17/24",
        policy: "REJECT",
      },
    ];
    expect(one("203.0.113.0", profile).policy).toBe("REJECT");
    expect(one("203.0.113.255", profile).policy).toBe("REJECT");
    expect(one("203.0.112.255,US", profile).policy).toBe("PROXY");
  });

  it("matches compressed IPv6, IPv4-mapped IPv6 and exact /128 ranges", () => {
    const profile = minimal();
    profile.rules = [
      {
        id: "v6",
        type: "IP-CIDR6",
        value: "2001:db8::abcd/128",
        policy: "DIRECT",
      },
      {
        id: "mapped",
        type: "IP-CIDR6",
        value: "::ffff:192.0.2.0/120",
        policy: "REJECT",
      },
    ];
    expect(one("2001:0db8:0:0:0:0:0:abcd", profile).policy).toBe("DIRECT");
    expect(one("2001:db8::abce,US", profile).policy).toBe("PROXY");
    expect(one("::ffff:192.0.2.17", profile).policy).toBe("REJECT");
  });

  it("matches /0 per IP family without treating IPv4 as IPv6", () => {
    const profile = minimal();
    profile.rules = [
      { id: "v6", type: "IP-CIDR6", value: "::/0", policy: "REJECT" },
      { id: "v4", type: "IP-CIDR", value: "0.0.0.0/0", policy: "DIRECT" },
    ];
    expect(one("2001:db8::8", profile).policy).toBe("REJECT");
    expect(one("203.0.113.8", profile).policy).toBe("DIRECT");
  });

  it("skips no-resolve IP rules when only a domain is supplied", () => {
    const profile = minimal();
    profile.rules = [
      { id: "range", type: "IP-CIDR", value: "0.0.0.0/0", policy: "REJECT" },
      { id: "domain", type: "DOMAIN", value: "example.com", policy: "DIRECT" },
    ];
    const unresolved = one("example.com", profile);
    expect(unresolved.policy).toBe("DIRECT");
    expect(
      unresolved.warnings.some((warning) => warning.includes("no-resolve")),
    ).toBe(true);
    expect(one("example.com,203.0.113.9", profile).policy).toBe("REJECT");
  });

  it("does not invent a resolved IP or a GeoIP country", () => {
    const domain = one("unlisted.example");
    expect(domain.status).toBe("needs-ip");
    expect(domain.policy).toBe("unknown");
    expect(domain.matchRule).toBeNull();
    expect(domain.candidateRule).toBe("FINAL,PROXY");
    const address = one("8.8.8.8");
    expect(address.status).toBe("needs-country");
    expect(address.policy).toBe("unknown");
    expect(address.countryHint).toBeUndefined();
  });

  it("uses manually supplied country hints without claiming a GeoIP lookup", () => {
    const cn = one("203.0.113.8,cn");
    expect(cn.matchRule).toBe("GEOIP,CN,DIRECT");
    expect(cn.reason).toContain("手动地区提示 CN");
    expect(cn.warnings.join()).toContain("不是定位");
    expect(one("203.0.113.8,US").matchRule).toBe("FINAL,PROXY");
    expect(one("unlisted.example,203.0.113.8,CN").matchRule).toBe(
      "GEOIP,CN,DIRECT",
    );
  });

  it("can establish a policy but not a rule when GeoIP and FINAL agree", () => {
    const profile = minimal();
    profile.domesticPolicy = "PROXY";
    for (const input of ["unlisted.example", "203.0.113.8"]) {
      const result = one(input, profile);
      expect(result.status).toBe("policy-only");
      expect(result.policy).toBe("PROXY");
      expect(result.matchRule).toBeNull();
      expect(result.reason).toContain("具体命中规则未确定");
    }
  });

  it("does not treat a supplied country or a profile Host mapping as a resolved domain IP", () => {
    const profile = minimal();
    profile.hosts = "example.com = 192.168.1.2";
    expect(one("example.com", profile).status).toBe("needs-ip");
    expect(one("example.com,CN", profile).status).toBe("invalid");
    expect(one("example.com,,CN", profile).status).toBe("invalid");
  });

  it.each([
    "999.1.1.1",
    "192.168.01.1",
    "1.2.3",
    "2001:::1",
    "::ffff:999.1.1.1",
    "8.8.8.8:53",
    "https://example.com",
    "example.com/path",
    "8.8.8.8/24",
    "example.com\u202e",
    "\texample.com",
    "example.com\u0000",
    "8.8.8.8,China",
    "8.8.8.8,ZZ",
  ])("reports invalid target with a line number: %s", (input) => {
    const result = one(input);
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("第 1 行");
  });

  it("retains blank and invalid line numbers and warns about normalized duplicates", () => {
    const report = diagnoseBatch(
      createProfile(),
      "WWW.KUGOU.COM.\n\nwww.kugou.com\n999.1.1.1\n8.8.8.8,US\n8.8.8.8,CN",
    );
    expect(report.results.map((result) => result.line)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(report.results[1].status).toBe("invalid");
    expect(report.results[2].duplicateOf).toBe(1);
    expect(report.results[5].duplicateOf).toBeUndefined();
  });

  it("accepts CRLF line separators without hiding control characters inside lines", () => {
    expect(
      diagnoseBatch(
        createProfile(),
        "www.kugou.com\r\n8.8.8.8,US",
      ).results.every((result) => result.status === "matched"),
    ).toBe(true);
    expect(one("example.com\r,8.8.8.8,US").status).toBe("invalid");
  });

  it("rejects a batch over 200 lines and does not silently truncate it", () => {
    expect(
      diagnoseBatch(createProfile(), Array(201).fill("8.8.8.8,US").join("\n")),
    ).toMatchObject({ results: [], errors: [expect.stringContaining("201")] });
    expect(
      diagnoseBatch(createProfile(), Array(200).fill("8.8.8.8,US").join("\n"))
        .results,
    ).toHaveLength(200);
    expect(one("").status).toBe("invalid");
  });

  it("does not evaluate a profile that the actual compiler rejects", () => {
    const profile = createProfile();
    profile.general = "[Proxy]\nx = invalid";
    const result = diagnoseBatch(profile, "www.kugou.com");
    expect(result.results).toEqual([]);
    expect(result.errors[0]).toContain("请先修正配置");
  });

  it("does not make network requests", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      diagnoseBatch(createProfile(), "unknown.example\n8.8.8.8\n8.8.8.8,US");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("quotes CSV cells and neutralizes spreadsheet formulas, including leading whitespace", () => {
    const report = diagnoseBatch(
      createProfile(),
      '=HYPERLINK("https://example.com","x")\n\t+1+1\n@SUM(1)',
    );
    const csv = diagnosticsToCsv(report.results);
    expect(csv).toContain('"\'=HYPERLINK(""https://example.com"",""x"")"');
    expect(csv).toContain('"\'\t+1+1"');
    expect(csv).toContain('"\'@SUM(1)"');
    expect(csv).toContain("\r\n");
    expect(csv).toContain("输入有误");
  });
});
