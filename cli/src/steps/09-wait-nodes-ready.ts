import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { retry } from "../lib/retry.js";
import { kubeconfigPath } from "../lib/paths.js";

interface NodeList {
  items: Array<{
    metadata: { name: string };
    status: { conditions: Array<{ type: string; status: string }> };
  }>;
}

/**
 * Doc: checks the specific node(s) targeted this run by hostname, not a
 * raw count — so this works the same whether it's the first node ever or
 * the 4th one joining an already-Ready cluster.
 */
export const waitNodesReadyStep: ListrTask<InstallCtx> = {
  title: "Wait for the targeted node(s) to go Ready (Cilium coming up)",
  task: async (ctx, task) => {
    const wanted = ctx.targetNodes.map((n) => n.hostname);

    await retry(
      async () => {
        const { stdout } = await execa("kubectl", ["get", "nodes", "-o", "json"], {
          env: { KUBECONFIG: kubeconfigPath },
        });
        const list = JSON.parse(stdout) as NodeList;

        const readyNames = new Set(
          list.items
            .filter((n) => n.status.conditions.some((c) => c.type === "Ready" && c.status === "True"))
            .map((n) => n.metadata.name),
        );
        const readyWanted = wanted.filter((h) => readyNames.has(h));

        task.output = `${readyWanted.length}/${wanted.length} targeted nodes Ready`;

        if (readyWanted.length < wanted.length) {
          throw new Error(`Only ${readyWanted.length}/${wanted.length} targeted nodes Ready`);
        }
      },
      { attempts: 30, delayMs: 10_000 },
    );

    task.title = "Targeted node(s) Ready";
  },
};
