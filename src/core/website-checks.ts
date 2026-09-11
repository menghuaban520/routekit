export const WEBSITE_CATEGORIES = ["搜索资讯", "AI 助手", "开发协作", "影音社交", "国内常用"] as const;
export type WebsiteCategory = (typeof WEBSITE_CATEGORIES)[number];
export type WebsiteTarget = { id: string; name: string; category: WebsiteCategory; homepage: string; probeUrl: string; requestMode?: "cors"; statusUrl?: string };

/** Fixed public HTTPS resources; neither credentials nor custom URLs enter this test. */
export const WEBSITE_TARGETS: readonly WebsiteTarget[] = [
  { id: "google", name: "Google", category: "搜索资讯", homepage: "https://www.google.com/", probeUrl: "https://www.google.com/favicon.ico" },
  { id: "wikipedia", name: "Wikipedia", category: "搜索资讯", homepage: "https://www.wikipedia.org/", probeUrl: "https://www.wikipedia.org/static/favicon/wikipedia.ico" },
  { id: "chatgpt", name: "ChatGPT", category: "AI 助手", homepage: "https://chatgpt.com/", probeUrl: "https://chatgpt.com/favicon.ico", statusUrl: "https://status.openai.com/" },
  { id: "claude", name: "Claude", category: "AI 助手", homepage: "https://claude.ai/", probeUrl: "https://claude.ai/favicon.ico", statusUrl: "https://status.claude.com/" },
  { id: "github", name: "GitHub", category: "开发协作", homepage: "https://github.com/", probeUrl: "https://github.com/favicon.ico", statusUrl: "https://www.githubstatus.com/" },
  { id: "telegram", name: "Telegram", category: "影音社交", homepage: "https://telegram.org/", probeUrl: "https://telegram.org/favicon.ico" },
  { id: "discord", name: "Discord", category: "影音社交", homepage: "https://discord.com/", probeUrl: "https://discord.com/api/v10/gateway", requestMode: "cors", statusUrl: "https://discordstatus.com/" },
  { id: "youtube", name: "YouTube", category: "影音社交", homepage: "https://www.youtube.com/", probeUrl: "https://www.youtube.com/favicon.ico" },
  { id: "netflix", name: "Netflix", category: "影音社交", homepage: "https://www.netflix.com/", probeUrl: "https://www.netflix.com/favicon.ico", statusUrl: "https://help.netflix.com/en/is-netflix-down" },
  { id: "baidu", name: "百度", category: "国内常用", homepage: "https://www.baidu.com/", probeUrl: "https://www.baidu.com/favicon.ico" },
  { id: "bilibili", name: "哔哩哔哩", category: "国内常用", homepage: "https://www.bilibili.com/", probeUrl: "https://www.bilibili.com/favicon.ico" },
  { id: "qq", name: "腾讯", category: "国内常用", homepage: "https://www.qq.com/", probeUrl: "https://www.qq.com/favicon.ico" },
];

export const WEBSITE_SAMPLE_COUNT = 3;
const CONCURRENCY = 4;
export type WebsiteSample = { outcome: "response" | "http-error" | "timeout" | "failed" | "stopped"; ms?: number; httpStatus?: number; visibility?: "opaque" | "readable" };
export type WebsiteResult = { id: string; samples: WebsiteSample[]; state: "queued" | "running" | "done" | "stopped"; checkedAt?: string };
export type WebsiteSummary = { responded: number; attempted: number; medianMs?: number; status: "idle" | "running" | "responded" | "partial" | "failed" | "stopped"; label: string };
type WebsiteCheckOptions = { signal?: AbortSignal; onUpdate?: (result: WebsiteResult) => void; fetcher?: typeof fetch; timeoutMs?: number };

let requestSequence = 0;
const snapshot = (result: WebsiteResult): WebsiteResult => ({ ...result, samples: result.samples.map((sample) => ({ ...sample })) });

