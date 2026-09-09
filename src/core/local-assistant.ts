import { parseProbeResults, type ProbeJob, type ProbeResult } from "./probe-results";
import { proxyNodeIdentity, type ProxyNode } from "./subscriptions";

export type AssistantJobStatus = "running" | "cancelling" | "cancelled" | "completed" | "failed";
export type AssistantReport = { version: 1; source: "routekit-local-probe"; generatedAt: string; results: ProbeResult[] };
export type AssistantJob = {
  id: string;
  status: AssistantJobStatus;
  createdAt: string;
  updatedAt: string;
  total: number;
  completed: number;
  currentNodeId?: string;
  phase: "preparing" | "checking" | "cleanup" | "finished";
  report: AssistantReport;
  error?: string;
};
export type AssistantCapabilities = {
  version: 1;
  source: "routekit-local-helper";
  monitor: boolean;
  probe: { available: boolean; reason?: string; maxNodes: number; maxBodyBytes: number; maxDownloadBytes: number };
  currentJob: AssistantJob | null;
};

const HELPER_ORIGIN = "http://127.0.0.1:8766";
const MAX_BYTES = 2 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const isTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const isNodeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value);

export function parseAssistantJob(value: unknown): AssistantJob {
  if (!isRecord(value) || !isId(value.id) || !["running", "cancelling", "cancelled", "completed", "failed"].includes(String(value.status)) || !isTime(value.createdAt) || !isTime(value.updatedAt) || !isCount(value.total, 100) || value.total === 0 || !isCount(value.completed, value.total) || !["preparing", "checking", "cleanup", "finished"].includes(String(value.phase)) || (value.currentNodeId != null && !isNodeId(value.currentNodeId)) || (value.error != null && (typeof value.error !== "string" || value.error.length > 2000))) throw new Error("助手返回的检测进度格式不正确");
  parseProbeResults(JSON.stringify(value.report), []);
  const report = value.report as AssistantReport;
  if (report.results.length !== value.completed || report.results.length > value.total) throw new Error("助手返回的完成数量与结果不一致");
  return { ...(value as unknown as AssistantJob), currentNodeId: value.currentNodeId == null ? undefined : value.currentNodeId as string, error: value.error == null ? undefined : value.error as string };
}

export function parseAssistantCapabilities(value: unknown): AssistantCapabilities {
  if (!isRecord(value) || value.version !== 1 || value.source !== "routekit-local-helper" || typeof value.monitor !== "boolean" || !isRecord(value.probe) || typeof value.probe.available !== "boolean" || !isCount(value.probe.maxNodes, 100) || value.probe.maxNodes < 1 || !isCount(value.probe.maxBodyBytes, MAX_BYTES) || value.probe.maxBodyBytes < 1 || !isCount(value.probe.maxDownloadBytes, 5_000_000) || (value.probe.reason != null && typeof value.probe.reason !== "string")) throw new Error("本地助手版本不兼容，请下载更新后的两个脚本并重新运行");
  return { version: 1, source: "routekit-local-helper", monitor: value.monitor, probe: value.probe as AssistantCapabilities["probe"], currentJob: value.currentJob == null ? null : parseAssistantJob(value.currentJob) };
}

export function associateAssistantResults(report: AssistantReport, inputNodes: ProxyNode[], currentNodes: ProxyNode[]) {
  const parsed = parseProbeResults(JSON.stringify(report), inputNodes);
  const originals = new Map(inputNodes.map(node => [node.id, proxyNodeIdentity(node)]));
  const current = new Map(currentNodes.map(node => [node.id, node]));
  const results = parsed.results.filter(result => {
    const node = current.get(result.nodeId);
    return node && originals.get(result.nodeId) === proxyNodeIdentity(node);
  });
  return { ...parsed, results, skipped: parsed.results.length - results.length };
}

export class AssistantRequestError extends Error {
  status: number;
  job?: AssistantJob;
  constructor(message: string, status: number, job?: AssistantJob) { super(message); this.status = status; this.job = job; }
}

async function request(token: string, path: string, method: "GET" | "POST" | "DELETE", signal: AbortSignal, payload?: ProbeJob): Promise<unknown> {
  const body = payload ? JSON.stringify(payload) : undefined;
  if (body && new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new Error("检测任务超过 2 MB，请减少选中的节点后重试");
  const response = await fetch(HELPER_ORIGIN + path, { method, headers: { Authorization: `Bearer ${token.trim()}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body, signal, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
  if (!response.body) throw new Error("助手没有返回可读取的数据");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error("助手返回内容超过 2 MB，已停止读取"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let result: unknown;
  try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("助手返回内容无法解析，请确认已更新本地助手"); }
  if (!response.ok) {
    const job = isRecord(result) && result.job ? parseAssistantJob(result.job) : undefined;
    const error = isRecord(result) && typeof result.error === "string" ? result.error.slice(0, 500) : `本地助手返回 HTTP ${response.status}`;
    throw new AssistantRequestError(error, response.status, job);
  }
  return result;
}
export async function getAssistantCapabilities(token: string, signal: AbortSignal) { return parseAssistantCapabilities(await request(token, "/v1/capabilities", "GET", signal)); }
export async function startAssistantJob(token: string, job: ProbeJob, signal: AbortSignal) { return parseAssistantJob(await request(token, "/v1/probe/jobs", "POST", signal, job)); }
export async function readAssistantJob(token: string, id: string, signal: AbortSignal) { if (!isId(id)) throw new Error("检测任务 ID 不正确"); return parseAssistantJob(await request(token, `/v1/probe/jobs/${id}`, "GET", signal)); }
export async function cancelAssistantJob(token: string, id: string, signal: AbortSignal) { if (!isId(id)) throw new Error("检测任务 ID 不正确"); return parseAssistantJob(await request(token, `/v1/probe/jobs/${id}`, "DELETE", signal)); }
export function assistantJobActive(job?: AssistantJob | null) { return job?.status === "running" || job?.status === "cancelling"; }
