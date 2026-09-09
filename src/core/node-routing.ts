import {
  parseSubscription,
  proxyNodeIdentity,
  type ProxyNode,
} from "./subscriptions";
import type { NodeRouting, Policy, Profile } from "./types";

// Shadowrocket syntax evidence: LOWERTOP's maintained, executable configuration
// documents [Proxy] positional credentials and direct node-name rule policies:
// https://github.com/LOWERTOP/Shadowrocket/blob/main/lazy_group.conf
// The app developer's release channel also confirms named policy groups:
// https://t.me/s/shadowrocketnews/987
// We do not translate advanced transport parameters based on other clients.

export type NodeRoutingSupport = {
  supported: boolean;
  mode?: "embedded" | "reference";
  reason?: string;
};
export type RouteTarget = { appId?: string; ruleId?: string };
export type CompiledRoutingNode = {
  node: ProxyNode;
  alias: string;
  mode: "embedded" | "reference";
  definition?: string;
  importUri: string;
};
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const NODE_KEYS = ["id", "name", "protocol", "server", "port", "uri"];

function object(
  value: unknown,
  keys?: string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("节点路由必须是对象");
  if (keys && Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("节点路由包含不支持的字段");
}

/** URI parser remains the authority for credentials and protocol parameters. */
function checkedNode(value: unknown): ProxyNode {
  object(value, NODE_KEYS);
  if (typeof value.id !== "string" || !ID.test(value.id))
    throw new Error("节点 ID 只支持 1–100 位字母、数字、短横线和下划线");
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 200 ||
    CONTROL.test(value.name)
  )
    throw new Error("节点名称无效");
  if (
    typeof value.uri !== "string" ||
    value.uri.length > 16_384 ||
    /\s/.test(value.uri) ||
    CONTROL.test(value.uri)
  )
    throw new Error("节点链接无效");
  const parsed = parseSubscription(value.uri);
  if (parsed.errors.length || parsed.nodes.length !== 1)
    throw new Error("节点链接无法安全解析，请重新导入该节点");
  const canonical = parsed.nodes[0];
  if (
    canonical.protocol !== value.protocol ||
    canonical.server !== value.server ||
    canonical.port !== value.port
  )
    throw new Error("节点信息与原始链接不一致，请重新导入该节点");
  return { ...canonical, id: value.id, name: value.name };
}

export function assertNodeRouting(
  value: unknown,
): asserts value is NodeRouting {
  object(value, ["nodes", "defaultNodeId", "appNodeIds", "ruleNodeIds"]);
  if (!Array.isArray(value.nodes) || value.nodes.length > 500)
    throw new Error("节点路由最多保存 500 个节点");
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const item of value.nodes) {
    const node = checkedNode(item);
    if (ids.has(node.id)) throw new Error("节点路由 ID 不能重复");
    const identity = proxyNodeIdentity(node);
    if (identities.has(identity))
      throw new Error(
        "节点路由包含相同连接的重复节点，请保留一个节点后重新绑定",
      );
    ids.add(node.id);
    identities.add(identity);
  }
  const assertReference = (id: unknown) => {
    if (typeof id !== "string" || !ID.test(id) || !ids.has(id))
      throw new Error("路由绑定的节点不存在，请重新选择节点");
  };
  if (value.defaultNodeId !== undefined) assertReference(value.defaultNodeId);
  for (const [field, limit] of [
    ["appNodeIds", 100],
    ["ruleNodeIds", 500],
  ] as const) {
    const mapping = value[field];
    if (mapping === undefined) continue;
    object(mapping);
    if (Object.keys(mapping).length > limit)
      throw new Error("节点绑定数量超出限制");
    for (const [key, id] of Object.entries(mapping)) {
      if (
        !key ||
        key.length > 100 ||
        CONTROL.test(key) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        throw new Error("路由绑定 ID 无效");
      assertReference(id);
    }
  }
}

export function nodeRoutingAlias(node: Pick<ProxyNode, "id">): string {
  if (!ID.test(node.id)) throw new Error("节点 ID 无效");
  return `RK_${node.id}`;
}

