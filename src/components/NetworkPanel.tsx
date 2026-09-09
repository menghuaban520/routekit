import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Copy,
  Globe2,
  Info,
  Play,
  ShieldCheck,
  Search,
  Square,
  Timer,
} from "lucide-react";
import { DNS_RECORD_TYPES, dnsQueryUrl, networkFailure, parseDnsResponse, prepareDnsQuery, type DnsQuery, type DnsRecordType, type DnsResult } from "../core/network-checks";
import "./toolbox.css";
import "./network-lab.css";

type Connection = {
  source: string;
  local: boolean;
  ip: string | null;
  ipVersion: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  asn: number | null;
  organization: string | null;
  colo: string | null;
  timestamp: string;
  tlsVersion: string | null;
};
type Phase = "connection" | "latency" | "speed";
export type NetworkSection = "overview" | "speed" | "host" | "leaks";
type NetworkPanelProps = { section?: NetworkSection; onSectionChange?: (section: NetworkSection) => void; active?: boolean };
type PhaseResult = { status: "running" | "passed" | "error" | "stopped"; message: string };
type ThroughputSample = { elapsedMs: number; mbps: number; receivedBytes: number };
type ProbeEvent = { id: number; at: string; text: string; tone: "data" | "info" | "error"; section: "overview" | "speed" };
const SPEED_BYTES = 5_000_000;
const SPEED_URL = "https://speed.cloudflare.com/__down";
const SAMPLE_INTERVAL = 100;
const PHASE_NAMES: Record<Phase, string> = { connection: "识别出口", latency: "测量延迟", speed: "接收下载样本" };
const PHASE_GUIDES: Record<Phase, string> = {
  connection: "确认网站看到的出口 IP 与地区。",
  latency: "向 Cloudflare 发送 3 次 HTTPS 请求，观察等待与波动。",
  speed: "接收 5 MB 样本，观察当前路径的下载表现。",
};
const clock = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
const decimal = (value: number | undefined, digits = 2) => value === undefined ? "—" : value.toFixed(digits);

function ThroughputChart({ samples }: { samples: ThroughputSample[] }) {
  const width = 680, height = 180, inset = 12;
  const maxRate = Math.max(1, ...samples.map((sample) => sample.mbps));
  const maxTime = Math.max(1, samples.at(-1)?.elapsedMs ?? 1);
  const points = samples.map((sample) => ({
    x: inset + (sample.elapsedMs / maxTime) * (width - inset * 2),
    y: height - inset - (sample.mbps / maxRate) * (height - inset * 2),
  }));
  return (
    <div className="lab-chart-wrap">
      <div className="lab-chart-scale"><span>{samples.length ? `${decimal(maxRate)} Mbps` : "Mbps"}</span><span>采样窗口 ≥ 100 ms · 末次除外</span></div>
      <svg className="lab-throughput-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`真实下载吞吐量曲线，${samples.length} 个采样点`} data-testid="throughput-samples" data-sample-count={samples.length}>
        {[0, 1, 2, 3].map((line) => <line key={line} x1={inset} x2={width - inset} y1={inset + line * (height - inset * 2) / 3} y2={inset + line * (height - inset * 2) / 3} className="lab-grid-line" />)}
        {points.length > 1 && <polygon points={`${points[0].x},${height - inset} ${points.map((point) => `${point.x},${point.y}`).join(" ")} ${points.at(-1)!.x},${height - inset}`} className="lab-chart-area" />}
        {points.length > 1 && <polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} className="lab-chart-line" />}
        {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={index === points.length - 1 ? 3.5 : 1.5} className="lab-chart-point"><title>{decimal(samples[index].elapsedMs / 1000)} s · {decimal(samples[index].mbps)} Mbps</title></circle>)}
      </svg>
      <div className="lab-chart-axis"><span>0 s</span><span>{samples.length ? `${decimal(maxTime / 1000)} s` : "—"}</span></div>
    </div>
  );
}

