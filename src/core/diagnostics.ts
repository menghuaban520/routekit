import {
  compileProfile,
  validateDomain,
  type Policy,
  type Profile,
} from "./index";
import { compileRoutingNodes, type CompiledRoutingNode } from "./node-routing";

export type DiagnosticStatus =
  "matched" | "needs-ip" | "needs-country" | "policy-only" | "invalid";
export type DiagnosticResult = {
  line: number;
  input: string;
  target: string;
  resolvedIp?: string;
  countryHint?: string;
  status: DiagnosticStatus;
  policy: Policy | "unknown";
  nodeId?: string;
  nodeName?: string;
  nodeMode?: "embedded" | "reference";
  matchRule: string | null;
  candidateRule?: string;
  reason: string;
  warnings: string[];
  duplicateOf?: number;
};
export type DiagnosticReport = {
  results: DiagnosticResult[];
  errors: string[];
  ruleCount: number;
};

export const DIAGNOSTIC_STATUS_LABELS: Record<DiagnosticStatus, string> = {
  matched: "按输入匹配",
  "needs-ip": "需解析 IP",
  "needs-country": "待确认地区",
  "policy-only": "策略一致，规则待定",
  invalid: "输入有误",
};
export const MAX_DIAGNOSTIC_LINES = 200;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
type Address = { text: string; version: 4 | 6; value: bigint };
type Input = {
  target: string;
  domain?: string;
  address?: Address;
  country?: string;
};
type Rule = {
  text: string;
  type: string;
  value: string;
  policy: Policy;
  nodeId?: string;
  nodeName?: string;
  nodeMode?: "embedded" | "reference";
  noResolve: boolean;
  network?: { address: Address; prefix: number };
};

function parseAddress(raw: string): Address | null {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw)) {
    const octets = raw.split(".");
    if (
      octets.some(
        (part) => Number(part) > 255 || (part !== "0" && part.startsWith("0")),
      )
    )
      return null;
    return {
      text: raw,
      version: 4,
      value: octets.reduce((value, part) => (value << 8n) + BigInt(part), 0n),
    };
  }
  if (!raw.includes(":") || !/^[a-f\d:.]+$/i.test(raw)) return null;
  try {
    const text = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
    const [left, right] = text.split("::");
    const leading = left ? left.split(":") : [];
    const trailing = right ? right.split(":") : [];
    const groups =
      right === undefined
        ? leading
        : [
            ...leading,
            ...Array(8 - leading.length - trailing.length).fill("0"),
            ...trailing,
          ];
    if (groups.length !== 8) return null;
    return {
      text,
      version: 6,
      value: groups.reduce(
        (value: bigint, group: string) => (value << 16n) + BigInt(`0x${group}`),
        0n,
      ),
    };
  } catch {
    return null;
  }
}

function parseInput(raw: string): Input {
  if (CONTROL.test(raw))
    throw new Error("不能包含控制字符、制表符或隐藏方向字符。");
  if (!raw.trim()) throw new Error("这一行为空，请填写目标或删除空行。");
  if (raw.length > 512) throw new Error("每行最多 512 个字符。");
  const fields = raw.split(",").map((value) => value.trim());
  if (fields.length > 3 || fields.some((value) => !value))
    throw new Error(
      "格式应为 域名、IP、IP,CN 或 域名,解析IP,CN；不支持空字段。",
    );
  const firstAddress = parseAddress(fields[0]);
  let domain: string | undefined;
  if (!firstAddress) {
    if (fields[0].includes(":") || /^[\d.]+$/.test(fields[0]))
      throw new Error(
        "IP 地址无效，请检查 IPv4 / IPv6 格式；不含端口或网段前缀。",
      );
    if (!validateDomain(fields[0]))
      throw new Error("域名无效；请只填域名，不含协议、路径、端口或通配符。");
    domain = new URL(`https://${fields[0]}`).hostname
      .replace(/\.$/, "")
      .toLowerCase();
  }
  let address = firstAddress ?? undefined;
  let country: string | undefined;
  if (firstAddress) {
    if (fields.length > 2) throw new Error("IP 目标只需 IP 或 IP,国家代码。");
    country = fields[1];
  } else if (fields.length > 1) {
    address = parseAddress(fields[1]) ?? undefined;
    if (!address)
      throw new Error("域名后的第二列需为有效解析 IP；国家代码放在第三列。");
    country = fields[2];
  }
  if (country !== undefined) {
    country = country.toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || ["XX", "ZZ"].includes(country))
      throw new Error(
        "地区提示需为两位国家/地区代码，如 CN、US；未知地区请省略。",
      );
  }
  return { target: domain ?? firstAddress!.text, domain, address, country };
}

