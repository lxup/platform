# `platform` CLI

Everything that cannot be GitOps, because it has to exist before GitOps does.

```bash
cd cli && bun install
bun run src/index.ts          # interactive menu
bun run src/index.ts install  # bring up / extend the Talos cluster
bun run src/index.ts status   # health check, offers to fix what's missing
bun run src/index.ts tenant   # list vclusters, export a tenant's kubeconfig
```

## `install`

Brings the physical cluster up, or adds a node to a live one — same command
either way. `talos/talconfig.yaml` lists every node the cluster will ever
have; the prompt asks which are booted and reachable right now and only
touches those.

| # | Step | Idempotent? |
|---|---|---|
| 00 | load `talconfig.yaml` | yes |
| 01 | check `talhelper`/`talosctl`/`helm`/`kubectl`/`sops`/`age` on PATH | yes |
| 02 | generate the Age key if absent | yes |
| 03 | `talhelper gensecret` → `talos/talsecret.sops.yaml` | yes, skipped if present |
| 04 | `helm template cilium` → `talos/manifests/cilium.generated.yaml` | yes |
| 05 | `talhelper genconfig` → `talos/clusterconfig/` | yes |
| 06 | `talosctl apply-config` to the selected nodes | **reformats their disk** |
| 07 | `talosctl bootstrap` etcd — first control plane only | first run only |
| 08 | fetch `./kubeconfig` | yes |
| 09 | wait for nodes Ready | yes |
| 10 | create the `sops-age` Secret | yes |
| 11 | `helm upgrade --install` ArgoCD from `bootstrap/argocd/values.yaml` | yes |
| 12 | `kubectl apply` `kubernetes/platform/root.yaml` | yes |

Step 10 before 11 is not cosmetic: ArgoCD's repo-server mounts the
`sops-age` Secret as a volume, and a missing Secret leaves the pod pending
forever while `helm --wait` times out.

After step 12, nothing here is needed again — ArgoCD watches
`kubernetes/platform/applications/` and picks up every file added there.

## `tenant`

The platform's side of the contract with a tenant repo. It lists the declared
vclusters, shows which have a live control plane and on which address, and
writes a chosen tenant's kubeconfig to `tenants/<name>.kubeconfig`
(gitignored, mode 600).

That file is what replaces a tenant repo's cluster-provisioning step:

```
lxup/homelab        step 03  talhelper/talosctl   →  read tenants/homelab.kubeconfig
paveproject/infra   step 03  hetzner-k3s create   →  read tenants/pave.kubeconfig
recomendapp/infra   step 02  hetzner-k3s create   →  read tenants/recomend.kubeconfig
```

Every step after that in those repos — external-secrets, Infisical, their own
ArgoCD, their own root app — is unchanged. That is the whole point: one step
per repo moves, nothing else.

The kubeconfig is only published once the tenant's control plane has actually
started, so sync the tenant's Application in the platform ArgoCD first.
