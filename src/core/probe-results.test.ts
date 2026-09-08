import { describe, expect, it } from "vitest";
import { createSsNode } from "./subscriptions";
import {
  haversineDistanceKm,
  parseProbeJob,
  parseProbeResults,
} from "./probe-results";

const node = createSsNode({
  name: "测试节点",
  server: "proxy.example.com",
  port: 443,
  method: "aes-256-gcm",
  password: "example-password",
});
const row = () => ({
  nodeId: node.id,
  name: node.name,
  server: node.server,
  protocol: node.protocol,
  status: "ok",
  latencyMs: 182.3,
  speedMbps: 82.1,
  downloadedBytes: 5_000_000,
  exitIp: "203.0.113.8",
  country: "US",
  asn: "AS13335 Example Provider",
  latitude: 34.0522,
  longitude: -118.2437,
  ipType: "unknown",
  serverIps: ["198.51.100.2"],
  warnings: [],
});
const report = (results: unknown[] = [row()], overrides = {}) =>
  JSON.stringify({
    version: 1,
    source: "routekit-local-probe",
    generatedAt: "2026-09-08T10:00:00+00:00",
    results,
    ...overrides,
  });

describe("probe result validation", () => {
  it("accepts a matching result and keeps entry and exit addresses distinct", () => {
    const parsed = parseProbeResults(report(), [node]);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].serverIps).toEqual(["198.51.100.2"]);
    expect(parsed.results[0].exitIp).toBe("203.0.113.8");
    expect(parsed.results[0].asn).toBe("AS13335 Example Provider");
  });

  it("preserves partial measurements for failed jobs without changing their error status", () => {
    const parsed = parseProbeResults(
      report([
        {
          ...row(),
          status: "error",
          speedMbps: null,
          error: "Download timed out",
        },
      ]),
      [node],
    );
    expect(parsed.results[0].status).toBe("error");
    expect(parsed.results[0].latencyMs).toBe(182.3);
    expect(parsed.results[0].speedMbps).toBeUndefined();
  });

  it("skips unknown IDs and mismatched entry servers or protocols without adding nodes", () => {
    const cases = [
      { ...row(), nodeId: "unknown" },
      { ...row(), server: "another.example.com" },
      { ...row(), protocol: "trojan" },
    ];
    for (const value of cases) {
      const parsed = parseProbeResults(report([value]), [node]);
      expect(parsed.results).toEqual([]);
      expect(parsed.warnings).toHaveLength(1);
    }
  });

  it("rejects extra credential fields at either level", () => {
    expect(() =>
      parseProbeResults(report([{ ...row(), password: "secret" }]), [node]),
    ).toThrow("不支持的字段");
    expect(() =>
      parseProbeResults(report([], { nodes: [node] }), [node]),
    ).toThrow("不支持的字段");
  });

  it.each([
    { latencyMs: -1 },
    { latencyMs: "100" },
    { latencyMs: 120001 },
    { speedMbps: 100001 },
    { downloadedBytes: 2.5 },
    { latitude: 91 },
    { longitude: -181 },
    { longitude: null },
    { exitIp: "300.1.1.1" },
    { exitIp: "https://example.com" },
    { serverIps: ["not-an-ip"] },
    { status: "success" },
    { warnings: "wrong" },
    { asn: 4294967296 },
    { city: "bad\ncity" },
  ])("rejects invalid field value %s", (changes) => {
    expect(() =>
      parseProbeResults(report([{ ...row(), ...changes }]), [node]),
    ).toThrow();
  });

  it("accepts valid IPv6 and missing optional metrics without inventing results", () => {
    const parsed = parseProbeResults(
      report([
        {
          nodeId: node.id,
          name: node.name,
          server: node.server,
          protocol: node.protocol,
          status: "ok",
          exitIp: "2001:db8::1",
        },
      ]),
      [node],
    );
    expect(parsed.results[0].latencyMs).toBeUndefined();
    expect(parsed.results[0].speedMbps).toBeUndefined();
    expect(parsed.results[0].latitude).toBeUndefined();
  });

  it("refuses an empty successful result", () => {
    expect(() =>
      parseProbeResults(
        report([
          {
            nodeId: node.id,
            name: node.name,
            server: node.server,
            protocol: node.protocol,
            status: "ok",
          },
        ]),
        [node],
      ),
    ).toThrow("至少需要一项实测");
  });

  it("rejects duplicate IDs, oversized files, excessive rows and invalid provenance", () => {
    expect(() => parseProbeResults(report([row(), row()]), [node])).toThrow(
      "重复",
    );
    expect(() =>
      parseProbeResults(" ".repeat(2 * 1024 * 1024 + 1), [node]),
    ).toThrow("2 MB");
    expect(() =>
      parseProbeResults(report(Array(501).fill(row())), [node]),
    ).toThrow("500");
    expect(() =>
      parseProbeResults(report([], { source: "other" }), [node]),
    ).toThrow("来源");
    expect(() =>
      parseProbeResults(report([], { generatedAt: "tomorrow" }), [node]),
    ).toThrow("时间");
  });

  it("redacts any URLs embedded in errors or warnings before rendering", () => {
    const parsed = parseProbeResults(
      report([
        {
          ...row(),
          status: "error",
          error: "request socks5://user:secret@host:1080 failed",
          warnings: ["See https://host/sub?token=secret"],
        },
      ]),
      [node],
    );
    expect(parsed.results[0].error).not.toContain("secret");
    expect(parsed.results[0].warnings?.join("")).not.toContain("secret");
  });
});

