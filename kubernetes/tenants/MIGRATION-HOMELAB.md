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

### Two things that bit on paperless

**Delete the helper pods and WAIT.** `kubectl delete pod --wait=false` on
`copy-in` left it holding the Longhorn PVC, and Longhorn volumes are RWO —
so the app could not start:

```
Waiting for detach for volume "pvc-53e444ea-…"
Volume is already used by pod(s) copy-in-x-paperless-x-homelab
```

Drop the `--wait=false`, or confirm the pod is gone before restoring
`replicas`.

**A stale NFS handle on the node.** The real blocker, and a known failure
mode in this homelab — `lxup/homelab`'s history has a commit saying as much
("a livenessProbe does not heal a stale NFS mount"). Paperless came up with
`PAPERLESS_MEDIA_ROOT is set but doesn't exist`, and the container runtime
underneath said why:

```
failed to apply OCI options: failed to stat
"/var/lib/kubelet/pods/…/volumes/kubernetes.io~nfs/media": stale file handle
```

Nothing to do with the vcluster: the kubelet on `elitedesk-03` held a stale
mount for `/mnt/user/paperless`. **Deleting the pod fixed it** — the kubelet
unmounted and remounted cleanly on recreation. If it recurs and a pod delete
does not clear it, the node's mount has to be cleared directly.

Every app that mounts the NAS (`nextcloud`, `immich`, `jellyfin`,
`nas-passthrough`) can hit this on first start in the vcluster. Delete the
pod once before looking for anything more complicated.

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

### The overlap is only free for stateless apps

Worth understanding before the procedure, because getting it wrong cost
`antoinequehec` eight minutes of HTTP 500.

While both copies exist, so do two Ingresses for the same host, and Traefik
picks one. For `lxup` that was harmless: stateless, both copies serving the
same image, either choice identical. For anything whose **source has to be
stopped** so its volume can be copied, it is not harmless at all — Traefik
kept routing `antoinequehec.com` to the stopped copy, whose web pod
crash-looped nine times against a Strapi at zero replicas.

So the old Ingress has to go as soon as the new copy is up — **before**
verifying anything, not after. An earlier version of the list below had
"verify the hostname" ahead of "delete the old namespace", which meant
verifying the copy that was deliberately down.

### Procedure

**Stateless app** (no volume): steps 1, 2, 6, 7, 8. The overlap is free, so
there is no hurry and no outage.

**App with a volume**, in this order:

1. **Dump first, stop nothing.** `pg_dump` the database if there is one.
   Then `git mv kubernetes/apps/applications/<app>.yaml
   kubernetes/core/applications/` and push — `path:` stays pointing at
   `kubernetes/apps/services/<app>`, which does not move. Put `replicas: 0`
   on any deployment that writes to a file volume in the **same** commit.
2. Refresh both ArgoCDs. The bridge prunes the old Application
   non-cascadingly, so the old pods keep running but are now unmanaged —
   which is what makes step 3 possible without ArgoCD reverting it.
3. **Outage starts.** Scale the old deployment to 0 on the host.
4. Copy: `pg_dump`/`psql` for databases, helper-pod `tar` for file volumes.
   Compare `find | wc -l` and `du -sb` on both sides, not just a human-readable
   total.
5. Second commit restoring `replicas`. Wait for the new copy — through its
   CrashLoopBackOff if it talks to a database, and note that a frontend
   talking to a backend will do the same thing one layer up.
6. **`kubectl delete namespace <app>` on the host, as soon as the new pods
   are Running.** This frees the duplicate Ingress and ends the outage. It
   is also the point of no return.
7. Verify — the hostname, and the data. Row counts, file counts, and
   something that actually reads the copied bytes: for `antoinequehec` that
   was fetching a 512 KB JPEG out of `uploads` over HTTPS, which proves more
   than a matching `du`.
8. Add an `argoAppCheck` line to this tenant's
   `cli/src/commands/status.ts`.

Rolling back is possible up to step 6: `git mv` the file back, scale the old
deployment up, and the bridge re-adopts the still-running old copy.