// Read the exported configuration, so normalization, deduplication and rule order
// remain owned by the actual client compiler rather than a parallel rule builder.
function parseRules(content: string, nodes: CompiledRoutingNode[]): Rule[] {
  let section = "";
  const rules: Rule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const text = raw.trim();
    if (text.startsWith("[")) {
      section = text;
      continue;
    }
    if (section !== "[Rule]" || !text || text.startsWith("#")) continue;
    const fields = text.split(",").map((value) => value.trim());
    const type = fields[0];
    const policy = fields[type === "FINAL" ? 1 : 2];
    const node = nodes.find((node) => node.alias === policy);
    if (
      ![
        "DOMAIN",
        "DOMAIN-SUFFIX",
        "DOMAIN-KEYWORD",
        "IP-CIDR",
        "IP-CIDR6",
        "GEOIP",
        "FINAL",
      ].includes(type) ||
      (!node && !["DIRECT", "PROXY", "REJECT"].includes(policy))
    )
      throw new Error(`检查器暂不支持生成规则：${text}`);
    const rule: Rule = {
      text,
      type,
      value: type === "FINAL" ? "" : fields[1],
      policy: node ? "PROXY" : (policy as Policy),
      ...(node
        ? {
            nodeId: node.node.id,
            nodeName: node.node.name,
            nodeMode: node.mode,
          }
        : {}),
      noResolve: fields.slice(3).includes("no-resolve"),
    };
    if (type === "IP-CIDR" || type === "IP-CIDR6") {
      const [rawAddress, rawPrefix] = rule.value.split("/");
      const address = parseAddress(rawAddress);
      const prefix = Number(rawPrefix);
      if (
        !address ||
        !Number.isInteger(prefix) ||
        prefix < 0 ||
        prefix > (address.version === 4 ? 32 : 128)
      )
        throw new Error(`无法读取 IP 规则：${text}`);
      rule.network = { address, prefix };
    }
    rules.push(rule);
  }
  if (!rules.length || rules.at(-1)?.type !== "FINAL")
    throw new Error("生成配置缺少可识别的最终规则，未执行检查。");
  return rules;
}

type Match = true | false | "needs-ip" | "needs-country";
function matches(rule: Rule, input: Input): Match {
  if (rule.type === "FINAL") return true;
  if (rule.type === "DOMAIN") return input.domain === rule.value;
  if (rule.type === "DOMAIN-SUFFIX")
    return (
      !!input.domain &&
      (input.domain === rule.value || input.domain.endsWith(`.${rule.value}`))
    );
  if (rule.type === "DOMAIN-KEYWORD")
    return !!input.domain && input.domain.includes(rule.value);
  if (rule.network) {
    if (!input.address) return rule.noResolve ? false : "needs-ip";
    if (input.address.version !== rule.network.address.version) return false;
    const shift = BigInt(
      (input.address.version === 4 ? 32 : 128) - rule.network.prefix,
    );
    return input.address.value >> shift === rule.network.address.value >> shift;
  }
  if (rule.type === "GEOIP") {
    if (!input.address) return rule.noResolve ? false : "needs-ip";
    if (!input.country) return "needs-country";
    return input.country === rule.value;
  }
  return false;
}

function diagnose(
  input: Input,
  rules: Rule[],
): Pick<
  DiagnosticResult,
  | "status"
  | "policy"
  | "nodeId"
  | "nodeName"
  | "nodeMode"
  | "matchRule"
  | "candidateRule"
  | "reason"
