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
  Square,
  Timer,
} from "lucide-react";
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
type ThroughputSample = { elapsedMs: number; mbps: number; receivedBytes: number };
type ProbeEvent = { id: number; at: string; text: string; tone: "data" | "info" | "error" };
const SPEED_BYTES = 5_000_000;
const SPEED_URL = "https://speed.cloudflare.com/__down";
const SAMPLE_INTERVAL = 100;
const PHASE_NAMES: Record<Phase, string> = { connection: "识别出口", latency: "测量延迟", speed: "接收下载样本" };
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

export default function NetworkPanel() {
  const [connection, setConnection] = useState<Connection>();
  const [ipCopied, setIpCopied] = useState(false);
  const [samples, setSamples] = useState<number[]>([]);
  const [throughput, setThroughput] = useState<ThroughputSample[]>([]);
  const [liveRate, setLiveRate] = useState<number>();
  const [speed, setSpeed] = useState<number>();
  const [bytes, setBytes] = useState(0);
  const [busy, setBusy] = useState<Phase | "">("");
  const [error, setError] = useState("");
  const [ipAt, setIpAt] = useState(""), [latencyAt, setLatencyAt] = useState(""), [speedAt, setSpeedAt] = useState("");
  const [sampleAt, setSampleAt] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("尚未探测");
  const [events, setEvents] = useState<ProbeEvent[]>([]);
  const eventId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  function record(text: string, tone: ProbeEvent["tone"] = "info") {
    const entry = { id: ++eventId.current, at: clock(), text, tone };
    setEvents((previous) => [entry, ...previous].slice(0, 12));
  }

  async function measure(kind: Phase, controller: AbortController) {
    setBusy(kind);
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
        setLatencyAt(""); setSpeedAt(""); setSampleAt("");
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
      setSpeed(average); setSpeedAt(clock()); setConnectionStatus("下载连通正常");
      record(`完整接收 5 MB · 均值 ${decimal(average)} Mbps`, "data");
    } finally {
      flush(true);
      setLiveRate(undefined);
    }
  }

  async function run(kind: Phase | "all") {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setError(""); setConnectionStatus("探测进行中");
    const errors: string[] = [];
    const phases: Phase[] = kind === "all" ? ["connection", "latency", "speed"] : [kind];
    try {
      for (const phase of phases) {
        const timer = setTimeout(() => controller.abort(), phase === "speed" ? 30_000 : 18_000);
        try { await measure(phase, controller); }
        catch (reason) {
          const message = controller.signal.aborted ? "检测已停止或超时，尚未完成的结果不作结论。" : reason instanceof Error ? reason.message : "检测失败，请重试。";
          errors.push(message); setError(errors.join(" "));
          record(`${PHASE_NAMES[phase]} · ${controller.signal.aborted ? "已停止" : "未完成"}`, "error");
          setConnectionStatus("部分项目未完成");
          if (controller.signal.aborted) break;
        } finally { clearTimeout(timer); }
      }
    } finally {
      if (errors.length) setConnectionStatus("部分项目未完成");
      if (abort.current === controller) abort.current = null;
      setBusy(""); setLiveRate(undefined);
    }
  }

  const average = samples.length === 3 ? Math.round(samples.reduce((a, b) => a + b, 0) / 3) : undefined;
  const jitter = samples.length === 3 ? Math.max(...samples) - Math.min(...samples) : undefined;
  const location = connection ? [connection.country, connection.region, connection.city].filter(Boolean).join(" · ") || "地区未提供" : "—";
  const organization = connection ? [connection.asn == null ? undefined : `AS${connection.asn}`, connection.organization].filter(Boolean).join(" · ") || "未提供" : "—";
  return (
    <section className="network-lab">
      <div className="lab-toolbar">
        <button className="button primary lab-start" disabled={!!busy} onClick={() => void run("all")}><Play size={15} />开始探测 · 5 MB</button>
        <div className="lab-individual-actions">
          <button className="button outline" disabled={!!busy} onClick={() => void run("connection")}><Globe2 size={15} />查看当前 IP</button>
          <button className="button outline" disabled={!!busy} onClick={() => void run("latency")}><Timer size={15} />测延迟与连通</button>
          <button className="button outline" disabled={!!busy} onClick={() => void run("speed")}><ArrowDownToLine size={15} />下载测速 · 5 MB</button>
        </div>
        {busy && <button className="button lab-stop" onClick={() => abort.current?.abort()}><Square size={12} />停止检测</button>}
        <div className={`lab-phase ${busy ? "is-running" : ""}`} data-testid="network-phase" data-phase={busy || "idle"} role="status"><i />{busy ? PHASE_NAMES[busy] : connectionStatus}</div>
      </div>
      <div className="lab-identity">
        <div className="lab-ip-block"><span className="lab-label"><Globe2 size={14} />本站观测 IP <span className="lab-target">→ 当前网站</span></span><strong className={`lab-ip ${connection?.ip ? "has-data" : ""}`}>{connection?.ip ?? "—"}</strong><div className="lab-ip-meta"><span>{connection?.ipVersion ?? "IP"}</span><span>{ipAt ? `${ipAt} 快照` : "等待查询"}</span><button className="lab-copy-ip" aria-label={ipCopied ? "IP 已复制" : "复制当前 IP"} disabled={!connection?.ip} onClick={() => { if (connection?.ip) void navigator.clipboard.writeText(connection.ip).then(() => setIpCopied(true)).catch(() => record("无法访问剪贴板，可选中 IP 手动复制", "error")); }}>{ipCopied ? <Check size={12} /> : <Copy size={12} />}{ipCopied ? "已复制" : "复制"}</button></div></div>
        <dl className="lab-identity-details"><div><dt>地区 · 粗略定位</dt><dd>{location}</dd></div><div><dt>ASN / 网络组织</dt><dd>{organization}</dd></div><div className="lab-edge-row"><div><dt>边缘节点</dt><dd>{connection?.colo ?? "—"}</dd></div><div><dt>TLS</dt><dd>{connection?.tlsVersion ?? "—"}</dd></div></div></dl>
      </div>
      {error && <div className="lab-alert" role="alert"><Info size={16} /><span>{error}</span></div>}
      <div className="lab-measurement-grid">
        <article className="lab-download-panel">
          <div className="lab-panel-heading"><span className="lab-label"><ArrowDownToLine size={14} />下载数据流</span><span className="lab-target">Cloudflare Speed</span></div>
          <div className="lab-rate-row">
            <div><span className="lab-readout-label">{busy === "speed" ? "当前采样" : "样本均值"}</span><strong className={(busy === "speed" ? liveRate : speed) !== undefined ? "has-data" : ""}>{decimal(busy === "speed" ? liveRate : speed)}<em>Mbps</em></strong></div>
            <div className="lab-download-count"><span data-testid="download-received" data-bytes={bytes}>{decimal(bytes / 1_000_000)}<small> / 5 MB</small></span><progress aria-label="下载接收进度" value={Math.min(bytes, SPEED_BYTES)} max={SPEED_BYTES} /></div>
          </div>
          <ThroughputChart samples={throughput} />
          <div className="lab-download-summary"><span>实时 <b data-testid="throughput-live">{decimal(liveRate)}</b> Mbps</span><span>均值 <b data-testid="throughput-final">{decimal(speed)}</b> Mbps</span><time>{speedAt || sampleAt || "—"}</time></div>
          <p className="lab-result-note">{speed === undefined ? "5 MB 有限样本 · 点击后接收" : "5 MB 样本吞吐量，非带宽上限"}</p>
        </article>
        <article className="lab-latency-panel">
          <div className="lab-panel-heading"><span className="lab-label"><Timer size={14} />HTTPS 请求延迟</span><span className="lab-sample-count">{samples.length}<small> / 3</small></span></div>
          <div className="lab-latency-main"><strong className={average !== undefined ? "has-data" : ""}>{average ?? "—"}<em>ms</em></strong><span>三次均值</span></div>
          <LatencyChart samples={samples} />
          <div className="lab-latency-footer"><span>波动范围 <b>{jitter ?? "—"}</b> ms</span><time>{latencyAt || "—"}</time></div>
          <p className="lab-result-note">Cloudflare Speed · HTTPS</p>
        </article>
      </div>
      <div className="lab-bottom-grid">
        <section className="lab-event-panel"><div className="lab-panel-heading"><span className="lab-label"><Activity size={14} />探测记录</span><span className="lab-target">本次会话</span></div><ol className="lab-event-list">{events.length ? events.map((event) => <li key={event.id} data-tone={event.tone}><time>{event.at}</time><i /><span>{event.text}</span></li>) : <li className="lab-event-empty"><time>—</time><span>等待第一条观测</span></li>}</ol></section>
        <section className="lab-tools-panel"><div className="lab-panel-heading"><span className="lab-label"><ShieldCheck size={14} />检查工具</span><span className="lab-target">外部测试</span></div><div className="lab-external-tools">{[
          ["https://www.dnsleaktest.com/", "DNS 泄漏测试", "DNS"],
          ["https://browserleaks.com/dns", "交叉检查 DNS", "DNS +"],
          ["https://browserleaks.com/webrtc", "WebRTC IP 暴露", "RTC"],
          ["https://test-ipv6.com/", "IPv6 可用性", "IPv6"],
        ].map(([url, label, tag]) => <a key={url} href={url} target="_blank" rel="noreferrer"><span>{tag}</span>{label}<ArrowUpRight size={14} /></a>)}</div></section>
      </div>
      <details className="lab-methods"><summary><Info size={14} />测量说明</summary><div><p>本站 IP 是当前网站请求的出口快照；下载与延迟请求发往 Cloudflare Speed，分流规则可能使它们使用不同出口。每项显示自己的测量时间。</p><p>曲线来自实际收到的字节与时间，每 100 ms 至多更新一次，结束时补记最后一段。均值仅在完整收到 5 MB 后生成，包含请求等待时间；有限样本不能代表线路带宽上限。HTTPS 延迟包含连接及服务端处理，并非 ICMP ping。失败只反映当前目标。</p><p>“开始探测”依次查询 IP、发出 3 次延迟请求并下载 5 MB；可随时停止。本站不会后台持续测速。测速经代理时可能消耗套餐流量。</p><p>外部检查站点会看到访问它的 IP。打开检测页面不代表已经通过 DNS、WebRTC 或 IPv6 泄漏验证。订阅节点请在“节点订阅”使用本地检测器。</p></div></details>
    </section>
  );
}
