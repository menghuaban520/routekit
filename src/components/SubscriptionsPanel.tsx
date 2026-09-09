import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
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
    throw new Error("浏览器无法流式读取订阅，请下载 .txt 文件后导入");
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

export default function SubscriptionsPanel() {
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
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
  const [usage, setUsage] = useState<UsageSnapshot>(),
    [manualHeader, setManualHeader] = useState("");
  const nodeFile = useRef<HTMLInputElement>(null),
    resultFile = useRef<HTMLInputElement>(null),
    jobFile = useRef<HTMLInputElement>(null),
    selectAll = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => () => abort.current?.abort(), []);

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

  function addParsed(parsed: SubscriptionResult, importMode: ImportMode) {
    setMessage("");
    if (!parsed.nodes.length) {
      setNotice({
        title: "没有可导入的节点，当前列表保持不变",
        errors: parsed.errors,
        warnings: parsed.warnings,
      });
      return;
    }
    if (importMode === "replace") {
      setNodes(parsed.nodes);
      setSelected(new Set(parsed.nodes.map((item) => item.id)));
      setMeasurements({});
      setNotice({
        title: `已替换为 ${parsed.nodes.length} 个节点`,
        errors: parsed.errors,
        warnings: parsed.warnings,
      });
      return;
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
    setNodes((previous) => [...previous, ...added]);
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
  }

  async function fetchSubscription() {
    const requestedUrl = subscriptionUrl.trim();
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
      const rawHeader = response.headers.get("subscription-userinfo");
      setUsage({
        data: parseSubscriptionUsage(rawHeader ?? ""),
        source: "header",
        capturedAt: new Date().toISOString(),
        headerVisible: rawHeader !== null,
        origin: redactSubscriptionUrl(requestedUrl),
        rawHeader: rawHeader ?? "",
      });
      if (response.headers.get("content-type")?.includes("text/html"))
        throw new Error(
          "订阅返回了网页，请使用订阅的节点文本链接或导入 .txt 文件",
        );
      const content = await limitedResponseText(response);
      addParsed(parseSubscription(content), mode);
      setFetchedSource(
        `${redactSubscriptionUrl(requestedUrl)} · ${new Date().toLocaleTimeString("zh-CN")}`,
      );
    } catch (error) {
      const explanation = controller.signal.aborted
        ? "读取已取消或超过 15 秒。你可以下载订阅 .txt 文件，再从本地导入。"
        : error instanceof TypeError
          ? "浏览器未能读取订阅。服务可能未开放 CORS、存在重定向或网络不可用；请手动下载 .txt 文件，或粘贴节点内容。"
          : error instanceof Error
            ? error.message
            : "读取失败，请改用粘贴或文件导入。";
      setNotice({ title: "订阅尚未读取", errors: [explanation], warnings: [] });
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
    setNodes((previous) => previous.filter((item) => !selected.has(item.id)));
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
      <div className="section-heading subscriptions-heading">
        <div>
          <h2>订阅与节点</h2>
          <p>查看用量，整理节点，比较实测结果。</p>
        </div>
        <span className="subscriptions-local">
          <ShieldCheck size={16} />
          刷新后清空
        </span>
      </div>
      <div className="subscriptions-usage">
        <div className="subscriptions-card-heading">
          <div>
            <h3>
              <ArrowDownToLine size={18} />
              订阅流量与到期
            </h3>
          </div>
          <span className="subscriptions-step-count">
            {!usage
              ? "尚未读取"
              : usage.source === "manual"
                ? "手动提供的数据"
                : usage.headerVisible
                  ? "服务商响应头"
                  : "响应头不可见"}
          </span>
        </div>
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
        {usage && (
          <p className="subscriptions-usage-source">
            {usage.source === "manual" ? "手动录入" : `来自 ${usage.origin}`} ·
            {dateLabel(usage.capturedAt)} 快照 ·
            {usage.source === "header" && !usage.headerVisible
              ? "用量头不可见，缺失数据未知。"
              : "重新读取后更新"}
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

      <div className="subscriptions-import">
        <div className="subscriptions-card-heading">
          <h3>
            <Link2 size={18} />
            添加节点
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
            个节点，并清除它们的检测结果；没有有效节点时保留列表。
          </p>
        )}
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
              onClick={fetchSubscription}
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
        {fetchedSource && (
          <p className="helper subscriptions-source">最近读取：{fetchedSource}</p>
        )}
        <label className="subscriptions-field" htmlFor="subscription-paste">
          节点链接或 Base64 内容
          <textarea
            id="subscription-paste"
            rows={3}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="每行一条节点链接，或粘贴 Base64 订阅"
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
            导入 .txt 文件
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
          accept=".txt,text/plain"
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

      <div className="subscriptions-library">
        <div className="subscriptions-card-heading">
          <h3>
            <Server size={18} />
            节点列表{" "}
            <span>
              {nodes.length} 个 · {measuredCount} 个已有结果
            </span>
          </h3>
          <div className="subscriptions-actions">
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
            <p>导入节点后，列表和实测结果会显示在这里。</p>
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
                            ? "未检测"
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

      <div className="subscriptions-probe">
        <div className="subscriptions-card-heading">
          <div>
            <h3>
              <Terminal size={18} />
              节点实测
            </h3>
            <p className="helper">
              在自己的电脑执行，再导回结果。
            </p>
          </div>
          <span className="subscriptions-step-count">最多 100 个 / 次</span>
        </div>
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
      </div>
      <details className="subscriptions-help">
        <summary><Info size={15} />使用说明</summary>
        <div>
          <h3>导入与隐私</h3>
          <p>节点仅留在当前页面内存，刷新后清空，不上传到 RouteKit。读取订阅时只请求你填写的服务；跨域不允许时，可粘贴内容或导入 .txt 文件，不经过转换服务器。节点链接和检测任务含有连接凭证，请作为私人文件保存。</p>
          <p>支持 SS、VMess、VLESS、Trojan、SOCKS5、HTTP / HTTPS 节点链接和 Base64 列表；最多 2 MB、500 个节点，暂不解析 Clash YAML。手动 SS 2022 节点需使用对应长度的 Base64 密钥。</p>
          <h3>流量与到期</h3>
          <p>用量只对应最近读取或手动填写的一份订阅，是服务商提供的快照。本站不累计或改写用量；测速经过代理时可能消耗套餐流量。重新读取订阅才能获得新数据。</p>
          <p>跨域读取用量需服务商暴露 Access-Control-Expose-Headers: Subscription-Userinfo。服务未提供或浏览器读不到时，数据保持未知，不代表没有用量、无限流量或永久有效。</p>
          <h3>实测与恢复</h3>
          <p>浏览器无法逐个切换这些代理。检测任务由你自己的 Python + Mihomo 检测器运行；导入结果只关联当前节点，不自动添加节点。刷新后先恢复原 routekit-job.json 中的节点和 ID，再导入结果。</p>
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
