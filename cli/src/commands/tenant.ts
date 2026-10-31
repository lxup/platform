import { readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { execa } from "execa";
import { kubeconfigPath, repoRoot } from "../lib/paths.js";

const tenantsServicesDir = path.join(repoRoot, "kubernetes", "tenants", "services");
const kubeconfigOutDir = path.join(repoRoot, "tenants");

/**
 * The platform's half of the contract with a tenant repo.
 *
 * A tenant repo (lxup/homelab, paveproject/infra, recomendapp/infra) used to
 * provision its own cluster — `talhelper` + `talosctl` for the first,
 * `hetzner-k3s create` for the other two — and ended up with a plain
 * ./kubeconfig that every later bootstrap step consumed. Running on a
 * vcluster changes only that one step: instead of creating machines, the
 * tenant reads the kubeconfig its vcluster published. This command is what
 * it reads it with.
 *
 * Everything after that — ESO, Infisical, ArgoCD, the root app — is
 * unchanged in those repos.
 */

/** Tenants are whatever has a directory under kubernetes/tenants/services/. */
async function listTenants(): Promise<string[]> {
  const entries = await readdir(tenantsServicesDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

interface TenantState {
  name: string;
  /** The vc-<name> Secret exists, i.e. the control plane has come up at least once. */
  ready: boolean;
  /** LoadBalancer address of the tenant's API server, once Cilium has assigned it. */
  endpoint: string | null;
}

async function inspect(name: string): Promise<TenantState> {
  const env = { KUBECONFIG: kubeconfigPath };

  const secret = await execa(
    "kubectl",
    ["get", "secret", `vc-${name}`, "-n", name, "--ignore-not-found", "-o", "name"],
    { env, reject: false },
  );

  const svc = await execa(
    "kubectl",
    [
      "get", "svc", name, "-n", name, "--ignore-not-found",
      "-o", "jsonpath={.status.loadBalancer.ingress[0].ip}",
    ],
    { env, reject: false },
  );

  return {
    name,
    ready: (secret.stdout ?? "").trim().length > 0,
    endpoint: (svc.stdout ?? "").trim() || null,
  };
}

/**
 * vcluster writes the kubeconfig into the Secret at runtime, not at Helm
 * install time, so the key name is the chart's business rather than ours.
 * It has been `config` for every 0.2x/0.3x release, but rather than hard-code
 * that and fail with a confusing "undefined" months from now, take `config`
 * when it is there and otherwise pick whichever key actually decodes to a
 * kubeconfig.
 */
function pickKubeconfigKey(data: Record<string, string>): string | null {
  if (data.config) return "config";
  for (const [key, b64] of Object.entries(data)) {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    if (decoded.includes("clusters:") && decoded.includes("apiVersion:")) return key;
  }
  return null;
}

async function writeKubeconfig(name: string): Promise<string> {
  const { stdout } = await execa("kubectl", ["get", "secret", `vc-${name}`, "-n", name, "-o", "json"], {
    env: { KUBECONFIG: kubeconfigPath },
  });

  const data = (JSON.parse(stdout) as { data?: Record<string, string> }).data ?? {};
  const key = pickKubeconfigKey(data);
  if (!key) {
    throw new Error(
      `Secret vc-${name} has no key that looks like a kubeconfig (found: ${Object.keys(data).join(", ") || "none"}).`,
    );
  }

  const kubeconfig = Buffer.from(data[key], "base64").toString("utf8");

  // Gitignored (tenants/*.kubeconfig) — these are live credentials to a
  // tenant's API server.
  await mkdir(kubeconfigOutDir, { recursive: true });
  const out = path.join(kubeconfigOutDir, `${name}.kubeconfig`);
  await writeFile(out, kubeconfig, { mode: 0o600 });
  return out;
}

export async function runTenant() {
  p.intro(pc.bgMagenta(pc.black(" tenants ")));

  const names = await listTenants();
  if (names.length === 0) {
    p.outro(pc.yellow("No tenant declared under kubernetes/tenants/services/."));
    return;
  }

  const states = await Promise.all(names.map(inspect));

  p.log.message(
    states
      .map((t) => {
        const dot = t.ready ? pc.green("●") : pc.red("●");
        const where = t.endpoint ? pc.dim(`https://${t.endpoint}:443`) : pc.dim("no LoadBalancer IP yet");
        const state = t.ready ? "" : pc.dim("  (not synced, or control plane still starting)");
        return `${dot} ${t.name.padEnd(10)} ${where}${state}`;
      })
      .join("\n"),
  );

  const ready = states.filter((t) => t.ready);
  if (ready.length === 0) {
    p.outro(
      pc.yellow(
        "No tenant has published a kubeconfig yet. Sync its Application in the platform ArgoCD first.",
      ),
    );
    return;
  }

  const choice = await p.select({
    message: "Export which tenant's kubeconfig?",
    options: ready.map((t) => ({ value: t.name, label: t.name })),
  });

  if (p.isCancel(choice)) {
    p.cancel("Bye.");
    return;
  }

  const name = choice as string;

  try {
    const out = await writeKubeconfig(name);
    p.note(
      [
        `export KUBECONFIG=${out}`,
        "kubectl get nodes      # the 3 EliteDesks, seen from inside the tenant",
        "kubectl get ns",
        "",
        `Then, in the ${name} repo: point its installer's provisioning step at`,
        "this file instead of creating a cluster, and run it.",
      ].join("\n"),
      `Written to tenants/${name}.kubeconfig (gitignored, mode 600)`,
    );
    p.outro(pc.green("Done."));
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro(pc.red("Export failed."));
  }
}
