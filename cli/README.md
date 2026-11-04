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
| 12 | apply the ArgoCD repo credential for github.com/lxup | yes, skipped if absent |
| 13 | `kubectl apply` `kubernetes/platform/root.yaml` | yes |

Step 10 before 11 is not cosmetic: ArgoCD's repo-server mounts the
`sops-age` Secret as a volume, and a missing Secret leaves the pod pending
forever while `helm --wait` times out.

Step 12 before 13 is the same kind of ordering, for a different reason: it
is what lets ArgoCD clone the repo that step 13 points it at. Putting that
credential under `kubernetes/` instead would be circular — ArgoCD would
need to clone the repo to find the credential that lets it clone the repo.
It runs unconditionally, so flipping these repos to private is a visibility
toggle on GitHub and nothing else. It is skipped, loudly, if
`bootstrap/argocd/repo-credentials.sops.yaml` does not exist yet, which is
only survivable while every repo is public.

After step 13, nothing here is needed again — ArgoCD watches
`kubernetes/platform/applications/` and picks up every file added there.

## `tenant`

The platform's side of the contract with a tenant repo. It lists the declared
vclusters, shows which have a live control plane and on which address, and
writes a chosen tenant's kubeconfig to `tenants/<name>.kubeconfig`
(gitignored, mode 600).

That file stands in for a tenant repo's cluster-provisioning step: instead of
building a cluster of its own, each repo reads the kubeconfig this writes.

```
lxup/homelab        →  reads tenants/homelab.kubeconfig
paveproject/infra   →  reads tenants/pave.kubeconfig
recomendapp/infra   →  reads tenants/recomend.kubeconfig
```

Every step after that in those repos — external-secrets, Infisical, their own
ArgoCD, their own root app — is theirs alone and the platform touches none of
it. That is the whole point: exactly one step per repo is ours.

The kubeconfig is only published once the tenant's control plane has actually
started, so sync the tenant's Application in the platform ArgoCD first.
