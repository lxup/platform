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
not one at that size — and matters even less now that migration copies the
live volume rather than a backup.

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

## Done: step 3, first app

`gatus` lives in the vcluster. Picked for what it exercised, not for its
importance.

**ksops works inside a vcluster** — the last open unknown. `db-credentials`
rendered decrypted, `POSTGRES_PASSWORD` 32 bytes of real content rather than
`ENC[...]`.

**The data moved intact.** 148 KB dump taken before anything was touched,
restored after: 747 `endpoint_results`, 639 `endpoint_uptimes`, 103
`endpoint_events`. `status.nvlab.fr` answers HTTP 200 and its API reports 50
results per endpoint — the restored history, not the handful a fresh
instance would show.

**The mechanism behaved as designed.** The bridge pruned the Application
when its file moved; the prune was non-cascading, so the old copy kept
running while the new one came up. Two Gatus and two Ingresses for
status.nvlab.fr for a few minutes, which is exactly what bought a rollback
while ksops was unproven. Deleting the old namespace left the vcluster
copies alone — they live in the host's `homelab` namespace as
`gatus-...-x-gatus-x-homelab`.

### Expect this again

Gatus panicked three times on startup:

```
panic: dial tcp 10.110.47.64:5432: connect: no route to host
```

Postgres was already accepting connections; the Service endpoints had not
been programmed yet, and gatus exits rather than retrying. It recovered by
itself after three restarts. **Every app with a database dependency will
probably do something similar on its first sync — CrashLoopBackOff for the
first minute is not a failure.** Wait before diagnosing.

### Data moves: copy the live volume, do not restore from R2

An earlier draft of this file said to restore `jellyfin-config` from the R2
backup. That is worse for no reason: the backup runs daily at 03:00, so
restoring it reintroduces up to 24 hours of divergence on an app that is
being migrated *right now* and whose current data is sitting on a disk two
metres away. Copy the live volume instead, and keep R2 as what it is — the
fallback if a copy goes wrong, not the migration path.

There is ~142 GB free locally and ~4.9 GB of file data to move in total, so
staging each copy on disk rather than streaming it is affordable and gives a
checkpoint: if the write into the new volume fails, the source does not have
to be read again.

**Databases.** `pg_dump` is consistent on its own (MVCC snapshot), so the
old app does not have to be stopped for the dump to be valid — only for the
dump to be *final*. Stop it, dump, restore with `--clean --if-exists` into
the new Postgres, which drops and recreates the tables so it does not matter
whether the new app has already written anything.

**File volumes.** Use a helper pod that mounts the PVC bare, on both sides,
rather than exec-ing into the app's own pod:

```
# source, on the HOST
kubectl -n <app> run copy-out --image=busybox --restart=Never   --overrides='{"spec":{"containers":[{"name":"c","image":"busybox",
    "command":["sleep","3600"],"volumeMounts":[{"name":"v","mountPath":"/v"}]}],
    "volumes":[{"name":"v","persistentVolumeClaim":{"claimName":"<pvc>"}}]}}'
kubectl -n <app> exec copy-out -- tar cf - -C /v . > <app>.tar

# destination, in the VCLUSTER (same shape, its own kubeconfig)
kubectl -n <app> exec -i copy-in -- tar xf - -C /v < <app>.tar
```

Two reasons for the helper pod rather than the app's pod: `strapi-data` is
mounted at three different paths via subPath, so only a bare mount sees the
whole volume; and the app has to be down anyway, since Longhorn volumes are
RWO and an app writing during the copy produces an inconsistent result —
Jellyfin's config holds a SQLite library database.

To stop the new copy writing while the file copy happens, set `replicas: 0`
in the app's manifest in the same commit that moves the Application, then
restore it in a second commit. Two commits, fully declarative, and no
fighting ArgoCD's `selfHeal` with `kubectl scale`.

**Two volumes not worth copying:**

| Volume | Claim | Why skip |
|---|---|---|
| `jellyfin/jellyfin-cache` | 20 Gi | transcode cache, rebuilt on demand |
| `immich/model-cache` | 10 Gi | ML models, re-downloaded on first use |

That takes the 4.9 GB of real copying down to mostly `jellyfin-config`.

### Procedure, now that it is proven

Per app:

1. **Stop nothing yet.** `git mv kubernetes/apps/applications/<app>.yaml
   kubernetes/core/applications/` and push — `path:` stays pointing at
   `kubernetes/apps/services/<app>`, which does not move. Add `replicas: 0`
   in the same commit if the app has a file volume to copy.
2. Refresh both ArgoCDs. The bridge prunes the old Application
   non-cascadingly, so the old pods keep running but are now unmanaged —
   which is what makes step 3 possible without ArgoCD reverting it.
3. **Outage starts.** Scale the old deployment to 0 on the host.
4. Copy the data: `pg_dump` for databases, helper-pod `tar` for file
   volumes.
5. Second commit restoring `replicas` if step 1 zeroed it. Wait for the new
   copy, through its CrashLoopBackOff if it has a database.
6. Verify the hostname answers **and** the data is there — row counts, file
   counts, not just HTTP 200.
7. `kubectl delete namespace <app>` on the **host**. This frees the duplicate
   Ingress and is the point of no return, so do it last.
8. Add an `argoAppCheck` line to this tenant's
   `cli/src/commands/status.ts`.

Rolling back is possible up to step 7: `git mv` the file back, and the
bridge re-adopts the still-running old copy.

### Order

`gatus` ✅ · `lxup` · `antoinequehec` · `vaultwarden` · `syncthing` ·
`paperless` · `nextcloud` · `immich` · `jellyfin` · `nas-passthrough`

`lxup` is next because it has no volume at all — a web deployment and a ghcr
pull secret — so it exercises the move with nothing to copy.
`nas-passthrough` is last and trivial: an ExternalName Service and an
Ingress, no data, no pods.

## Still unverified

- **Copying a file volume.** Gatus's data moved by `pg_dump`, which says
  nothing about the helper-pod `tar` path above. `vaultwarden-data` at 8.4 MB
  is the cheapest place to prove it before `jellyfin-config` at 4.7 GB.
- **An application that actually needs the GPU.** The probe proved the
  device reaches a vcluster pod; Jellyfin transcoding and Immich ML through
  it have not been exercised.
- Two external-dns instances writing `nvlab.fr` with distinct owner ids
  while both are live. The theory is sound (each only touches records whose
  TXT owner matches) but it has not been watched.
