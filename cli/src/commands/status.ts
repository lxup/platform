import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  getArgoApplication,
  getDaemonSetStatus,
  getDeploymentReady,
  getNodesStatus,
  helmReleaseExists,
  refreshArgoApplication,
} from "../lib/kubectl.js";
import { platformRootAppPath } from "../lib/paths.js";
import { runApplyRootApp, runInstallArgocdOnly } from "./install.js";

type Health = "ok" | "degraded" | "missing";

interface CheckResult {
  key: string;
  label: string;
  health: Health;
  detail: string;
  fix?: { label: string; run: () => Promise<void> };
}

async function checkNodes(): Promise<CheckResult> {
  const nodes = await getNodesStatus();
  if (!nodes) return { key: "nodes", label: "Talos nodes", health: "missing", detail: "no kubeconfig / cluster unreachable" };
  const health: Health = nodes.ready === nodes.total ? "ok" : "degraded";
  return { key: "nodes", label: "Talos nodes", health, detail: `${nodes.ready}/${nodes.total} Ready` };
}

async function checkCilium(): Promise<CheckResult> {
  const ds = await getDaemonSetStatus("kube-system", "cilium");
  if (!ds) return { key: "cilium", label: "Cilium (CNI)", health: "missing", detail: "daemonset not found" };
  const health: Health = ds.ready === ds.desired && ds.desired > 0 ? "ok" : "degraded";
  return { key: "cilium", label: "Cilium (CNI)", health, detail: `${ds.ready}/${ds.desired} pods ready` };
}

async function checkArgocd(): Promise<CheckResult> {
  const installed = await helmReleaseExists("argocd", "argocd");
  if (!installed) {
    return {
      key: "argocd",
      label: "ArgoCD",
      health: "missing",
      detail: "helm release not found",
      fix: { label: "Install ArgoCD", run: runInstallArgocdOnly },
    };
  }
  const dep = await getDeploymentReady("argocd", "argocd-server");
  const health: Health = dep && dep.ready === dep.desired && dep.desired > 0 ? "ok" : "degraded";
  return {
    key: "argocd",
    label: "ArgoCD",
    health,
    detail: dep ? `argocd-server ${dep.ready}/${dep.desired} ready` : "argocd-server not found",
    fix: health === "ok" ? undefined : { label: "Re-run ArgoCD install", run: runInstallArgocdOnly },
  };
}

async function checkRootApp(): Promise<CheckResult> {
  const app = await getArgoApplication("root");
  if (!app) {
    return {
      key: "root-app",
      label: "Root app-of-apps",
      health: "missing",
      detail: `not applied — see ${platformRootAppPath}`,
      fix: { label: "Apply root app-of-apps", run: runApplyRootApp },
    };
  }
  const health: Health = app.health === "Healthy" && app.sync === "Synced" ? "ok" : "degraded";
  return { key: "root-app", label: "Root app-of-apps", health, detail: `${app.sync} / ${app.health}` };
}

function argoAppCheck(key: string, label: string) {
  return async (): Promise<CheckResult> => {
    const app = await getArgoApplication(key);
    if (!app) {
      return { key, label, health: "missing", detail: "Application not found — root app-of-apps may not be synced yet" };
    }
    const health: Health = app.health === "Healthy" && app.sync === "Synced" ? "ok" : "degraded";
    return {
      key,
      label,
      health,
      detail: `${app.sync} / ${app.health}`,
      fix: health === "ok" ? undefined : { label: `Force ArgoCD refresh (${key})`, run: () => refreshArgoApplication(key) },
    };
  };
}

const CHECKS = [
  checkNodes,
  checkCilium,
  checkArgocd,
  checkRootApp,
  argoAppCheck("argocd-config", "ArgoCD Ingress"),
  argoAppCheck("cert-manager", "cert-manager"),
  argoAppCheck("traefik", "Traefik"),
  argoAppCheck("longhorn", "Longhorn"),
  argoAppCheck("external-dns", "Cloudflare DDNS"),
  argoAppCheck("external-dns-internal", "external-dns (UniFi)"),
  argoAppCheck("cilium-config", "Cilium LB config"),
  argoAppCheck("intel-gpu-plugin", "Intel GPU plugin"),
  argoAppCheck("monitoring", "Prometheus + Grafana"),
  argoAppCheck("metrics-server", "metrics-server"),
];

const ICON: Record<Health, string> = { ok: pc.green("●"), degraded: pc.yellow("●"), missing: pc.red("●") };

export async function runStatus() {
  p.intro(pc.bgCyan(pc.black(" cluster status ")));

  const spin = p.spinner();
  spin.start("Checking cluster components");
  const results = await Promise.all(CHECKS.map((check) => check()));
  spin.stop("Checked all components");

  const nameWidth = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    console.log(`  ${ICON[r.health]} ${r.label.padEnd(nameWidth)}  ${pc.dim(r.detail)}`);
  }

  const fixable = results.filter((r) => r.health !== "ok" && r.fix);
  if (fixable.length === 0) {
    const allOk = results.every((r) => r.health === "ok");
    p.outro(allOk ? pc.green("Everything healthy.") : pc.yellow("Some components need attention above (no automatic fix available)."));
    return;
  }

  if (!process.stdin.isTTY) {
    p.outro(pc.yellow("Non-interactive session — skipping fix prompt. Re-run in a terminal to fix."));
    return;
  }

  const choices = await p.multiselect({
    message: "Fix now?",
    options: fixable.map((r) => ({ value: r.key, label: `${r.label} — ${r.fix!.label}` })),
    required: false,
  });

  if (p.isCancel(choices) || choices.length === 0) {
    p.outro("No changes made.");
    return;
  }

  for (const key of choices as string[]) {
    const target = fixable.find((r) => r.key === key)!;
    const s = p.spinner();
    s.start(target.fix!.label);
    try {
      await target.fix!.run();
      s.stop(`${target.fix!.label} — done`);
    } catch (err) {
      s.stop(`${target.fix!.label} — failed`);
      p.log.error(err instanceof Error ? err.message : String(err));
    }
  }

  p.outro("Re-run status to confirm.");
}
