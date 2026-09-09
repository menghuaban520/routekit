import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Info,
  Link2,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import {
  createSsNode,
  parseSubscription,
  proxyNodeIdentity,
  redactSubscriptionUrl,
  serializeNodes,
  validateSubscriptionUrl,
  type ProxyNode,
  type SubscriptionResult,
} from "../core/subscriptions";
import {
  haversineDistanceKm,
  parseProbeJob,
  parseProbeResults,
  type Coordinates,
  type ProbeResult,
} from "../core/probe-results";
import {
  parseSubscriptionUsage,
  formatBytes,
  formatUsagePercent,
  formatUsageExpiry,
  type SubscriptionUsage,
} from "../core/subscription-usage";
import "./subscriptions-ui.css";
import { assistantJobActive, associateAssistantResults, cancelAssistantJob, getAssistantCapabilities, readAssistantJob, startAssistantJob, type AssistantCapabilities, type AssistantJob } from "../core/local-assistant";

type ImportMode = "append" | "replace";
type NodeMeasurement = { result: ProbeResult; generatedAt: string };
type Notice = { title: string; errors: string[]; warnings: string[] };
type UsageSnapshot = {
  data: SubscriptionUsage;
  source: "header" | "manual";
  capturedAt: string;
  headerVisible: boolean;
  origin?: string;
  rawHeader: string;
};
const MAX_BYTES = 2 * 1024 * 1024;
const METHODS = [
  "aes-256-gcm",
  "chacha20-ietf-poly1305",
  "aes-128-gcm",
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
];
const ORIGINS: { id: string; name: string; coordinates: Coordinates }[] = [
  {
    id: "beijing",
    name: "北京",
    coordinates: { latitude: 39.9042, longitude: 116.4074 },
  },
  {
    id: "shanghai",
    name: "上海",
    coordinates: { latitude: 31.2304, longitude: 121.4737 },
  },
  {
    id: "guangzhou",
    name: "广州",
    coordinates: { latitude: 23.1291, longitude: 113.2644 },
  },
  {
    id: "hongkong",
    name: "香港",
    coordinates: { latitude: 22.3193, longitude: 114.1694 },
  },
  {
    id: "tokyo",
    name: "东京",
    coordinates: { latitude: 35.6762, longitude: 139.6503 },
  },
  {
    id: "losangeles",
    name: "洛杉矶",
    coordinates: { latitude: 34.0522, longitude: -118.2437 },
  },
];
const PROBE_COMMAND =
  "python3 routekit_probe.py --input routekit-job.json --output routekit-results.json --core /path/to/mihomo";
const TYPE_LABELS: Record<string, string> = {
  unknown: "类型未知",
  datacenter: "数据中心",
  hosting: "托管网络",
  mobile: "移动网络",
  vpn: "VPN",
  proxy: "代理网络",
};
const DEMO_LINK = "ss://YWVzLTI1Ni1nY206ZGVtby1vbmx5@node.example.com:443#格式示例-不可连接";

type SubscriptionsPanelProps = {
  active: boolean;
  nodes: ProxyNode[];
  onNodesChange: (nodes: ProxyNode[]) => void;
  onConfigureNodes: (nodeId?: string) => void;
  section?: SubscriptionSection;
  onSectionChange?: (section: SubscriptionSection) => void;
};
export type SubscriptionSection = "import" | "usage" | "library" | "probe" | "live";
const SECTION_LABELS: Record<SubscriptionSection, string> = { import: "导入订阅", usage: "套餐用量", library: "节点列表", probe: "批量实测", live: "实时流量" };
type LiveChain = { name: string; connections: number; uploadedBytes: number; downloadedBytes: number; uploadBytesPerSecond?: number; downloadBytesPerSecond?: number };
type LiveSnapshot = { source: "mihomo"; observedAt: string; uploadBytesPerSecond: number; downloadBytesPerSecond: number; uploadedBytes: number; downloadedBytes: number; chains: LiveChain[] };
function readLiveSnapshot(value: unknown): LiveSnapshot {
  if (!value || typeof value !== "object") throw new Error("监测器返回格式不正确");
  const data = value as LiveSnapshot;
  const valid = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  if (data.source !== "mihomo" || typeof data.observedAt !== "string" || !Number.isFinite(Date.parse(data.observedAt)) || ![data.uploadBytesPerSecond, data.downloadBytesPerSecond, data.uploadedBytes, data.downloadedBytes].every(valid) || !Array.isArray(data.chains) || data.chains.length > 10000 || data.chains.some((item) => !item || typeof item.name !== "string" || item.name.length > 4096 || ![item.connections, item.uploadedBytes, item.downloadedBytes].every(valid) || ![item.uploadBytesPerSecond, item.downloadBytesPerSecond].every((rate) => rate === undefined || valid(rate)))) throw new Error("监测器返回的计数或时间无效");
  return data;
}
function rateLabel(value?: number) { return value === undefined ? "等待下次采样" : `${formatBytes(Math.round(value))}/s`; }

