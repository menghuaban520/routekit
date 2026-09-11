import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, Download, GitBranch, Globe2, Info, Play, RotateCcw, Square } from "lucide-react";
import type { Profile } from "../core";
import { diagnoseBatch, type DiagnosticResult } from "../core/diagnostics";
import { WEBSITE_CATEGORIES, WEBSITE_TARGETS, comparisonDelta, runWebsiteChecks, summaryWebsiteResult, type WebsiteResult, type WebsiteSample } from "../core/website-checks";
import "./website-connectivity.css";

type Snapshot = { label: string; at: string; results: Record<string, WebsiteResult> };
type Props = { active: boolean; profile?: Profile; onEditRouting?: () => void };
const DEFAULT_IDS = ["google", "youtube", "chatgpt", "github", "baidu", "bilibili"];
const time = (value?: string) => value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "尚未检测";
const sampleLabel = (sample: WebsiteSample) => ({ response: `收到响应 · ${sample.ms ?? "—"} ms`, "http-error": `HTTP ${sample.httpStatus ?? "异常"}`, timeout: "请求超时", failed: "未取得响应", stopped: "已停止" })[sample.outcome];
function routeLabel(route?: DiagnosticResult) {
  if (!route || route.policy === "unknown") return "需解析 IP 后确认";
  return route.nodeName ?? ({ DIRECT: "直连", PROXY: "客户端当前节点", REJECT: "拦截" })[route.policy];
}

