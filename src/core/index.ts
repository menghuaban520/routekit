import type {
  AppRule,
  CompilationResult,
  HostMapping,
  NormalizedRule,
  Policy,
  Profile,
} from "./types";
import { getConfigExporter } from "./adapters";
export type {
  AppRule,
  ConfigExporter,
  CustomRule,
  Policy,
  Profile,
} from "./types";
export { CLIENTS, getConfigExporter } from "./adapters";

// Small, independently written starter rules; these are not complete application inventories.
export const APP_CATALOG: AppRule[] = [
  {
    id: "kugou",
    name: "酷狗音乐",
    domains: ["kugou.com", "kugou.net"],
    policy: "DIRECT",
    color: "#3184FF",
    symbol: "酷",
  },
  {
    id: "bilibili",
    name: "哔哩哔哩",
    domains: ["bilibili.com", "bilibili.tv", "bilivideo.com", "hdslb.com"],
    policy: "DIRECT",
    color: "#F0789B",
    symbol: "哔",
  },
  {
    id: "youtube",
    name: "YouTube",
    domains: ["youtube.com", "youtu.be", "googlevideo.com", "ytimg.com"],
    policy: "PROXY",
    color: "#F04A4A",
    symbol: "▶",
  },
  {
    id: "telegram",
    name: "Telegram",
    domains: ["telegram.org", "t.me", "telegram.me"],
    policy: "PROXY",
    color: "#32A7DC",
    symbol: "↗",
  },
  {
    id: "netease",
    name: "网易云音乐",
    domains: ["music.163.com", "music.126.net"],
    policy: "DIRECT",
    color: "#D84B4B",
    symbol: "云",
  },
  {
    id: "qqmusic",
    name: "QQ 音乐",
    domains: ["y.qq.com", "music.qq.com", "qqmusic.qq.com"],
    policy: "DIRECT",
    color: "#2DB986",
    symbol: "♪",
  },
  {
    id: "wechat",
    name: "微信",
    domains: ["weixin.qq.com", "weixin.com", "wx.qq.com"],
    policy: "DIRECT",
    color: "#2AB75C",
    symbol: "微",
  },
  {
    id: "douyin",
    name: "抖音",
    domains: ["douyin.com", "douyincdn.com", "douyinpic.com"],
    policy: "DIRECT",
    color: "#363A43",
    symbol: "抖",
  },
  {
    id: "github",
    name: "GitHub",
    domains: ["github.com", "githubusercontent.com", "githubassets.com"],
    policy: "PROXY",
    color: "#424852",
    symbol: "GH",
  },
  {
    id: "netflix",
    name: "Netflix",
    domains: ["netflix.com", "nflxvideo.net", "nflximg.net", "nflxso.net"],
    policy: "PROXY",
    color: "#D82935",
    symbol: "N",
  },
  {
    id: "spotify",
    name: "Spotify",
    domains: ["spotify.com", "scdn.co", "spotifycdn.com"],
    policy: "PROXY",
    color: "#24A968",
    symbol: "S",
  },
  {
    id: "openai",
    name: "ChatGPT",
    domains: [
      "chatgpt.com",
      "openai.com",
      "oaistatic.com",
      "oaiusercontent.com",
    ],
    policy: "PROXY",
    color: "#548677",
    symbol: "AI",
  },
];

export function createProfile(): Profile {
  return {
    version: 1,
    name: "我的分流配置",
    client: "shadowrocket",
    domesticPolicy: "DIRECT",
    finalPolicy: "PROXY",
    bypassLan: true,
    dns: {
      mode: "encrypted",
      servers: "https://dns.alidns.com/dns-query, https://doh.pub/dns-query",
      ipv6: false,
    },
    apps: APP_CATALOG.slice(0, 4).map((app) => ({
      ...app,
      domains: [...app.domains],
    })),
    rules: [],
    hosts: "",
    general: "",
  };
}