function download(
  content: string,
  name: string,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function fileText(file: File): Promise<string> {
  if (file.size > MAX_BYTES) throw new Error("文件不能超过 2 MB");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    throw new Error("文件必须使用 UTF-8 文本编码");
  }
}
async function limitedResponseText(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new Error("订阅内容超过 2 MB，已停止读取");
  if (!response.body)
    throw new Error("浏览器无法流式读取订阅，请下载节点文件后导入");
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error("订阅内容超过 2 MB，已停止读取");
      parts.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("订阅返回的内容不是 UTF-8 文本");
  }
}
function dateLabel(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default function SubscriptionsPanel({ active, nodes, onNodesChange, onConfigureNodes, section, onSectionChange }: SubscriptionsPanelProps) {
  const [localSection, setLocalSection] = useState<SubscriptionSection>("import");
  const currentSection = section ?? localSection;
  function changeSection(next: SubscriptionSection) { setLocalSection(next); onSectionChange?.(next); }
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [measurements, setMeasurements] = useState<
    Record<string, NodeMeasurement>
  >({});
  const [mode, setMode] = useState<ImportMode>("append");
  const [input, setInput] = useState(""),
    [subscriptionUrl, setSubscriptionUrl] = useState("");
  const [showUrl, setShowUrl] = useState(false),
    [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null),
    [message, setMessage] = useState("");
  const [search, setSearch] = useState(""),
    [protocolFilter, setProtocolFilter] = useState("all");
  const [sort, setSort] = useState<"name" | "latency" | "speed">("name");
  const [manualOpen, setManualOpen] = useState(false),
    [showPassword, setShowPassword] = useState(false);
  const [manual, setManual] = useState({
    name: "",
    server: "",
    port: "8388",
    method: "aes-256-gcm",
    password: "",
  });
  const [speedTest, setSpeedTest] = useState(false),
    [originId, setOriginId] = useState("");
  const [latitude, setLatitude] = useState(""),
    [longitude, setLongitude] = useState("");
  const [fetchedSource, setFetchedSource] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [monitorToken, setMonitorToken] = useState("");
  const [helperCapabilities, setHelperCapabilities] = useState<AssistantCapabilities>();
  const [helperConnecting, setHelperConnecting] = useState(false);
  const [helperOpen, setHelperOpen] = useState(false);
  const [helperError, setHelperError] = useState("");
  const [autoProbe, setAutoProbe] = useState(true);
  const [probeRunning, setProbeRunning] = useState(false);
  const [probeJob, setProbeJob] = useState<AssistantJob>();
  const [probeError, setProbeError] = useState("");
  const [queuePaused, setQueuePaused] = useState(false);
  const [probeProgress, setProbeProgress] = useState({ total: 0, completed: 0 });
  const [pendingProbeIds, setPendingProbeIds] = useState<Set<string>>(new Set());
  const probeQueue = useRef<{ nodes: ProxyNode[]; speedTest: boolean }[]>([]);
  const probeInputs = useRef(new Map<string, ProxyNode[]>());
  const probeOffsets = useRef(new Map<string, number>());
  const probeSpeedOptions = useRef(new Map<string, boolean>());
  const pendingSubmission = useRef(false);
  const probeController = useRef<AbortController | undefined>(undefined);
  const helperController = useRef<AbortController | undefined>(undefined);
  const runnerActive = useRef(false);
  const cancellationRequested = useRef(false);
  const currentJobRef = useRef<AssistantJob | undefined>(undefined);
  const aggregateProgress = useRef({ total: 0, completed: 0 });
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [monitorError, setMonitorError] = useState("");
  const [liveSnapshot, setLiveSnapshot] = useState<LiveSnapshot>();
  const lastSubscription = useRef<{ url: string; ownedIds: Set<string>; updatedAt: string } | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot>(),
    [manualHeader, setManualHeader] = useState("");
  const nodeFile = useRef<HTMLInputElement>(null),
    resultFile = useRef<HTMLInputElement>(null),
    jobFile = useRef<HTMLInputElement>(null),
    selectAll = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => () => { abort.current?.abort(); helperController.current?.abort(); probeController.current?.abort(); }, []);
  useEffect(() => {
    const pause = () => { if (document.hidden) setMonitorRunning(false); };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);
  useEffect(() => {
    if (!active || currentSection !== "live") { setMonitorRunning(false); return; }
    if (!monitorRunning) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const sampleSession = crypto.randomUUID();
    async function sample() {
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch("http://127.0.0.1:8766/v1/snapshot", { headers: { Authorization: `Bearer ${monitorToken.trim()}`, "X-RouteKit-Session": sampleSession }, signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error.slice(0, 500) : `监测器返回 HTTP ${response.status}`);
        const data = readLiveSnapshot(body);
        if (!stopped) { setLiveSnapshot(data); setMonitorError(""); }
      } catch (error) {
        if (!stopped) {
          setMonitorError(error instanceof TypeError || controller.signal.aborted ? "没有连上本地监测器。请运行下载的脚本，核对令牌，并允许浏览器访问本地网络；部分浏览器会限制此连接。" : error instanceof Error ? error.message : "监测器连接失败");
          setMonitorRunning(false);
        }
        return;
      } finally { clearTimeout(timeout); }
      if (!stopped) timer = setTimeout(() => void sample(), 2000);
    }
    void sample();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [active, currentSection, monitorRunning, monitorToken]);

  const origin = useMemo<Coordinates | undefined>(() => {
    if (originId !== "custom")
      return ORIGINS.find((item) => item.id === originId)?.coordinates;
    if (!latitude.trim() || !longitude.trim()) return undefined;
    const lat = Number(latitude),
      lon = Number(longitude);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      return undefined;
    return { latitude: lat, longitude: lon };
  }, [originId, latitude, longitude]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const visible = nodes.filter(
      (item) =>
        (protocolFilter === "all" || item.protocol === protocolFilter) &&
        `${item.name} ${item.server} ${measurements[item.id]?.result.exitIp ?? ""}`
          .toLowerCase()
          .includes(query),
    );
    const metric = (item: ProxyNode) => {
      const result = measurements[item.id]?.result;
      if (!result) return Infinity;
      const value = sort === "latency" ? result.latencyMs : result.speedMbps;
      return value === undefined ? Infinity : sort === "speed" ? -value : value;
    };
    return visible.sort((a, b) => {
      if (sort !== "name") {
        const first = metric(a),
          second = metric(b);
        if (first !== second) return first - second;
      }
      return (
        a.name.localeCompare(b.name, "zh-CN") ||
        a.server.localeCompare(b.server)
      );
    });
  }, [nodes, measurements, search, protocolFilter, sort]);
  const selectedNodes = nodes.filter((item) => selected.has(item.id));
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((item) => selected.has(item.id));
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate =
        !allVisibleSelected && filtered.some((item) => selected.has(item.id));
  }, [filtered, selected, allVisibleSelected]);
  const measuredCount = nodes.filter((item) => measurements[item.id]).length;

  const helperFailure = (error: unknown) => error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")
    ? "没有连上本地助手。请把两个文件放在同一目录，运行本地助手，核对会话令牌，并允许浏览器访问本地网络。"
    : error instanceof Error ? error.message : "本地助手请求失败";

  async function helperCall<T>(operation: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const stop = () => controller.abort();
    parentSignal?.addEventListener("abort", stop, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const timeout = setTimeout(stop, 15000);
    try { return await operation(controller.signal); }
    finally { clearTimeout(timeout); parentSignal?.removeEventListener("abort", stop); }
  }

  async function connectHelper() {
    if (!monitorToken.trim() || helperConnecting) return;
    const controller = new AbortController();
    helperController.current = controller;
    setHelperConnecting(true); setHelperError("");
    try {
      const capabilities = await helperCall(signal => getAssistantCapabilities(monitorToken, signal), controller.signal);
      if (controller.signal.aborted) return;
      setHelperCapabilities(capabilities); setHelperOpen(false);
      if (queuePaused && !runnerActive.current) {
        const retained = capabilities.currentJob;
        if (!capabilities.probe.available) { setHelperOpen(true); return; }
        if (pendingSubmission.current && retained && !probeInputs.current.has(retained.id)) {
          currentJobRef.current = retained; setProbeJob(retained);
          setHelperError(`上次提交的响应丢失，无法确认助手任务是否属于这批节点。保留的 ${probeQueue.current.reduce((sum, batch) => sum + batch.nodes.length, 0)} 个节点未重新提交；先在批量实测查看任务，待任务结束后可明确重试。`);
          return;
        }
        pendingSubmission.current = false;
        if (retained && probeInputs.current.has(retained.id)) {
          if (retained.status === "failed" || retained.status === "cancelled") {
            updateProbeJob(retained, probeOffsets.current.get(retained.id) ?? 0);
            setProbeError("助手中的这一批已停止。已完成结果和剩余队列保留，可重试未完成节点。");
            return;
          }
          void runProbeQueue(retained, cancellationRequested.current);
        } else if (!retained) { setProbeError("助手已重启，当前任务不可恢复。保留的节点与队列还在，可重试未完成节点。"); }
        else void runProbeQueue();
        return;
      }
      if (capabilities.currentJob && !runnerActive.current) {
        cancellationRequested.current = false;
        aggregateProgress.current = { total: capabilities.currentJob.total, completed: 0 };
        setProbeProgress(aggregateProgress.current);
        if (!probeInputs.current.has(capabilities.currentJob.id)) setMessage("助手保留了先前任务。当前会话没有原节点凭证，结果可在批量实测中查看，不会套用到新节点。");
        if (assistantJobActive(capabilities.currentJob)) void runProbeQueue(capabilities.currentJob);
        else { updateProbeJob(capabilities.currentJob, 0); aggregateProgress.current.completed = capabilities.currentJob.completed; setProbeError(capabilities.currentJob.status === "failed" ? capabilities.currentJob.error ?? "上次检测失败，已完成结果保留。" : ""); }
      }
    } catch (error) { if (!controller.signal.aborted) { setHelperError(helperFailure(error)); setHelperCapabilities(undefined); } }
    finally { if (!controller.signal.aborted) setHelperConnecting(false); }
  }

  function updateProbeJob(job: AssistantJob, completedBefore: number) {
    currentJobRef.current = job; setProbeJob(job);
    const inputs = probeInputs.current.get(job.id) ?? [];
    const parsed = associateAssistantResults(job.report, inputs, nodesRef.current);
    setMeasurements(previous => ({ ...previous, ...Object.fromEntries(parsed.results.map(result => [result.nodeId, { result, generatedAt: parsed.generatedAt }])) }));
    setPendingProbeIds(previous => { const next = new Set(previous); for (const result of job.report.results) next.delete(result.nodeId); return next; });
    setProbeProgress({ total: aggregateProgress.current.total, completed: completedBefore + job.completed });
    if (parsed.skipped) setMessage(`${parsed.skipped} 个节点已变更或删除，对应旧检测结果已跳过。`);
  }

  async function pollProbeJob(initial: AssistantJob, completedBefore: number, signal: AbortSignal) {
    let job = initial;
    updateProbeJob(job, completedBefore);
    while (assistantJobActive(job) && !signal.aborted) {
      if (cancellationRequested.current && job.status === "running") {
        job = await helperCall(requestSignal => cancelAssistantJob(monitorToken, job.id, requestSignal), signal);
        updateProbeJob(job, completedBefore);
      }
      if (!assistantJobActive(job)) break;
      await new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }; const timer = setTimeout(finish, 900); signal.addEventListener("abort", finish, { once: true }); });
      if (signal.aborted) break;
      job = await helperCall(requestSignal => readAssistantJob(monitorToken, job.id, requestSignal), signal);
      updateProbeJob(job, completedBefore);
    }
    return job;
  }

  async function runProbeQueue(existing?: AssistantJob, continueCancellation = false) {
    if (runnerActive.current) return;
    runnerActive.current = true; cancellationRequested.current = continueCancellation;
    const controller = new AbortController(); probeController.current = controller;
    setProbeRunning(true); setProbeError(""); setQueuePaused(false);
    let interrupted = false;
    try {
      if (existing) {
        const offset = probeOffsets.current.get(existing.id) ?? 0;
        const result = await pollProbeJob(existing, offset, controller.signal);
        aggregateProgress.current.completed = offset + result.completed;
        if (result.status === "failed") throw new Error(result.error ?? "本地检测任务失败");
        if (result.status === "cancelled") cancellationRequested.current = true;
      }
      while (probeQueue.current.length && !controller.signal.aborted && !cancellationRequested.current) {
        const batch = probeQueue.current[0];
        const current = new Map(nodesRef.current.map(node => [node.id, proxyNodeIdentity(node)]));
        const validNodes = batch.nodes.filter(node => current.get(node.id) === proxyNodeIdentity(node));
        aggregateProgress.current.completed += batch.nodes.length - validNodes.length;
        if (!validNodes.length) { probeQueue.current.shift(); continue; }
        batch.nodes = validNodes;
        pendingSubmission.current = true;
        const job = await helperCall(signal => startAssistantJob(monitorToken, { version: 1, nodes: validNodes, options: { speedTest: batch.speedTest, downloadBytes: 5_000_000, timeoutSeconds: 10 } }, signal), controller.signal);
        pendingSubmission.current = false;
        probeQueue.current.shift();
        probeInputs.current.set(job.id, validNodes);
        probeOffsets.current.set(job.id, aggregateProgress.current.completed);
        probeSpeedOptions.current.set(job.id, batch.speedTest);
        const result = await pollProbeJob(job, aggregateProgress.current.completed, controller.signal);
        aggregateProgress.current.completed += result.completed;
        if (result.status === "failed") throw new Error(result.error ?? "本地检测任务失败，已保留完成的结果");
        if (result.status === "cancelled") { cancellationRequested.current = true; break; }
      }
      if (!controller.signal.aborted) {
        setProbeProgress({ ...aggregateProgress.current });
        setSort("latency");
        setMessage(cancellationRequested.current ? "检测已取消，已完成的结果保留。" : "批量检测已完成，可按实测延迟或下载速度排序并用于分流。");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        interrupted = true; setQueuePaused(true);
        const queued = probeQueue.current.reduce((sum, batch) => sum + batch.nodes.length, 0);
        setProbeError(`${helperFailure(error)} 已完成结果与 ${queued} 个未提交节点保留；重新连接助手后继续本次队列。`);
        setHelperCapabilities(undefined);
      }
    } finally {
      if (!interrupted) probeQueue.current = [];
      runnerActive.current = false;
      if (!controller.signal.aborted) { setProbeRunning(false); if (!interrupted) setPendingProbeIds(new Set()); }
    }
  }

  function enqueueProbe(targets: ProxyNode[]) {
    if (queuePaused) { setHelperOpen(true); setHelperError("上一轮检测队列尚未完成，请先重新连接继续或明确重试保留的节点。"); return; }
    if (!helperCapabilities?.probe.available) { setHelperOpen(true); setHelperError(helperCapabilities?.probe.reason ?? "先连接本地助手，再执行节点批量检测。"); return; }
    if (!targets.length) return;
    if (!runnerActive.current) { aggregateProgress.current = { total: 0, completed: 0 }; probeInputs.current.clear(); probeOffsets.current.clear(); probeSpeedOptions.current.clear(); setProbeJob(undefined); currentJobRef.current = undefined; }
    const chunkSize = helperCapabilities.probe.maxNodes;
    for (let start = 0; start < targets.length; start += chunkSize) probeQueue.current.push({ nodes: structuredClone(targets.slice(start, start + chunkSize)), speedTest });
    aggregateProgress.current.total += targets.length;
    setProbeProgress({ ...aggregateProgress.current });
    setPendingProbeIds(previous => new Set([...previous, ...targets.map(node => node.id)]));
    setMeasurements(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !targets.some(node => node.id === id))));
    setProbeError(""); setSort("latency");
    void runProbeQueue();
  }

  function importedNodesReady(next: ProxyNode[], incoming: ProxyNode[]) {
    const identities = new Set(incoming.map(proxyNodeIdentity));
    const imported = next.filter(node => identities.has(proxyNodeIdentity(node)));
    if (autoProbe && helperCapabilities?.probe.available) enqueueProbe(imported);
    changeSection("library");
  }

  function requestProbeCancellation() {
    cancellationRequested.current = true; probeQueue.current = [];
    setMessage("正在取消检测；本地助手完成清理后会停止。已完成结果保留。");
  }

  function retryRetainedQueue() {
    if (!helperCapabilities?.probe.available) { setHelperOpen(true); return; }
    if (assistantJobActive(helperCapabilities.currentJob)) { setHelperError("助手当前任务仍在运行。请先重新连接更新任务状态，避免重复检测。"); return; }
    const previous = currentJobRef.current;
    if (previous && probeInputs.current.has(previous.id) && !pendingSubmission.current) {
      const finished = new Set(previous.report.results.map(result => result.nodeId));
      const queuedIds = new Set(probeQueue.current.flatMap(batch => batch.nodes.map(node => node.id)));
      const remaining = probeInputs.current.get(previous.id)!.filter(node => !finished.has(node.id) && !queuedIds.has(node.id));
      if (remaining.length) probeQueue.current.unshift({ nodes: remaining, speedTest: probeSpeedOptions.current.get(previous.id) ?? false });
      aggregateProgress.current.completed = (probeOffsets.current.get(previous.id) ?? 0) + previous.completed;
    }
    pendingSubmission.current = false;
    void runProbeQueue();
  }

  function setNodes(next: ProxyNode[]) {
    nodesRef.current = next;
    onNodesChange(next);
  }

  function keepMeasurements(next: ProxyNode[]) {
    const ids = new Set(next.map((item) => item.id));
    setMeasurements((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))));
  }

  function addParsed(parsed: SubscriptionResult, importMode: ImportMode, continueWorkflow = true) {
    setMessage("");
    if (!parsed.nodes.length) {
      setNotice({
        title: "没有可导入的节点，当前列表保持不变",
        errors: parsed.errors,
        warnings: parsed.warnings,
      });
      return undefined;
    }
    if (importMode === "replace") {
      const existing = new Map(nodesRef.current.map((item) => [proxyNodeIdentity(item), item.id]));
      const next = parsed.nodes.map((item) => ({ ...item, id: existing.get(proxyNodeIdentity(item)) ?? item.id }));
      setNodes(next);
      setSelected(new Set(next.map((item) => item.id)));
      keepMeasurements(next);
      setNotice({
        title: `已替换为 ${parsed.nodes.length} 个节点`,
        errors: parsed.errors,
        warnings: parsed.warnings,
      });
      if (continueWorkflow) importedNodesReady(next, parsed.nodes);
      return next;
    }
    const currentNodes = nodesRef.current;
    const existing = new Set(currentNodes.map(proxyNodeIdentity)),
      added: ProxyNode[] = [];
    let duplicateCount = 0,
      overflow = 0;
    for (const item of parsed.nodes) {
      const key = proxyNodeIdentity(item);
      if (existing.has(key)) {
        duplicateCount++;
        continue;
      }
      if (currentNodes.length + added.length >= 500) {
        overflow++;
        continue;
      }
      existing.add(key);
      added.push(item);
    }
    const next = [...currentNodes, ...added];
    setNodes(next);
    setSelected(
      (previous) => new Set([...previous, ...added.map((item) => item.id)]),
    );
    setNotice({
      title: `已追加 ${added.length} 个节点${duplicateCount ? `，跳过 ${duplicateCount} 个重复节点` : ""}`,
      errors: [
        ...parsed.errors,
        ...(overflow
          ? [`列表上限为 500 个，另有 ${overflow} 个节点未添加`]
          : []),
      ],
      warnings: parsed.warnings,
    });
    if (continueWorkflow) importedNodesReady(next, parsed.nodes);
    return next;
  }

  async function fetchSubscription(refresh = false) {
    if (abort.current) return;
    const requestedUrl = refresh ? lastSubscription.current?.url ?? "" : subscriptionUrl.trim();
    if (!validateSubscriptionUrl(requestedUrl)) {
      setNotice({
        title: "订阅地址无效",
        errors: [
          "请填写公网上的 HTTPS 订阅地址，不支持本机/私网、URL 用户名密码或片段。",
        ],
        warnings: [],
      });
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setMessage("");
    setNotice(null);
    setRefreshError("");
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(requestedUrl, {
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
        mode: "cors",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok)
        throw new Error(
          `订阅服务返回 HTTP ${response.status}，请检查地址或下载文件后导入`,
        );
      if (response.headers.get("content-type")?.includes("text/html"))
        throw new Error(
          "订阅返回了网页，请使用订阅的节点文本链接或导入节点文件",
        );
      const content = await limitedResponseText(response);
      const parsed = parseSubscription(content);
      if (!parsed.nodes.length) {
        addParsed(parsed, mode);
        throw new Error("没有可用节点，已保留原节点与上次成功的流量快照。请检查订阅格式后重试。");
      }
      const currentNodes = nodesRef.current;
      const previous = lastSubscription.current;
      const matchingSource = previous?.url === requestedUrl;
      const shouldSync = matchingSource && (refresh || mode === "append");
      if (shouldSync && parsed.errors.length) {
        throw new Error(`订阅有 ${parsed.errors.length} 条内容无法解析，本次未更新节点和流量。旧列表与分流引用保留，请检查订阅格式后重试。`);
      }
      let next: ProxyNode[];
      let ownedIds: Set<string>;
      if (shouldSync) {
        const existing = new Map(currentNodes.map((item) => [proxyNodeIdentity(item), item]));
        const untouched = currentNodes.filter((item) => !previous.ownedIds.has(item.id));
        const identities = new Set(untouched.map(proxyNodeIdentity));
        next = [...untouched];
        ownedIds = new Set();
        let overflow = 0;
        for (const item of parsed.nodes) {
          const identity = proxyNodeIdentity(item);
          if (identities.has(identity)) continue;
          if (next.length >= 500) { overflow++; continue; }
          const stable = { ...item, id: existing.get(identity)?.id ?? item.id };
          next.push(stable);
          identities.add(identity);
          ownedIds.add(stable.id);
        }
        setNodes(next);
        keepMeasurements(next);
        setSelected((selectedIds) => new Set(next.filter((item) => selectedIds.has(item.id) || !currentNodes.some((old) => old.id === item.id)).map((item) => item.id)));
        setNotice({ title: `订阅已刷新 · 当前共 ${next.length} 个节点`, errors: [...parsed.errors, ...(overflow ? [`另有 ${overflow} 个节点超出 500 个上限`] : [])], warnings: parsed.warnings });
      } else {
        next = addParsed(parsed, mode, false)!;
        const beforeIds = new Set(currentNodes.map((item) => item.id));
        ownedIds = new Set(next.filter((item) => mode === "replace" || !beforeIds.has(item.id)).map((item) => item.id));
      }
      const capturedAt = new Date().toISOString();
      const rawHeader = response.headers.get("subscription-userinfo");
      setUsage({ data: parseSubscriptionUsage(rawHeader ?? ""), source: "header", capturedAt, headerVisible: rawHeader !== null, origin: redactSubscriptionUrl(requestedUrl), rawHeader: rawHeader ?? "" });
      lastSubscription.current = { url: requestedUrl, ownedIds, updatedAt: capturedAt };
      setFetchedSource(
        `${redactSubscriptionUrl(requestedUrl)} · ${new Date().toLocaleTimeString("zh-CN")}`,
      );
      if (!refresh) importedNodesReady(next, parsed.nodes);
    } catch (error) {
      const explanation = controller.signal.aborted
        ? "读取已取消或超过 15 秒。你可以下载订阅文件，再从本地导入。"
        : error instanceof TypeError
          ? "浏览器未能读取订阅。服务可能未开放 CORS、存在重定向或网络不可用；请手动下载节点文件，或粘贴节点内容。"
          : error instanceof Error
            ? error.message
            : "读取失败，请改用粘贴或文件导入。";
      setNotice({ title: "订阅尚未读取", errors: [explanation], warnings: [] });
      setRefreshError(explanation);
    } finally {
      clearTimeout(timeout);
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  }

  async function importNodeFile(file?: File) {
    if (!file) return;
    try {
      addParsed(parseSubscription(await fileText(file)), mode);
    } catch (error) {
      setNotice({
        title: "文件未导入",
        errors: [error instanceof Error ? error.message : "读取文件失败"],
        warnings: [],
      });
    }
  }
  function addManual(event: React.FormEvent) {
    event.preventDefault();
    try {
      const created = createSsNode({
        ...manual,
        name: manual.name.trim(),
        server: manual.server.trim(),
        port: Number(manual.port),
      });
      addParsed(
        {
          nodes: [created],
          errors: [],
          warnings: ["手动节点已添加，尚未检测。"],
        },
        "append",
      );
      setManual((previous) => ({ ...previous, password: "" }));
      setShowPassword(false);
    } catch (error) {
      setNotice({
        title: "节点未添加",
        errors: [error instanceof Error ? error.message : "节点参数无效"],
        warnings: [],
      });
    }
  }
  function toggleVisible() {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const item of filtered) {
        if (allVisibleSelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  }
  function removeSelected() {
    setNodes(nodesRef.current.filter((item) => !selected.has(item.id)));
    setMeasurements((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id]) => !selected.has(id)),
      ),
    );
    setMessage(`已删除 ${selectedNodes.length} 个选中节点。`);
    setSelected(new Set());
  }
  function exportSelected() {
    try {
      download(serializeNodes(selectedNodes), "routekit-nodes.txt");
      setMessage(
        `已发起 ${selectedNodes.length} 个节点链接下载；文件包含连接凭证。`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出失败");
    }
  }
  function exportJob() {
    if (!selectedNodes.length || selectedNodes.length > 100) return;
    download(
      JSON.stringify(
        {
          version: 1,
          nodes: selectedNodes,
          options: { speedTest, downloadBytes: 5_000_000, timeoutSeconds: 10 },
        },
        null,
        2,
      ),
      "routekit-job.json",
      "application/json",
    );
    setMessage(
      `已发起 ${selectedNodes.length} 个节点的检测任务下载。请交给你自己的本地检测器；JSON 包含凭证。`,
    );
  }
  async function importResults(file?: File) {
    if (!file) return;
    try {
      const parsed = parseProbeResults(await fileText(file), nodesRef.current);
      setMeasurements((previous) => ({
        ...previous,
        ...Object.fromEntries(
          parsed.results.map((result) => [
            result.nodeId,
            { result, generatedAt: parsed.generatedAt },
          ]),
        ),
      }));
      setNotice({
        title: `已关联 ${parsed.results.length} 个当前节点的检测结果`,
        errors: [],
        warnings: parsed.warnings,
      });
      setMessage(
        "可按实测延迟或速度排序。结果来自你导入的文件，RouteKit 未重新执行检测。",
      );
      changeSection("library");
    } catch (error) {
      setNotice({
        title: "检测结果未导入",
        errors: [error instanceof Error ? error.message : "结果文件无效"],
        warnings: [],
      });
    }
  }
  async function restoreJob(file?: File) {
    if (!file) return;
    try {
      const restored = parseProbeJob(await fileText(file));
      nodesRef.current = restored.nodes;
      setNodes(restored.nodes);
      setSelected(new Set(restored.nodes.map((item) => item.id)));
      setMeasurements({});
      setSpeedTest(restored.options.speedTest);
      setNotice({
        title: `已从检测任务恢复 ${restored.nodes.length} 个节点，替换了当前列表`,
        errors: [],
        warnings: ["原节点 ID 已恢复，现在可以导入对应的检测结果 JSON。"],
      });
    } catch (error) {
      setNotice({
        title: "检测任务未恢复",
        errors: [error instanceof Error ? error.message : "任务文件无效"],
        warnings: [],
      });
    }
  }

  return (
    <section className="subscriptions-panel" aria-label="节点与订阅工作台">
      {!section && <nav className="subscriptions-jump" aria-label="订阅工作台区段">
        {(Object.keys(SECTION_LABELS) as SubscriptionSection[]).map((item) => <button type="button" key={item} aria-current={currentSection === item ? "page" : undefined} onClick={() => changeSection(item)}>{SECTION_LABELS[item]}{item === "library" && nodes.length ? ` · ${nodes.length}` : ""}</button>)}
      </nav>}
      <div className="subscriptions-assistant">
        <div className="subscriptions-assistant-status"><ShieldCheck size={19} /><div><strong>本地助手</strong><span>{helperConnecting ? "正在连接" : helperCapabilities ? helperCapabilities.probe.available ? "已连接 · 批量检测与实时流量可用" : "已连接 · 批量检测尚未就绪" : "未连接 · 导入与分流仍可使用"}</span></div><button type="button" className="button outline compact" onClick={() => setHelperOpen(!helperOpen)} aria-expanded={helperOpen}>{helperCapabilities ? "连接设置" : "连接本地助手"}</button></div>
        {helperOpen && <div className="subscriptions-assistant-setup">
          <p>需要 Python 3.10+ 和本机 Mihomo / Clash Verge。</p><ol><li><a href="/routekit_monitor.py" download>下载本地助手</a> 和 <a href="/routekit_probe.py" download>下载检测模块</a>，放在同一个文件夹。</li><li>已有 Mihomo / Clash Verge 时可先运行 <code>python3 routekit_monitor.py</code>。无法找到内核时，用 <code>python3 routekit_monitor.py --core /你的/mihomo/路径</code>。</li><li>复制终端输出的会话令牌到下面。浏览器询问本地网络权限时允许访问。</li></ol>
          <div className="subscriptions-monitor-connect"><label className="subscriptions-field">本地助手会话令牌<input id="local-helper-token" type="password" autoComplete="off" spellCheck={false} value={monitorToken} disabled={helperConnecting || monitorRunning || probeRunning} maxLength={512} onChange={event => { setMonitorToken(event.target.value); setHelperCapabilities(undefined); }} placeholder="只在此会话使用，不上传到本站" /></label><button type="button" className="button primary" disabled={!monitorToken.trim() || helperConnecting || probeRunning || monitorRunning} onClick={() => void connectHelper()}>{helperConnecting ? <LoaderCircle size={15} className="subscriptions-spin" /> : <Link2 size={15} />}{helperCapabilities ? "重新连接助手" : "验证并连接"}</button></div>
          <details><summary>控制器、自托管与隐私</summary><p>批量检测使用隔离的内核，不改变系统代理。节点凭证只从本网页发往本机 127.0.0.1:8766；退出助手会清空任务，网页刷新会清空未提交的分批队列。</p><p>实时流量需要已有 Mihomo 开启 <code>external-controller: 127.0.0.1:9090</code>；设置过 secret 时加 <code>--secret-file 本地文件路径</code>。自托管网页加 <code>--origin https://你的网页域名</code>。</p><p><a href="https://wiki.metacubex.one/start/" target="_blank" rel="noopener noreferrer">Mihomo 官方安装说明</a> · <a href="https://wiki.metacubex.one/api/" target="_blank" rel="noopener noreferrer">控制器 API</a></p></details>
        </div>}
        {helperError && <p className="subscriptions-inline-warning" role="alert">{helperError}</p>}
        {helperCapabilities && !helperCapabilities.probe.available && <p className="subscriptions-inline-warning">{helperCapabilities.probe.reason ?? "批量检测内核尚未就绪，请查看连接设置。"}</p>}
      </div>
      {probeProgress.total > 0 && <div className={`subscriptions-batch-progress ${probeError ? "has-error" : ""}`} role="status">
        <div><strong>{probeRunning ? cancellationRequested.current ? "正在取消" : "正在批量检测" : probeError ? "检测已中断" : cancellationRequested.current || probeJob?.status === "cancelled" ? "检测已取消" : "检测完成"}</strong><span>{probeProgress.completed} / {probeProgress.total} 个节点已处理{probeJob?.currentNodeId && probeRunning ? ` · ${nodes.find(node => node.id === probeJob.currentNodeId)?.name ?? "当前节点"}` : ""}</span></div>
        <progress max={probeProgress.total} value={probeProgress.completed} aria-label="批量节点检测进度" />
        <div className="subscriptions-actions"><button type="button" className="text-button accent" onClick={() => changeSection("library")}>查看节点结果</button>{probeRunning ? <button type="button" className="button outline compact" disabled={cancellationRequested.current} onClick={requestProbeCancellation}><Square size={14} />取消全部检测</button> : <button type="button" className="text-button accent" onClick={() => { setSort("latency"); changeSection("library"); }}>按延迟排序</button>}</div>
        {probeError && <p className="subscriptions-inline-warning">{probeError}</p>}
        {queuePaused && <div className="subscriptions-actions"><button type="button" className="button outline compact" disabled={helperConnecting} onClick={() => void connectHelper()}>重新连接并继续队列</button>{helperCapabilities && <button type="button" className="text-button accent" onClick={retryRetainedQueue}>{pendingSubmission.current ? "明确重试保留节点（可能重复当前批次）" : "重试未完成节点"}</button>}</div>}
      </div>}
      <ol hidden={currentSection !== "import"} className="subscriptions-start" aria-label="订阅到分流的三个步骤">
        <li><span>1</span><div><strong>拿到订阅</strong><p>在服务商后台复制「订阅链接」，或准备节点文本 / YAML 文件。</p></div></li>
        <li><span>2</span><div><strong>自动检测</strong><p>连接本地助手后，导入即可检测出口 IP、延迟与连通性。</p></div></li>
        <li><span>3</span><div><strong>给应用选节点</strong><p>按实测结果排序，点「用于分流」指定应用去向。</p></div></li>
      </ol>
      <div hidden={currentSection !== "import"} className="subscriptions-import" id="subscription-import">
        <div className="subscriptions-card-heading">
          <h3>
            <Link2 size={18} />
            导入你的订阅
          </h3>
          <div
            className="subscriptions-mode"
            role="group"
            aria-label="节点导入方式"
          >
            <button
              type="button"
              aria-pressed={mode === "append"}
              className={mode === "append" ? "active" : ""}
              onClick={() => setMode("append")}
              disabled={busy}
            >
              追加到列表
            </button>
            <button
              type="button"
              aria-pressed={mode === "replace"}
              className={mode === "replace" ? "active" : ""}
              onClick={() => setMode("replace")}
              disabled={busy}
            >
              替换当前列表
            </button>
          </div>
        </div>
        {mode === "replace" && nodes.length > 0 && (
          <p className="subscriptions-inline-warning">
            下一次成功导入会替换当前 {nodes.length}{" "}
            个节点；相同连接保留分流引用和检测结果，没有有效节点时保留列表。
          </p>
        )}
        <div className="subscriptions-auto-probe"><label><input type="checkbox" checked={autoProbe} onChange={event => setAutoProbe(event.target.checked)} />导入后自动检测全部节点</label><span>{helperCapabilities?.probe.available ? "已就绪 · 每批最多 100 个，自动分批完成" : "连接本地助手后生效；当前只导入节点"}</span><label><input type="checkbox" checked={speedTest} onChange={event => setSpeedTest(event.target.checked)} />同时测下载速度<span>{speedTest ? "每个新导入节点额外下载最多 5 MB" : "默认不下载 5 MB 测速样本，仍有连接与定位请求流量"}</span></label></div>
        <label className="subscriptions-field" htmlFor="subscription-url">
          HTTPS 订阅地址
          <div className="subscriptions-url-row">
            <div className="subscriptions-secret-field">
              <input
                id="subscription-url"
                type={showUrl ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                value={subscriptionUrl}
                onChange={(event) => setSubscriptionUrl(event.target.value)}
                placeholder="https://你的订阅服务/…"
                disabled={busy}
              />
              <button
                type="button"
                className="icon-button"
                onClick={() => setShowUrl(!showUrl)}
                aria-label={showUrl ? "隐藏订阅地址" : "显示订阅地址"}
              >
                {showUrl ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <button
              type="button"
              className="button primary"
              disabled={busy || !subscriptionUrl.trim()}
              onClick={() => void fetchSubscription()}
            >
              {busy ? (
                <LoaderCircle size={16} className="subscriptions-spin" />
              ) : (
                <ArrowDownToLine size={16} />
              )}
              读取订阅
            </button>
            {busy && (
              <button
                type="button"
                className="button outline"
                onClick={() => abort.current?.abort()}
              >
                <Square size={14} />
                取消
              </button>
            )}
          </div>
        </label>
        <p className="helper subscriptions-import-hint">订阅链接通常在服务商后台的「订阅 / 一键导入」里。可用通用节点链接、Base64 或 Clash / Mihomo YAML；YAML 只导入节点，分流规则在本站另行配置。</p>
        {fetchedSource && (
          <p className="helper subscriptions-source">最近读取：{fetchedSource}</p>
        )}
        <label className="subscriptions-field" htmlFor="subscription-paste">
          节点链接、Base64 或 YAML 内容
          <textarea
            id="subscription-paste"
            rows={3}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="每行一条节点链接，或粘贴 Base64 / Clash YAML 订阅"
          />
        </label>
        <div className="subscriptions-actions">
          <button
            type="button"
            className="button outline"
            disabled={busy || !input.trim()}
            onClick={() => addParsed(parseSubscription(input), mode)}
          >
            <Plus size={16} />
            导入粘贴内容
          </button>
          <button
            type="button"
            className="button outline"
            disabled={busy}
            onClick={() => nodeFile.current?.click()}
          >
            <FileUp size={16} />
            导入节点文件
          </button>
          <button
            type="button"
            className="text-button accent"
            onClick={() => setManualOpen(!manualOpen)}
            aria-expanded={manualOpen}
          >
            <Plus size={16} />
            {manualOpen ? "收起手动添加" : "手动添加 SS 节点"}
          </button>
          <span className="helper">最多 2 MB · 500 个节点</span>
        </div>
        <input
          hidden
          ref={nodeFile}
          type="file"
          accept=".txt,.yaml,.yml,text/plain,application/yaml,text/yaml"
          aria-label="选择节点文本文件"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void importNodeFile(file);
          }}
        />
        {manualOpen && (
          <form className="subscriptions-manual" onSubmit={addManual}>
            <div className="subscriptions-manual-fields">
              <label className="subscriptions-field">
                节点名称
                <input
                  value={manual.name}
                  maxLength={200}
                  onChange={(event) =>
                    setManual({ ...manual, name: event.target.value })
                  }
                  placeholder="如：我的东京节点"
                />
              </label>
              <label className="subscriptions-field">
                服务器地址
                <input
                  required
                  value={manual.server}
                  onChange={(event) =>
                    setManual({ ...manual, server: event.target.value })
                  }
                  spellCheck={false}
                  placeholder="域名、IPv4 或 IPv6"
                />
              </label>
              <label className="subscriptions-field">
                端口
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  value={manual.port}
                  onChange={(event) =>
                    setManual({ ...manual, port: event.target.value })
                  }
                />
              </label>
              <label className="subscriptions-field">
                加密方式
                <select
                  value={manual.method}
                  onChange={(event) =>
                    setManual({ ...manual, method: event.target.value })
                  }
                >
                  {METHODS.map((method) => (
                    <option key={method}>{method}</option>
                  ))}
                </select>
              </label>
              <label className="subscriptions-field subscriptions-manual-password">
                密码 / SS 2022 密钥
                <div className="subscriptions-secret-field">
                  <input
                    required
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    maxLength={2048}
                    value={manual.password}
                    onChange={(event) =>
                      setManual({ ...manual, password: event.target.value })
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={showPassword ? "隐藏节点密码" : "显示节点密码"}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
            </div>
            <button type="submit" className="button primary" disabled={busy}>
              <Plus size={16} />
              添加到列表
            </button>
          </form>
        )}
      </div>

      <div hidden={currentSection !== "usage"} className="subscriptions-usage">
        <div className="subscriptions-card-heading">
          <div>
            <h3>
              <ArrowDownToLine size={18} />
              订阅流量与到期
            </h3>
          </div>
          <div className="subscriptions-actions"><span className="subscriptions-step-count">
            {!usage
              ? "尚未读取"
              : usage.source === "manual"
                ? "手动提供的数据"
                : usage.headerVisible
                  ? "服务商响应头"
                  : "响应头不可见"}
          </span>
          <button type="button" className="button outline compact" disabled={busy || !lastSubscription.current} onClick={() => void fetchSubscription(true)}>
            <RefreshCw size={15} className={busy ? "subscriptions-spin" : ""} />
            {busy ? "正在刷新" : "刷新流量与节点"}
          </button></div>
        </div>
        {!usage && <p className="subscriptions-usage-empty">读取订阅后，这里显示服务商提供的总额、剩余、上传、下载和到期时间。</p>}
        {usage && <>
        <div className="subscriptions-usage-metrics">
          <div>
            <span>总额度</span>
            <strong>{formatBytes(usage?.data.totalBytes)}</strong>
          </div>
          <div>
            <span>已用流量</span>
            <strong>{formatBytes(usage?.data.usedBytes)}</strong>
          </div>
          <div>
            <span>剩余流量</span>
            <strong>{formatBytes(usage?.data.remainingBytes)}</strong>
          </div>
          <div>
            <span>累计上传</span>
            <strong>{formatBytes(usage?.data.uploadBytes)}</strong>
          </div>
          <div>
            <span>累计下载</span>
            <strong>{formatBytes(usage?.data.downloadBytes)}</strong>
          </div>
          <div className="subscriptions-usage-expiry">
            <span>到期时间</span>
            <strong>{formatUsageExpiry(usage?.data.expiresAt)}</strong>
            {usage?.data.expired !== undefined && (
              <small>
                {usage.data.expired
                  ? "按提供时间已到期"
                  : `采集时距到期约 ${usage.data.daysRemaining} 天`}
              </small>
            )}
          </div>
        </div>
        <div className="subscriptions-usage-progress">
          <span>已用占比 {formatUsagePercent(usage?.data.usedPercent)}</span>
          {usage?.data.usedPercent !== undefined ? (
            <progress
              value={Math.min(100, usage.data.usedPercent)}
              max={100}
              aria-label={`订阅流量已用 ${formatUsagePercent(usage.data.usedPercent)}`}
            />
          ) : (
            <span className="helper">占比无法计算</span>
          )}
        </div>
        </>}
        {refreshError && <p className="subscriptions-inline-warning" role="status">本次读取失败。{usage ? "下面仍是上次成功取得的数据，未更新。" : "暂时没有可用的流量数据。"}</p>}
        {usage && (
          <p className="subscriptions-usage-source">
            {usage.source === "manual" ? "手动录入" : `来自 ${usage.origin}`} ·
            最后更新 {dateLabel(usage.capturedAt)} ·
            {usage.source === "header" && !usage.headerVisible
              ? "用量头不可见，缺失数据未知。"
              : "服务商统计可能延后"}
          </p>
        )}
        {usage &&
          (usage.data.errors.length > 0 || usage.data.warnings.length > 0) && (
            <details
              className="subscriptions-usage-notes"
              open={usage.data.errors.length > 0}
            >
              <summary>
                {usage.data.errors.length
                  ? "流量响应头存在错误"
                  : "流量数据说明"}
              </summary>
              <ul>
                {[...usage.data.errors, ...usage.data.warnings].map(
                  (item, index) => (
                    <li key={index}>{item}</li>
                  ),
                )}
              </ul>
            </details>
          )}
        <details className="subscriptions-manual-usage">
          <summary>手动补充流量数据</summary>
          <label
            className="subscriptions-field"
            htmlFor="subscription-userinfo"
          >
            从服务商复制头值
            <textarea
              id="subscription-userinfo"
              rows={2}
              maxLength={32768}
              spellCheck={false}
              value={manualHeader}
              onChange={(event) => setManualHeader(event.target.value)}
              placeholder="upload=1024; download=2048; total=10737418240; expire=…"
            />
          </label>
          <button
            type="button"
            className="button outline"
            disabled={!manualHeader.trim()}
            onClick={() => {
              setUsage({
                data: parseSubscriptionUsage(manualHeader),
                source: "manual",
                capturedAt: new Date().toISOString(),
                headerVisible: true,
                rawHeader: manualHeader,
              });
              setMessage(
                "已读取手动提供的响应头；这不是向服务商发起的实时查询。",
              );
            }}
          >
            读取手动流量数据
          </button>
        </details>
      </div>


      {notice && (
        <div
          className={`subscriptions-notice ${notice.errors.length ? "has-errors" : ""}`}
          role={notice.errors.length ? "alert" : "status"}
        >
          <strong>{notice.title}</strong>
          {notice.errors.length > 0 && (
            <details open>
              <summary>{notice.errors.length} 条导入错误</summary>
              <ul>
                {notice.errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </details>
          )}
          {notice.warnings.length > 0 && (
            <details>
              <summary>{notice.warnings.length} 条提示</summary>
              <ul>
                {notice.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div hidden={currentSection !== "library"} className="subscriptions-library" id="subscription-library">
        <div className="subscriptions-card-heading">
          <h3>
            <Server size={18} />
            节点列表{" "}
            <span>
              {nodes.length} 个 · {measuredCount} 个已有结果
            </span>
          </h3>
          <div className="subscriptions-actions">
            <button type="button" className="button outline compact" disabled={!selectedNodes.length || probeRunning} onClick={() => { if (helperCapabilities?.probe.available) enqueueProbe(selectedNodes); else { changeSection("probe"); setHelperOpen(true); } }}><Search size={15} />检测选中节点</button>
            <button type="button" className="text-button accent" onClick={() => changeSection("import")}><Plus size={15} />继续导入</button>
            <button type="button" className="button primary compact" disabled={!nodes.length} onClick={() => onConfigureNodes()}>
              去配置分流 <ArrowRight size={15} />
            </button>
            <button
              type="button"
              className="button outline compact"
              disabled={!selectedNodes.length}
              onClick={exportSelected}
            >
              <Download size={15} />
              导出选中链接（含凭证）
            </button>
            <button
              type="button"
              className="button outline compact subscriptions-danger"
              disabled={!selectedNodes.length}
              onClick={removeSelected}
            >
              <Trash2 size={15} />
              删除选中
            </button>
          </div>
        </div>
        <div className="subscriptions-filters">
          <label className="subscriptions-search">
            <Search size={17} />
            <input
              aria-label="搜索节点名称、入口或出口 IP"
              placeholder="搜索名称、入口或出口 IP"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="subscriptions-filter-label">
            协议
            <select
              aria-label="节点协议筛选"
              value={protocolFilter}
              onChange={(event) => setProtocolFilter(event.target.value)}
            >
              <option value="all">全部协议</option>
              {[
                "ss",
                "vmess",
                "vless",
                "trojan",
                "socks5",
                "http",
                "https",
              ].map((protocol) => (
                <option key={protocol} value={protocol}>
                  {protocol.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="subscriptions-filter-label">
            排序
            <select
              aria-label="节点排序"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
            >
              <option value="name">按名称</option>
              <option value="latency">实测延迟 · 从低到高</option>
              <option value="speed">实测速度 · 从高到低</option>
            </select>
          </label>
        </div>
        <div className="subscriptions-selection">
          <label>
            <input
              ref={selectAll}
              type="checkbox"
              checked={allVisibleSelected}
              disabled={!filtered.length}
              onChange={toggleVisible}
            />
            选择当前筛选的 {filtered.length} 个节点
          </label>
          <span>
            已选 {selectedNodes.length} 个
            {sort !== "name" ? " · 缺少该项实测值的节点排在最后" : ""}
          </span>
        </div>
        {nodes.length === 0 ? (
          <div className="subscriptions-empty">
            <Server size={30} />
            <h3>先添加你的节点</h3>
            <p>一份订阅可以包含多个地区的节点。导入后，你可以让视频走日本节点、国内音乐直连。</p>
            <details className="subscriptions-example">
              <summary>没有订阅？先看格式示例</summary>
              <p>下面只是格式示例，使用保留的 example.com 域名，不能连接网络。</p>
              <code>{DEMO_LINK}</code>
              <button type="button" className="button outline compact" onClick={() => void navigator.clipboard.writeText(DEMO_LINK).then(() => setMessage("已复制格式示例；这是不可连接的示例地址。"), () => setMessage("复制失败，请选中示例文本手动复制。"))}><Copy size={14} />复制格式示例</button>
            </details>
          </div>
        ) : filtered.length === 0 ? (
          <div className="subscriptions-empty">
            <Search size={26} />
            <p>没有符合当前搜索或协议筛选的节点。</p>
            <button
              type="button"
              className="text-button accent"
              onClick={() => {
                setSearch("");
                setProtocolFilter("all");
              }}
            >
              清除筛选
            </button>
          </div>
        ) : (
          <div
            className="subscriptions-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="节点列表，可横向滚动"
          >
            <table className="subscriptions-table">
              <thead>
                <tr>
                  <th scope="col">选择</th>
                  <th scope="col">节点 / 协议</th>
                  <th scope="col">入口主机 / 入口 IP</th>
                  <th scope="col">实际出口 / 归属</th>
                  <th scope="col">实测延迟</th>
                  <th scope="col">下载速度</th>
                  <th scope="col">约直线距离</th>
                  <th scope="col">检测状态</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => {
                  const measurement = measurements[item.id],
                    result = measurement?.result;
                  const distance =
                    origin &&
                    result?.latitude !== undefined &&
                    result.longitude !== undefined
                      ? haversineDistanceKm(origin, {
                          latitude: result.latitude,
                          longitude: result.longitude,
                        })
                      : undefined;
                  return (
                    <tr key={item.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择节点 ${item.name}`}
                          checked={selected.has(item.id)}
                          onChange={() =>
                            setSelected((previous) => {
                              const next = new Set(previous);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td>
                        <strong>{item.name}</strong>
                        <span className="subscriptions-protocol">
                          {item.protocol.toUpperCase()}
                        </span>
                        <button type="button" className="text-button accent subscriptions-use-node" onClick={() => onConfigureNodes(item.id)} aria-label={`将 ${item.name} 用于分流`}>用于分流 <ArrowRight size={13} /></button>
                      </td>
                      <td>
                        <code>
                          {item.server}:{item.port}
                        </code>
                        {result?.serverIps?.length ? (
                          <small>
                            入口解析：{result.serverIps.join(" / ")}
                          </small>
                        ) : (
                          <small>
                            入口 IP{" "}
                            {/^\d+(?:\.\d+){3}$/.test(item.server) ||
                            item.server.includes(":")
                              ? "同上"
                              : "尚未解析"}
                          </small>
                        )}
                      </td>
                      <td>
                        {result?.exitIp ? (
                          <>
                            <strong className="subscriptions-address">
                              {result.exitIp}
                            </strong>
                            <small>
                              {[result.country, result.region, result.city]
                                .filter(Boolean)
                                .join(" · ") || "地区未知"}
                            </small>
                            <small>
                              {[result.asn, result.organization]
                                .filter(Boolean)
                                .join(" · ") || "ASN / 机构未知"}
                            </small>
                            <span className="subscriptions-ip-type">
                              {TYPE_LABELS[result.ipType ?? "unknown"] ??
                                "类型未知"}
                            </span>
                          </>
                        ) : (
                          <span className="subscriptions-unmeasured">
                            尚无出口结果
                          </span>
                        )}
                      </td>
                      <td className="subscriptions-number">
                        {result?.latencyMs === undefined ? (
                          "—"
                        ) : (
                          <>
                            {result.latencyMs.toFixed(1)}
                            <small>ms · HTTPS</small>
                          </>
                        )}
                      </td>
                      <td className="subscriptions-number">
                        {result?.speedMbps === undefined ? (
                          "—"
                        ) : (
                          <>
                            {result.speedMbps.toFixed(2)}
                            <small>Mbps</small>
                            {result.downloadedBytes !== undefined && (
                              <small>
                                {(result.downloadedBytes / 1_000_000).toFixed(
                                  1,
                                )}{" "}
                                MB 样本
                              </small>
                            )}
                          </>
                        )}
                      </td>
                      <td className="subscriptions-number">
                        {distance === undefined ? (
                          <span className="subscriptions-unmeasured">
                            {origin ? "无出口坐标" : "未选起点"}
                          </span>
                        ) : (
                          <>
                            {Math.round(distance).toLocaleString()}
                            <small>km · 地理估算</small>
                          </>
                        )}
                      </td>
                      <td>
                        <span
                          className={`subscriptions-status ${result?.status ?? "pending"}`}
                        >
                          {!result
                            ? pendingProbeIds.has(item.id) ? queuePaused ? "等待恢复" : probeJob?.currentNodeId === item.id ? "正在检测" : "等待检测" : "未检测"
                            : result.status === "ok"
                              ? "已完成"
                              : "检测异常"}
                        </span>
                        {measurement && (
                          <small>{dateLabel(measurement.generatedAt)}</small>
                        )}
                        {result?.error && (
                          <p className="subscriptions-row-error">
                            {result.error}
                          </p>
                        )}
                        {result?.warnings?.length ? (
                          <details>
                            <summary>{result.warnings.length} 条说明</summary>
                            {result.warnings.map((warning, index) => (
                              <small key={index}>{warning}</small>
                            ))}
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div hidden={currentSection !== "live"} className="subscriptions-live" id="subscription-live">
        <div className="subscriptions-card-heading">
          <div><h3><Server size={18} />实时上下行</h3><p className="helper">连接你正在运行的 Mihomo，查看总速度和实际代理链路。</p></div>
          <span className="subscriptions-step-count" role="status">{monitorRunning ? liveSnapshot ? "正在连续采样" : "正在连接" : liveSnapshot ? "已停止 · 保留上次快照" : "尚未连接"}</span>
        </div>
        <p className="subscriptions-live-boundary">此功能适用于 Mihomo / Clash Meta。Shadowrocket 的实时流量和连接记录，请在小火箭客户端内查看。</p>
        <div className="subscriptions-actions">
          {monitorRunning ? <button type="button" className="button outline" onClick={() => setMonitorRunning(false)}><Square size={14} />停止实时监测</button> : <button type="button" className="button primary" onClick={() => { if (!helperCapabilities?.monitor) { setHelperOpen(true); return; } setMonitorError(""); setLiveSnapshot(undefined); setMonitorRunning(true); }}><RefreshCw size={15} />{helperCapabilities?.monitor ? "开始实时监测" : "连接助手后监测"}</button>}
        </div>
        {monitorError && <p className="subscriptions-inline-warning" role="alert">{monitorError}</p>}
        {liveSnapshot && <>
          <div className="subscriptions-live-metrics"><div><span>实时下载</span><strong>{rateLabel(liveSnapshot.downloadBytesPerSecond)}</strong></div><div><span>实时上传</span><strong>{rateLabel(liveSnapshot.uploadBytesPerSecond)}</strong></div><div><span>内核运行累计下载</span><strong>{formatBytes(Math.round(liveSnapshot.downloadedBytes))}</strong></div><div><span>内核运行累计上传</span><strong>{formatBytes(Math.round(liveSnapshot.uploadedBytes))}</strong></div></div>
          <p className="subscriptions-usage-source">来自本机 Mihomo · {dateLabel(liveSnapshot.observedAt)} · 内核统计，不等于订阅计费额度</p>
          {liveSnapshot.chains.length ? <div className="subscriptions-table-wrap" role="region" aria-label="实时代理链路，可横向滚动" tabIndex={0}><table className="subscriptions-live-table"><thead><tr><th>实际代理链路</th><th>活跃连接</th><th>下载增量速率</th><th>上传增量速率</th><th>活跃连接累计下载</th></tr></thead><tbody>{liveSnapshot.chains.map((chain) => <tr key={chain.name}><td>{chain.name}</td><td>{chain.connections}</td><td>{rateLabel(chain.downloadBytesPerSecond)}</td><td>{rateLabel(chain.uploadBytesPerSecond)}</td><td>{formatBytes(Math.round(chain.downloadedBytes))}</td></tr>)}</tbody></table></div> : <p className="subscriptions-usage-empty">内核当前没有活跃连接。通过该客户端访问网页后再看这里。</p>}
          <p className="helper">链路速率只统计相邻两次都活跃的连接；新连接等待下一次采样，已结束连接不会继续展示。代理链保留原名称，可能含多个节点。</p>
        </>}
      </div>

      <div hidden={currentSection !== "probe"} className="subscriptions-probe" id="subscription-probe">
        <div className="subscriptions-card-heading">
          <div>
            <h3>
              <Terminal size={18} />
              批量检测节点
            </h3>
            <p className="helper">
              由本地助手逐个连接节点，检测完成后直接出现在节点列表。
            </p>
          </div>
          <span className="subscriptions-step-count">最多 100 个 / 次</span>
        </div>
        <div className="subscriptions-actions subscriptions-run-actions">
          <button type="button" className="button primary" disabled={!selectedNodes.length || probeRunning} onClick={() => { enqueueProbe(selectedNodes); }}>{helperCapabilities?.probe.available ? <Search size={16} /> : <Link2 size={16} />}{helperCapabilities?.probe.available ? `检测选中节点（${selectedNodes.length}）` : "先连接本地助手"}</button>
          <button type="button" className="button outline" disabled={!nodes.length || probeRunning} onClick={() => enqueueProbe(nodes)}>检测全部 {nodes.length} 个节点</button>
          <button type="button" className="text-button accent" onClick={() => changeSection("library")}>查看节点与结果 <ArrowRight size={14} /></button>
        </div>
        {!nodes.length && <p className="subscriptions-usage-empty">还没有节点。<button type="button" className="text-button accent" onClick={() => changeSection("import")}>先导入订阅</button></p>}
        <p className="helper">每批最多 100 个，超过后自动分批完成。页面内切换功能会继续检测；关闭或刷新网页会丢失未提交队列，本地已开始的任务可能继续，请在助手中取消或关闭助手。</p>
        {probeJob && !probeInputs.current.has(probeJob.id) && probeJob.report.results.length > 0 && <details className="subscriptions-previous-results" open><summary>助手保留的上次结果（未关联当前节点）</summary><div className="subscriptions-table-wrap"><table className="subscriptions-live-table"><thead><tr><th>节点</th><th>出口 IP</th><th>延迟</th><th>下载速度</th><th>状态</th></tr></thead><tbody>{probeJob.report.results.map(result => <tr key={result.nodeId}><td>{result.name}</td><td>{result.exitIp ?? "未知"}</td><td>{result.latencyMs === undefined ? "未知" : `${result.latencyMs.toFixed(1)} ms`}</td><td>{result.speedMbps === undefined ? "未知" : `${result.speedMbps.toFixed(2)} Mbps`}</td><td>{result.status === "ok" ? "完成" : result.error ?? "检测异常"}</td></tr>)}</tbody></table></div></details>}
        <div className="subscriptions-probe-options">
          <label className="subscriptions-checkbox">
            <input
              type="checkbox"
              checked={speedTest}
              onChange={(event) => setSpeedTest(event.target.checked)}
            />
            <span>
              <strong>同时测下载速度</strong>
              <small>
                默认关闭。开启后每个节点最多下载 5 MB 测速样本
                {selectedNodes.length > 0
                  ? `，当前选中共约 ${selectedNodes.length * 5} MB`
                  : ""}
                ，另有连接与定位请求流量。
              </small>
            </span>
          </label>
          <div className="subscriptions-origin">
            <label
              className="subscriptions-field"
              htmlFor="subscription-origin"
            >
              <span>
                <MapPin size={14} />
                距离起点
              </span>
              <select
                id="subscription-origin"
                value={originId}
                onChange={(event) => setOriginId(event.target.value)}
              >
                <option value="">未选择起点</option>
                {ORIGINS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
                <option value="custom">自填坐标</option>
              </select>
            </label>
            {originId === "custom" && (
              <div className="subscriptions-coordinate-fields">
                <label>
                  纬度
                  <input
                    type="number"
                    min={-90}
                    max={90}
                    step="any"
                    value={latitude}
                    onChange={(event) => setLatitude(event.target.value)}
                    placeholder="-90 至 90"
                  />
                </label>
                <label>
                  经度
                  <input
                    type="number"
                    min={-180}
                    max={180}
                    step="any"
                    value={longitude}
                    onChange={(event) => setLongitude(event.target.value)}
                    placeholder="-180 至 180"
                  />
                </label>
              </div>
            )}
            {originId === "custom" && !origin && (
              <small className="subscriptions-inline-warning">
                请填写范围内的完整经纬度。
              </small>
            )}
          </div>
        </div>
        <details className="subscriptions-manual-fallback"><summary>手动文件方式（备用）</summary><p className="helper">浏览器连接本地助手受限时，可以下载任务在自己的电脑执行，再导入结果。</p>
        <div className="subscriptions-probe-steps">
          <div>
            <span>1</span>
            <strong>下载任务和检测器</strong>
            <p>任务包含选中节点的凭证，只交给自己的电脑。</p>
            <div className="subscriptions-actions">
              <button
                type="button"
                className="button primary"
                disabled={!selectedNodes.length || selectedNodes.length > 100}
                onClick={exportJob}
              >
                <Download size={16} />
                下载检测任务（{selectedNodes.length}）
              </button>
              <a
                className="button outline"
                href="/routekit_probe.py"
                download="routekit_probe.py"
              >
                <Download size={16} />
                下载检测器
              </a>
            </div>
            {selectedNodes.length > 100 && (
              <small className="subscriptions-inline-warning">
                请将选中数量减少到 100 个以内。
              </small>
            )}
          </div>
          <div>
            <span>2</span>
            <strong>在电脑上运行</strong>
            <p>需要 Python 3 + Mihomo；替换命令里的内核路径。</p>
            <div className="subscriptions-command">
              <code>{PROBE_COMMAND}</code>
              <button
                type="button"
                className="icon-button"
                aria-label="复制本地检测命令"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(PROBE_COMMAND);
                    setMessage(
                      "检测命令已复制，请替换 Mihomo 内核路径后运行。",
                    );
                  } catch {
                    setMessage("浏览器未允许复制，请手动选择上方命令。");
                  }
                }}
              >
                <Copy size={16} />
              </button>
            </div>
          </div>
          <div>
            <span>3</span>
            <strong>导入结果并排序</strong>
            <p>
              选择 routekit-results.json，关联当前节点。
            </p>
            <button
              type="button"
              className="button outline"
              disabled={!nodes.length}
              onClick={() => resultFile.current?.click()}
            >
              <Upload size={16} />
              导入检测结果 JSON
            </button>
          </div>
        </div>
        <input
          hidden
          ref={resultFile}
          type="file"
          accept=".json,application/json"
          aria-label="选择本地检测结果文件"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void importResults(file);
          }}
        />
        <div className="subscriptions-restore">
          <div>
            <strong>恢复原检测任务</strong>
            <p>
              导入原 routekit-job.json，将替换当前节点列表与检测结果。
            </p>
          </div>
          <button
            type="button"
            className="button outline"
            onClick={() => jobFile.current?.click()}
          >
            <FileUp size={16} />
            恢复检测任务（替换列表）
          </button>
        </div>
        <input
          hidden
          ref={jobFile}
          type="file"
          accept=".json,application/json"
          aria-label="选择原检测任务 JSON"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void restoreJob(file);
          }}
        />
        </details>
      </div>
      <details hidden={currentSection !== "import" && currentSection !== "usage"} className="subscriptions-help">
        <summary><Info size={15} />使用说明</summary>
        <div>
          <h3>导入与隐私</h3>
          <p>未保存的节点库仅在当前会话中，刷新网页后清空。已绑定到配置的节点，会随你显式保存的方案保留（含凭证）。读取订阅时只请求你填写的服务；跨域不允许时，可粘贴内容或导入节点文件，不经过转换服务器。节点链接和检测任务含有连接凭证，请作为私人文件保存。</p>
          <p>支持 SS、VMess、VLESS、Trojan、SOCKS5、HTTP / HTTPS 节点链接和 Base64 列表；最多 2 MB、500 个节点，也支持 Clash / Mihomo YAML 的节点部分，不导入原规则、策略组或远程 providers。不能保留的节点参数会明确报错。手动 SS 2022 节点需使用对应长度的 Base64 密钥。</p>
          <h3>订阅该怎么选</h3>
          <ul className="subscriptions-provider-checklist">
            <li><strong>先核费用：</strong>在服务商订单页核对首期价、续费价、退款条件与自动续费。</li>
            <li><strong>再核额度：</strong>确认上传是否计费、不同线路流量倍率、重置日、设备数和带宽限制。</li>
            <li><strong>按自己线路试：</strong>用自己的移动 / 联通 / 电信网络，在常用时段测试延迟、丢连接和下载；先短期试用。</li>
            <li><strong>核实来源：</strong>看服务商公开条款、隐私政策、联系方式和独立审计；“住宅 IP”“零日志”等标签需有证据。</li>
          </ul>
          <p>参考 <a href="https://ssd.eff.org/module/choosing-vpn-thats-right-you" target="_blank" rel="noopener noreferrer">EFF 的 VPN 选择指南</a>。本站不出售订阅；没有当前线路实测和可核对条款，就不把某家订阅标为“最好”。</p>
          <h3>流量与到期</h3>
          <p>用量只对应最近读取或手动填写的一份订阅，是服务商提供的快照。本站不累计或改写用量；测速经过代理时可能消耗套餐流量。点击「刷新流量与节点」查询新数据；当前订阅的增删会同步，相同连接保留分流引用，手动或其他来源节点保留。刷新地址只保存在本次会话中。</p>
          <p>跨域读取用量需服务商暴露 Access-Control-Expose-Headers: Subscription-Userinfo（<a href="https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers" target="_blank" rel="noopener noreferrer">浏览器规则</a>）。服务未提供或浏览器读不到时，数据保持未知，不代表没有用量、无限流量或永久有效。</p>
          <h3>实测与恢复</h3>
          <p>批量检测通过本地助手连接隔离的 Mihomo 内核，逐个返回出口 IP、延迟与性能。检测期间库里的节点被删除或连接凭证改变时，旧结果不会套用；手动文件流程作为备用。网页刷新后助手可能保留当前任务，但未提交的分批队列不会恢复。</p>
          <p>入口不等于出口。IP 位置与坐标是粗略信息，距离仅为地理直线估算，不能预测实际线路、质量或延迟；未知 IP 类型保持未知，不推断住宅属性。</p>
        </div>
      </details>
      {message && (
        <p className="subscriptions-message" role="status">
          <Check size={16} />
          {message}
        </p>
      )}
    </section>
  );
}
