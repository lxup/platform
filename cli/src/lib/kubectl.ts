import { execa } from "execa";
import { kubeconfigPath } from "./paths.js";

const env = { KUBECONFIG: kubeconfigPath };

async function kubectlJson<T>(args: string[]): Promise<T | null> {
  try {
    const { stdout } = await execa("kubectl", [...args, "-o", "json"], { env });
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

export interface NodeStatus {
  total: number;
  ready: number;
}

export async function getNodesStatus(): Promise<NodeStatus | null> {
  const list = await kubectlJson<{
    items: Array<{ status: { conditions: Array<{ type: string; status: string }> } }>;
  }>(["get", "nodes"]);
  if (!list) return null;

  const ready = list.items.filter((n) =>
    n.status.conditions.some((c) => c.type === "Ready" && c.status === "True"),
  ).length;

  return { total: list.items.length, ready };
}

/** Hostnames of nodes already Ready in the cluster — empty if unreachable/no cluster yet. */
export async function getReadyNodeNames(): Promise<Set<string>> {
  const list = await kubectlJson<{
    items: Array<{
      metadata: { name: string };
      status: { conditions: Array<{ type: string; status: string }> };
    }>;
  }>(["get", "nodes"]);
  if (!list) return new Set();

  return new Set(
    list.items
      .filter((n) => n.status.conditions.some((c) => c.type === "Ready" && c.status === "True"))
      .map((n) => n.metadata.name),
  );
}

export async function getDaemonSetStatus(namespace: string, name: string) {
  const ds = await kubectlJson<{ status: { desiredNumberScheduled: number; numberReady: number } }>(
    ["get", "daemonset", name, "-n", namespace],
  );
  if (!ds) return null;
  return { desired: ds.status.desiredNumberScheduled, ready: ds.status.numberReady };
}

export async function helmReleaseExists(namespace: string, name: string): Promise<boolean> {
  try {
    await execa("helm", ["status", name, "-n", namespace], { env });
    return true;
  } catch {
    return false;
  }
}

export async function getDeploymentReady(namespace: string, name: string) {
  const dep = await kubectlJson<{ status: { replicas?: number; readyReplicas?: number } }>([
    "get",
    "deployment",
    name,
    "-n",
    namespace,
  ]);
  if (!dep) return null;
  return { desired: dep.status.replicas ?? 0, ready: dep.status.readyReplicas ?? 0 };
}

export interface ArgoApplication {
  health: string;
  sync: string;
}

export async function getArgoApplication(name: string): Promise<ArgoApplication | null> {
  const app = await kubectlJson<{
    status?: { health?: { status?: string }; sync?: { status?: string } };
  }>(["get", "application", name, "-n", "argocd"]);
  if (!app) return null;
  return {
    health: app.status?.health?.status ?? "Unknown",
    sync: app.status?.sync?.status ?? "Unknown",
  };
}

export async function refreshArgoApplication(name: string) {
  await execa(
    "kubectl",
    [
      "annotate",
      "application",
      name,
      "-n",
      "argocd",
      "argocd.argoproj.io/refresh=hard",
      "--overwrite",
    ],
    { env },
  );
}

export async function applyManifest(path: string) {
  await execa("kubectl", ["apply", "-f", path], { env });
}
