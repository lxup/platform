import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { clusterConfigDir, talosDir } from "../lib/paths.js";

/**
 * Doc: regenerates machine config for EVERY node in talconfig.yaml, not
 * just the targeted one(s) — cheap and side-effect-free (writes local
 * files only), and means a freshly-added talconfig.yaml entry is always
 * ready to apply without a separate "generate" step.
 */
export const genconfigStep: ListrTask<InstallCtx> = {
  title: "Validate talconfig & render per-node Talos configs",
  task: async (ctx, task) => {
    const env = { SOPS_AGE_KEY_FILE: ctx.ageKeyPath };

    task.output = "talhelper validate talconfig";
    await execa("talhelper", ["validate", "talconfig"], { cwd: talosDir, env });

    task.output = "talhelper genconfig";
    await execa(
      "talhelper",
      ["genconfig", "--out-dir", clusterConfigDir],
      { cwd: talosDir, env },
    );

    task.title = "Talos configs rendered for all nodes";
  },
};
