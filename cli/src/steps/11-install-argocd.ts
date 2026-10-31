import type { ListrTask } from "listr2";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import {
  argocdBootstrapSecretValuesPath,
  argocdBootstrapValuesPath,
  kubeconfigPath,
  repoRoot,
} from "../lib/paths.js";

/**
 * Doc: `helm upgrade --install` is idempotent — safe to run every time
 * (fresh bootstrap or adding a node to an existing cluster), it just
 * confirms ArgoCD is already as described in bootstrap/argocd/values.yaml
 * and does nothing if so. This is also how you upgrade ArgoCD itself
 * later: bump the chart version there and re-run.
 *
 * values.secret.sops.yaml is an OPTIONAL second values file holding the
 * GitHub webhook shared secret (chart key `configs.secret.githubSecret`,
 * which lands in the `argocd-secret` Secret as `webhook.github.secret`).
 * It can't go through ksops like every other secret in this repo — ksops
 * only decrypts Kubernetes manifests during `kustomize build`, and
 * `argocd-secret` is owned by this Helm release, not by GitOps (letting an
 * Application with prune+selfHeal own it would mean a bad sync can delete
 * ArgoCD's own admin password and server signing key). So it's decrypted
 * here into a 0600 temp file that lives only for the duration of the helm
 * call. Missing file = no webhook secret = ArgoCD still works, it just
 * falls back to polling the repo every 3 minutes.
 */
export const installArgocdStep: ListrTask<InstallCtx> = {
  title: "Install ArgoCD",
  task: async (ctx, task) => {
    const env = { KUBECONFIG: kubeconfigPath };

    task.output = "helm repo add/update argo";
    await execa("helm", ["repo", "add", "argo", "https://argoproj.github.io/argo-helm"], {
      cwd: repoRoot,
      env,
      reject: false,
    });
    await execa("helm", ["repo", "update", "argo"], { cwd: repoRoot, env });

    const valuesFiles = [argocdBootstrapValuesPath];
    let scratchDir: string | undefined;

    if (existsSync(argocdBootstrapSecretValuesPath)) {
      task.output = "Decrypting bootstrap/argocd/values.secret.sops.yaml";
      const { stdout } = await execa("sops", ["-d", argocdBootstrapSecretValuesPath], {
        cwd: repoRoot,
        env: { SOPS_AGE_KEY_FILE: ctx.ageKeyPath },
      });
      scratchDir = await mkdtemp(path.join(tmpdir(), "platform-argocd-"));
      const decryptedPath = path.join(scratchDir, "values.secret.yaml");
      await writeFile(decryptedPath, stdout + "\n", { mode: 0o600 });
      valuesFiles.push(decryptedPath);
    }

    try {
      task.output = "helm upgrade --install argocd (this can take a minute)";
      await execa(
        "helm",
        [
          "upgrade",
          "--install",
          "argocd",
          "argo/argo-cd",
          "--namespace",
          "argocd",
          "--create-namespace",
          ...valuesFiles.flatMap((file) => ["--values", file]),
          "--wait",
        ],
        { cwd: repoRoot, env },
      );
    } finally {
      if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
    }

    task.title = "ArgoCD installed";
  },
};
