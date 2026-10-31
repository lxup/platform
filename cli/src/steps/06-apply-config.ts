import type { ListrTask } from "listr2";
import path from "node:path";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { clusterConfigDir } from "../lib/paths.js";

/**
 * Doc: `--insecure` talks to the node's maintenance-mode API (booted from
 * USB/ISO, no config yet) — it only works before the node has a config
 * applied. Re-running this against an already-configured node fails safely
 * (it'll refuse); that's fine, it just means that node is done.
 */
export const applyConfigStep: ListrTask<InstallCtx> = {
  title: "Apply machine config to the targeted node(s)",
  task: (ctx, task) =>
    task.newListr(
      ctx.targetNodes.map((node) => ({
        title: `${node.hostname} (${node.ipAddress})`,
        task: async (ctx, subtask) => {
          // talhelper names output files `<clusterName>-<hostname>.yaml`.
          const configFile = path.join(
            clusterConfigDir,
            `${ctx.clusterName}-${node.hostname}.yaml`,
          );
          subtask.output = "talosctl apply-config --insecure";
          await execa("talosctl", [
            "apply-config",
            "--insecure",
            "--nodes",
            node.ipAddress,
            "--file",
            configFile,
          ]);
        },
      })),
      { concurrent: true, rendererOptions: { collapseSubtasks: false } },
    ),
};
