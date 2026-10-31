import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Listr } from "listr2";
import type { InstallCtx } from "../lib/context.js";
import { getReadyNodeNames } from "../lib/kubectl.js";
import { kubeconfigPath } from "../lib/paths.js";
import { loadTalconfig } from "../lib/talconfig.js";

import { loadContextStep } from "../steps/00-load-context.js";
import { prerequisitesStep } from "../steps/01-prerequisites.js";
import { ageKeyStep } from "../steps/02-age-key.js";
import { talosSecretsStep } from "../steps/03-talos-secrets.js";
import { renderCiliumStep } from "../steps/04-render-cilium.js";
import { genconfigStep } from "../steps/05-genconfig.js";
import { applyConfigStep } from "../steps/06-apply-config.js";
import { bootstrapEtcdStep } from "../steps/07-bootstrap-etcd.js";
import { kubeconfigStep } from "../steps/08-kubeconfig.js";
import { waitNodesReadyStep } from "../steps/09-wait-nodes-ready.js";
import { sopsSecretStep } from "../steps/10-sops-secret.js";
import { installArgocdStep } from "../steps/11-install-argocd.js";
import { argocdRepoCredentialsStep } from "../steps/12-argocd-repo-credentials.js";
import { applyRootAppStep } from "../steps/13-apply-root-app.js";

const STEPS = [
  loadContextStep,
  prerequisitesStep,
  ageKeyStep,
  talosSecretsStep,
  renderCiliumStep,
  genconfigStep,
  applyConfigStep,
  bootstrapEtcdStep,
  kubeconfigStep,
  waitNodesReadyStep,
  // sops-age secret must exist BEFORE ArgoCD installs — its repo-server
  // mounts it as a volume, and a missing Secret hangs the pod forever.
  sopsSecretStep,
  installArgocdStep,
  // Before the root app, not after: this is what lets ArgoCD clone the repo
  // the root app points at, if these repos ever go private.
  argocdRepoCredentialsStep,
  applyRootAppStep,
];

/**
 * First node ever, or adding another node to an already-running cluster —
 * same command either way. talos/talconfig.yaml always lists every node
 * the cluster will ever have; this just asks which of them are physically
 * booted and reachable *right now*, and only touches those.
 */
export async function runInstall() {
  p.intro(pc.bgCyan(pc.black(" install / add nodes ")));

  const topo = await loadTalconfig();
  const clusterAlreadyUp = existsSync(kubeconfigPath);
  const readyNodes = clusterAlreadyUp ? await getReadyNodeNames() : new Set<string>();

  p.log.message(
    clusterAlreadyUp
      ? "A cluster already exists (kubeconfig found) — this run can only add new node(s) to it, etcd won't be re-bootstrapped."
      : "No cluster yet — the first control-plane node selected below will bootstrap etcd.",
  );

  // Nodes already Ready are unchecked by default: re-selecting one does no
  // damage (Talos refuses --insecure apply-config once a node has left
  // maintenance mode — no wipe, no reinstall), but it does fail that node's
  // step and, since steps run with exitOnError, aborts the whole run before
  // confirming the *new* node you actually care about joined cleanly.
  const selected = await p.multiselect({
    message: "Which node(s) are booted (on the USB/ISO) and reachable right now?",
    options: topo.nodes.map((n) => ({
      value: n.hostname,
      label: `${n.hostname} (${n.ipAddress})`,
      hint: readyNodes.has(n.hostname) ? "already in cluster" : undefined,
    })),
    initialValues: topo.nodes.filter((n) => !readyNodes.has(n.hostname)).map((n) => n.hostname),
  });

  if (p.isCancel(selected) || selected.length === 0) {
    p.cancel("Aborted — nothing was touched.");
    return;
  }

  const targetNodes = topo.nodes.filter((n) => selected.includes(n.hostname));

  p.log.message(
    [
      "This run will, in order:",
      "  1. generate/encrypt Talos + SOPS secrets (skipped if they already exist)",
      `  2. wipe and install Talos on: ${targetNodes.map((n) => n.hostname).join(", ")}`,
      clusterAlreadyUp
        ? "  3. join the existing cluster (no etcd bootstrap, no ArgoCD reinstall needed)"
        : "  3. bootstrap the Kubernetes cluster (Cilium, no kube-proxy) and install ArgoCD",
    ].join("\n"),
  );

  const proceed = await p.confirm({
    message: `This will reformat the disk on: ${targetNodes.map((n) => n.hostname).join(", ")}. Continue?`,
    initialValue: false,
  });

  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Aborted — nothing was touched.");
    return;
  }

  const tasks = new Listr<InstallCtx>(STEPS, {
    concurrent: false,
    exitOnError: true,
    rendererOptions: { collapseSubtasks: false },
  });

  try {
    await tasks.run({ targetNodes, clusterAlreadyUp } as InstallCtx);
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro(pc.red("Install failed — re-run once you've fixed the issue above."));
    return;
  }

  p.note(
    [
      `export KUBECONFIG=${kubeconfigPath}`,
      "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d",
      "kubectl -n argocd port-forward svc/argocd-server 8080:443",
    ].join("\n"),
    "Next steps",
  );

  if (!clusterAlreadyUp) {
    p.note(
      [
        "git add talos/talsecret.sops.yaml .sops.yaml",
        "git commit -m 'chore: bootstrap cluster secrets'",
      ].join("\n"),
      "Commit the new encrypted secrets",
    );
  }

  // Nodes neither already-Ready nor just-installed this run still need booting.
  const remaining = topo.nodes.filter(
    (n) => !readyNodes.has(n.hostname) && !selected.includes(n.hostname),
  );
  p.outro(
    remaining.length > 0
      ? pc.green(
          `Done. Boot ${remaining.map((n) => n.hostname).join(", ")} and re-run "Install" when ready.`,
        )
      : pc.green("Cluster is up. ArgoCD now owns kubernetes/platform/."),
  );
}

/** Re-install just ArgoCD — used by the status command when it's missing or unhealthy. */
export async function runInstallArgocdOnly() {
  const tasks = new Listr<InstallCtx>(
    [loadContextStep, ageKeyStep, sopsSecretStep, installArgocdStep],
    { concurrent: false, exitOnError: true },
  );
  await tasks.run({ targetNodes: [], clusterAlreadyUp: true } as unknown as InstallCtx);
}

/** Re-apply the app-of-apps — used by the status command when it's missing. */
export async function runApplyRootApp() {
  const tasks = new Listr<InstallCtx>([applyRootAppStep], { concurrent: false, exitOnError: true });
  await tasks.run({} as InstallCtx);
}
