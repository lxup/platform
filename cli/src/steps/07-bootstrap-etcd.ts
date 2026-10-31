import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { retry } from "../lib/retry.js";
import { talosconfigPath } from "../lib/paths.js";

/**
 * Doc: `talosctl bootstrap` initializes etcd and must run EXACTLY ONCE per
 * cluster, on exactly one control-plane node — never again after that,
 * even when adding more control-plane nodes later (they join the existing
 * etcd automatically once their config is applied, no extra command
 * needed). We detect "already bootstrapped" by the presence of kubeconfig.
 */
export const bootstrapEtcdStep: ListrTask<InstallCtx> = {
  title: "Bootstrap etcd on first control-plane node",
  skip: (ctx) => ctx.clusterAlreadyUp && "Cluster already bootstrapped — skipping",
  task: async (ctx, task) => {
    const node = ctx.targetNodes.find((n) => n.controlPlane) ?? ctx.firstControlPlane;
    task.output = `Waiting for ${node.hostname} to come back up after applying its config`;

    await retry(
      () =>
        execa("talosctl", [
          "bootstrap",
          "--nodes",
          node.ipAddress,
          "--talosconfig",
          talosconfigPath,
        ]),
      {
        attempts: 30,
        delayMs: 10_000,
        onAttempt: (attempt, attempts) => {
          task.output = `talosctl bootstrap (attempt ${attempt}/${attempts})`;
        },
      },
    );

    task.title = "etcd bootstrapped";
  },
};