function LatencyChart({ samples }: { samples: number[] }) {
  const max = Math.max(1, ...samples);
  const points = samples.map((value, index) => ({ x: 42 + index * 100, y: 94 - value / max * 65 }));
  return (
    <div className="lab-latency-plot">
      <svg viewBox="0 0 284 122" role="img" aria-label={`HTTPS 请求延迟，已完成 ${samples.length} 次实测`} data-testid="latency-samples" data-sample-count={samples.length}>
        {[42, 142, 242].map((x) => <line key={x} x1={x} x2={x} y1={14} y2={100} className="lab-grid-line" />)}
        {points.length > 1 && <polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} className="lab-chart-line lab-latency-line" />}
        {points.map((point, index) => <g key={index}><circle cx={point.x} cy={point.y} r={4} className="lab-latency-dot" /><text x={point.x} y={point.y - 12} className="lab-latency-value">{samples[index]} ms</text></g>)}
        {[0, 1, 2].map((index) => <text key={index} x={42 + index * 100} y={118} className="lab-point-label">{String(index + 1).padStart(2, "0")}{samples[index] === undefined ? " · —" : ""}</text>)}
      </svg>
    </div>
  );
}

export default function NetworkPanel({ section, onSectionChange, active = true }: NetworkPanelProps = {}) {
  const [localSection, setLocalSection] = useState<NetworkSection>("overview");
  const view = section ?? localSection;
  function navigate(next: NetworkSection) {
    if (section === undefined) setLocalSection(next);
    onSectionChange?.(next);
  }
  const [connection, setConnection] = useState<Connection>();
  const [ipCopied, setIpCopied] = useState(false);
  const [samples, setSamples] = useState<number[]>([]);
  const [throughput, setThroughput] = useState<ThroughputSample[]>([]);
  const [liveRate, setLiveRate] = useState<number>();
  const [speed, setSpeed] = useState<number>();
  const [bytes, setBytes] = useState(0);
  const [busy, setBusy] = useState<Phase | "">("");
  const [errors, setErrors] = useState({ overview: "", speed: "" });
  const [ipAt, setIpAt] = useState(""), [latencyAt, setLatencyAt] = useState(""), [speedAt, setSpeedAt] = useState("");
  const [sampleAt, setSampleAt] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("尚未检测");
  const [speedStatus, setSpeedStatus] = useState("等待开始");
  const [events, setEvents] = useState<ProbeEvent[]>([]);
  const [phaseResults, setPhaseResults] = useState<Partial<Record<Phase, PhaseResult>>>({});
  const [hostInput, setHostInput] = useState("");
  const [recordType, setRecordType] = useState<DnsRecordType>("A");
  const [hostBusy, setHostBusy] = useState(false);
  const [hostError, setHostError] = useState("");
  const [hostResult, setHostResult] = useState<{ query: DnsQuery; result: DnsResult; ms: number; at: string }>();
  const dnsAbort = useRef<AbortController | null>(null);
  const eventId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => { abort.current?.abort(); dnsAbort.current?.abort(); }, []);
  useEffect(() => {
    // Changing categories or leaving the workspace must not keep using data.
    abort.current?.abort();
    dnsAbort.current?.abort();
  }, [view, active]);

  async function queryHost() {
    if (!active || dnsAbort.current) return;
    setHostResult(undefined); setHostError("");
    let query: DnsQuery;
    try { query = prepareDnsQuery(hostInput, recordType); }
    catch (reason) { setHostError(networkFailure("dns", reason)); return; }
    const controller = new AbortController();
    dnsAbort.current = controller;
    setHostBusy(true);
    const timer = setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), 12_000);
    const started = performance.now();
    try {
      const response = await fetch(dnsQueryUrl(query), { headers: { Accept: "application/dns-json" }, signal: controller.signal, cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error(`公共 DNS 服务返回 HTTP ${response.status}，请稍后重试。`);
      const result = parseDnsResponse(await response.json());
      controller.signal.throwIfAborted();
      setHostResult({ query, result, ms: Math.round(performance.now() - started), at: clock() });
    } catch (reason) {
      setHostError(networkFailure("dns", controller.signal.aborted ? controller.signal.reason : reason));
    } finally {
      clearTimeout(timer);
      if (dnsAbort.current === controller) dnsAbort.current = null;
      setHostBusy(false);
    }
  }

  function record(text: string, tone: ProbeEvent["tone"] = "info") {
    const entry: ProbeEvent = { id: ++eventId.current, at: clock(), text, tone, section: view === "speed" ? "speed" : "overview" };
    setEvents((previous) => [entry, ...previous].slice(0, 12));
  }

  async function measure(kind: Phase, controller: AbortController) {
    setBusy(kind);
    setPhaseResults((previous) => ({ ...previous, [kind]: { status: "running", message: PHASE_GUIDES[kind] } }));
    record(`${PHASE_NAMES[kind]} · 开始`);
    if (kind === "connection") {
      setConnection(undefined);
      setIpCopied(false);
      setIpAt("");
      const response = await fetch("/api/connection", { signal: controller.signal, cache: "no-store", credentials: "omit" });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
        throw new Error("当前站点未启用网络信息 API。Cloudflare Workers 部署支持此功能。");
      const data = (await response.json()) as Connection;
      controller.signal.throwIfAborted();
      if (data.source !== "cloudflare-request") throw new Error("网络信息响应无法识别。");
      if (data.local) throw new Error("本地开发环境不提供真实出口信息，请打开已部署的网站检测。");
      if (connection?.ip && connection.ip !== data.ip) {
        setSamples([]); setSpeed(undefined); setThroughput([]); setLiveRate(undefined); setBytes(0);
        setLatencyAt(""); setSpeedAt(""); setSampleAt(""); setSpeedStatus("等待重新测速");
        setErrors(previous => ({ ...previous, speed: "" }));
        record("本站观测 IP 已变化，旧测速结果已清除");
      }
      setConnection(data); setIpAt(clock()); setConnectionStatus("网站连接正常");
      record(`出口 ${data.ip ?? "未提供"}${data.colo ? ` · ${data.colo}` : ""}`, "data");
      return;
    }
    if (kind === "latency") {
      setSamples([]); setLatencyAt("");
      const times: number[] = [];
      for (let index = 0; index < 3; index++) {
        controller.signal.throwIfAborted();
        const start = performance.now();
        const response = await fetch(`${SPEED_URL}?bytes=0&nonce=${crypto.randomUUID()}`, { signal: controller.signal, cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new Error(`检测端点返回 HTTP ${response.status}`);
        await response.arrayBuffer();
        controller.signal.throwIfAborted();
        const elapsed = Math.round(performance.now() - start);
        times.push(elapsed); setSamples([...times]); setLatencyAt(clock());
        record(`延迟 ${index + 1}/3 · ${elapsed} ms`, "data");
      }
      setConnectionStatus("HTTPS 连通正常");
      return;
    }

    setSpeed(undefined); setBytes(0); setSpeedAt(""); setSampleAt(""); setThroughput([]); setLiveRate(undefined);
    const start = performance.now();
    let received = 0, lastBytes = 0, lastTime = start;
    let pendingSample: ReturnType<typeof setTimeout> | undefined;
    const points: ThroughputSample[] = [];
    function flush(force = false) {
      if (force && pendingSample !== undefined) {
        clearTimeout(pendingSample);
        pendingSample = undefined;
      }
      const now = performance.now(), elapsed = now - lastTime;
      if (received === lastBytes || elapsed <= 0) return;
      if (!force && elapsed < SAMPLE_INTERVAL) {
        if (pendingSample === undefined) pendingSample = setTimeout(() => {
          pendingSample = undefined;
          flush();
        }, Math.ceil(SAMPLE_INTERVAL - elapsed));
        return;
      }
      if (pendingSample !== undefined) {
        clearTimeout(pendingSample);
        pendingSample = undefined;
      }
      const mbps = (received - lastBytes) * 8 / elapsed / 1000;
      points.push({ elapsedMs: now - start, mbps, receivedBytes: received });
      lastTime = now; lastBytes = received;
      setThroughput([...points]); setLiveRate(mbps); setBytes(received); setSampleAt(clock());
    }
    try {
      const response = await fetch(`${SPEED_URL}?bytes=${SPEED_BYTES}&nonce=${crypto.randomUUID()}`, { signal: controller.signal, cache: "no-store", credentials: "omit" });
      if (!response.ok || !response.body) throw new Error("测速端点暂不可用。");
      const reader = response.body.getReader();
      try {
        while (true) {
          controller.signal.throwIfAborted();
          const part = await reader.read();
          controller.signal.throwIfAborted();
          if (part.done) break;
          received += part.value.byteLength;
          if (received > SPEED_BYTES) {
            await reader.cancel();
            throw new Error("响应超过测速流量上限，已停止。");
          }
          flush();
        }
      } finally { reader.releaseLock(); }
      flush(true);
      if (received !== SPEED_BYTES) throw new Error("测速内容未完整下载，不生成速度结论。");
      const seconds = (performance.now() - start) / 1000;
      if (seconds <= 0) throw new Error("计时结果无效，请重试。");
      const average = received * 8 / seconds / 1_000_000;
      setSpeed(average); setSpeedAt(clock()); setSpeedStatus("下载连通正常");
      record(`完整接收 5 MB · 均值 ${decimal(average)} Mbps`, "data");
    } finally {
      flush(true);
      setLiveRate(undefined);
    }
  }

  async function run(kind: Phase | "overview") {
    if (!active || abort.current) return;
    const scope = kind === "speed" ? "speed" : "overview";
    const controller = new AbortController();
    abort.current = controller;
    setErrors(previous => ({ ...previous, [scope]: "" }));
    if (scope === "speed") setSpeedStatus("测速进行中");
    else setConnectionStatus("检测进行中");
    const failures: string[] = [];
    const phases: Phase[] = kind === "overview" ? ["connection", "latency"] : [kind];
    setPhaseResults((previous) => Object.fromEntries(Object.entries(previous).filter(([phase]) => !phases.includes(phase as Phase))));
    try {
      for (const phase of phases) {
        const timer = setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), phase === "speed" ? 30_000 : 18_000);
        try {
          await measure(phase, controller);
          const message = phase === "connection" ? "本站已收到连接并返回出口信息。" : phase === "latency" ? "3 次 HTTPS 请求已完成；下方查看平均延迟与波动。" : "5 MB 完整下载；下方查看有限样本的平均吞吐量。";
          setPhaseResults((previous) => ({ ...previous, [phase]: { status: "passed", message } }));
        }
        catch (reason) {
          const failure = controller.signal.aborted ? controller.signal.reason : reason;
          const message = networkFailure(phase, failure);
          const stopped = controller.signal.aborted && failure instanceof DOMException && failure.name === "AbortError";
          setPhaseResults((previous) => ({ ...previous, [phase]: { status: stopped ? "stopped" : "error", message } }));
          failures.push(message); setErrors(previous => ({ ...previous, [scope]: failures.join(" ") }));
          record(`${PHASE_NAMES[phase]} · ${message}`, "error");
          if (controller.signal.aborted) break;
        } finally { clearTimeout(timer); }
      }
    } finally {
      if (failures.length) {
        if (scope === "speed") setSpeedStatus(controller.signal.aborted ? "测速已停止" : "测速未完成");
        else setConnectionStatus(controller.signal.aborted ? "检测已停止" : "部分项目未完成");
      }
      if (abort.current === controller) abort.current = null;
      setBusy(""); setLiveRate(undefined);
    }
  }

  const average = samples.length === 3 ? Math.round(samples.reduce((a, b) => a + b, 0) / 3) : undefined;
  const jitter = samples.length === 3 ? Math.max(...samples) - Math.min(...samples) : undefined;
  const location = connection ? [connection.country, connection.region, connection.city].filter(Boolean).join(" · ") || "地区未提供" : "—";
  const organization = connection ? [connection.asn == null ? undefined : `AS${connection.asn}`, connection.organization].filter(Boolean).join(" · ") || "未提供" : "—";
  function eventList(category: "overview" | "speed") {
    const entries = events.filter(event => event.section === category);
    return <details className="lab-records"><summary><Activity size={15} />{category === "speed" ? "测速记录" : "检测记录"}<span>{entries.length} 条</span></summary><ol className="lab-event-list">{entries.length ? entries.map(event => <li key={event.id} data-tone={event.tone}><time>{event.at}</time><i /><span>{event.text}</span></li>) : <li className="lab-event-empty">还没有记录，点击上方按钮开始。</li>}</ol></details>;
  }
  const measurementView = view === "overview" || view === "speed";
  return (
    <section className="network-lab" data-section={view}>
      {section === undefined && <nav className="lab-view-navigation" aria-label="网络检查工具">
        {([{ key: "overview", label: "网络概览", icon: Activity }, { key: "speed", label: "速度测试", icon: ArrowDownToLine }, { key: "host", label: "主机查询", icon: Search }, { key: "leaks", label: "泄漏检查", icon: ShieldCheck }] as const).map(({ key, label, icon: Icon }) => <button key={key} aria-current={view === key ? "page" : undefined} aria-controls={`network-${key}`} onClick={() => navigate(key)}><Icon size={18} />{label}</button>)}
      </nav>}
      {measurementView && <>
        <div className="lab-setup"><div><h2>{view === "speed" ? "测一段真实的下载速度" : "当前出口与连通性"}</h2><p>{view === "speed" ? "接收 5 MB 样本，看实时速度与曲线。先连接要测试的节点，再开始。" : "查看网站看到的 IP，并用 3 次 HTTPS 请求检查当前连接。测试节点前，请先在小火箭中连接它。"}</p></div></div>
        <div className="lab-toolbar">
          {view === "overview" ? <><button className="button primary lab-start" disabled={!!busy} onClick={() => void run("overview")}><Play size={16} />开始检测</button><div className="lab-individual-actions"><button className="button outline" disabled={!!busy} onClick={() => void run("connection")}><Globe2 size={15} />查看当前 IP</button><button className="button outline" disabled={!!busy} onClick={() => void run("latency")}><Timer size={15} />测延迟与连通</button></div></> : <><button className="button primary lab-start" disabled={!!busy} onClick={() => void run("speed")}><ArrowDownToLine size={16} />下载测速 · 5 MB</button><span className="lab-sample-budget">最多 5 MB · 可随时停止</span></>}
          {busy && <button className="button lab-stop" onClick={() => abort.current?.abort()}><Square size={12} />停止检测</button>}
          <div className={`lab-phase ${busy ? "is-running" : ""}`} data-testid="network-phase" data-phase={busy || "idle"} role="status"><i />{busy ? PHASE_NAMES[busy] : view === "speed" ? speedStatus : connectionStatus}</div>
        </div>
      </>}
      <div id="network-overview" hidden={view !== "overview"}>
      <div className="lab-identity">
        <div className="lab-ip-block"><span className="lab-label"><Globe2 size={14} />本站观测 IP <span className="lab-target">→ 当前网站</span></span><strong className={`lab-ip ${connection?.ip ? "has-data" : ""}`}>{connection?.ip ?? "—"}</strong><div className="lab-ip-meta"><span>{connection?.ipVersion ?? "IP"}</span><span>{ipAt ? `${ipAt} 快照` : "等待查询"}</span><button className="lab-copy-ip" aria-label={ipCopied ? "IP 已复制" : "复制当前 IP"} disabled={!connection?.ip} onClick={() => { if (connection?.ip) void navigator.clipboard.writeText(connection.ip).then(() => setIpCopied(true)).catch(() => record("无法访问剪贴板，可选中 IP 手动复制", "error")); }}>{ipCopied ? <Check size={12} /> : <Copy size={12} />}{ipCopied ? "已复制" : "复制"}</button></div></div>
        <dl className="lab-identity-details"><div><dt>地区 · 粗略定位</dt><dd>{location}</dd></div><div><dt>ASN / 网络组织</dt><dd>{organization}</dd></div><div className="lab-edge-row"><div><dt>边缘节点</dt><dd>{connection?.colo ?? "—"}</dd></div><div><dt>TLS</dt><dd>{connection?.tlsVersion ?? "—"}</dd></div></div></dl>
      </div>
        {errors.overview && <div className="lab-alert" role="alert"><Info size={16} /><span>{errors.overview}</span></div>}
        <div className="lab-overview-grid">
        <article className="lab-latency-panel">
          <div className="lab-panel-heading"><span className="lab-label"><Timer size={14} />HTTPS 请求延迟</span><span className="lab-sample-count">{samples.length}<small> / 3</small></span></div>
          <div className="lab-latency-main"><strong className={average !== undefined ? "has-data" : ""}>{average ?? "—"}<em>ms</em></strong><span>三次均值</span></div>
          <LatencyChart samples={samples} />
          <div className="lab-latency-footer"><span>波动范围 <b>{jitter ?? "—"}</b> ms</span><time>{latencyAt || "—"}</time></div>
          <p className="lab-result-note">Cloudflare Speed · HTTPS</p>
        </article>
          <section className="lab-connectivity-panel" aria-label="连通性进展">
            <div className="lab-panel-heading"><span className="lab-label"><Activity size={16} />连通性进展</span><span className="lab-target">本次检测</span></div>
            <ol className="lab-check-sequence" aria-label="检测顺序与结果">
              {(["connection", "latency"] as const).map((phase, index) => {
                const result = phaseResults[phase];
                return <li key={phase} data-status={result?.status ?? "idle"}><span className="lab-step-number">{result?.status === "passed" ? <Check size={16} /> : index + 1}</span><div><h3>{["本站出口", "HTTPS 连通"][index]}<span>{({ running: "进行中", passed: "已完成", error: "需检查", stopped: "已停止", idle: "待检测" })[result?.status ?? "idle"]}</span></h3><p>{result?.message ?? PHASE_GUIDES[phase]}</p></div></li>;
              })}
            </ol>
            <p className="lab-result-note">IP 与延迟目标可能走不同分流规则；这里的耗时不是 ICMP Ping，也无法定位到某个路由跳点。</p>
          </section>
        </div>
        <div className="lab-next-actions" aria-label="继续检查"><button onClick={() => navigate("speed")}><ArrowDownToLine size={18} /><span><strong>继续测下载速度</strong><small>单独接收 5 MB 样本</small></span><ArrowUpRight size={16} /></button><button onClick={() => navigate("host")}><Search size={18} /><span><strong>查一个域名或 IP</strong><small>公共 DNS 记录与 TTL</small></span><ArrowUpRight size={16} /></button><button onClick={() => navigate("leaks")}><ShieldCheck size={18} /><span><strong>检查 DNS / IP 泄漏</strong><small>对照出口与解析路径</small></span><ArrowUpRight size={16} /></button></div>
        {eventList("overview")}
        <details className="lab-methods"><summary><Info size={14} />结果怎么理解</summary><div><p>本站 IP 是访问本网站时的出口快照，延迟请求发往 Cloudflare Speed；它们可能匹配不同分流规则。IP 没变化时，先检查本站是否设置为直连；延迟高或波动明显时，换节点再用同样方式对比。</p><p>地区和 ASN 是粗略网络信息，不能单独证明住宅、机房或 IP 信誉。“开始检测”只查询 IP 与 3 次 HTTPS 请求，不执行 5 MB 下载。对订阅里的各个节点逐个检测，请使用“订阅与节点”的本地检测器。</p></div></details>
      </div>
      <div id="network-speed" hidden={view !== "speed"}>
        {errors.speed && <div className="lab-alert" role="alert"><Info size={16} /><span>{errors.speed}</span></div>}
        <div className="lab-speed-layout">
        <article className="lab-download-panel">
          <div className="lab-panel-heading"><span className="lab-label"><ArrowDownToLine size={14} />下载数据流</span><span className="lab-target">Cloudflare Speed</span></div>
          <div className="lab-rate-row">
            <div><span className="lab-readout-label">{busy === "speed" ? "当前采样" : "样本均值"}</span><strong className={(busy === "speed" ? liveRate : speed) !== undefined ? "has-data" : ""}>{decimal(busy === "speed" ? liveRate : speed)}<em>Mbps</em></strong><span className="lab-byte-rate">≈ {decimal((busy === "speed" ? liveRate : speed) === undefined ? undefined : (busy === "speed" ? liveRate! : speed!) / 8)} MB/s</span></div>
            <div className="lab-download-count"><span data-testid="download-received" data-bytes={bytes}>{decimal(bytes / 1_000_000)}<small> / 5 MB</small></span><progress aria-label="下载接收进度" value={Math.min(bytes, SPEED_BYTES)} max={SPEED_BYTES} /></div>
          </div>
          <ThroughputChart samples={throughput} />
          <div className="lab-download-summary"><span>实时 <b data-testid="throughput-live">{decimal(liveRate)}</b> Mbps</span><span>均值 <b data-testid="throughput-final">{decimal(speed)}</b> Mbps</span><time>{speedAt || sampleAt || "—"}</time></div>
          <p className="lab-result-note">{speed === undefined ? "5 MB 有限样本 · 点击后接收" : "5 MB 样本吞吐量，非带宽上限"}</p>
        </article>
          <aside className="lab-speed-guide"><h3>数值怎么看</h3><p><strong>Mbps 是每秒兆比特。</strong>下方的 MB/s 是同一结果换算成的每秒兆字节：8 Mbps = 1 MB/s。</p><dl><div><dt>测试目标</dt><dd>Cloudflare Speed</dd></div><div><dt>样本大小</dt><dd>5,000,000 字节</dd></div><div><dt>完成条件</dt><dd>完整接收才生成均值</dd></div></dl><p>网络空闲时更易对比。切换节点后重新测速；切换分类或离开网络检查会停止当前请求。</p><button className="lab-text-button" onClick={() => navigate("overview")}>查看出口与延迟 <ArrowUpRight size={15} /></button></aside>
        </div>
        {eventList("speed")}
        <details className="lab-methods"><summary><Info size={14} />测速范围与流量</summary><div><p>曲线由真实收到的字节与时间计算，每 100 ms 至多更新一次，结束时补记最后一段。平均吞吐量包含请求等待时间；5 MB 是有限样本，不能代表线路带宽上限，也不是上传速度。</p><p>经过代理时可能消耗套餐流量；测速不会在后台循环。停止或失败会保留已收到的样本，但不会生成完成均值。再次开始会清空本轮旧样本。</p></div></details>
      </div>
      <div id="network-host" hidden={view !== "host"} className="lab-host-view">
        <div className="lab-setup"><div><h2>主机解析，先确认地址对不对</h2><p>输入节点的服务器地址或网站域名，查看公共 DNS 的答复。输入公网 IP 会自动查询反向主机名。</p></div></div>
        <form className="lab-host-form" onSubmit={(event) => { event.preventDefault(); void queryHost(); }}>
          <label>公网域名或 IP<input value={hostInput} onChange={(event) => { setHostInput(event.target.value); setHostResult(undefined); setHostError(""); }} placeholder="例如 example.com 或 1.1.1.1" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={253} disabled={hostBusy} /></label>
          <label>记录类型<select value={recordType} onChange={(event) => { setRecordType(event.target.value as DnsRecordType); setHostResult(undefined); }} disabled={hostBusy}>{DNS_RECORD_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
          <button type="submit" className="button primary" disabled={hostBusy || !hostInput.trim()}><Search size={17} />{hostBusy ? "正在查询" : "查询主机"}</button>
          {hostBusy && <button type="button" className="button outline" onClick={() => dnsAbort.current?.abort()}>停止查询</button>}
        </form>
        <p className="lab-host-privacy">点击查询后，仅把填写的域名或 IP 发给 Cloudflare 公共 DNS。不要粘贴订阅链接或密码。</p>
        {hostError && <div className="lab-alert" role="alert"><Info size={16} /><span>{hostError}</span></div>}
        {hostBusy && <p className="lab-host-wait" role="status">正在等待公共 DNS 答复，最多等待 12 秒…</p>}
        {hostResult && <section className="lab-host-results" aria-label="主机查询结果"><div className="lab-host-summary"><div><h3>{hostResult.query.display}</h3><p>{hostResult.result.message}</p></div><dl><div><dt>类型</dt><dd>{hostResult.query.type}</dd></div><div><dt>查询耗时</dt><dd>{hostResult.ms} ms</dd></div><div><dt>查询时间</dt><dd>{hostResult.at}</dd></div><div><dt>DNSSEC 验证</dt><dd>{hostResult.result.authenticated ? "已验证" : "未标记"}</dd></div></dl></div>{hostResult.result.answers.length > 0 && <div className="lab-dns-table-wrap"><table className="lab-dns-table"><thead><tr><th>记录 / 名称</th><th>答复</th><th>TTL</th></tr></thead><tbody>{hostResult.result.answers.map((answer, index) => <tr key={index}><td><b>{answer.type}</b><span>{answer.name}</span></td><td>{answer.data}</td><td>{answer.ttl} 秒</td></tr>)}</tbody></table></div>}</section>}
        {!hostResult && !hostBusy && !hostError && <div className="lab-host-empty"><Search size={28} /><h3>先填一个想查的地址</h3><p>如要排查节点，复制节点详情中的服务器地址；如要排查应用，填写它实际访问的域名。</p><button className="lab-text-button" onClick={() => { setHostInput("example.com"); setHostError(""); }}>填入示例域名</button></div>}
        <div className="lab-host-guides"><article><h3>记录怎么看</h3><p><b>A / AAAA</b> 分别是 IPv4 / IPv6 地址；<b>CNAME</b> 是别名；<b>PTR</b> 是 IP 的反向主机名。TTL 是此记录可缓存的秒数。</p></article><article><h3>能解析，不等于能连接</h3><p>这里的耗时是一次 DoH 查询时间，不是到目标主机的 Ping。公共 DNS 答复也不等同于小火箭实际使用的解析结果。</p></article></div>
        <details className="lab-methods"><summary><Info size={14} />解析正常，但仍然打不开？</summary><div><p>检查节点端口、协议与 TLS 参数是否与提供方一致，再查看应用域名匹配哪条分流规则。网页不能进行 ICMP Ping 或直接验证任意代理端口；请用小火箭内的节点测试或“订阅与节点”的本地检测器继续排查。</p><p>部分 IP 未设置 PTR，查询不到主机名不代表 IP 不可用。公共 DNS 返回不同地区的 CDN 地址也可能是正常调度。<a href="https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/" target="_blank" rel="noreferrer">查看 Cloudflare 解析字段说明 <ArrowUpRight size={13} /></a></p></div></details>
      </div>
      <div id="network-leaks" hidden={view !== "leaks"} className="lab-leaks-view">
        <div className="lab-setup"><div><h2>泄漏检查，要对照结果才算完成</h2><p>先记下直连时的公网 IP 与运营商，再连接小火箭、选择要验证的节点，在同一个浏览器运行下面的检查。</p></div></div>
        <div className="lab-leak-baseline"><Globe2 size={20} /><div><strong>本站最近一次观测：{connection?.ip ?? "尚未查询"}</strong><span>{ipAt ? `${ipAt} · ${location}` : "可在「网络概览」查询，再与外部测试的结果对照。"}</span></div><button className="button outline" onClick={() => navigate("overview")}>查看当前连接</button></div>
        <div className="lab-leak-cards">
          <article><span className="lab-tool-type">DNS</span><h3>DNS 请求交给了谁？</h3><ol><li>打开测试站，运行 DNS 测试；dnsleaktest 可选择 Extended test。</li><li>查看 DNS 服务器列表，核对是否符合自己配置的解析服务。</li><li>若要求 DNS 也走代理，却出现直连运营商解析器，检查小火箭的 DNS 与分流设置。</li></ol><p>解析器与出口 IP 不同很常见；仅凭国家不同不能判断泄漏。浏览器安全 DNS 也可能改变结果。</p><div className="lab-leak-links"><a href="https://www.dnsleaktest.com/" target="_blank" rel="noreferrer">DNS 泄漏测试 <ArrowUpRight size={15} /></a><a href="https://browserleaks.com/dns" target="_blank" rel="noreferrer">交叉检查 DNS <ArrowUpRight size={15} /></a></div></article>
          <article><span className="lab-tool-type">WebRTC</span><h3>浏览器有没有暴露直连 IP？</h3><ol><li>连接代理后打开 WebRTC 测试。</li><li>对照 Remote IP 与 WebRTC Public IP，查看是否出现直连时的公网 IP。</li><li>如果直连公网 IP 仍被列出，再检查客户端 UDP 路由与浏览器 WebRTC 设置。</li></ol><p>本地私有地址或 .local 名称不能单独证明公网 IP 泄漏；WebRTC 不可用也不代表所有流量都受保护。</p><div className="lab-leak-links"><a href="https://browserleaks.com/webrtc" target="_blank" rel="noreferrer">WebRTC IP 暴露 <ArrowUpRight size={15} /></a></div></article>
          <article><span className="lab-tool-type">IPv6</span><h3>IPv6 是否走了预期路径？</h3><ol><li>保持小火箭连接，打开 IPv6 可用性测试。</li><li>查看它识别到的 IPv4 / IPv6 地址和网络提供方。</li><li>若 IPv6 显示直连运营商，而你希望全部代理，核对节点的 IPv6 支持与客户端设置。</li></ol><p>“IPv6 可用”只说明连通性，不能直接等同于“没有泄漏”。分别验证两种地址的出口。</p><div className="lab-leak-links"><a href="https://test-ipv6.com/" target="_blank" rel="noreferrer">IPv6 可用性 <ArrowUpRight size={15} /></a></div></article>
        </div>
        <p className="lab-leak-boundary"><Info size={17} />外部站点会看到访问它们的 IP。结果需在检测页核对，RouteKit 不会把“已打开”标记为“已通过”。</p>
      </div>
    </section>
  );
}
