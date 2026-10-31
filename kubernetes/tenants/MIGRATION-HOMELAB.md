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

## Still unverified

- The per-app data moves themselves. Restoring a Longhorn volume from R2
  into a tenant-side PVC has not been done once.
- The tenant's ArgoCD running ksops inside a vcluster.
- Two external-dns instances writing `nvlab.fr` with distinct owner ids
  while both are live. The theory is sound (each only touches records whose
  TXT owner matches) but it has not been watched.
