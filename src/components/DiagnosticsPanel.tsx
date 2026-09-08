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
        <h2>这些地址，会走哪条规则？</h2>
        <p>按当前导出的规则逐行检查，不发起 DNS、定位或测速请求。</p>
      </div>
      <div className="form-stack">
        <label htmlFor="diagnostics-input">
          域名或 IP，每行一个
          <textarea
            id="diagnostics-input"
            rows={7}
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
          最多 {MAX_DIAGNOSTIC_LINES} 行。可填 IPv4 /
          IPv6，或“域名,解析IP,国家代码”“IP,国家代码”；国家代码如
          CN、US，均视为你手动提供的提示。使用英文逗号。
        </p>
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
      <div className="note diagnostics-note">
        <Info size={17} />
        <div>
          这里匹配的是访问目标，不是代理节点的出口 IP。缺少 IP
          或地区且会影响策略时会显示待确认；手动地区可能与客户端 GeoIP
          数据库不同。未填解析 IP 时，带 no-resolve 的规则不会主动查询 DNS。
        </div>
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
                      <small>{DIAGNOSTIC_STATUS_LABELS[result.status]}</small>
                    </td>
                    <td>
                      {result.matchRule && <code>{result.matchRule}</code>}
                      {result.candidateRule && (
                        <code>候选：{result.candidateRule}</code>
                      )}
                      <p>{result.reason}</p>
                      {result.warnings.map((warning) => (
                        <small key={warning}>{warning}</small>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="helper diagnostics-limits">
            结果只说明这些输入在当前规则中的匹配情况，不代表实际连接成功；DNS
            缓存、Hosts 是否被客户端采用、系统绕过及客户端 GeoIP
            数据库都可能影响实测结果。需要复现实际访问时，请填写设备当时使用的解析
            IP。
          </p>
        </div>
      )}
      {message && (
        <p className="diagnostics-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
