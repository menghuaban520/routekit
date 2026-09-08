import {
  parseSubscription,
  proxyNodeIdentity,
  type ProxyNode,
} from "./subscriptions";

export type ProbeResult = {
  nodeId: string;
  name: string;
  server: string;
  protocol: ProxyNode["protocol"];
  status: "ok" | "error";
  latencyMs?: number;
  speedMbps?: number;
  downloadedBytes?: number;
  exitIp?: string;
  country?: string;
  region?: string;
  city?: string;
  asn?: string | number;
  organization?: string;
  ipType?: string;
  latitude?: number;
  longitude?: number;
  serverIps?: string[];
  warnings?: string[];
  error?: string;
};
export type ImportedProbeResults = {
  generatedAt: string;
  results: ProbeResult[];
  warnings: string[];
};
export type Coordinates = { latitude: number; longitude: number };
export type ProbeJob = {
  version: 1;
  nodes: ProxyNode[];
  options: {
    speedTest: boolean;
    downloadBytes: number;
    timeoutSeconds: number;
  };
};
const MAX_BYTES = 2 * 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const RESULT_KEYS = [
  "nodeId",
  "name",
  "server",
  "protocol",
  "status",
  "latencyMs",
  "speedMbps",
  "downloadedBytes",
  "exitIp",
  "country",
  "region",
  "city",
  "asn",
  "organization",
  "ipType",
  "latitude",
  "longitude",
  "serverIps",
  "warnings",
  "error",
];

function object(
  value: unknown,
  allowed: string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}应为对象`);
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(
      `${label}包含不支持的字段，请使用 RouteKit 本地检测器导出的结果`,
    );
}
function text(value: unknown, label: string, max = 200, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    CONTROL.test(value) ||
    (!empty && !value)
  )
    throw new Error(`${label}无效`);
  return value;
}
function ip(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value))
    return value
      .split(".")
      .every(
        (part) =>
          Number(part) <= 255 && (part === "0" || !part.startsWith("0")),
      );
  if (!value.includes(":") || !/^[0-9a-f:.]+$/i.test(value)) return false;
  try {
    return new URL(`https://[${value}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}
