import { describe, expect, it } from "vitest";
import { dnsQueryUrl, networkFailure, parseDnsResponse, prepareDnsQuery } from "./network-checks";

describe("public DNS queries", () => {
  it("queries a fixed resolver and normalizes internationalized hostnames", () => {
    const query = prepareDnsQuery(" 例子.中国. ", "AAAA");
    expect(query).toEqual({ display: "xn--fsqu00a.xn--fiqs8s", name: "xn--fsqu00a.xn--fiqs8s", type: "AAAA" });
    const url = new URL(dnsQueryUrl(query));
    expect(url.origin).toBe("https://cloudflare-dns.com");
    expect(url.searchParams.get("name")).toBe(query.name);
    expect(url.searchParams.get("type")).toBe("AAAA");
  });
  it("constructs IPv4 and expanded IPv6 reverse queries", () => {
    expect(prepareDnsQuery("1.1.1.1", "A")).toEqual({ display: "1.1.1.1", name: "1.1.1.1.in-addr.arpa", type: "PTR" });
    const reverse = prepareDnsQuery("2606:4700:4700::1111", "A");
    expect(reverse.type).toBe("PTR");
    expect(reverse.name).toBe("1.1.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.7.4.0.0.7.4.6.0.6.2.ip6.arpa");
  });
  it.each(["", "localhost", "router.local", "my.home.arpa", "192.168.1.1", "127.0.0.1", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "1.2.3.999", "01.2.3.4", "https://example.com/secret", "ss://secret@example.com", "example.com:443", "example.com/path", "x@y.com", "a\u202e.com"])("rejects private, malformed or sensitive input %s before a request", (value) => {
    expect(() => prepareDnsQuery(value, "A")).toThrow();
  });
  it("retains real TTL, type and DNSSEC metadata while distinguishing no answer from failure", () => {
    expect(parseDnsResponse({ Status: 0, AD: true, Answer: [{ name: "example.com.", type: 1, TTL: 180, data: "93.184.215.14" }] })).toEqual({ status: 0, message: "查到 1 条记录", authenticated: true, answers: [{ name: "example.com.", type: "A", ttl: 180, data: "93.184.215.14" }] });
    expect(parseDnsResponse({ Status: 0 }).message).toContain("没有这一类型");
    expect(parseDnsResponse({ Status: 3 }).message).toContain("NXDOMAIN");
    expect(parseDnsResponse({ Status: 2 }).message).toContain("SERVFAIL");
    expect(parseDnsResponse({ Status: 2, Answer: [{ name: "example.com.", type: 1, TTL: 180, data: "93.184.215.14" }] }).answers).toEqual([]);
  });
  it.each([null, {}, { Status: "0" }, { Status: 0, Answer: "wrong" }, { Status: 0, Answer: [{ name: "example.com", type: 1, TTL: -1, data: "1.1.1.1" }] }])("rejects malformed resolver responses", (value) => {
    expect(() => parseDnsResponse(value)).toThrow();
  });
});

describe("actionable network errors", () => {
  it("identifies the failed target without claiming to know a hidden browser network cause", () => {
    expect(networkFailure("latency", new TypeError("Failed to fetch"))).toContain("speed.cloudflare.com");
    expect(networkFailure("dns", new TypeError("Failed to fetch"))).toContain("cloudflare-dns.com");
    expect(networkFailure("dns", new TypeError("Failed to fetch"))).not.toContain("Failed to fetch");
    expect(networkFailure("speed", new DOMException("deadline", "TimeoutError"))).toContain("超时");
    expect(networkFailure("speed", new DOMException("stop", "AbortError"))).toContain("已停止");
  });
});
