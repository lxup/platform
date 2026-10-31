import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { argocdRepoCredentialsPath, kubeconfigPath } from "../lib/paths.js";

/**
 * Doc: gives ArgoCD a Git credential for github.com/lxup, and runs
 * unconditionally — a credential ArgoCD does not need is simply unused.
 *
 * The point is that flipping this repo (or lxup/homelab) to private becomes
 * a visibility toggle on GitHub and nothing else. Put the credential under
 * kubernetes/ instead and it is circular: ArgoCD would have to clone the
 * repo to find the credential that lets it clone the repo. So it is applied
 * here, after ArgoCD exists and before the root app hands GitOps over.
 *
 * Skipped with a visible note if bootstrap/argocd/repo-credentials.sops.yaml
 * is absent, which is survivable only while every repo is public. See the
 * .example.yaml next to it.
 */
export const argocdRepoCredentialsStep: ListrTask<InstallCtx> = {
  title: "Create ArgoCD repository credentials",
  skip: () =>
    existsSync(argocdRepoCredentialsPath)
      ? false
      : "bootstrap/argocd/repo-credentials.sops.yaml absent — ArgoCD will clone anonymously (public repos only)",
  task: async (ctx, task) => {
    task.output = "Decrypting bootstrap/argocd/repo-credentials.sops.yaml";
    const { stdout } = await execa("sops", ["-d", argocdRepoCredentialsPath], {
      env: { SOPS_AGE_KEY_FILE: ctx.ageKeyPath },
    });

    if (stdout.includes("REPLACE_WITH_A_READ_ONLY_PAT")) {
      throw new Error(
        "repo-credentials.sops.yaml still holds the template placeholder — put a real read-only PAT in it (see repo-credentials.example.yaml).",
      );
    }

    // Never written to the repo tree, and removed even on failure: this is a
    // cleartext Git credential.
    const scratch = await mkdtemp(path.join(tmpdir(), "platform-repocreds-"));
    try {
      const file = path.join(scratch, "repo-credentials.yaml");
      await writeFile(file, stdout + "\n", { mode: 0o600 });
      await execa("kubectl", ["apply", "-f", file], { env: { KUBECONFIG: kubeconfigPath } });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    task.title = "ArgoCD can read github.com/lxup (works whether the repos are public or private)";
  },
};