const MAX_BACKUP_SIZE = 512 * 1024;
const POLICIES: readonly string[] = ["DIRECT", "PROXY", "REJECT"];
const RULE_TYPES: readonly string[] = [
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
];
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const NO_FIELD_DELIMITERS = /[\s,#=/?@:;[\]\\%]/u;
const ENCRYPTED_DNS = [
  "https://dns.alidns.com/dns-query",
  "https://doh.pub/dns-query",
];

function domainASCII(value: string): string | null {
  if (
    !value ||
    value.length > 253 ||
    CONTROL.test(value) ||
    NO_FIELD_DELIMITERS.test(value)
  )
    return null;
  try {
    const host = new URL(`https://${value}`).hostname
      .replace(/\.$/, "")
      .toLowerCase();
    if (host.length > 253 || /^\d+(?:\.\d+)*$/.test(host)) return null;
    const labels = host.split(".");
    if (
      labels.some(
        (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
      )
    )
      return null;
    return host;
  } catch {
    return null;
  }
}

export function validateDomain(value: string): boolean {
  return typeof value === "string" && domainASCII(value) !== null;
}

function ipv4(value: string): boolean {
  return (
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) &&
    value
      .split(".")
      .every(
        (part) =>
          Number(part) <= 255 && (part === "0" || !part.startsWith("0")),
      )
  );
}

function ipv6(value: string): boolean {
  if (!value.includes(":") || !/^[0-9a-f:.]+$/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

function cidr(value: string, version: 4 | 6): boolean {
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    (version === 4 ? ipv4(parts[0]) : ipv6(parts[0])) &&
    /^(0|[1-9]\d*)$/.test(parts[1]) &&
    Number(parts[1]) <= (version === 4 ? 32 : 128)
  );
}

function record(
  value: unknown,
  keys: readonly string[],
  path: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} 必须是对象`);
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${path} 包含不支持的字段`);
}

function string(
  value: unknown,
  path: string,
  max: number,
  allowEmpty = true,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && !value.trim())
  )
    throw new Error(
      `${path} 必须是${allowEmpty ? "" : "非空"}文本，最长 ${max} 字符`,
    );
}

function oneOf(value: unknown, values: readonly unknown[], path: string) {
  if (!values.includes(value)) throw new Error(`${path} 的值不受支持`);
}

