# platform

The Talos cluster that runs on three HP EliteDesks, and nothing else.

This repo owns the machine. It does not own what runs on it. Applications
live in tenant repos, each with its own ArgoCD inside its own virtual
cluster:

| Tenant | Repo | What it is | Status |
|---|---|---|---|
| `homelab` | [lxup/homelab](https://github.com/lxup/homelab) | Immich, Jellyfin, Nextcloud, Paperless, Vaultwarden, Syncthing, two websites | migrating |
| `pave` | [paveproject/infra](https://github.com/paveproject/infra) | api, postgres, redis, rustfs, notify | declared, still on Hetzner |
| `recomend` | [recomendapp/infra](https://github.com/recomendapp/infra) | backend, web-app, martin, prefect, umami | declared, still on Hetzner (production) |

## Why this repo exists

It used to be one repo. `lxup/homelab` held the Talos configs, the cluster
infra *and* the media apps, while two other projects paid Hetzner for their
own k3s clusters — about 75 €/month between them, after Hetzner's RAM-driven
price rise.

The EliteDesks are 32% used. Three nodes, 48 GB of RAM, 36 threads, running
at 3% CPU. There is room for all of it at home.

Bringing the projects home only works if they stay *independent*: each one
needs its own ArgoCD, its own cert-manager, its own CRDs, its own ingress —
and must not grow a dependency on a repo that describes someone's house.
Namespaces cannot do that (cluster-scoped resources collide). Separate
physical clusters would cost hardware and break this cluster's 3-node etcd
quorum.

So: one real cluster, one platform repo, N tenants in vclusters. Every
tenant is treated identically, including `homelab` — it has no privileges
the others lack.

## Layout

```
talos/                        machine configs (talhelper), the real cluster
bootstrap/argocd/             ArgoCD #0 — installed imperatively, by hand, once
kubernetes/platform/          what the platform provides
  root.yaml                   the only Application ever applied manually
  applications/               app-of-apps: one file per platform service
  services/                   their manifests, values and SOPS secrets
kubernetes/tenants/           what the platform hands out
  applications/               one Application per tenant
  services/<tenant>/          its vcluster, namespace, quota, network policy
cli/                          everything that cannot be GitOps (see cli/README.md)
```

## The platform / tenant boundary

The hard question in this design is not "how does vcluster work", it is
where to draw the line. Current answer:

| | Platform | Tenant | Why |
|---|---|---|---|
| Talos, Cilium (CNI) | ● | | one CNI per cluster, it *is* the cluster |
| Cilium LB IP pool, L2 policy | ● | | cluster-scoped, shared address space |
| Longhorn | ● | | one CSI; its StorageClasses are handed to tenants |
| `intel-gpu-plugin` | ● | | privileged DaemonSet talking to real hardware |
| metrics-server | ● | | tenants see node metrics through the syncer |
| vclusters, quotas, network policies | ● | | this is the definition of a tenant |
| ArgoCD #0 | ● | | syncs this repo only, never a tenant's workloads |
| cert-manager + ClusterIssuers | ● | ● | one each; CRDs are isolated per vcluster, so no conflict |
| Traefik / ingress | ● | ● | platform: admin UIs only. tenant: its own edge |
| external-dns | ● | ● | one instance per provider per owner — see below |
| Prometheus / Grafana | ● | ◐ | the seam. See below |
| A tenant's ArgoCD | | ● | one per repo. The whole point |

### What a vcluster actually is

A pod. Inside it runs a real Kubernetes API server with its own datastore,
plus a *syncer*. When a tenant's ArgoCD applies a Deployment:

1. the Deployment is stored in the **vcluster's** datastore — the real
   cluster never sees it;
2. the vcluster's controller-manager turns it into Pods, still virtual;
3. the syncer creates the **real** Pods in the tenant's host namespace;
4. the host scheduler places them on an EliteDesk. They run for real.

Virtual-only: Deployments, StatefulSets, **CRDs**, RBAC, ServiceAccounts,
Namespaces, Ingresses. Synced to the host: Pods, Services, PVCs, the
ConfigMaps and Secrets pods mount.

Which is why `kubectl get pods -A` on `./kubeconfig` shows everything
including tenant pods, while the same command on
`tenants/homelab.kubeconfig` shows only that tenant, in its own namespaces,
as if it were a cluster of its own.

### Addresses

One Cilium pool, `10.10.100.200-250`, shared by the platform and every
tenant (a vcluster's LoadBalancer Service is synced to the host, so Cilium
allocates for all of them). Pinned assignments:

| Address | Who |
|---|---|
| `.200` | whoever owns the UDM Pro's 80/443 forward — platform Traefik today, the `homelab` tenant's Traefik after the migration |
| `.201` | platform Traefik post-migration (admin UIs, LAN-only) |
| `.210` | `homelab` tenant API server |
| `.211` | `pave` tenant API server |
| `.212` | `recomend` tenant API server |
| `.220+` | tenant ingress controllers, reached through their own Cloudflare Tunnel |

Tenant API servers are on a pinned LoadBalancer IP rather than the chart's
default `localhost:8443`, because the address ends up written inside a
kubeconfig on disk: a tenant's installer CLI needs to use that file
directly, the way `hetzner-k3s create` used to hand it one.

### DNS

Two layers, same as before the split, but now one instance per owner:

- the platform runs `external-dns-internal` → UniFi local DNS,
  `txtOwnerId: platform-internal`. It only ever sees Ingresses on the real
  cluster, i.e. the admin UIs.
- each tenant runs its own external-dns inside its vcluster, with its own
  `txtOwnerId`. Two instances writing `nvlab.fr` is safe *because* the
  owner differs — each deletes only records it owns. **Give every new
  tenant a distinct owner id** or they will flap each other's records.

### Monitoring: where the seam is

`kubernetes/platform/services/monitoring` is the single ingress-exposed
Grafana. Its Prometheus sees the physical layer — nodes, Longhorn, Cilium —
and, because the syncer creates real pods, the raw resource usage of tenant
pods too.

What it cannot see is anything a tenant declares inside its vcluster: a
`ServiceMonitor` there lives in the tenant's API server and is invisible
here. So a tenant that wants application dashboards runs a light Prometheus
of its own and is added here as an extra datasource.

Do **not** solve it by letting tenants write ServiceMonitors into the
platform's namespace. That hands every tenant a write path into the
platform and the boundary is gone.

Each tenant's *control-plane* health is already covered: its vcluster ships
a host-side ServiceMonitor (`controlPlane.serviceMonitor`), so the platform
watches API latency and syncer errors without seeing inside the workloads.

### What isolation this does and does not give you

A vcluster is a **control-plane** boundary, not a kernel sandbox. A tenant
cannot read or write this cluster's objects, cannot install a CRD here,
cannot see another tenant's resources. It *can* run a privileged pod, and
that pod is privileged on the host — the tenant host namespaces are
deliberately PSA `privileged` (see any `namespace.yaml` under
`kubernetes/tenants/services/`).

The real guardrails are:

- a separate API server per tenant;
- a `ResourceQuota` on the host namespace, where the syncer creates pods —
  so it bites;
- `CiliumNetworkPolicy` with `egressDeny` on `10.10.10.0/24` (the home LAN)
  and `10.10.100.0/24` (the Talos API VIP, the node APIs, every
  LoadBalancer IP on the machine).

`egressDeny` rather than a default-deny `egress:` rule on purpose: a
default-deny means enumerating every destination every app will ever need,
and anything forgotten breaks silently at 3am looking like a DNS problem.
Deny rules subtract the destinations that matter without touching the rest.

**`recomend` deserves a specific warning.** It is meant to run
actions-runner-controller for a *public* repo, which means CI jobs proposed
by strangers execute on hardware in a house. Before activating it:
require workflow approval for outside collaborators in the GitHub repo
settings, keep the runners ephemeral, and keep that namespace's egressDeny
in place.

## Memory budget

48 GB total, ~45 GB allocatable, 15.2 GB in use at the time of the split.

| | requests | note |
|---|---|---|
| platform | ~8 GB | monitoring, Longhorn, Cilium, apiservers |
| `homelab` | 12 GB | ~8 GB of apps (measured) + ~1.2 GB for its own ArgoCD/Traefik/cert-manager/control plane |
| `pave` | 4 GB | |
| `recomend` | 10 GB | |
| **spare** | **~11 GB** | |

The `requests` quota is the one that protects the other tenants. Raising it
in one tenant takes memory from another — check this table first.

Per-tenant overhead is cheaper than the sizing guides suggest: the live
`argocd` namespace (controller, repo-server, server, redis, dex,
applicationset, notifications) measures **507 Mi**, and a vcluster control
plane idles under 512 Mi. Four ArgoCD instances cost ~2 GB of the 48.

## Install

See [`cli/README.md`](cli/README.md). Short version:

```bash
cd cli && bun install
bun run src/index.ts install   # Talos + Cilium + ArgoCD + the root app
bun run src/index.ts tenant    # export a tenant's kubeconfig
```

Prerequisites on PATH: `talhelper`, `talosctl`, `helm`, `kubectl`, `sops`,
`age`. Step 01 checks.

## Secrets

Same Age key as `lxup/homelab`, deliberately: `talos/talsecret.sops.yaml`
moved here already encrypted to it, and re-keying would mean regenerating
Talos secrets, i.e. rebuilding the cluster.

`.sops.yaml` holds only the public half. Secrets are committed as
`*.sops.yaml` next to a `ksops-generator.yaml`; ArgoCD's repo-server
decrypts them inline at render time via the `sops-age` Secret (created by
CLI step 10, before ArgoCD is installed — the repo-server mounts it as a
volume and hangs forever if it is missing).

Tenants do **not** share this key. `homelab` keeps its own SOPS setup;
`pave` and `recomend` use Infisical + external-secrets. That scheme is
already cloud-agnostic, which is why moving them off Hetzner needs no
secret migration at all.

### Git credentials, and staying private-ready

All four repos are public today, so ArgoCD clones them anonymously. That is
not something to rely on: `bootstrap/argocd/repo-credentials.sops.yaml`
holds a `repo-creds` credential template for `https://github.com/lxup`
(URL prefix, so one entry covers this repo *and* `lxup/homelab`, which the
transitional bridge reads), and CLI step 12 applies it **unconditionally**.
A Git credential ArgoCD does not need is simply unused — so flipping any of
these repos to private is a visibility toggle on GitHub and nothing else.

It lives in `bootstrap/` and is applied imperatively, not committed under
`kubernetes/` as GitOps. The GitOps version is circular: ArgoCD would have
to clone the repo to find the credential that lets it clone the repo. That
works while a repo is public and breaks the moment it is not, which is the
trap the old single-repo arrangement was in — it just never showed, because
the repo was always public. `paveproject/infra` and `recomendapp/infra`
already do it the right way, via Infisical; this is the same thing with
SOPS.

Start from `repo-credentials.example.yaml` next to it. Use a fine-grained
PAT with Contents: read-only, not the token from `gh auth token`.

**Each tenant needs its own.** `pave` and `recomend` already have one
(their own ExternalSecret, their own ArgoCD, inside their own vcluster).
The `homelab` tenant will need one in phase 1 — its ArgoCD reads
`lxup/homelab`, and this platform credential is not visible from inside a
vcluster.

Note that `kustomize build` run locally without `ksops` on PATH silently
skips those generators — the manifests render, the Secrets just are not
there. That is expected; only ArgoCD has both the binary and the key.

## Migration status

The split is phase 0 of four. Nothing is migrated yet.

- [~] **Phase 0** — this repo exists; ArgoCD #0 switches from
      `lxup/homelab:kubernetes/core` to `lxup/platform:kubernetes/platform`.
      The real cluster's state is unchanged: same resource names, same
      namespaces, so ArgoCD adopts rather than recreates.
- [ ] **Phase 1** — `homelab` becomes a tenant. Riskiest for data, so it
      goes first *only* because it is the one whose downtime costs nothing
      but convenience.
- [ ] **Phase 2** — `pave`. Still in development; the pattern's rehearsal.
- [ ] **Phase 3** — `recomend`. Production, and the ~70 €/month this was
      all for. Last.

### Companion changes in lxup/homelab

Done, in commit `184b5cc` there:

1. **`external-dns` and `gatus` moved** from `kubernetes/core/` to
   `kubernetes/apps/`. The transitional bridge
   (`kubernetes/platform/applications/zz-transitional-homelab-apps.yaml`)
   only watches `kubernetes/apps/applications` — anything left under
   `core/` there stops reconciling once ArgoCD #0 points here instead.
2. **`argocd.nvlab.fr` removed from the DDNS updater's `DOMAINS`.** The
   platform ArgoCD is LAN-only at `argocd.platform.nvlab.fr`; the old
   public hostname is held for the `homelab` tenant's own ArgoCD to claim
   in phase 1, which is what keeps its GitHub webhook working.
   `DELETE_ON_STOP` is false there, so the existing Cloudflare record
   survives and merely goes stale — if the WAN IP changes during the
   migration window, that one hostname points at nothing until phase 1.
3. **Gatus's ArgoCD check commented out** for the same window, so it does
   not fire Telegram every minute at a hostname nothing answers. Restore it
   in the same commit that brings up the tenant's ArgoCD ingress.

Still to do, but *after* the switchover is verified, not before: delete
from `lxup/homelab` what moved here — `talos/`, `bootstrap/`, `cli/` and
the platform half of `kubernetes/core/`.

### What is deliberately still wrong

- `kubernetes/platform/services/monitoring` still carries
  `dashboards/homelab-apps.json`. It belongs to the `homelab` tenant and
  moves there in phase 1; it stays for now so the Grafana you open today
  shows exactly what it showed before the split.
- The transitional bridge reaches across repos, which is the exact coupling
  this split removes. It is named `zz-` so it sorts last and stays visibly
  odd. Delete it at the end of phase 1 — but only *after* the tenant-side
  copies are live, because ArgoCD prunes what it created.
- Platform Traefik is pinned to `.200`, not `.201`. Free it before the
  `homelab` tenant asks for `.200`, or Cilium hands the tenant a different
  address and the UDM forward points at the wrong controller.

### Verified, and not

`helm template` and `kustomize build` pass on every service and every
tenant, and every Application validates against the live cluster's schema.
What has **not** been exercised on real hardware:

- **Jellyfin and Immich ML hardware transcoding from inside a vcluster.**
  The GPU request should be resolved host-side by the device plugin, but
  this is the one thing to test explicitly in phase 1 before cutting over.
- The `egressDeny` policies, which have never been applied.
- Restoring the 14 Longhorn PVCs from R2 into tenant-side PVCs.
