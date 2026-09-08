import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Globe2,
  Info,
  LoaderCircle,
  MapPin,
  Network,
  ShieldCheck,
  Square,
  Timer,
} from "lucide-react";
import "./toolbox.css";

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
const SPEED_BYTES = 5_000_000;
const SPEED_URL = "https://speed.cloudflare.com/__down";
export default function NetworkPanel() {
  const [connection, setConnection] = useState<Connection>();
  const [samples, setSamples] = useState<number[]>([]);
  const [speed, setSpeed] = useState<number>();
  const [bytes, setBytes] = useState(0);
  const [busy, setBusy] = useState<"" | "connection" | "latency" | "speed">("");
  const [error, setError] = useState("");
  const [measuredAt, setMeasuredAt] = useState("");
  const [ipAt, setIpAt] = useState(""),
    [latencyAt, setLatencyAt] = useState(""),
    [speedAt, setSpeedAt] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("未检查");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function run(kind: "connection" | "latency" | "speed") {
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(kind);
    setError("");
    setConnectionStatus("检测中");
    if (kind === "connection") setConnection(undefined);
    const timer = setTimeout(
      () => controller.abort(),
      kind === "speed" ? 30_000 : 18_000,
    );
    try {
      if (kind === "connection") {
        const response = await fetch("/api/connection", {
          signal: controller.signal,
          cache: "no-store",
          credentials: "omit",
        });
        if (
          !response.ok ||
          !response.headers.get("content-type")?.includes("application/json")
        )
          throw new Error(
            "当前站点未启用网络信息 API。Cloudflare Workers 部署支持此功能。",
          );
        const data = (await response.json()) as Connection;
        if (data.source !== "cloudflare-request")
          throw new Error("网络信息响应无法识别。");
        if (data.local)
          throw new Error(
            "本地开发环境不提供真实出口信息，请打开已部署的网站检测。",
          );
        if (connection?.ip && connection.ip !== data.ip) {
          setSamples([]);
          setSpeed(undefined);
          setLatencyAt("");
          setSpeedAt("");
        }
        setConnection(data);
        setIpAt(new Date().toLocaleTimeString("zh-CN"));
        setConnectionStatus("网站连接正常");
      } else if (kind === "latency") {
        setSamples([]);
        setLatencyAt("");
        const times: number[] = [];
        for (let i = 0; i < 3; i++) {
          const start = performance.now();
          const response = await fetch(
            `${SPEED_URL}?bytes=0&nonce=${crypto.randomUUID()}`,
            {
              signal: controller.signal,
              cache: "no-store",
              credentials: "omit",
            },
          );
          if (!response.ok)
            throw new Error(`检测端点返回 HTTP ${response.status}`);
          await response.arrayBuffer();
          times.push(Math.round(performance.now() - start));
          setSamples([...times]);
        }
        setLatencyAt(new Date().toLocaleTimeString("zh-CN"));
        setConnectionStatus("HTTPS 连通正常");
      } else {
        setSpeed(undefined);
        setBytes(0);
        setSpeedAt("");
        const start = performance.now();
        const response = await fetch(
          `${SPEED_URL}?bytes=${SPEED_BYTES}&nonce=${crypto.randomUUID()}`,
          { signal: controller.signal, cache: "no-store", credentials: "omit" },
        );
        if (!response.ok || !response.body)
          throw new Error("测速端点暂不可用。");
        const reader = response.body.getReader();
        let received = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          received += part.value.byteLength;
          if (received > SPEED_BYTES) {
            await reader.cancel();
            throw new Error("响应超过测速流量上限，已停止。");
          }
          setBytes(received);
        }
        if (received !== SPEED_BYTES)
          throw new Error("测速内容未完整下载，不生成速度结论。");
        const seconds = (performance.now() - start) / 1000;
        if (seconds <= 0) throw new Error("计时结果无效，请重试。");
        setSpeed(Number(((received * 8) / seconds / 1_000_000).toFixed(2)));
        setSpeedAt(new Date().toLocaleTimeString("zh-CN"));
        setConnectionStatus("下载连通正常");
      }
      setMeasuredAt(new Date().toLocaleTimeString("zh-CN"));
    } catch (reason) {
      setError(
        controller.signal.aborted
          ? "检测已停止或超时，尚未完成的结果不作结论。"
          : reason instanceof Error
            ? reason.message
            : "检测失败，请重试。",
      );
      setConnectionStatus("未确认");
    } finally {
      clearTimeout(timer);
      if (abort.current === controller) abort.current = null;
      setBusy("");
    }
  }
  const average =
    samples.length === 3
      ? Math.round(samples.reduce((a, b) => a + b, 0) / 3)
      : undefined;
  const jitter =
    samples.length === 3
      ? Math.max(...samples) - Math.min(...samples)
      : undefined;
  return (
    <section className="network-home">
      <div className="tool-section-heading">
        <div>
          <h2>先看看，你现在的网络</h2>
          <p>
            测量此浏览器当前使用的连接。节点订阅里的代理，需要通过本地检测器单独测试。
          </p>
        </div>
        <span className="local-pill">
          <ShieldCheck size={16} />
          按需检测
        </span>
      </div>
      <div className="metric-strip">
        <div>
          <span>
            <Globe2 size={17} />
            本站观测 IP
          </span>
          <strong className="ip-metric">{connection?.ip ?? "尚未检测"}</strong>
          <small>
            {connection
              ? `${connection.ipVersion ?? "IP"} · ${ipAt} 查询快照`
              : "由网站收到的请求识别"}
          </small>
        </div>
        <div>
          <span>
            <Timer size={17} />
            HTTPS 请求延迟
          </span>
          <strong>
            {average === undefined ? "—" : average}
            <em> ms</em>
          </strong>
          <small>
            {samples.length
              ? `已完成 ${samples.length}/3 次${jitter !== undefined ? ` · 波动范围 ${jitter} ms` : ""}`
              : "3 次实际请求取平均"}
          </small>
          {latencyAt && <small>{latencyAt} · Cloudflare Speed</small>}
        </div>
        <div>
          <span>
            <ArrowDownToLine size={17} />
            下载速度
          </span>
          <strong>
            {speed === undefined ? "—" : speed}
            <em> Mbps</em>
          </strong>
          <small>
            {speed === undefined
              ? "点击测速后下载 5 MB"
              : "5 MB 样本吞吐量，非带宽上限"}
          </small>
          {speedAt && <small>{speedAt} · Cloudflare Speed</small>}
        </div>
        <div>
          <span>
            <Activity size={17} />
            连通状态
          </span>
          <strong className="text-metric">{connectionStatus}</strong>
          <small>
            {measuredAt ? `状态更新 ${measuredAt}` : "仅检查当前测试目标"}
          </small>
        </div>
      </div>
      <div className="network-actions">
        <button
          className="button primary"
          disabled={!!busy}
          onClick={() => void run("connection")}
        >
          <Globe2 size={17} />
          查看当前 IP
        </button>
        <button
          className="button outline"
          disabled={!!busy}
          onClick={() => void run("latency")}
        >
          <Timer size={17} />
          测延迟与连通
        </button>
        <button
          className="button outline"
          disabled={!!busy}
          onClick={() => void run("speed")}
        >
          <ArrowDownToLine size={17} />
          下载测速 · 5 MB
        </button>
        {busy && (
          <button
            className="button stop-button"
            onClick={() => abort.current?.abort()}
          >
            <Square size={14} />
            停止检测
          </button>
        )}
      </div>
      {busy && (
        <div className="measurement-progress" role="status">
          <LoaderCircle size={16} className="spin" />
          <span>
            {busy === "speed"
              ? `正在下载 ${(bytes / 1_000_000).toFixed(2)} / 5 MB`
              : "正在检测，请稍候…"}
          </span>
          {busy === "speed" && <progress value={bytes} max={SPEED_BYTES} />}
        </div>
      )}
      {error && (
        <div className="tool-alert" role="alert">
          <Info size={17} />
          {error}
        </div>
      )}
      {connection && (
        <dl className="connection-details">
          <div>
            <dt>IP 地区（粗略）</dt>
            <dd>
              {[connection.country, connection.region, connection.city]
                .filter(Boolean)
                .join(" · ") || "未提供"}
            </dd>
          </div>
          <div>
            <dt>ASN / 网络组织</dt>
            <dd>
              {connection.asn ? `AS${connection.asn} · ` : ""}
              {connection.organization ?? "未提供"}
            </dd>
          </div>
          <div>
            <dt>IP 类型</dt>
            <dd>{connection.ipVersion ?? "未知"} · 住宅 / 机房属性未判定</dd>
          </div>
          <div>
            <dt>接入与传输</dt>
            <dd>
              {connection.colo ?? "未知边缘节点"} ·{" "}
              {connection.tlsVersion ?? "TLS 信息未提供"}
            </dd>
          </div>
        </dl>
      )}
      <p className="tool-footnote">
        <Info size={15} />
        IP 仅代表访问本站这次请求的出口；测速目标为 Cloudflare
        Speed，两者可能因分流而使用不同出口。每项显示自己的测量时间。HTTP
        延迟包含服务处理等开销，不等同于
        ping。失败可能来自目标服务或网络，不能断言所有外网都不可用。
      </p>
      <div className="tool-divider" />
      <div className="tool-section-heading">
        <div>
          <h2>DNS 与网络暴露检查</h2>
          <p>
            加密 DNS
            是设置；是否泄漏，要观察真实解析请求。以下入口在新标签页进行检测。
          </p>
        </div>
        <ShieldCheck size={23} />
      </div>
      <div className="external-tools">
        <a href="https://www.dnsleaktest.com/" target="_blank" rel="noreferrer">
          <ShieldCheck />
          <div>
            <strong>DNS 泄漏测试</strong>
            <p>查看实际响应查询的 DNS 服务器。</p>
            <small>DNSLeakTest · 外部服务</small>
          </div>
          <ArrowUpRight />
        </a>
        <a href="https://browserleaks.com/dns" target="_blank" rel="noreferrer">
          <Network />
          <div>
            <strong>交叉检查 DNS</strong>
            <p>对比不同测试服务观测到的结果。</p>
            <small>BrowserLeaks · 外部服务</small>
          </div>
          <ArrowUpRight />
        </a>
        <a
          href="https://browserleaks.com/webrtc"
          target="_blank"
          rel="noreferrer"
        >
          <Globe2 />
          <div>
            <strong>WebRTC IP 暴露</strong>
            <p>检查浏览器 WebRTC 可见的网络地址。</p>
            <small>BrowserLeaks · 外部服务</small>
          </div>
          <ArrowUpRight />
        </a>
        <a href="https://test-ipv6.com/" target="_blank" rel="noreferrer">
          <MapPin />
          <div>
            <strong>IPv6 可用性</strong>
            <p>检查 IPv4 / IPv6 连通与支持情况。</p>
            <small>Test IPv6 · 外部服务</small>
          </div>
          <ArrowUpRight />
        </a>
      </div>
      <p className="tool-footnote">
        <Check size={15} />
        外部测试会看到你的访问 IP 及相关诊断信息。结果由检测服务显示，RouteKit
        不会把“打开页面”记成“无泄漏”。
      </p>
    </section>
  );
}
