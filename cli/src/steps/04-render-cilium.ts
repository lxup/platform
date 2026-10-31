import type { ListrTask } from "listr2";
import { writeFile } from "node:fs/promises";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { ciliumRenderedPath, ciliumValuesPath, repoRoot } from "../lib/paths.js";

/** Bump when you want a newer Cilium — https://github.com/cilium/cilium/releases */
export const CILIUM_CHART_VERSION = "1.20.2";

/**
 * Doc: Talos only *creates* resources from an inline manifest on a node's
 * first-ever bootstrap — it ignores this file completely for a node
 * that's joining an already-running cluster. Re-rendering it here is
 * harmless either way; it's only actually used the moment etcd is
 * bootstrapped for the first time.
 */
export const renderCiliumStep: ListrTask<InstallCtx> = {
  title: `Render Cilium v${CILIUM_CHART_VERSION} manifest for Talos inline install`,
  task: async (_ctx, task) => {
    task.output = "helm repo add/update cilium";
    await execa("helm", ["repo", "add", "cilium", "https://helm.cilium.io/"], {
      cwd: repoRoot,
      reject: false,
    });
    await execa("helm", ["repo", "update", "cilium"], { cwd: repoRoot });

    task.output = "helm template";
    const { stdout } = await execa(
      "helm",
      [
        "template",
        "cilium",
        "cilium/cilium",
        "--version",
        CILIUM_CHART_VERSION,
        "--namespace",
        "kube-system",
        "-f",
        ciliumValuesPath,
      ],
      { cwd: repoRoot },
    );

    await writeFile(ciliumRenderedPath, stdout + "\n");
    task.title = `Cilium v${CILIUM_CHART_VERSION} manifest rendered`;
  },
};
