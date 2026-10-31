import type { TalosNode } from "./talconfig.js";

/** Shared state threaded through every install step. */
export interface InstallCtx {
  clusterName: string;
  endpoint: string;
  nodes: TalosNode[];
  controlPlanes: TalosNode[];
  firstControlPlane: TalosNode;
  /** Nodes to actually touch this run — may be a subset of `nodes` when bringing nodes up one at a time. */
  targetNodes: TalosNode[];
  /** True if kubeconfig already exists — this run is adding node(s) to a live cluster, not bootstrapping. */
  clusterAlreadyUp: boolean;
  ageKeyPath: string;
  agePublicKey?: string;
}