function probeWebsite(target: WebsiteTarget, options: WebsiteCheckOptions): Promise<WebsiteSample> {
  if (options.signal?.aborted) return Promise.resolve({ outcome: "stopped" });
  const controller = new AbortController();
  const started = performance.now();
  const url = new URL(target.probeUrl);
  url.searchParams.set("routekit_probe", `${Date.now()}-${++requestSequence}`);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0 ? options.timeoutMs! : 8_000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (sample: WebsiteSample) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve(sample);
    };
    const stop = () => {
      finish({ outcome: "stopped" });
      controller.abort();
    };
    const timer = setTimeout(() => {
      finish({ outcome: "timeout" });
      controller.abort();
    }, timeoutMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    // Settling here also handles fetch implementations that ignore AbortSignal.
    try {
      void fetcher(url.href, {
        method: "GET", mode: target.requestMode ?? "no-cors", credentials: "omit", referrerPolicy: "no-referrer",
        cache: "no-store", signal: controller.signal,
      }).then((response) => {
        try {
          const ms = Math.max(0, Math.round(performance.now() - started));
          if (response.type === "opaque") {
            finish({ outcome: "response", ms, visibility: "opaque" });
          } else if (response.status === 0) {
            finish({ outcome: "failed" });
          } else if (response.status >= 200 && response.status < 300) {
            finish({ outcome: "response", ms, visibility: "readable", httpStatus: response.status });
          } else {
            finish({ outcome: "http-error", ms, visibility: "readable", httpStatus: response.status });
          }
          void response.body?.cancel().catch(() => undefined);
        } finally {
          // Stop the underlying transfer even when an opaque response hides its body.
          // This controller belongs only to this sample; the queue's signal stays intact.
          controller.abort();
        }
      }, () => finish({ outcome: options.signal?.aborted ? "stopped" : "failed" }));
    } catch {
      finish({ outcome: options.signal?.aborted ? "stopped" : "failed" });
    }
  });
}

/** A response to a public resource is not proof of HTTP success, sign-in or regional access. */
export async function runWebsiteChecks(targets: readonly WebsiteTarget[], options: WebsiteCheckOptions = {}): Promise<WebsiteResult[]> {
  const selected = Array.from(new Set(targets.map((target) => target.id))).map((id) => {
    const target = WEBSITE_TARGETS.find((candidate) => candidate.id === id);
    if (!target) throw new Error("只能检测目录内的网站。");
    return target;
  });
  const results: WebsiteResult[] = selected.map(({ id }) => ({ id, samples: [], state: "queued" }));
  const publish = (result: WebsiteResult) => options.onUpdate?.(snapshot(result));
  results.forEach(publish);
  let cursor = 0;
  async function worker() {
    while (cursor < selected.length && !options.signal?.aborted) {
      const index = cursor++;
      const result = results[index];
      result.state = "running";
      publish(result);
      for (let attempt = 0; attempt < WEBSITE_SAMPLE_COUNT; attempt++) {
        if (options.signal?.aborted) break;
        result.samples.push(await probeWebsite(selected[index], options));
        if (options.signal?.aborted || result.samples.at(-1)?.outcome === "stopped") result.state = "stopped";
        else if (attempt === WEBSITE_SAMPLE_COUNT - 1) result.state = "done";
        result.checkedAt = new Date().toISOString();
        publish(result);
        if (result.state === "stopped") break;
      }
      if (result.state === "running") {
        result.state = "stopped";
        publish(result);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () => worker()));
  for (const result of results) {
    if (result.state === "queued") {
      result.state = "stopped";
      publish(result);
    }
  }
  return results.map(snapshot);
}

export function summaryWebsiteResult(result?: WebsiteResult): WebsiteSummary {
  if (!result) return { responded: 0, attempted: 0, status: "idle", label: "待检测" };
  const responses = result.samples.filter((sample) => sample.outcome === "response");
  const responded = responses.length;
  const attempted = result.samples.filter((sample) => sample.outcome !== "stopped").length;
  let status: WebsiteSummary["status"];
  if (result.state === "queued") status = "idle";
  else if (result.state === "running") status = "running";
  else if (result.state === "stopped") status = "stopped";
  else if (responded === WEBSITE_SAMPLE_COUNT && result.samples.length === WEBSITE_SAMPLE_COUNT) status = "responded";
  else status = responded ? "partial" : "failed";
  const timings = responses.map((sample) => sample.ms).filter((ms): ms is number => ms !== undefined && Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
  const labels: Record<WebsiteSummary["status"], string> = { idle: "待检测", running: "检测中", responded: "收到响应", partial: "部分响应", failed: "未取得响应", stopped: "已停止" };
  return { responded, attempted, status, label: labels[status], ...(status === "responded" && timings.length === WEBSITE_SAMPLE_COUNT ? { medianMs: timings[1] } : {}) };
}

/** Complete samples rank first; unknown or partial results remain unranked. */
export function compareWebsiteResults(a: WebsiteResult, b: WebsiteResult): number {
  const left = summaryWebsiteResult(a).medianMs, right = summaryWebsiteResult(b).medianMs;
  if (left === undefined) return right === undefined ? 0 : 1;
  return right === undefined ? -1 : left - right;
}

/** Positive means this run took longer; only compare complete samples of the same site. */
export function comparisonDelta(current?: WebsiteResult, baseline?: WebsiteResult): number | undefined {
  if (!current || !baseline || current.id !== baseline.id) return undefined;
  const now = summaryWebsiteResult(current).medianMs, before = summaryWebsiteResult(baseline).medianMs;
  return now === undefined || before === undefined ? undefined : now - before;
}
