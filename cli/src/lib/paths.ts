import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** platform/ — the git repo root (this file lives at cli/src/lib/). */
export const repoRoot = path.resolve(here, "..", "..", "..");

export const talosDir = path.join(repoRoot, "talos");
export const clusterConfigDir = path.join(talosDir, "clusterconfig");
export const talconfigPath = path.join(talosDir, "talconfig.yaml");
export const talsecretPath = path.join(talosDir, "talsecret.sops.yaml");
export const ciliumValuesPath = path.join(talosDir, "manifests", "cilium-values.yaml");
export const ciliumRenderedPath = path.join(talosDir, "manifests", "cilium.generated.yaml");
export const talosconfigPath = path.join(clusterConfigDir, "talosconfig");
export const kubeconfigPath = path.join(repoRoot, "kubeconfig");
export const argocdBootstrapValuesPath = path.join(repoRoot, "bootstrap", "argocd", "values.yaml");
/** Optional SOPS-encrypted values overlay (GitHub webhook secret). Absent on a cluster that doesn't use webhooks. */
export const argocdBootstrapSecretValuesPath = path.join(
  repoRoot,
  "bootstrap",
  "argocd",
  "values.secret.sops.yaml",
);
/** SOPS-encrypted ArgoCD repository credential, applied imperatively (see steps/12). Absent while every repo is public. */
export const argocdRepoCredentialsPath = path.join(
  repoRoot,
  "bootstrap",
  "argocd",
  "repo-credentials.sops.yaml",
);
export const platformRootAppPath = path.join(repoRoot, "kubernetes", "platform", "root.yaml");
export const platformApplicationsDir = path.join(repoRoot, "kubernetes", "platform", "applications");
export const sopsYamlPath = path.join(repoRoot, ".sops.yaml");
export const defaultAgeKeyPath = path.join(
  process.env.HOME ?? "",
  ".config",
  "sops",
  "age",
  "keys.txt",
);
