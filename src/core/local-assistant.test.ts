import { describe, expect, it } from "vitest";
import { associateAssistantResults, parseAssistantCapabilities, parseAssistantJob, type AssistantJob } from "./local-assistant";
import { parseSubscription } from "./subscriptions";

const node = parseSubscription("ss://YWVzLTI1Ni1nY206cGFzcw@node.example.com:443#fixture").nodes[0];
const job = (): AssistantJob => ({ id: "job-1", status: "completed", createdAt: "2026-09-09T10:00:00Z", updatedAt: "2026-09-09T10:00:01Z", total: 1, completed: 1, phase: "finished", report: { version: 1, source: "routekit-local-probe", generatedAt: "2026-09-09T10:00:01Z", results: [{ nodeId: node.id, name: node.name, server: node.server, protocol: node.protocol, status: "ok", latencyMs: 42, exitIp: "203.0.113.10" }] } });

describe("local assistant reports", () => {
  it("accepts actual progress and rejects mismatched completion totals", () => {
    expect(parseAssistantJob(job()).report.results[0].latencyMs).toBe(42);
    expect(() => parseAssistantJob({ ...job(), completed: 0 })).toThrow("完成数量");
    expect(() => parseAssistantJob({ ...job(), total: 101 })).toThrow();
    expect(() => parseAssistantJob({ ...job(), id: "../other" })).toThrow();
  });
  it("checks result metrics before exposing them", () => {
    const value = job(); value.report.results[0].latencyMs = -2;
    expect(() => parseAssistantJob(value)).toThrow("延迟");
  });
  it("accepts restored node IDs independently from URL-safe assistant job IDs", () => {
    for (const currentNodeId of ["node_1", "node.1", "node:1"]) expect(parseAssistantJob({ ...job(), currentNodeId }).currentNodeId).toBe(currentNodeId);
    expect(() => parseAssistantJob({ ...job(), currentNodeId: "node/1" })).toThrow();
  });
  it("only associates a result with the same original credentials and node ID", () => {
    expect(associateAssistantResults(job().report, [node], [node]).results).toHaveLength(1);
    const changed = { ...node, uri: node.uri.replace("YWVzLTI1Ni1nY206cGFzcw", "YWVzLTI1Ni1nY206bmV3") };
    expect(associateAssistantResults(job().report, [node], [changed])).toMatchObject({ results: [], skipped: 1 });
    expect(associateAssistantResults(job().report, [node], [])).toMatchObject({ results: [], skipped: 1 });
  });
  it("retains a renamed node while never attaching an unknown previous session", () => {
    const renamed = { ...node, name: "renamed", uri: node.uri.split("#")[0] + "#renamed" };
    expect(associateAssistantResults(job().report, [node], [renamed]).results).toHaveLength(1);
    expect(associateAssistantResults(job().report, [], [node]).results).toHaveLength(0);
  });
  it("validates helper capabilities and a retained terminal job", () => {
    const caps = { version: 1, source: "routekit-local-helper", monitor: true, probe: { available: true, maxNodes: 100, maxBodyBytes: 2097152, maxDownloadBytes: 5000000 }, currentJob: job() };
    expect(parseAssistantCapabilities(caps).currentJob?.status).toBe("completed");
    expect(() => parseAssistantCapabilities({ ...caps, probe: { ...caps.probe, maxNodes: 0 } })).toThrow();
    expect(() => parseAssistantCapabilities({ ...caps, version: 2 })).toThrow();
  });
});
