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
| Prometheus | ● | ◐ | the seam. See below |
| **Traefik / ingress** | | ● | |
| **cert-manager + ClusterIssuers** | | ● | |
| **external-dns (Cloudflare and UniFi)** | | ● | |
| **Grafana** | | | nobody — removed, see below |
| A tenant's ArgoCD | | ● | one per repo. The whole point |

### The platform exposes no HTTP

That is the rule the bottom half of the table follows from, and it is worth
stating plainly because an earlier draft of this repo got it wrong.

Nothing about serving HTTP is a platform concern. An ingress controller, a
cert-manager with a Cloudflare token, something writing DNS records — that
is one environment's infrastructure, not the machine's. The UniFi API key is
the clearest case: UniFi is the home router at `10.10.10.1`. `recomend` and
`pave` will never write a record there. It belongs to `homelab`, full stop.

So each environment owns its own edge:

| | Ingress | Reached how |
|---|---|---|
| `homelab` | its Traefik, pinned `10.10.100.200` | the UDM Pro's 80/443 forward — direct, full bandwidth |
| `recomend` | its own | its own `cloudflared`, dialing out |
| `pave` | its own | its own `cloudflared`, dialing out |
| platform | none | `kubectl port-forward` |

`homelab` takes the direct path for a reason: Jellyfin, Immich and Nextcloud
need real throughput and their uploads exceed Cloudflare's 100MB
proxied-request cap. `recomend` and `pave` are API and web traffic, where a
tunnel is strictly better — no open port, no inbound anything, and the home
WAN IP never appears in their public DNS.

Three ingress controllers, one port-forward on the UDM, and it never has to
change.

What the platform gives up: no hostnames of its own. ArgoCD #0, Hubble,
Prometheus and the Longhorn UI are reached with `kubectl port-forward`,
which is fine for things opened a few times a month. That is the whole price
of a platform with no HTTP in it.

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
| `.200` | `homelab` tenant's Traefik — the UDM Pro's 80/443 forward |
| `.210` | `homelab` tenant API server |
| `.211` | `pave` tenant API server |
| `.212` | `recomend` tenant API server |

The platform claims nothing from the pool, so `.200` is the `homelab`
tenant's from the start: no handover to sequence, and the port-forward never
changes. `pave` and `recomend` need no ingress address at all — their
`cloudflared` dials out.

Tenant API servers are on a pinned LoadBalancer IP rather than the chart's
default `localhost:8443`, because the address ends up written inside a
kubeconfig on disk: a tenant's installer CLI needs to use that file
directly, the way `hetzner-k3s create` used to hand it one.

### DNS

The platform writes no DNS records. It has no hostnames to write.

Each tenant runs its own external-dns inside its own vcluster, with its own
`txtOwnerId`: `homelab` keeps the `homelab-internal` instance that writes
UniFi local DNS, plus the public Cloudflare DDNS updater; `pave` and
`recomend` keep their Cloudflare instances. **Give every new tenant a
distinct owner id** — external-dns tracks ownership with a TXT record
holding that id and, with `policy: sync`, only ever touches records it
owns. Two instances in the same zone is safe precisely because the owner
differs; two sharing an id will flap each other's records.

### Monitoring: where the seam is

