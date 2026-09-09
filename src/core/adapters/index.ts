import type { ConfigExporter } from "../types";
import { clashExporter } from "./clash";
import { xrayExporter } from "./xray";
import { shadowrocketExporter } from "./shadowrocket";

const exporters: ReadonlyMap<string, ConfigExporter> = new Map([
  [shadowrocketExporter.id, shadowrocketExporter],
  [clashExporter.id, clashExporter],
  [xrayExporter.id, xrayExporter],
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
  { id: "clash", name: "Clash / Mihomo", extension: ".yaml", available: true },
  { id: "v2rayn", name: "v2rayN", extension: ".json", available: true },
] as const;