function canonicalServer(value: unknown): string {
  const server = text(value, "入口主机", 253);
  if (ip(server))
    return server.includes(":")
      ? new URL(`https://[${server}]/`).hostname
      : server;
  if (/[\s/#?@:%\\\[\]]/.test(server)) throw new Error("入口主机格式无效");
  let host: string;
  try {
    host = new URL(`https://${server}/`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    throw new Error("入口主机格式无效");
  }
  if (
    host
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error("入口主机格式无效");
  return host;
}
function optionalNumber(
  value: unknown,
  min: number,
  max: number,
  label: string,
  integer = false,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(`${label}超出有效范围`);
  return value;
}
function safeMessage(value: unknown, label: string): string {
  return text(value, label, 1000, true).replace(
    /\b(?:https?|socks5|ss|vmess|vless|trojan):\/\/\S+/gi,
    "[地址已隐藏]",
  );
}

export function parseProbeResults(
  input: string,
  nodes: ProxyNode[],
): ImportedProbeResults {
  if (
    typeof input !== "string" ||
    new TextEncoder().encode(input).byteLength > MAX_BYTES
  )
    throw new Error("检测结果文件不能超过 2 MB");
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error("无法读取结果 JSON，请选择本地检测器导出的文件");
  }
  object(raw, ["version", "source", "generatedAt", "results"], "检测结果");
  if (raw.version !== 1 || raw.source !== "routekit-local-probe")
    throw new Error("不支持此检测结果版本或来源");
  const generatedAt = text(raw.generatedAt, "检测时间", 40);
  const timestamp = Date.parse(generatedAt);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      generatedAt,
    ) ||
    !Number.isFinite(timestamp)
  )
    throw new Error("检测时间格式无效");
  if (!Array.isArray(raw.results) || raw.results.length > 500)
    throw new Error("结果最多包含 500 个节点");
  const known = new Map(nodes.map((node) => [node.id, node])),
    seen = new Set<string>(),
    warnings: string[] = [],
    results: ProbeResult[] = [];
  let unknown = 0,
    mismatched = 0;
  for (const [index, item] of raw.results.entries()) {
    const label = `结果 ${index + 1}`;
    object(item, RESULT_KEYS, label);
    const nodeId = text(item.nodeId, `${label}节点 ID`, 100);
    if (seen.has(nodeId)) throw new Error("检测结果包含重复节点 ID");
    seen.add(nodeId);
    const name = text(item.name, `${label}节点名称`, 200, true);
    const server = text(item.server, `${label}入口主机`, 253);
    canonicalServer(server);
    const protocol = text(
      item.protocol,
      `${label}协议`,
      20,
    ) as ProxyNode["protocol"];
    if (
      !["ss", "vmess", "vless", "trojan", "socks5", "http", "https"].includes(
        protocol,
      )
    )
      throw new Error(`${label}协议无效`);
    if (item.status !== "ok" && item.status !== "error")
      throw new Error(`${label}状态无效`);
    const result: ProbeResult = {
      nodeId,
      name,
      server,
      protocol,
      status: item.status,
    };
    result.latencyMs = optionalNumber(item.latencyMs, 0, 120_000, "延迟");
    result.speedMbps = optionalNumber(item.speedMbps, 0, 100_000, "下载速度");
    result.downloadedBytes = optionalNumber(
      item.downloadedBytes,
      0,
      100_000_000,
      "测速字节数",
      true,
    );
    result.latitude = optionalNumber(item.latitude, -90, 90, "纬度");
    result.longitude = optionalNumber(item.longitude, -180, 180, "经度");
    if ((result.latitude === undefined) !== (result.longitude === undefined))
      throw new Error("检测坐标需要同时提供经纬度");
    for (const key of [
      "country",
      "region",
      "city",
      "organization",
      "ipType",
    ] as const) {
      if (item[key] !== undefined && item[key] !== null)
        result[key] = text(item[key], key, 200, true);
    }
    if (item.asn !== undefined && item.asn !== null)
      result.asn =
        typeof item.asn === "number"
          ? optionalNumber(item.asn, 0, 4294967295, "ASN", true)
          : text(item.asn, "ASN", 200, true);
    if (item.exitIp !== undefined && item.exitIp !== null) {
      result.exitIp = text(item.exitIp, "出口 IP", 64);
      if (!ip(result.exitIp)) throw new Error("出口 IP 格式无效");
    }
    if (item.serverIps !== undefined && item.serverIps !== null) {
      if (!Array.isArray(item.serverIps) || item.serverIps.length > 32)
        throw new Error("入口 IP 列表无效");
      result.serverIps = item.serverIps.map((value) => {
        const address = text(value, "入口 IP", 64);
        if (!ip(address)) throw new Error("入口 IP 格式无效");
        return address;
      });
    }
    if (item.warnings !== undefined && item.warnings !== null) {
      if (!Array.isArray(item.warnings) || item.warnings.length > 30)
        throw new Error("检测提示列表无效");
      result.warnings = item.warnings.map((warning) =>
        safeMessage(warning, "检测提示"),
      );
    }
    if (item.error !== undefined && item.error !== null)
      result.error = safeMessage(item.error, "检测错误");
    if (
      result.status === "ok" &&
      result.latencyMs === undefined &&
      result.speedMbps === undefined &&
      result.exitIp === undefined
    )
      throw new Error("已完成的检测结果至少需要一项实测延迟、速度或出口 IP");
    const current = known.get(nodeId);
    if (!current) {
      unknown++;
      continue;
    }
    if (
      canonicalServer(current.server) !== canonicalServer(server) ||
      current.protocol !== protocol
    ) {
      mismatched++;
      continue;
    }
    results.push(result);
  }
  if (unknown)
    warnings.push(
      `${unknown} 个结果不属于当前节点列表，已跳过；没有新增节点。`,
    );
  if (mismatched)
    warnings.push(
      `${mismatched} 个结果的入口主机或协议与当前节点不一致，已跳过。`,
    );
  if (timestamp > Date.now() + 300_000)
    warnings.push("结果时间晚于当前时间，请核对本地检测器的系统时钟。");
  return { generatedAt, results, warnings };
}

/** Explicit task restoration preserves IDs without storing credentials in browser storage. */
export function parseProbeJob(input: string): ProbeJob {
  if (
    typeof input !== "string" ||
    new TextEncoder().encode(input).byteLength > MAX_BYTES
  )
    throw new Error("检测任务文件不能超过 2 MB");
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error("无法读取任务 JSON，请选择已下载的 routekit-job.json");
  }
  object(raw, ["version", "nodes", "options"], "检测任务");
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.nodes) ||
    !raw.nodes.length ||
    raw.nodes.length > 100
  )
    throw new Error("检测任务需为 v1 格式且包含 1–100 个节点");
  object(
    raw.options,
    ["speedTest", "downloadBytes", "timeoutSeconds"],
    "检测选项",
  );
  if (typeof raw.options.speedTest !== "boolean")
    throw new Error("测速选项无效");
  const downloadBytes = optionalNumber(
    raw.options.downloadBytes,
    1,
    50_000_000,
    "测速流量",
    true,
  );
  const timeoutSeconds = optionalNumber(
    raw.options.timeoutSeconds,
    1,
    120,
    "超时时间",
    true,
  );
  if (downloadBytes === undefined || timeoutSeconds === undefined)
    throw new Error("检测选项缺失");
  const ids = new Set<string>(),
    identities = new Set<string>(),
    nodes: ProxyNode[] = [];
  for (const entry of raw.nodes) {
    object(
      entry,
      ["id", "name", "protocol", "server", "port", "uri"],
      "任务节点",
    );
    const id = text(entry.id, "任务节点 ID", 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(id) || ids.has(id))
      throw new Error("任务节点 ID 无效或重复");
    const uri = text(entry.uri, "任务节点链接", 16 * 1024);
    const parsed = parseSubscription(uri);
    if (parsed.errors.length || parsed.nodes.length !== 1)
      throw new Error("任务含有无效节点链接");
    const node = parsed.nodes[0];
    if (
      entry.name !== node.name ||
      entry.protocol !== node.protocol ||
      entry.port !== node.port ||
      canonicalServer(entry.server) !== canonicalServer(node.server)
    )
      throw new Error("任务节点的名称、入口、端口或协议与链接不一致");
    const key = proxyNodeIdentity(node);
    if (identities.has(key)) throw new Error("任务包含重复连接配置");
    ids.add(id);
    identities.add(key);
    nodes.push({ ...node, id });
  }
  return {
    version: 1,
    nodes,
    options: {
      speedTest: raw.options.speedTest,
      downloadBytes,
      timeoutSeconds,
    },
  };
}

/** Great-circle distance between approximate coordinates; not a routed network distance. */
export function haversineDistanceKm(
  origin: Coordinates,
  target: Coordinates,
): number {
  for (const point of [origin, target]) {
    optionalNumber(point.latitude, -90, 90, "纬度");
    optionalNumber(point.longitude, -180, 180, "经度");
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude))
      throw new Error("坐标无效");
  }
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const latitude = rad(target.latitude - origin.latitude),
    longitude = rad(target.longitude - origin.longitude);
  const a =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(rad(origin.latitude)) *
      Math.cos(rad(target.latitude)) *
      Math.sin(longitude / 2) ** 2;
  return (
    6371.0088 *
    2 *
    Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)))
  );
}
