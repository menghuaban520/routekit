import type { ProxyNode } from "./subscriptions";

export type Policy = "DIRECT" | "PROXY" | "REJECT";
export type NodeRouting = {
  nodes: ProxyNode[];
  defaultNodeId?: string;
  appNodeIds?: Record<string, string>;
  ruleNodeIds?: Record<string, string>;
};
export type AppRule = {
  id: string;
  name: string;
  domains: string[];
  policy: Policy;
  color: string;
  symbol: string;
  custom?: boolean;
};
export type CustomRule = {
  id: string;
  type: "DOMAIN" | "DOMAIN-SUFFIX" | "DOMAIN-KEYWORD" | "IP-CIDR" | "IP-CIDR6";
  value: string;
  policy: Policy;
};
export type Profile = {
  version: 1;
  name: string;
  client: "shadowrocket";
  domesticPolicy: "DIRECT" | "PROXY";
  finalPolicy: "DIRECT" | "PROXY";
  bypassLan: boolean;
  dns: {
    mode: "encrypted" | "system" | "custom";
    servers: string;
    ipv6: boolean;
  };
  apps: AppRule[];
  rules: CustomRule[];
  hosts: string;
  general: string;
  nodeRouting?: NodeRouting;
};

// The compiler owns validation and rule order; each adapter owns its file syntax.
export type NormalizedRule = {
  type: CustomRule["type"] | "GEOIP" | "FINAL";
  value: string;
  policy: Policy;
  noResolve: boolean;
  // A compiler-created alias, never a raw user-supplied policy string.
  target?: string;
};
export type GeneralOption = { key: string; value: string };
export type HostMapping = { hostname: string; address: string };
export type ExportModel = {
  servers: string[];
  ipv6: boolean;
  general: GeneralOption[];
  rules: NormalizedRule[];
  hosts: HostMapping[];
  proxies?: { alias: string; definition: string }[];
  externalNodes?: { alias: string }[];
};
export interface ConfigExporter {
  id: string;
  name: string;
  extension: string;
  parseGeneral(raw: string, errors: string[]): GeneralOption[];
  serialize(model: ExportModel): string;
}
export type CompilationResult = {
  content: string;
  errors: string[];
  warnings: string[];
  ruleCount: number;
};