> {
  const possible: { rule: Rule; uncertainty: "needs-ip" | "needs-country" }[] =
    [];
  for (const rule of rules) {
    const match = matches(rule, input);
    if (!match) continue;
    if (match !== true) {
      possible.push({ rule, uncertainty: match });
      continue;
    }
    if (!possible.length)
      return {
        status: "matched",
        policy: rule.policy,
        ...(rule.nodeId
          ? {
              nodeId: rule.nodeId,
              nodeName: rule.nodeName,
              nodeMode: rule.nodeMode,
            }
          : {}),
        matchRule: rule.text,
        reason:
          rule.type === "GEOIP"
            ? `按手动地区提示 ${input.country} 命中；未核验客户端 GeoIP 数据库。`
            : `按导出规则顺序，首先命中 ${rule.text}。${input.country ? `地区采用手动提示 ${input.country}。` : ""}`,
      };
    const pending = possible[0];
    const missing =
      pending.uncertainty === "needs-ip"
        ? "未提供域名的解析 IP"
        : "未提供 IP 的国家/地区提示";
    const allSame = possible.every(
      (item) =>
        item.rule.policy === rule.policy && item.rule.nodeId === rule.nodeId,
    );
    return {
      status: allSame ? "policy-only" : pending.uncertainty,
      policy: allSame ? rule.policy : "unknown",
      ...(allSame && rule.nodeId
        ? {
            nodeId: rule.nodeId,
            nodeName: rule.nodeName,
            nodeMode: rule.nodeMode,
          }
        : {}),
      matchRule: null,
      candidateRule: rule.text,
      reason: allSame
        ? `${missing}；${possible.map((item) => item.rule.text).join("、")} 与后续 ${rule.text} 的策略相同，可确定策略，具体命中规则未确定。`
        : `${missing}，前面的 ${pending.rule.text} 可能改变策略。若这些待确认规则均不命中，候选为 ${rule.text}；不能据此确定最终策略。`,
    };
  }
  return {
    status: "invalid",
    policy: "unknown",
    matchRule: null,
    reason: "没有找到可评估的最终规则。",
  };
}

export function diagnoseBatch(
  profile: Profile,
  text: string,
): DiagnosticReport {
  if (text.length > 104_000)
    return {
      results: [],
      errors: ["输入过大；最多 200 行，每行最多 512 个字符。"],
      ruleCount: 0,
    };
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_DIAGNOSTIC_LINES)
    return {
      results: [],
      errors: [
        `最多检查 ${MAX_DIAGNOSTIC_LINES} 行；当前 ${lines.length} 行，请分批检查。`,
      ],
      ruleCount: 0,
    };
  const compiled = compileProfile(profile);
  if (compiled.errors.length)
    return {
      results: [],
      errors: compiled.errors.map((error) => `请先修正配置：${error}`),
      ruleCount: 0,
    };
  let rules: Rule[];
  try {
    rules = parseRules(compiled.content, compileRoutingNodes(profile));
  } catch (error) {
    return { results: [], errors: [(error as Error).message], ruleCount: 0 };
  }
  const seen = new Map<string, number>();
  const results = lines.map((raw, index): DiagnosticResult => {
    const base = { line: index + 1, input: raw, warnings: [] as string[] };
    try {
      const input = parseInput(raw);
      const key = [
        input.target,
        input.address?.text ?? "",
        input.country ?? "",
      ].join("|");
      const duplicateOf = seen.get(key);
      if (duplicateOf !== undefined)
        base.warnings.push(`与第 ${duplicateOf} 行重复，已保留此行结果。`);
      else seen.set(key, base.line);
      if (input.country)
        base.warnings.push(
          `国家/地区 ${input.country} 是手动提示，不是定位或客户端 GeoIP 验证结果。`,
        );
      if (
        input.domain &&
        !input.address &&
        rules.some((rule) => rule.noResolve)
      )
        base.warnings.push(
          "未提供解析 IP，no-resolve 规则不会主动解析；客户端若已有解析或 DNS 缓存，请补充 IP 后再检查。",
        );
      return {
        ...base,
        target: input.target,
        resolvedIp: input.address?.text,
        countryHint: input.country,
        duplicateOf,
        ...diagnose(input, rules),
      };
    } catch (error) {
      return {
        ...base,
        target: raw,
        status: "invalid",
        policy: "unknown",
        matchRule: null,
        reason: `第 ${base.line} 行：${(error as Error).message}`,
      };
    }
  });
  return { results, errors: [], ruleCount: rules.length };
}

function csvCell(value: string | number): string {
  let text = String(value);
  // Quoting alone does not stop spreadsheet formula execution.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function diagnosticsToCsv(results: DiagnosticResult[]): string {
  const rows: (string | number)[][] = [
    [
      "行号",
      "原始输入",
      "目标",
      "解析 IP",
      "手动地区提示",
      "状态",
      "策略",
      "绑定节点",
      "节点配置方式",
      "命中规则",
      "后续候选规则",
      "说明",
      "提示",
    ],
  ];
  for (const result of results)
    rows.push([
      result.line,
      result.input,
      result.target,
      result.resolvedIp ?? "",
      result.countryHint ?? "",
      DIAGNOSTIC_STATUS_LABELS[result.status],
      result.policy,
      result.nodeName ?? "",
      result.nodeMode === "reference"
        ? "需先导入配套节点"
        : result.nodeMode === "embedded"
          ? "内嵌节点"
          : "",
      result.matchRule ?? "",
      result.candidateRule ?? "",
      result.reason,
      result.warnings.join("；"),
    ]);
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
