import { afterEach, describe, expect, it, vi } from "vitest";
import { compareWebsiteResults, comparisonDelta, runWebsiteChecks, summaryWebsiteResult, WEBSITE_TARGETS, type WebsiteResult, type WebsiteSample } from "./website-checks";

it("reads HTTP status only for a fixed public CORS endpoint", async () => {
  const discord = WEBSITE_TARGETS.find(target => target.id === "discord")!;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 429 }));
  const [result] = await runWebsiteChecks([discord], { fetcher });
  expect(fetcher.mock.calls[0][1]).toMatchObject({ mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
  expect(result.samples.every(sample => sample.outcome === "http-error" && sample.httpStatus === 429)).toBe(true);
  expect(summaryWebsiteResult(result).medianMs).toBeUndefined();
});

const opaque = () => ({ type: "opaque", status: 0, ok: false, body: null }) as Response;
const readable = (status: number) => ({ type: "cors", status, ok: status >= 200 && status < 300, body: null }) as Response;
const fetchStub = (implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => vi.fn(implementation) as unknown as typeof fetch;
const done = (timings: number[], id = "google"): WebsiteResult => ({ id, state: "done", samples: timings.map((ms) => ({ outcome: "response", visibility: "opaque", ms })) });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("fixed website resource probes", () => {
  it("uses fixed public HTTPS targets and distinct uncached credential-free requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(opaque());
    const tampered = { ...WEBSITE_TARGETS[0], probeUrl: "http://127.0.0.1/private" };
    const results = await runWebsiteChecks([tampered, tampered], { fetcher });
    expect(WEBSITE_TARGETS).toHaveLength(12);
    expect(new Set(WEBSITE_TARGETS.map(({ id }) => id)).size).toBe(12);
    expect(WEBSITE_TARGETS.every(({ probeUrl }) => new URL(probeUrl).protocol === "https:")).toBe(true);
    expect(results).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const urls = fetcher.mock.calls.map(([input]) => new URL(input));
    expect(new Set(urls.map(({ href }) => href)).size).toBe(3);
    expect(urls.every((url) => url.origin === new URL(WEBSITE_TARGETS[0].probeUrl).origin && url.searchParams.has("routekit_probe"))).toBe(true);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: expect.any(AbortSignal) });
    await expect(runWebsiteChecks([{ ...tampered, id: "custom" }], { fetcher })).rejects.toThrow("目录内");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("treats opaque status zero as a response without inventing an HTTP status or access verdict", async () => {
    const results = await runWebsiteChecks(WEBSITE_TARGETS.slice(0, 1), { fetcher: vi.fn().mockResolvedValue(opaque()) });
    expect(results[0].state).toBe("done");
    expect(results[0].samples).toHaveLength(3);
    expect(results[0].samples.every((sample) => sample.outcome === "response" && sample.visibility === "opaque" && sample.httpStatus === undefined)).toBe(true);
    expect(summaryWebsiteResult(results[0])).toMatchObject({ responded: 3, attempted: 3, status: "responded", label: "收到响应", medianMs: expect.any(Number) });
  });

  it("preserves readable errors separately from response timing and does not rank partial results", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(readable(403)).mockResolvedValueOnce(readable(204)).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const [result] = await runWebsiteChecks(WEBSITE_TARGETS.slice(0, 1), { fetcher });
    expect(result.samples).toEqual([
      { outcome: "http-error", visibility: "readable", httpStatus: 403, ms: expect.any(Number) },
      { outcome: "response", visibility: "readable", httpStatus: 204, ms: expect.any(Number) },
      { outcome: "failed" },
    ]);
    expect(summaryWebsiteResult(result)).toEqual({ responded: 1, attempted: 3, status: "partial", label: "部分响应" });
  });

  it("does not invent HTTP zero when a fetch implementation returns a synthetic error response", async () => {
    const [result] = await runWebsiteChecks(WEBSITE_TARGETS.slice(0, 1), { fetcher: vi.fn().mockResolvedValue(Response.error()) });
    expect(result.samples).toEqual([{ outcome: "failed" }, { outcome: "failed" }, { outcome: "failed" }]);
  });

  it("stops opaque response transfers after arrival while retaining responses and continuing the queue", async () => {
    const controller = new AbortController();
    const requestSignals: AbortSignal[] = [];
    const fetcher = fetchStub(async (_input, init) => {
      requestSignals.push(init?.signal as AbortSignal);
      return opaque();
    });
    const [result] = await runWebsiteChecks(WEBSITE_TARGETS.slice(0, 1), { fetcher, signal: controller.signal });
    expect(requestSignals).toHaveLength(3);
    expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(result.state).toBe("done");
    expect(result.samples.every((sample) => sample.outcome === "response")).toBe(true);
    expect(summaryWebsiteResult(result).status).toBe("responded");
  });

  it("times out one sample, aborts its request and continues both its remaining samples and the queue", async () => {
    vi.useFakeTimers();
    let timeoutSignal: AbortSignal | undefined;
    let requests = 0;
    const fetcher = fetchStub(async (_input, init) => {
      requests++;
      if (requests === 1) {
        timeoutSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined); // Even a fetch that ignores abort must settle the probe.
      }
      return opaque();
    });
    const pending = runWebsiteChecks(WEBSITE_TARGETS.slice(0, 5), { fetcher, timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    const results = await pending;
    expect(timeoutSignal?.aborted).toBe(true);
    expect(requests).toBe(15);
    expect(results[0].samples.map(({ outcome }) => outcome)).toEqual(["timeout", "response", "response"]);
    expect(results.every(({ state }) => state === "done")).toBe(true);
    expect(results.slice(1).every((result) => summaryWebsiteResult(result).responded === 3)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs no more than four requests concurrently across the full catalog", async () => {
    vi.useFakeTimers();
    let active = 0, peak = 0;
    const fetcher = fetchStub(() => new Promise((resolve) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => { active--; resolve(opaque()); }, 10);
    }));
    const pending = runWebsiteChecks(WEBSITE_TARGETS, { fetcher });
    await vi.runAllTimersAsync();
    const results = await pending;
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(36);
    expect(results.every((result) => summaryWebsiteResult(result).responded === 3)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops all active requests and starts no queued request after cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const fetcher = fetchStub((_input, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    });
    const pending = runWebsiteChecks(WEBSITE_TARGETS, { fetcher, signal: controller.signal });
    expect(fetcher).toHaveBeenCalledTimes(4);
    controller.abort();
    const results = await pending;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(results.every(({ state }) => state === "stopped")).toBe(true);
    expect(results.slice(0, 4).every(({ samples }) => samples.length === 1 && samples[0].outcome === "stopped")).toBe(true);
    expect(results.slice(4).every(({ samples }) => samples.length === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not fetch when already stopped and retains an honest unattempted count", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    const [result] = await runWebsiteChecks(WEBSITE_TARGETS.slice(0, 1), { fetcher, signal: controller.signal });
    expect(fetcher).not.toHaveBeenCalled();
    expect(summaryWebsiteResult(result)).toEqual({ responded: 0, attempted: 0, status: "stopped", label: "已停止" });
  });

  it("publishes independent snapshots after each sample and rejects mutations back into its state", async () => {
    const updates: WebsiteResult[] = [];
    const [result] = await runWebsiteChecks(WEBSITE_TARGETS.slice(0, 1), {
      fetcher: vi.fn().mockResolvedValue(opaque()),
      onUpdate: (update) => { updates.push(update); },
    });
    expect(updates.map(({ samples }) => samples.length)).toEqual([0, 0, 1, 2, 3]);
    expect(updates.map(({ state }) => state)).toEqual(["queued", "running", "running", "running", "done"]);
    updates[2].samples[0].outcome = "failed";
    updates[3].samples.push({ outcome: "failed" });
    expect(updates[4].samples).toHaveLength(3);
    expect(updates[4].samples[0].outcome).toBe("response");
    expect(result.samples).toHaveLength(3);
    expect(result.samples[0].outcome).toBe("response");
    expect(result.checkedAt).toEqual(expect.any(String));
  });
});

describe("website result summaries and comparisons", () => {
  it("keeps results absent before the first run idle and incomparable", () => {
    expect(summaryWebsiteResult(undefined)).toEqual({ responded: 0, attempted: 0, status: "idle", label: "待检测" });
    expect(comparisonDelta(undefined, done([100, 200, 300]))).toBeUndefined();
    expect(comparisonDelta(done([100, 200, 300]), undefined)).toBeUndefined();
    expect(comparisonDelta(undefined, undefined)).toBeUndefined();
  });

  it("uses the median of exactly three responses and keeps missing or invalid timings unknown", () => {
    expect(summaryWebsiteResult(done([100, 500, 80])).medianMs).toBe(100);
    for (const timings of [[100], [100, 200], [100, 200, 300, 400], [100, NaN, 200], [100, -1, 200], [100, Infinity, 200]]) {
      expect(summaryWebsiteResult(done(timings)).medianMs).toBeUndefined();
    }
    const missing = done([100, 200, 300]);
    delete missing.samples[1].ms;
    expect(summaryWebsiteResult(missing).medianMs).toBeUndefined();
    expect(summaryWebsiteResult({ ...done([100, 200, 300]), state: "running" }).medianMs).toBeUndefined();
    expect(summaryWebsiteResult({ ...done([100, 200, 300]), state: "stopped" }).medianMs).toBeUndefined();
  });

  it("does not turn stopped samples into failed attempts", () => {
    const samples: WebsiteSample[] = [{ outcome: "response", ms: 100 }, { outcome: "stopped" }];
    expect(summaryWebsiteResult({ id: "google", samples, state: "stopped" })).toEqual({ responded: 1, attempted: 1, status: "stopped", label: "已停止" });
    expect(summaryWebsiteResult({ id: "google", samples: [], state: "queued" }).status).toBe("idle");
    expect(summaryWebsiteResult({ id: "google", samples: [{ outcome: "failed" }, { outcome: "timeout" }, { outcome: "http-error", httpStatus: 403 }], state: "done" }).status).toBe("failed");
  });

  it("ranks complete measurements before unknowns without assigning unknowns a zero latency", () => {
    const incomplete = done([1]), slow = done([50, 60, 70]), fast = done([0, 0, 0]), failed: WebsiteResult = { id: "claude", samples: [{ outcome: "failed" }], state: "done" };
    expect([incomplete, slow, failed, fast].sort(compareWebsiteResults)).toEqual([fast, slow, incomplete, failed]);
    expect(compareWebsiteResults(incomplete, failed)).toBe(0);
    expect(comparisonDelta(done([90, 100, 110]), done([40, 50, 60]))).toBe(50);
    expect(comparisonDelta(done([1, 2, 3]), incomplete)).toBeUndefined();
    expect(comparisonDelta(incomplete, done([1, 2, 3]))).toBeUndefined();
    expect(comparisonDelta(done([1, 2, 3], "google"), done([4, 5, 6], "claude"))).toBeUndefined();
  });
});
