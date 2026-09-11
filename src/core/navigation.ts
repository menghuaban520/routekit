export type Workspace = "network" | "nodes" | "config" | "diagnostics";
export type NetworkSection = "overview" | "websites" | "speed" | "host" | "leaks";
export type SubscriptionSection = "import" | "usage" | "library" | "probe" | "live";
export type ConfigTab = "apps" | "basic" | "dns" | "advanced" | "chain";
export type NavigationTarget = { view: Workspace; tool: string };

const sections: Record<Workspace, readonly string[]> = {
  network: ["overview", "websites", "speed", "host", "leaks"],
  nodes: ["import", "usage", "library", "probe", "live"],
  config: ["apps", "basic", "dns", "chain", "advanced"],
  diagnostics: ["rules"],
};
const legacySections: Record<string, SubscriptionSection> = {
  "#subscription-import": "import",
  "#subscription-usage": "usage",
  "#subscription-library": "library",
  "#subscription-probe": "probe",
  "#subscription-live": "live",
};

export function normalizeNavigation(view: string | null, tool?: string | null): NavigationTarget {
  const validView: Workspace = view && Object.hasOwn(sections, view) ? view as Workspace : "network";
  return { view: validView, tool: tool && sections[validView].includes(tool) ? tool : sections[validView][0] };
}

export function readNavigation(url: URL): NavigationTarget {
  const view = url.searchParams.get("view");
  const tool = url.searchParams.get("tool") ?? (view === "nodes" ? legacySections[url.hash] : undefined);
  return normalizeNavigation(view, tool);
}

export function navigationUrl(url: URL, target: NavigationTarget): URL {
  const next = new URL(url);
  const valid = normalizeNavigation(target.view, target.tool);
  next.searchParams.set("view", valid.view);
  next.searchParams.set("tool", valid.tool);
  next.hash = "";
  return next;
}
