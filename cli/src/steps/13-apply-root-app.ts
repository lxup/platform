import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { platformRootAppPath, kubeconfigPath } from "../lib/paths.js";

/**
 * Doc: `kubectl apply` on the same unchanged file is a no-op — safe to
 * run on every node-add too. After the very first apply, ArgoCD watches
 * this path itself, so nothing here ever needs manual re-applying anyway.
 */
export const applyRootAppStep: ListrTask<InstallCtx> = {
  title: "Apply the ArgoCD root app-of-apps",
  task: async (_ctx, task) => {
    await execa("kubectl", ["apply", "-f", platformRootAppPath], {
      env: { KUBECONFIG: kubeconfigPath },
    });
    task.title = "GitOps handed off to ArgoCD — it now owns kubernetes/platform";
  },
};
