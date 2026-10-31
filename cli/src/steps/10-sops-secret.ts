import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { kubeconfigPath } from "../lib/paths.js";

/**
 * Doc: ArgoCD's repo-server needs the Age *private* key to decrypt
 * SOPS-encrypted manifests (ksops) when it renders kustomize output. This
 * secret is the root of trust for every other secret in the repo, so it's
 * created here imperatively from the operator's local key — never
 * GitOps-managed.
 *
 * Runs BEFORE installing ArgoCD on purpose: the repo-server pod spec
 * (bootstrap/argocd/values.yaml) mounts this secret as a volume, so if it
 * doesn't exist yet, the pod hangs on a FailedMount forever and
 * `helm --wait` times out. Namespace is created here too since ArgoCD's
 * own `--create-namespace` hasn't run yet at this point.
 */
export const sopsSecretStep: ListrTask<InstallCtx> = {
  title: "Create sops-age secret for ArgoCD's repo-server",
  task: async (ctx, task) => {
    const env = { KUBECONFIG: kubeconfigPath };

    const { stdout: namespace } = await execa("kubectl", [
      "create",
      "namespace",
      "argocd",
      "--dry-run=client",
      "-o",
      "yaml",
    ]);
    await execa("kubectl", ["apply", "-f", "-"], { env, input: namespace });

    const { stdout: secret } = await execa("kubectl", [
      "create",
      "secret",
      "generic",
      "sops-age",
      "--namespace",
      "argocd",
      `--from-file=keys.txt=${ctx.ageKeyPath}`,
      "--dry-run=client",
      "-o",
      "yaml",
    ]);
    await execa("kubectl", ["apply", "-f", "-"], { env, input: secret });

    task.title = "sops-age secret ready in argocd namespace";
  },
};