`kubernetes/platform/services/monitoring` watches the physical layer —
nodes, Longhorn, Cilium — and, because the syncer creates real pods, the raw
resource usage of tenant pods too. **There is no Grafana** — it cost 418 Mi
and a PVC to serve dashboards nobody opened, while the alerting half of the
stack was discarding everything (Alertmanager's only receiver was `"null"`).
What was missing was not a screen but a notification.

So Prometheus stays as the data source and Alertmanager now routes to the
Telegram bot Gatus already uses, landing both in one conversation: Gatus
says "cloud.nvlab.fr stopped answering", this says "elitedesk-02 is down".
Eleven of the 149 loaded rules reach Telegram — a node down, a volume
degraded, a crash loop, a disk filling — chosen because Gatus structurally
cannot see any of them. The rest stay in Prometheus for post-mortems, via
`kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090`.

Longhorn needed building rather than configuring: Prometheus had **zero**
`longhorn_*` metrics, because nothing scraped it and its chart ships no
ServiceMonitor. Its own NetworkPolicy also had to be unblocked — see
`kubernetes/platform/services/longhorn/prometheus-scrape-policy.yaml`.

What it cannot see is anything a tenant declares inside its vcluster: a
`ServiceMonitor` there lives in the tenant's API server and is invisible
here. So a tenant that wants application dashboards runs a light Prometheus
of its own — and, owning its own ingress and cert-manager, its own Grafana
on its own hostname if it wants one. This one stays for the physical layer.

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
- **and, for now, nothing at the network layer.**

That last one is a gap, not a design: a tenant's pods can currently reach
the home LAN, the cluster VLAN and every ClusterIP on the host. Two attempts
at a hand-rolled `CiliumNetworkPolicy` were tried and both broke the
vcluster control plane — the second one fatally, because `10.96.0.1` DNATs
to the apiserver's real backends on `10.10.100.0/24` and Cilium evaluates
policy after translation, so denying the VLAN denies the apiserver by the
back door. One `endpointSelector` cannot both deny the VLAN to workloads and
allow the apiserver to the control plane.

The vcluster chart's own `policies.networkPolicy` does exactly that, with
the right polarity and a `publicEgress.except` that already covers
`10.0.0.0/8`. Enabling it is a phase-1 task with two prerequisites to work
out against Hubble. The full write-up, including both failures verbatim so
they are not re-derived, is in
[`kubernetes/tenants/NETWORK-POLICY.md`](kubernetes/tenants/NETWORK-POLICY.md).

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

### Why the platform has secrets of its own

Not leftovers from homelab — the platform runs real services, and each
needs a credential:

| Secret | Who needs it |
|---|---|
| `talos/talsecret.sops.yaml` | the cluster's own PKI: CA certs, bootstrap tokens |
| `longhorn/backup-target-credentials` | the R2 backup target |
| `monitoring/alertmanager-config` | the whole Alertmanager config, for the Telegram bot token |

Three, and none belongs to a tenant. The Cloudflare API token and the UniFi
API key are **not** here: they serve certificates and DNS records for one
environment's hostnames, so they live in `lxup/homelab` — where they always
were. Moving them here would have duplicated a tenant's credentials into
the thing that runs every tenant.

### Why SOPS here and Infisical in pave/recomend

Chicken-and-egg, and only the platform has it. `talsecret.sops.yaml` is
read by `talhelper` to *generate the Talos machine configs* — before any
cluster exists. Infisical + external-secrets needs a running cluster, the
ESO operator and a ClusterSecretStore; `paveproject/infra` sets those up in
its steps 05-07 precisely because `hetzner-k3s create` already built the
cluster in step 03. Here, that step *is* the cluster. You cannot fetch a
cluster's PKI from an operator running on a cluster that does not exist yet.

Once SOPS is unavoidable for `talsecret`, using it for the other four
avoids running two secret systems on the platform. It also means the
platform boots with no SaaS in the path: if Infisical is unreachable, a
tenant does not sync but the cluster stays up — the reverse would be a much
worse failure mode.

And the platform imposes nothing on tenants: `homelab` uses SOPS,
`pave` and `recomend` use Infisical + ESO, all three keep exactly what they
already have. That is why bringing them home needs no secret migration.

### Known gap: the Age key is shared with the homelab tenant

`lxup/homelab` currently encrypts its 13 application secrets to the **same**
Age recipient as this repo. So the platform's private key decrypts the
tenant's secrets, and the tenant's decrypts the platform's — which is a
real hole in the boundary everything else here is built to enforce.

It is this way because `talsecret.sops.yaml` moved here already encrypted
to that key, and re-keying *the platform* would mean regenerating Talos
secrets, i.e. rebuilding the cluster. So the platform keeps the key and the
**tenant** gets a new one, in phase 1:

```bash
age-keygen -o ~/.config/sops/age/homelab-tenant.txt   # new recipient
# swap it into lxup/homelab's .sops.yaml, then:
sops updatekeys kubernetes/apps/services/*/*.sops.yaml
```

Mechanical, and it has to happen in phase 1 anyway: a vcluster cannot see
the platform's `sops-age` Secret, so that tenant's ArgoCD needs its own
key in its own namespace regardless.

### Git credentials, and staying private-ready

All four repos are public today, so ArgoCD clones them anonymously. That is
not something to rely on: `bootstrap/argocd/repo-credentials.sops.yaml`
holds a `repo-creds` credential template for `https://github.com/lxup`
(URL prefix, so one entry covers every repo under that account), and CLI
step 12 applies it **unconditionally**.
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
## Status

The homelab migration is done: all ten of its applications run in its
vcluster, it serves its own ingress on `10.10.100.200`, and the transitional
bridge that used to reach across repos is gone.

`pave` and `recomend` are declared and not activated — their Applications
show OutOfSync and create nothing until synced deliberately. They still run
on Hetzner.

The full record — what each app moved, what verified it, the mistakes made
along the way, and the per-app procedure for the remaining two — is in
[`kubernetes/tenants/MIGRATION-HOMELAB.md`](kubernetes/tenants/MIGRATION-HOMELAB.md).

### Open, by choice

- **No network policy on tenants.** The quota is the only guardrail. A
  hand-rolled CiliumNetworkPolicy cannot express this (it broke the vcluster
  control plane twice); the chart's own `policies.networkPolicy` can, and
  needs two settings worked out against Hubble. See
  [`kubernetes/tenants/NETWORK-POLICY.md`](kubernetes/tenants/NETWORK-POLICY.md).
  `pave` is the easy case to prove it on: no private network needs, and its
  tunnel dials out so default-deny ingress costs nothing.
- **The Age key is shared with the homelab tenant** — see above.
- **`tenant-homelab` is manual-sync.** It reports OutOfSync on three
  resources from render drift (a version-gated RBAC rule that ArgoCD's
  repo-server renders and a local `kustomize` does not). Harmless while
  manual; decide on `ignoreDifferences` from a real `argocd app diff` before
  giving it `selfHeal`.
