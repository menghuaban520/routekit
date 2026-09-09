import { useState } from "react";
import { Copy, Download, Info, ScanLine } from "lucide-react";
import { type Profile } from "../core";
import {
  diagnoseBatch,
  diagnosticsToCsv,
  DIAGNOSTIC_STATUS_LABELS,
  MAX_DIAGNOSTIC_LINES,
  type DiagnosticReport,
} from "../core/diagnostics";
import "./diagnostics.css";

const policyLabels = {
  DIRECT: "直连",
  PROXY: "代理",
  REJECT: "拦截",
  unknown: "未确定",
};

export default function DiagnosticsPanel({ profile }: { profile: Profile }) {
  const [input, setInput] = useState("");
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [checkedInput, setCheckedInput] = useState("");
  const [checkedProfile, setCheckedProfile] = useState("");
  const [message, setMessage] = useState("");
  const stale =
    !!report &&
    (input !== checkedInput || JSON.stringify(profile) !== checkedProfile);
  const canExport = !!report?.results.length && !stale;

  function check() {
    setReport(diagnoseBatch(profile, input));
    setCheckedInput(input);
    setCheckedProfile(JSON.stringify(profile));
    setMessage("");
  }
  function download() {
    if (!report || !canExport) return;
    const url = URL.createObjectURL(
      new Blob(["\uFEFF", diagnosticsToCsv(report.results)], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "routekit-routing-check.csv";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("已发起 CSV 下载，请在下载列表查看。");
  }

  return (
    <section className="diagnostics-panel" aria-label="批量分流检查">
      <div className="section-heading">
        <h2>批量分流检查</h2>
        <p>粘贴目标，查看命中的规则。</p>
      </div>
      <div className="form-stack">
        <label htmlFor="diagnostics-input">
          域名或 IP，每行一个
          <textarea
            id="diagnostics-input"
            rows={6}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={
              "www.kugou.com\n192.168.1.20\n8.8.8.8,US\nexample.com,203.0.113.8,CN"
            }
            aria-describedby="diagnostics-format"
          />
        </label>
        <p className="helper" id="diagnostics-format">
          域名、IP 或“域名,解析IP,CN”。英文逗号，地区按手动提示处理。
        </p>
      </div>
      <div className="diagnostics-examples">
        <button className="text-button accent" onClick={() => setInput(profile.apps.flatMap(app => app.domains.slice(0,1)).join("\n"))}>填入当前应用</button>
        <button className="text-button" onClick={() => setInput("www.kugou.com\nyoutube.com\n192.168.1.20\n8.8.8.8,US")}>填入域名与 IP 示例</button>
      </div>
      <div className="diagnostics-actions">
        <button type="button" className="button primary" onClick={check}>
          <ScanLine size={17} />
          检查分流
        </button>
        <span className="helper">
          {input ? input.split(/\r?\n/).length : 0} / {MAX_DIAGNOSTIC_LINES} 行
        </span>
      </div>
      {stale && (
        <p className="diagnostics-stale" role="status">
          配置或输入已修改，下面是上次结果。请重新检查后复制或下载。
        </p>
      )}
      {report?.errors.length ? (
        <div className="note warning diagnostics-note" role="alert">
          <Info size={17} />
          <div>
            {report.errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        </div>
      ) : null}
      {report && report.results.length > 0 && (
        <div className="diagnostics-results">
          <div className="diagnostics-results-heading">
            <h3>
              检查结果{" "}
              <span>
                {report.results.length} 行 · {report.ruleCount} 条配置规则
              </span>
            </h3>
            <div className="diagnostics-actions">
              <button
                type="button"
                className="button outline compact"
                disabled={!canExport}
                onClick={async () => {
                  if (!report) return;
                  try {
                    await navigator.clipboard.writeText(
                      diagnosticsToCsv(report.results),
                    );
                    setMessage("CSV 已复制。");
                  } catch {
                    setMessage("浏览器未允许复制，请下载 CSV。");
                  }
                }}
              >
                <Copy size={15} />
                复制 CSV
              </button>
              <button
                type="button"
                className="button outline compact"
                disabled={!canExport}
                onClick={download}
              >
                <Download size={15} />
                下载 CSV
              </button>
            </div>
          </div>
          <div
            className="diagnostics-table-wrap"
            tabIndex={0}
            aria-label="分流结果表，可横向滚动"
          >
            <table className="diagnostics-table">
              <thead>
                <tr>
                  <th scope="col">行 / 目标</th>
                  <th scope="col">判断</th>
                  <th scope="col">规则与说明</th>
                </tr>
              </thead>
              <tbody>
                {report.results.map((result) => (
                  <tr key={result.line}>
                    <td>
                      <small>
                        第 {result.line} 行
                        {result.duplicateOf
                          ? ` · 重复第 ${result.duplicateOf} 行`
                          : ""}
                      </small>
                      <strong>{result.target || "（空行）"}</strong>
                      {result.resolvedIp &&
                        result.resolvedIp !== result.target && (
                          <small>解析 IP：{result.resolvedIp}</small>
                        )}
                      {result.countryHint && (
                        <small>手动地区：{result.countryHint}</small>
                      )}
                    </td>
                    <td>
                      <span
                        className={`diagnostics-policy ${result.policy.toLowerCase()}`}
                      >
                        {policyLabels[result.policy]}
                      </span>
                      {result.nodeName && <strong className="diagnostics-node">{result.nodeName}</strong>}
                      <small>{DIAGNOSTIC_STATUS_LABELS[result.status]}</small>
                    </td>
                    <td>
                      {result.matchRule && <code>{result.matchRule}</code>}
                      {result.candidateRule && (
                        <code>候选：{result.candidateRule}</code>
                      )}
                      {result.status === "matched" ? (
                        <details className="diagnostics-row-details">
                          <summary>判断说明{result.warnings.length ? ` · ${result.warnings.length} 条提示` : ""}</summary>
                          <p>{result.reason}</p>
                          {result.warnings.map((warning) => <small key={warning}>{warning}</small>)}
                        </details>
                      ) : (
                        <>
                          <p>{result.reason}</p>
                          {result.warnings.map((warning) => <small key={warning}>{warning}</small>)}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <details className="diagnostics-help">
        <summary><Info size={15} />使用说明</summary>
        <div>
          <p>每行输入一个域名、IPv4 或 IPv6，最多 {MAX_DIAGNOSTIC_LINES} 行。也可使用“域名,解析IP,国家代码”或“IP,国家代码”，以英文逗号分隔；CN、US 等地区代码均为手动提示。</p>
          <p>按当前导出的规则顺序匹配访问目标，不发起 DNS、定位或测速请求，也不把节点入口 IP 当作出口。缺少 IP 或地区且会影响策略时，结果显示待确认；未填解析 IP 时，no-resolve 规则不会主动查询 DNS。</p>
          <p>匹配不代表实际连接成功。手动地区可能与客户端 GeoIP 数据库不同，DNS 缓存、Hosts 是否被采用和系统绕过也会影响实测。需要复现实际访问时，请填写设备当时使用的解析 IP。</p>
        </div>
      </details>
      {message && (
        <p className="diagnostics-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
