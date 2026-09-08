import type { ConfigExporter } from "../types";
import { shadowrocketExporter } from "./shadowrocket";

const exporters: ReadonlyMap<string, ConfigExporter> = new Map([
  [shadowrocketExporter.id, shadowrocketExporter],
]);

export function getConfigExporter(client: string): ConfigExporter | undefined {
  return exporters.get(client);
}

export const CLIENTS = [
  {
    id: shadowrocketExporter.id,
    name: shadowrocketExporter.name,
    extension: shadowrocketExporter.extension,
    available: true,
  },
  { id: "clash", name: "Clash / Mihomo", extension: ".yaml", available: false },
  { id: "v2rayn", name: "v2rayN", extension: ".json", available: false },
] as const;