function assertProfile(value: unknown): asserts value is Profile {
  record(
    value,
    [
      "version",
      "name",
      "client",
      "domesticPolicy",
      "finalPolicy",
      "bypassLan",
      "dns",
      "apps",
      "rules",
      "hosts",
      "general",
    ],
    "配置",
  );
  oneOf(value.version, [1], "配置版本");
  oneOf(value.client, ["shadowrocket"], "客户端");
  string(value.name, "配置名称", 80, false);
  if (CONTROL.test(value.name))
    throw new Error("配置名称不能包含控制字符或换行");
  oneOf(value.domesticPolicy, ["DIRECT", "PROXY"], "国内流量策略");
  oneOf(value.finalPolicy, ["DIRECT", "PROXY"], "兜底策略");
  oneOf(value.bypassLan, [true, false], "局域网选项");
  record(value.dns, ["mode", "servers", "ipv6"], "DNS");
  oneOf(value.dns.mode, ["encrypted", "system", "custom"], "DNS 模式");
  string(value.dns.servers, "DNS 服务器", 2000);
  oneOf(value.dns.ipv6, [true, false], "IPv6 选项");
  string(value.hosts, "Hosts", 20000);
  string(value.general, "高级通用参数", 10000);
  if (!Array.isArray(value.apps) || value.apps.length > 100)
    throw new Error("应用最多 100 个");
  if (!Array.isArray(value.rules) || value.rules.length > 500)
    throw new Error("自定义规则最多 500 条");
  let totalDomains = 0;
  const appIds = new Set<string>();
  for (const [index, app] of value.apps.entries()) {
    const path = `应用 ${index + 1}`;
    record(
      app,
      ["id", "name", "domains", "policy", "color", "symbol", "custom"],
      path,
    );
    string(app.id, `${path} ID`, 100, false);
    string(app.name, `${path}名称`, 80, false);
    if (CONTROL.test(app.name) || CONTROL.test(app.id))
      throw new Error(`${path}名称或 ID 包含控制字符`);
    if (appIds.has(app.id)) throw new Error("应用 ID 不能重复");
    appIds.add(app.id);
    oneOf(app.policy, POLICIES, `${path}策略`);
    string(app.color, `${path}颜色`, 7, false);
    if (!/^#[\da-f]{6}$/i.test(app.color))
      throw new Error(`${path}颜色必须使用六位十六进制色值`);
    string(app.symbol, `${path}图标`, 8, false);
    if (app.custom !== undefined)
      oneOf(app.custom, [true, false], `${path}类型`);
    if (
      !Array.isArray(app.domains) ||
      !app.domains.length ||
      app.domains.length > 100
    )
      throw new Error(`${path}需要 1–100 个域名`);
    for (const domain of app.domains) string(domain, `${path}域名`, 253, false);
    totalDomains += app.domains.length;
  }
  if (totalDomains > 2000) throw new Error("应用域名总数最多 2000 个");
  const ruleIds = new Set<string>();
  for (const [index, rule] of value.rules.entries()) {
    const path = `规则 ${index + 1}`;
    record(rule, ["id", "type", "value", "policy"], path);
    string(rule.id, `${path} ID`, 100, false);
    if (ruleIds.has(rule.id)) throw new Error("规则 ID 不能重复");
    ruleIds.add(rule.id);
    oneOf(rule.type, RULE_TYPES, `${path}类型`);
    oneOf(rule.policy, POLICIES, `${path}策略`);
    string(rule.value, `${path}内容`, 253, false);
  }
}

function dnsServers(value: string, errors: string[]): string[] {
  const servers = value
    .split(/[,\r\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!servers.length || servers.length > 8)
    errors.push("自定义 DNS 需要 1–8 个服务器，使用换行或逗号分隔");
  for (const server of servers) {
    if (CONTROL.test(server) || /[\[\]]/.test(server)) {
      errors.push("DNS 不能包含控制字符或配置章节");
      continue;
    }
    if (server === "system" || ipv4(server) || ipv6(server)) continue;
    try {
      const url = new URL(server);
      if (
        !["https:", "tls:", "quic:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        /\s/.test(server)
      )
        throw new Error("invalid");
      if (url.protocol !== "https:" && url.pathname && url.pathname !== "/")
        throw new Error("invalid");
      if (!(domainASCII(url.hostname) || ipv4(url.hostname)))
        throw new Error("invalid");
    } catch {
      errors.push(
        `DNS 地址无效：${server}。支持 IP、system、https://、tls:// 或 quic://，不支持附加参数`,
      );
    }
  }
  return [...new Set(servers)];
}

function hostLines(value: string, errors: string[]): HostMapping[] {
  const lines: HostMapping[] = [],
    seen = new Set<string>();
  for (const [index, raw] of value.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("=").map((item) => item.trim());
    const domain = parts.length === 2 ? domainASCII(parts[0]) : null;
    if (!domain || !(ipv4(parts[1]) || ipv6(parts[1]))) {
      errors.push(`Hosts 第 ${index + 1} 行应为 域名 = IPv4 或 IPv6 地址`);
      continue;
    }
    if (seen.has(domain)) {
      errors.push(`Hosts 域名 ${domain} 重复`);
      continue;
    }
    seen.add(domain);
    lines.push({ hostname: domain, address: parts[1] });
  }
  return lines;
}

type NetworkRange = { start: bigint; end: bigint };

function networkRange(value: string, version: 4 | 6): NetworkRange {
  const [ip, prefix] = value.split("/");
  let address: bigint;
  if (version === 4) {
    address = ip
      .split(".")
      .reduce((result, octet) => (result << 8n) + BigInt(octet), 0n);
  } else {
    // URL canonicalizes valid IPv6, including an embedded IPv4 tail.
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split("::");
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
    address = groups.reduce(
      (result: bigint, group: string) => (result << 16n) + BigInt(`0x${group}`),
      0n,
    );
  }
  const hostBits = BigInt((version === 4 ? 32 : 128) - Number(prefix));
  const start = (address >> hostBits) << hostBits;
  return { start, end: start + (1n << hostBits) - 1n };
}

function domainRulesOverlap(
  first: NormalizedRule,
  second: NormalizedRule,
): boolean {
  const isDomain = (rule: NormalizedRule) =>
    rule.type === "DOMAIN" || rule.type === "DOMAIN-SUFFIX";
  if (!isDomain(first) || !isDomain(second)) return false;
  const inSuffix = (domain: string, suffix: string) =>
    domain === suffix || domain.endsWith(`.${suffix}`);
  return (
    (first.type === "DOMAIN-SUFFIX" && inSuffix(second.value, first.value)) ||
    (second.type === "DOMAIN-SUFFIX" && inSuffix(first.value, second.value))
  );
}

export function compileProfile(profile: Profile): CompilationResult {
  const errors: string[] = [],
    warnings: string[] = [];
  try {
    assertProfile(profile);
  } catch (error) {
    return {
      content: "",
      errors: [(error as Error).message],
      warnings,
      ruleCount: 0,
    };
  }
  const exporter = getConfigExporter(profile.client);
  if (!exporter)
    return {
      content: "",
      errors: ["此客户端的配置导出尚未实现"],
      warnings,
      ruleCount: 0,
    };
  const servers =
    profile.dns.mode === "encrypted"
      ? ENCRYPTED_DNS
      : profile.dns.mode === "system"
        ? ["system"]
        : dnsServers(profile.dns.servers, errors);
  const extraGeneral = exporter.parseGeneral(profile.general, errors);
  const hosts = hostLines(profile.hosts, errors);
  const rules: NormalizedRule[] = [],
    seenRules = new Map<string, Policy>();
  const networkRanges = new Map<NormalizedRule, NetworkRange>();
  let overlapWarnings = 0;
  const add = (
    type: NormalizedRule["type"],
    value: string,
    policy: Policy,
    noResolve = false,
  ) => {
    const key = `${type},${value}`;
    if (seenRules.has(key)) {
      if (seenRules.get(key) !== policy)
        warnings.push(
          `${key} 存在不同策略；按顺序使用前面的 ${seenRules.get(key)}`,
        );
      return;
    }
    const rule = { type, value, policy, noResolve };
    const range =
      type === "IP-CIDR" || type === "IP-CIDR6"
        ? networkRange(value, type === "IP-CIDR" ? 4 : 6)
        : undefined;
    const overlap = rules.find((previous) => {
      if (previous.policy === policy) return false;
      if (domainRulesOverlap(previous, rule)) return true;
      const previousRange = networkRanges.get(previous);
      return (
        range &&
        previousRange &&
        previous.type === type &&
        range.start <= previousRange.end &&
        previousRange.start <= range.end
      );
    });
    if (overlap) {
      overlapWarnings++;
      if (overlapWarnings <= 50)
        warnings.push(
          `${key} 与前面的 ${overlap.type},${overlap.value} 范围重叠且策略不同（${overlap.policy} / ${policy}）；已保留顺序，重叠流量由最先命中的规则决定，请检查。`,
        );
    }
    if (range) networkRanges.set(rule, range);
    seenRules.set(key, policy);
    rules.push(rule);
  };
  if (profile.bypassLan) {
    add("DOMAIN-SUFFIX", "local", "DIRECT");
    add("DOMAIN", "localhost", "DIRECT");
    for (const range of [
      "127.0.0.0/8",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
    ])
      add("IP-CIDR", range, "DIRECT", true);
    for (const range of ["::1/128", "fc00::/7", "fe80::/10"])
      add("IP-CIDR6", range, "DIRECT", true);
  }
  for (const rule of profile.rules) {
    const value = rule.value.trim();
    if (CONTROL.test(rule.value) || /[,#=\[\]]/.test(rule.value)) {
      errors.push(`规则含有非法分隔符：${rule.id}`);
      continue;
    }
    if (rule.type === "IP-CIDR" || rule.type === "IP-CIDR6") {
      if (!cidr(value, rule.type === "IP-CIDR" ? 4 : 6)) {
        errors.push(`无效的 ${rule.type} 网段：${value}`);
        continue;
      }
      add(rule.type, value.toLowerCase(), rule.policy, true);
    } else if (rule.type === "DOMAIN-KEYWORD") {
      if (!/^[a-zA-Z0-9._-]{1,253}$/.test(value)) {
        errors.push("域名关键词仅支持英文字母、数字、点、下划线与短横线");
        continue;
      }
      add(rule.type, value.toLowerCase(), rule.policy);
      warnings.push(`关键词 ${value} 会匹配任何包含该内容的域名，请留意误匹配`);
    } else {
      const domain = domainASCII(value);
      if (!domain) {
        errors.push(`无效的域名：${value}`);
        continue;
      }
      add(rule.type, domain, rule.policy);
    }
  }
  for (const app of profile.apps) {
    for (const entry of app.domains) {
      const domain = domainASCII(entry);
      if (!domain) {
        errors.push(`${app.name} 的域名无效：${entry}`);
        continue;
      }
      add("DOMAIN-SUFFIX", domain, app.policy);
    }
  }
  add("GEOIP", "CN", profile.domesticPolicy);
  rules.push({
    type: "FINAL",
    value: "",
    policy: profile.finalPolicy,
    noResolve: false,
  });
  if (overlapWarnings > 50)
    warnings.push(
      `另有 ${overlapWarnings - 50} 条规则存在不同策略的范围重叠，请缩小规则范围或检查顺序。`,
    );
  warnings.push(
    "应用预设仅包含基础域名，可能遗漏 CDN 或 IP 连接；共享域名也会影响其他应用。",
  );
  warnings.push(
    "GEOIP 国内判断可能触发 DNS 查询；DNS 加密设置不能证明无泄漏，请在客户端导入后实测。",
  );
  if (
    profile.dns.mode === "system" ||
    servers.some(
      (server) => server === "system" || ipv4(server) || ipv6(server),
    )
  )
    warnings.push(
      "当前 DNS 包含系统或明文解析，查询可能由本地网络提供的 DNS 处理。",
    );
  if (profile.dns.ipv6)
    warnings.push(
      "已启用 IPv6，请确认客户端、节点与网络均支持，并分别验证 IPv4 和 IPv6 出口。",
    );
  if (
    extraGeneral.some(
      (option) =>
        option.key === "use-local-host-item-for-proxy" &&
        option.value === "true",
    )
  )
    warnings.push("代理连接将使用本地 Hosts 映射；错误映射可能导致连接失败。");
  const content = exporter.serialize({
    servers,
    ipv6: profile.dns.ipv6,
    general: extraGeneral,
    rules,
    hosts,
  });
  return {
    content: errors.length ? "" : content,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    ruleCount: rules.length,
  };
}

export function parseProfile(text: string): Profile {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > MAX_BACKUP_SIZE
  )
    throw new Error("备份文件不能超过 512 KB");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("无法读取备份，请选择 RouteKit 导出的 JSON 文件");
  }
  assertProfile(value);
  const result = compileProfile(value);
  if (result.errors.length) throw new Error(result.errors.join("；"));
  return value;
}

export function serializeProfile(profile: Profile): string {
  assertProfile(profile);
  const result = compileProfile(profile);
  if (result.errors.length) throw new Error(result.errors.join("；"));
  return JSON.stringify(profile, null, 2);
}

export function fileName(name: string): string {
  const safe = name
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.(conf|json)$/i, "")
    .replace(/\.+$/g, "")
    .slice(0, 64);
  return !safe ||
    /^\.+$/.test(safe) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)
    ? "routekit"
    : safe;
}