function decodeBase64(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0)),
  );
}
function encodeBase64(value: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(value), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
}
// Do not quote/escape undocumented config syntax. Preserve such credentials in
// the original URI and require its separate import instead of losing any bytes.
function safeField(value: string): boolean {
  return !CONTROL.test(value) && !/[\s,#=;"'\\[\]]/.test(value);
}
function inlineDefinition(node: ProxyNode): string | undefined {
  if (!["ss", "http", "https", "socks5"].includes(node.protocol))
    return undefined;
  // IPv6 inline formatting differs across clients; URI import is unambiguous.
  if (node.server.includes(":")) return undefined;
  const url = new URL(node.uri);
  if (url.search) return undefined;
  if (node.protocol === "ss") {
    let method: string, password: string;
    if (url.password) {
      method = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
    } else {
      const info = decodeBase64(url.username);
      const colon = info.indexOf(":");
      method = info.slice(0, colon);
      password = info.slice(colon + 1);
    }
    // SS 2022, plugins and protocol extensions remain untouched in the URI file.
    if (
      ![
        "aes-128-gcm",
        "aes-192-gcm",
        "aes-256-gcm",
        "chacha20-ietf-poly1305",
      ].includes(method) ||
      !safeField(password)
    )
      return undefined;
    return `ss, ${node.server}, ${node.port}, password=${password}, method=${method}`;
  }
  const username = decodeURIComponent(url.username),
    password = decodeURIComponent(url.password);
  if (!safeField(username) || !safeField(password)) return undefined;
  return `${node.protocol}, ${node.server}, ${node.port}${username || password ? `, ${username}, ${password}` : ""}`;
}

function renamedUri(node: ProxyNode, alias: string): string {
  if (node.protocol !== "vmess")
    return `${node.uri.split("#")[0]}#${encodeURIComponent(alias)}`;
  const data = JSON.parse(decodeBase64(node.uri.slice(8))) as Record<
    string,
    unknown
  >;
  data.ps = alias;
  return `vmess://${encodeBase64(JSON.stringify(data))}`;
}

function compileNode(input: ProxyNode): CompiledRoutingNode {
  const node = checkedNode(input),
    alias = nodeRoutingAlias(node);
  const definition = inlineDefinition(node);
  return {
    node,
    alias,
    definition,
    mode: definition ? "embedded" : "reference",
    importUri: renamedUri(node, alias),
  };
}

export function nodeRoutingSupport(node: ProxyNode): NodeRoutingSupport {
  try {
    const compiled = compileNode(node);
    return {
      supported: true,
      mode: compiled.mode,
      reason:
        compiled.mode === "reference"
          ? "保留全部原始连接参数。请先导入配套节点，再导入分流配置；不要修改 RK_ 节点备注。"
          : undefined,
    };
  } catch (error) {
    return { supported: false, reason: (error as Error).message };
  }
}

export function resolveRouteNode(
  profile: Profile,
  policy: Policy,
  target: RouteTarget = {},
): ProxyNode | undefined {
  if (policy !== "PROXY" || !profile.nodeRouting) return undefined;
  const routing = profile.nodeRouting;
  const own = (
    mapping: Record<string, string> | undefined,
    id: string | undefined,
  ) => (id && mapping && Object.hasOwn(mapping, id) ? mapping[id] : undefined);
  const id =
    own(routing.ruleNodeIds, target.ruleId) ??
    own(routing.appNodeIds, target.appId) ??
    routing.defaultNodeId;
  return routing.nodes.find((node) => node.id === id);
}

export function routePolicyLabel(
  profile: Profile,
  policy: Policy,
  target: RouteTarget = {},
): string {
  const node = resolveRouteNode(profile, policy, target);
  return node
    ? node.name
    : { DIRECT: "直连", PROXY: "客户端当前节点", REJECT: "拦截" }[policy];
}

export function compileRoutingNodes(profile: Profile): CompiledRoutingNode[] {
  if (!profile.nodeRouting) return [];
  assertNodeRouting(profile.nodeRouting);
  const used = new Set<string>();
  const add = (policy: Policy, target?: RouteTarget) => {
    const node = resolveRouteNode(profile, policy, target);
    if (node) used.add(node.id);
  };
  add(profile.domesticPolicy);
  add(profile.finalPolicy);
  for (const app of profile.apps) add(app.policy, { appId: app.id });
  for (const rule of profile.rules) add(rule.policy, { ruleId: rule.id });
  return profile.nodeRouting.nodes
    .filter((node) => used.has(node.id))
    .map(compileNode);
}

export function routingNodeBundle(profile: Profile): {
  content: string;
  count: number;
  referenceCount: number;
  errors: string[];
} {
  try {
    const nodes = compileRoutingNodes(profile);
    // Only externally referenced nodes need this second import; embedded nodes
    // must not be imported a second time under the same config-local alias.
    const references = nodes.filter((node) => node.mode === "reference");
    return {
      content: references.length
        ? `${references.map((node) => node.importUri).join("\n")}\n`
        : "",
      count: references.length,
      referenceCount: references.length,
      errors: [],
    };
  } catch (error) {
    return {
      content: "",
      count: 0,
      referenceCount: 0,
      errors: [(error as Error).message],
    };
  }
}
