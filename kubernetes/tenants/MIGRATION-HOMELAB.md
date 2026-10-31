# Migrating the homelab tenant into its vcluster

What is verified, what the order is, and what the real outage per app is.

## The constraint that shapes everything

The UDM Pro forwards 80/443 to one literal IP, `10.10.100.200`, and only one
ingress controller can hold it. So if the tenant ran its own Traefik from the
start, every app would have to move in a single window with all of them down
at once.

`sync.toHost.ingresses.enabled: true` removes that. **Verified on this
cluster**, with a throwaway nginx inside the vcluster:

| Step | Result |
|---|---|
| Ingress declared inside the vcluster | synced to the host as `vctest-x-vctest-x-homelab` |
| `secretName` and backend `service` names | **rewritten by the syncer** to the synced names |
| host cert-manager | created the Certificate, `Ready: True` |
| TLS Secret | present host-side under the name the synced Ingress references |
| `curl --resolve vctest.nvlab.fr:443:10.10.100.200` | **HTTP 200**, nginx's page, TLSv1.3 |
| `kubectl get ns vctest` on the host | `NotFound` — the app really only exists in the vcluster |
| deleting the namespace in the vcluster | syncer removed the host Ingress, Certificate, Secret, Service and pod |

So an app moved into the vcluster is publicly reachable **immediately**,
through the Traefik that is already running, with a real certificate. Apps
migrate one at a time.

## What actually has to move

Measured on the live cluster, not estimated:

| | Real size |
|---|---|
| `jellyfin/jellyfin-config` | **4.7 GB** |
| `nextcloud` Postgres | **259 MB** |
| `nextcloud-config` + `nextcloud-custom-apps` | **44 KB** (both) |
| `paperless` Postgres | 17 MB |
| `gatus` Postgres | 9 MB |
| `immich` Postgres, `antoinequehec`, `vaultwarden`, `syncthing` | small |
| **photos, documents, media, Plex library** | **nothing** — same NFS share from both sides |

The 44 KB figure retires an earlier worry: `nextcloud-config` and
`custom_apps` are not in the R2 backup group, which looked like a gap and is
not one at that size.

Per-app outage is therefore: stop it, dump, copy, start, restore.
**Nextcloud ~5 minutes. Jellyfin ~10, for the 4.7 GB.** Not hours — that
number was a conflation of total project time with service downtime.

## Order

1. **Tenant's own Age key** — skipped for now, deliberately. One key stays
   shared with the platform; the escalation path that creates is documented
   in the platform README. Revisit with `sops updatekeys` and two recipients
   when it is worth a second cold-storage backup.
2. **Tenant ArgoCD** inside the vcluster, syncing `lxup/homelab`'s own
   `kubernetes/core/` — its cert-manager, its external-dns-internal with a
   *distinct* `txtOwnerId`, its ArgoCD config. Not Traefik.
3. **App by app**, smallest and least missed first: `gatus`, `antoinequehec`,
   `lxup`, `vaultwarden`, `syncthing`, `paperless`, `nextcloud`, `immich`,
   `jellyfin`, `nas-passthrough`. For each: move its file out of the bridge's
   path into the tenant's, stop the old copy, move the data, verify the
   hostname answers, then the next.
4. **Last**: tenant Traefik claims `.200`, `sync.toHost.ingresses` back to
   `false`, bridge deleted from the platform repo. Seconds of downtime.
5. Then `policies.networkPolicy` — see `NETWORK-POLICY.md`.

## Done: steps 1 and 2

The tenant's ArgoCD runs inside the vcluster and has reclaimed
`argocd.nvlab.fr`.

- `cli/` in lxup/homelab was rewritten as a tenant installer. Half of it
  went away — no talhelper, no talosctl, no etcd bootstrap — and everything
  from the `sops-age` Secret onward was left untouched, which is what the
  layered design was for.
- Step 03 there refuses to run if the kubeconfig points at the host cluster.
  The tell is a `longhorn-system` namespace, which a vcluster never sees.
- The installer ran clean: ArgoCD up in the vcluster, `root` and
  `argocd-config` both Synced/Healthy.
- `https://argocd.nvlab.fr/` answers **HTTP 200 from the internet with a
  valid certificate**, and `/api/version` reports `v3.5.6` — the tenant's
  instance. `webhook.github.secret` is in `argocd-secret`, so the GitHub
  webhook is live again.
- `argocd.nvlab.fr` is back in the DDNS updater's `DOMAINS` and Gatus's
  check for it is restored.

Measured cost: the tenant's ArgoCD is **~291 Mi** across 7 pods.

### And a ceiling that had to be raised

The vcluster control plane went from **330 Mi** (empty) to **708 Mi** with
only ArgoCD synced. The syncer's memory tracks the number of objects it
syncs, not the vcluster's idle size, so the original 1 Gi limit would have
OOMed partway through migrating nine applications. Now 2 Gi. **Watch
`kubectl top pod -n homelab` as each app moves in** rather than discovering
the next ceiling mid-step.

### Known, not yet acted on

`tenant-homelab` reports OutOfSync on its Service, StatefulSet and
ServiceMonitor. The only substantive difference found is a version-gated
RBAC rule (`pods/resize`) that ArgoCD's repo-server renders because it knows
the cluster version and a local `kubectl kustomize` does not — render drift,
not configuration drift. Harmless while the Application is manual-sync,
which is its resting state anyway.

It stops being harmless at step 4, when this Application gets
`automated.selfHeal`: ArgoCD would then fight that drift on a loop. Work out
whether it needs `ignoreDifferences` **then**, with the real diff from
`argocd app diff`, rather than guessing at it now.

## Still unverified

- The per-app data moves themselves. Restoring a Longhorn volume from R2
  into a tenant-side PVC has not been done once.
- **ksops inside the vcluster.** ArgoCD is up and its repo-server has the
  `sops-age` Secret mounted, but no Application has yet rendered a
  `*.sops.yaml` through it — the only thing it syncs so far is an Ingress.
  The first app to migrate will be the real test of that path.
- Two external-dns instances writing `nvlab.fr` with distinct owner ids
  while both are live. The theory is sound (each only touches records whose
  TXT owner matches) but it has not been watched.
