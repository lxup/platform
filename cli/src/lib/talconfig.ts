import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { talconfigPath } from "./paths.js";

export interface TalosNode {
  hostname: string;
  ipAddress: string;
  controlPlane: boolean;
}

interface RawTalconfig {
  clusterName: string;
  endpoint: string;
  nodes: Array<{ hostname: string; ipAddress: string; controlPlane?: boolean }>;
}

export async function loadTalconfig() {
  const raw = await readFile(talconfigPath, "utf8");
  const parsed = parse(raw) as RawTalconfig;

  const nodes: TalosNode[] = parsed.nodes.map((n) => ({
    hostname: n.hostname,
    ipAddress: n.ipAddress,
    controlPlane: n.controlPlane ?? false,
  }));

  const controlPlanes = nodes.filter((n) => n.controlPlane);
  if (controlPlanes.length === 0) {
    throw new Error(`No control-plane node found in ${talconfigPath}`);
  }

  return {
    clusterName: parsed.clusterName,
    endpoint: parsed.endpoint,
    nodes,
    controlPlanes,
    firstControlPlane: controlPlanes[0],
  };
}
