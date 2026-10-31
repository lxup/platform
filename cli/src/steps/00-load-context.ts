import type { ListrTask } from "listr2";
import type { InstallCtx } from "../lib/context.js";
import { loadTalconfig } from "../lib/talconfig.js";

/**
 * Doc: talos/talconfig.yaml is the single source of truth for every node
 * this cluster will ever have. Adding a 4th node later just means adding
 * another entry under `nodes:` and re-running `pnpm start install` — this
 * step always re-reads the full file, even when only targeting one node.
 */
export const loadContextStep: ListrTask<InstallCtx> = {
  title: "Read cluster topology from talos/talconfig.yaml",
  task: async (ctx, task) => {
    const { clusterName, endpoint, nodes, controlPlanes, firstControlPlane } =
      await loadTalconfig();

    Object.assign(ctx, { clusterName, endpoint, nodes, controlPlanes, firstControlPlane });

    task.title = `Cluster "${clusterName}": ${nodes.length} nodes (${controlPlanes.length} control-plane)`;
  },
};