### Order

`gatus` ✅ · `lxup` ✅ · `antoinequehec` ✅ · `vaultwarden` ✅ ·
`syncthing` ✅ · `paperless` ✅ · `nextcloud` · `immich` · `jellyfin` ·
`nas-passthrough`

Six done. The remaining ones are ordered by how much an outage is noticed:
`vaultwarden` (8.4 MB) and `syncthing` (155 MB) are small and personal,
`paperless` (21 MB + 17 MB DB) next, then the three that matter —
`nextcloud` (259 MB DB + 44 KB config), `immich` (DB only, library on NFS,
`model-cache` skipped) and `jellyfin` (4.7 GB config, `jellyfin-cache`
skipped). `nas-passthrough` is last and trivial: an ExternalName Service and
an Ingress, no data, no pods.

## Step 4: the ingress handover

The last step, and the only one with a cluster-wide outage in it rather than
a per-app one. Four Applications are still synced onto the real cluster by
the bridge — `cert-manager`, `traefik`, `external-dns`,
`external-dns-internal` — and they are what serves every tenant Ingress
today.

### Why it is not one commit

The naive version moves all four at once, and the outage runs from "old
Traefik gone" until "new Traefik has .200 **and** the tenant's cert-manager
has issued eleven certificates" — DNS-01 through Cloudflare takes a minute
or two each. That is a long time with nothing served.

Split it so the certificates are already issued before the switch:

**4a — cert-manager to the tenant.** Additive and safe. The tenant's
cert-manager installs its own CRDs and ClusterIssuers inside the vcluster,
sees the tenant's Ingress objects (which live there), and starts issuing
certificates into the vcluster. The host's cert-manager keeps serving the
synced copies meanwhile; different clusters, no conflict. Two cert-managers
briefly solving DNS-01 for the same names is fine — each ACME order is
independent and both clean up their `_acme-challenge` records.

**4b — both external-dns instances to the tenant.** Keep
`txtOwnerId: homelab-internal` rather than inventing a new one: the existing
UniFi records are owned by that id, and a new owner could not update them.
The two instances agree on every value while they overlap (same hostnames,
same `.200`), so the overlap is harmless. The public DDNS updater is keyed
on hostnames rather than Ingresses, so two of them setting the same records
to the same WAN IP is a no-op.

**4c — the cutover.** `traefik` to the tenant and
`sync.toHost.ingresses.enabled: false` in the same commit. The tenant's
Traefik comes up and sits Pending on `.200`, because the old one still holds
it — the bridge's prune is non-cascading, so it keeps running. Then
`kubectl delete namespace traefik cert-manager external-dns
external-dns-internal` on the host frees the address and the tenant's
Traefik claims it, with its certificates already in hand from 4a.

Expected outage: the time between deleting the host namespaces and Cilium
handing `.200` over. Tens of seconds, not minutes.

**4d — delete the bridge.** `zz-transitional-homelab-apps.yaml` from this
repo, and `sync.toHost.ingresses` stays `false` for good. At that point
nothing reaches across repos any more and the split is finished.

### Verify after 4c, before 4d

Every hostname, through the real public path and not through the LAN — the
UDM intercepts port 53, so a `curl https://host/` from a machine at home
resolves to `.200` and proves nothing about reachability from outside. Use
`--resolve host:443:90.0.236.76` for the unproxied ones and the Cloudflare
edge address for the proxied ones, or query over DoH.

## Still unverified

- **Copying a file volume at scale.** Proven at 176 MB on
  `antoinequehec`'s `strapi-data` — byte-identical, and the copied uploads
  verified served over HTTPS. `jellyfin-config` is 4.7 GB, 27× that, and the
  only thing left that might behave differently is the time it takes.
- **An application that actually needs the GPU.** The probe proved the
  device reaches a vcluster pod; Jellyfin transcoding and Immich ML through
  it have not been exercised.
- Two external-dns instances writing `nvlab.fr` with distinct owner ids
  while both are live. The theory is sound (each only touches records whose
  TXT owner matches) but it has not been watched.