describe("approximate straight-line distance", () => {
  it("returns zero for equal coordinates and about a quarter circumference for 90 degrees", () => {
    expect(
      haversineDistanceKm(
        { latitude: 0, longitude: 0 },
        { latitude: 0, longitude: 0 },
      ),
    ).toBe(0);
    expect(
      haversineDistanceKm(
        { latitude: 0, longitude: 0 },
        { latitude: 0, longitude: 90 },
      ),
    ).toBeCloseTo(10007.56, 1);
  });
  it("is symmetric across the date line and refuses invalid coordinates", () => {
    const a = { latitude: 0, longitude: 179 },
      b = { latitude: 0, longitude: -179 };
    expect(haversineDistanceKm(a, b)).toBeCloseTo(222.39, 1);
    expect(haversineDistanceKm(a, b)).toBe(haversineDistanceKm(b, a));
    expect(() =>
      haversineDistanceKm({ latitude: NaN, longitude: 0 }, b),
    ).toThrow();
  });
});

describe("explicit detection task restoration", () => {
  const job = () => ({
    version: 1,
    nodes: [node],
    options: { speedTest: false, downloadBytes: 5_000_000, timeoutSeconds: 10 },
  });
  it("restores original IDs from validated links so returning results still match after a refresh", () => {
    const restored = parseProbeJob(JSON.stringify(job()));
    expect(restored.nodes[0].id).toBe(node.id);
    expect(restored.nodes[0].uri).toBe(node.uri);
    expect(parseProbeResults(report(), restored.nodes).results).toHaveLength(1);
  });
  it("rejects metadata/link disagreement, duplicate IDs, unknown fields and invalid limits", () => {
    for (const patch of [
      { protocol: "trojan" },
      { port: 8443 },
      { server: "wrong.example.com" },
      { name: "wrong" },
      { password: "extra" },
    ]) {
      expect(() =>
        parseProbeJob(
          JSON.stringify({ ...job(), nodes: [{ ...node, ...patch }] }),
        ),
      ).toThrow();
    }
    expect(() =>
      parseProbeJob(JSON.stringify({ ...job(), nodes: [node, node] })),
    ).toThrow();
    expect(() =>
      parseProbeJob(
        JSON.stringify({
          ...job(),
          options: { speedTest: true, downloadBytes: -1, timeoutSeconds: 10 },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProbeJob(
        JSON.stringify({
          ...job(),
          options: { speedTest: true, timeoutSeconds: 10 },
        }),
      ),
    ).toThrow();
  });
});