export default function WebsiteConnectivityPanel({ active, profile, onEditRouting }: Props) {
  const [selected, setSelected] = useState<string[]>(DEFAULT_IDS);
  const [tested, setTested] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, WebsiteResult>>({});
  const [label, setLabel] = useState("");
  const [roundLabel, setRoundLabel] = useState("当前线路");
  const [roundAt, setRoundAt] = useState("");
  const [baseline, setBaseline] = useState<Snapshot>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [sort, setSort] = useState("default");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (!active) abort.current?.abort(); }, [active]);
  useEffect(() => {
    const stopWhenHidden = () => { if (document.hidden) abort.current?.abort(); };
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => document.removeEventListener("visibilitychange", stopWhenHidden);
  }, []);

  const visibleIds = tested.length ? tested : selected;
  const targets = WEBSITE_TARGETS.filter(target => visibleIds.includes(target.id));
  const routeReport = useMemo(() => profile ? diagnoseBatch(profile, WEBSITE_TARGETS.map(target => new URL(target.probeUrl).hostname).join("\n")) : undefined, [profile]);
  const routes = routeReport?.results ?? [];
  const routeErrors = routeReport?.errors ?? [];
  const routeMap = new Map(WEBSITE_TARGETS.map((target, index) => [target.id, routes[index]]));
  const finished = targets.filter(target => results[target.id]?.state === "done").length;
  const responded = targets.filter(target => summaryWebsiteResult(results[target.id]).status === "responded").length;
  const issues = targets.filter(target => ["partial", "failed"].includes(summaryWebsiteResult(results[target.id]).status)).length;
  const hasResults = Object.values(results).some(result => result.samples.length > 0);
  const sorted = [...targets].sort((a, b) => {
    const left = summaryWebsiteResult(results[a.id]), right = summaryWebsiteResult(results[b.id]);
    if (sort === "latency") return (left.medianMs ?? Infinity) - (right.medianMs ?? Infinity);
    if (sort === "issues") return Number(["failed", "partial"].includes(right.status)) - Number(["failed", "partial"].includes(left.status));
    return 0;
  });

  async function run(ids: string[] = selected) {
    if (!active || abort.current || !ids.length) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setNotice(""); setTested(ids); setResults({});
    setRoundLabel(label.trim() || "当前线路"); setRoundAt(new Date().toISOString());
    try {
      await runWebsiteChecks(WEBSITE_TARGETS.filter(target => ids.includes(target.id)), {
        signal: controller.signal,
        onUpdate: result => setResults(previous => ({ ...previous, [result.id]: result })),
      });
      if (controller.signal.aborted) setNotice("检测已停止，已完成的样本保留。切换线路后可重新开始。");
    } catch {
      setNotice("本轮检测未完成，请重新开始。");
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  }

  function pinBaseline() {
    setBaseline({ label: roundLabel, at: roundAt, results: structuredClone(results) });
    setNotice("对照已保留。去客户端切换节点，再回这里检测同一批网站。");
  }
  function download() {
    const data = {
      version: 1, scope: "browser-current-route", label: roundLabel, startedAt: roundAt,
      meaning: "Public-resource response checks only; opaque HTTP status, login, unlocking and per-site exit IP are not verified. Three-sample median is not ICMP ping.",
      websites: targets.map(target => ({ name: target.name, probeUrl: target.probeUrl, requestMode: target.requestMode ?? "no-cors", ...results[target.id], baseline: baseline?.results[target.id] })),
      baseline: baseline ? { label: baseline.label, at: baseline.at } : undefined,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "routekit-website-check.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("已发起检测报告下载。");
  }

  return <section className="website-checks" aria-label="主要网站连通检测">
    <div className="website-intro"><div><span className="website-eyebrow"><Globe2 size={15} />浏览器当前连接</span><h2>常用的网站，现在通吗？</h2><p>先在客户端连接节点，再开始检测。每站 3 次请求，结果逐个出现。</p></div><span className="website-scope">搜索 · AI · 影音 · 开发 · 国内</span></div>
    <details className="website-selection"><summary>检测范围 <b>{selected.length} 个网站</b><span>展开选择</span></summary>
      <div className="website-presets" aria-label="选择网站分类">
        <button disabled={busy} onClick={() => setSelected(DEFAULT_IDS)}>常用网站</button>
        <button disabled={busy} onClick={() => setSelected(WEBSITE_TARGETS.map(target => target.id))}>全部网站</button>
        {WEBSITE_CATEGORIES.map(category => <button key={category} disabled={busy} onClick={() => setSelected(WEBSITE_TARGETS.filter(target => target.category === category).map(target => target.id))}>{category}</button>)}
      </div>
      <div className="website-options">{WEBSITE_TARGETS.map(target => <label key={target.id}><input type="checkbox" checked={selected.includes(target.id)} disabled={busy} onChange={event => setSelected(previous => event.target.checked ? [...previous, target.id] : previous.filter(id => id !== target.id))} /><span>{target.name}</span></label>)}</div>
    </details>
    <div className="website-controls">
      <label className="website-line-label">线路备注<input value={label} maxLength={40} onChange={event => setLabel(event.target.value)} disabled={busy} placeholder="如：香港节点 A（可选）" /></label>
      <button className="button primary" disabled={busy || !selected.length} onClick={() => void run()}><Play size={16} />{hasResults ? "重新检测所选网站" : "开始网站检测"}</button>
      {busy && <button className="button outline" onClick={() => abort.current?.abort()}><Square size={13} />停止网站检测</button>}
    </div>
    <div className="website-summary" aria-live="polite" aria-atomic="true"><span><b>{finished}</b> / {targets.length} 完成</span><span><i className="responded" /><b>{responded}</b> 站收到响应</span><span><i className="failed" /><b>{issues}</b> 站待排查</span><span className="website-round">{busy ? "正在采样…" : roundAt ? `${roundLabel} · ${time(roundAt)}` : "等待开始"}</span></div>
    <p className="website-boundary">“收到响应”表示探测请求有返回；登录、播放和地区解锁需打开原站确认。各站的实际出口 IP 尚未观测。</p>
    <div className="website-result-tools"><div><button disabled={!hasResults || busy} onClick={pinBaseline}><Check size={15} />记为对照</button><button disabled={!hasResults || busy} onClick={download}><Download size={15} />导出报告</button></div><label>结果排序<select value={sort} onChange={event => setSort(event.target.value)}><option value="default">默认顺序</option><option value="issues">异常优先</option><option value="latency">请求耗时</option></select></label></div>
    {baseline && <div className="website-baseline"><span>对照：<strong>{baseline.label}</strong> · {time(baseline.at)}<small>相同网站的 3 次完整响应才比较耗时</small></span><button onClick={() => setBaseline(undefined)}>清除对照</button></div>}
    {notice && <p className="website-notice" role="status">{notice}</p>}
    <div className="website-grid">{sorted.map(target => {
      const result = results[target.id], summary = summaryWebsiteResult(result), route = routeMap.get(target.id);
      const delta = baseline ? comparisonDelta(result, baseline.results[target.id]) : undefined;
      const previous = baseline?.results[target.id];
      return <article className="website-card" key={target.id} data-testid={`website-${target.id}`} data-status={summary.status}>
        <div className="website-card-heading"><span className="website-monogram" aria-hidden="true">{target.name.slice(0, 1)}</span><div><h3>{target.name}</h3><span>{new URL(target.probeUrl).hostname}</span></div><span className="website-state">{summary.label}</span></div>
        <div className="website-value"><strong>{summary.medianMs ?? "—"}<small>ms</small></strong><span>三次响应中位数</span></div>
        <div className="website-samples" aria-label={`${target.name} 三次采样`}>
          {[0, 1, 2].map(index => { const sample = result?.samples[index]; return <span key={index} data-outcome={sample?.outcome ?? (result?.state === "running" && index === result.samples.length ? "running" : "idle")} title={sample ? sampleLabel(sample) : "未完成"}><i />{sample?.outcome === "response" ? `${sample.ms} ms` : sample ? sampleLabel(sample) : "—"}</span>; })}
        </div>
        {baseline && <p className="website-delta" data-direction={delta === undefined ? "unknown" : delta > 0 ? "slower" : "faster"}>{delta === undefined ? previous ? `对照：${summaryWebsiteResult(previous).label} · 样本不足，暂不比较耗时` : "本次对照没有该网站" : delta === 0 ? "与对照耗时相同" : `比对照${delta < 0 ? "快" : "慢"} ${Math.abs(delta)} ms`}</p>}
        {["failed", "partial"].includes(summary.status) && <p className="website-card-help">{target.category === "AI 助手" ? "该站验证机制可能限制浏览器探测。请打开原站确认，并核对官方服务状态。" : "先打开原站确认；浏览器拦截、验证页面或目标故障都可能影响探测。"}</p>}
        <details className="website-detail"><summary><GitBranch size={13} />配置预期：{routeErrors.length ? "配置需修正" : routeLabel(route)}</summary><div>
          <p>按当前编辑的配置匹配此探测域名；网页不会替你切换节点或启用配置。重定向、登录和播放还可能使用其他域名。</p>
          {routeErrors.map((error, index) => <p key={index}>{error}</p>)}
          {route && <><p>{route.reason}</p>{route.matchRule && <code>{route.matchRule}</code>}{route.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</>}
          {onEditRouting && <button onClick={onEditRouting}>去应用分流调整 <ArrowUpRight size={13} /></button>}
          <p>探测地址：<span className="website-endpoint">{target.probeUrl}</span></p>
          <p>多数目标跨域隐藏 HTTP 状态；公开接口允许读取时记录真实状态。收到响应不等于登录或播放可用。耗时包含浏览器与 HTTPS 请求开销，不是 ICMP Ping。</p>
          {result?.checkedAt && <p>最近检测：{time(result.checkedAt)}</p>}
        </div></details>
        <div className="website-card-actions"><a href={target.homepage} target="_blank" rel="noreferrer">打开网站 <ArrowUpRight size={13} /></a>{target.statusUrl && <a href={target.statusUrl} target="_blank" rel="noreferrer">官方状态 <ArrowUpRight size={13} /></a>}<button disabled={busy} onClick={() => { setSelected([target.id]); void run([target.id]); }} aria-label={`重测 ${target.name}`}><RotateCcw size={13} />单独重测</button></div>
      </article>;
    })}</div>
    {!targets.length && <p className="website-notice">展开“检测范围”，至少选择一个网站。</p>}
    <details className="lab-methods"><summary><Info size={14} />检测方式与排查顺序</summary><div><p>点击后由当前浏览器访问选中站点的公共资源或免登录接口，每站 3 次、最多 4 站并发，每次最多等待 8 秒。只请求固定公开地址，不发送订阅或节点凭证，也不读取网站登录状态。站点会看到本次访问；实际流量取决于响应大小。切换分类、隐藏页面或停止时取消未完成请求。</p><p>单个网站异常：打开原站，检查卡片里的配置预期与客户端实际启用的规则；多个网站异常：回网络概览核对出口，再检查客户端连接。AI 服务可同时查看官方状态。三次样本只反映这一次测试，不能据此计算链路丢包率或评定 IP 信誉。</p><p>先把一轮结果记为对照，在客户端换节点，再检测同一批网站。结果和对照只保留在当前页面会话，刷新即清除；需要保留可导出报告。</p></div></details>
  </section>;
}
