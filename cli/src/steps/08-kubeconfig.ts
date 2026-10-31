import type { ListrTask } from "listr2";
import { existsSync } from "node:fs";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { retry } from "../lib/retry.js";
import { kubeconfigPath, talosconfigPath } from "../lib/paths.js";

/**
 * Doc: only needs to run once, against whichever control-plane node was
 * used to bootstrap etcd — any control-plane node can serve it after that,
 * so this is never re-run just because you added another node.
 */
export const kubeconfigStep: ListrTask<InstallCtx> = {
  title: "Fetch kubeconfig",
  skip: () => existsSync(kubeconfigPath) && "kubeconfig already present — skipping",
  task: async (ctx, task) => {
    const node = ctx.targetNodes.find((n) => n.controlPlane) ?? ctx.firstControlPlane;

    await retry(
      () =>
        execa("talosctl", [
          "kubeconfig",
          kubeconfigPath,
          "--nodes",
          node.ipAddress,
          "--talosconfig",
          talosconfigPath,
          "--force",
        ]),
      {
        attempts: 20,
        delayMs: 10_000,
        onAttempt: (attempt, attempts) => {
          task.output = `talosctl kubeconfig (attempt ${attempt}/${attempts}) — waiting for kube-apiserver`;
        },
      },
    );

    task.title = `kubeconfig written to ${kubeconfigPath}`;
  },
};
