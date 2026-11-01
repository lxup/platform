# Bringing a tenant up

Written for `pave` and `recomend`, the two still on Hetzner. Everything here
either bit during the homelab migration or was measured during it; the
narrative of that migration is in git history, not in this file.

## Their migration is not shaped like homelab's

homelab moved between two clusters on the same hardware, so a lot of its
mechanics do not transfer:

| | homelab | pave / recomend |
|---|---|---|
| source | the same cluster | a Hetzner cluster, over the internet |
| old copy during the move | kept running (non-cascading prune) and was deleted by hand | stays up on Hetzner until `hetzner-k3s delete` — a real rollback |
| ingress handover | contended for `10.10.100.200` behind the UDM forward | none: `cloudflared` dials out, no inbound, no address to contend for |
| secrets | SOPS + ksops | Infisical + external-secrets, unchanged by the move |
| bulk data | NFS from the NAS, never moved | Longhorn volumes and object storage, all of it moves |

The rollback story is better for them: Hetzner keeps serving until you
delete it, so there is no window where the only copy is the new one.

## What will bite anyway

**A LimitRange is mandatory.** Once the tenant quota constrains
requests/limits for cpu and memory, Kubernetes rejects any pod that does not
declare all four. The rejection appears as a vcluster `SyncError` on the
**virtual** pod — nothing at all shows up in `kubectl get pods -n <tenant>`
on the host, which is a miserable place to debug from. Each tenant ships one;
do not remove it.

**Size the quota on `limits`, not just `requests`.** A ResourceQuota counts
*declared* limits, and generous declarations add up fast. homelab's limits
budget filled at ten apps and refused immich's four pods outright while its
requests sat at a third of theirs.

**First sync CrashLoopBackOffs are normal.** An app that talks to a database
usually exits before the Service endpoints are programmed, and a frontend
talking to that app does the same one layer up. Gatus took three restarts,
antoinequehec's web pod two. Wait a minute before diagnosing.

**Delete copy-helper pods with `--wait`.** `--wait=false` left one holding a
Longhorn PVC, and those are RWO, so the app could not start:
`Waiting for detach for volume … already used by pod(s) copy-in-…`.

**Watch the control plane's memory as apps arrive.** It tracks the object
count it syncs, not idle size: 330 Mi empty, 708 Mi with one ArgoCD. A limit
set from the empty figure OOMs partway through a migration.

## Moving data

**Databases.** `pg_dump` takes an MVCC snapshot, so it is consistent whether
or not the app is running — the app only has to be stopped for the dump to be
*final*. Restore with `--clean --if-exists`, which drops and recreates, so it
does not matter whether the new side has written anything.

If a restored database then errors about an extension's types — immich did,
with `operator class "vector_cosine_ops" does not accept data type real[]` —
**restart Postgres before comparing schemas**. Restoring recreates extensions
underneath a running server and leaves its catalog stale. The error message
says so; it was the last thing tried rather than the first.

**File volumes.** Use a helper pod that mounts the PVC bare on both sides,
not an exec into the app's own pod: a volume mounted at several paths via
subPath (antoinequehec's `strapi-data` is mounted at three) is only visible
whole from a bare mount. Exclude `lost+found`.

```
kubectl -n <ns> exec copy-out -- tar cf - -C /v --exclude=./lost+found . > app.tar
kubectl -n <ns> exec -i copy-in -- tar xf - -C /v < app.tar
```

Compare `find -type f | wc -l` **and** the sum of file sizes, not `du -sb` —
that differs by a block of directory allocation between filesystems and
looks like data loss. Then verify with something that reads the copied bytes:
fetching a JPEG out of migrated uploads over HTTPS proves more than a
matching byte count. Proven from 44 KB to 4.7 GB, byte-exact each time.

To stop the new copy writing during a file copy, put `replicas: 0` in the
same commit that moves the Application and restore it in the next —
declarative, so `selfHeal` does not undo it mid-copy.

## Verify through the real public path

The UDM Pro intercepts port 53, so `curl https://host/` from a machine at
home resolves to `10.10.100.200` and proves nothing about reachability from
outside. Use `--resolve host:443:<WAN IP>` for unproxied names, the
Cloudflare edge address for proxied ones, and DoH over 443 to see what public
DNS actually holds.

## Still open for every tenant

- **No network policy.** See [`NETWORK-POLICY.md`](NETWORK-POLICY.md).
  `pave` is the easy case to prove it on: no private network needs and a
  tunnel that dials out, so default-deny ingress costs nothing.
- **The Age key is shared** between the platform and the homelab tenant —
  see the platform README.
