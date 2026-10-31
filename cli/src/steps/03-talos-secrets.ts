import type { ListrTask } from "listr2";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { repoRoot, talosDir, talsecretPath } from "../lib/paths.js";

/**
 * Doc: one set of cluster secrets (CA, tokens) for the cluster's entire
 * life — generated once, shared by every node including ones added later.
 * Never regenerate this against a live cluster (new nodes couldn't join
 * the old one's etcd anymore); delete talsecret.sops.yaml only when you
 * mean to build a brand new cluster from zero.
 */
export const talosSecretsStep: ListrTask<InstallCtx> = {
  title: "Generate & encrypt Talos cluster secrets",
  task: async (ctx, task) => {
    if (existsSync(talsecretPath)) {
      task.title = "Talos cluster secrets already exist (left untouched)";
      task.output =
        "Regenerating would invalidate certs for any already-bootstrapped cluster — delete the file manually if you really want a fresh cluster.";
      return;
    }

    task.output = "Running talhelper gensecret";
    const { stdout } = await execa("talhelper", ["gensecret"], { cwd: talosDir });
    await writeFile(talsecretPath, stdout + "\n");

    task.output = "Encrypting with sops";
    await execa("sops", ["-e", "-i", "talos/talsecret.sops.yaml"], {
      cwd: repoRoot,
      env: { SOPS_AGE_KEY_FILE: ctx.ageKeyPath },
    });

    task.title = "Talos cluster secrets generated and encrypted";
  },
};
