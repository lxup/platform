# Network policy for tenants: what was tried, what broke, what to do

Status: **no network policy is applied.** The `ResourceQuota` on each
tenant's host namespace is the only guardrail in place. This file exists so
the next person does not re-derive the two dead ends below.

## What was tried, and why it cannot work

A single `CiliumNetworkPolicy` per tenant namespace with
`endpointSelector: {}` and `egressDeny` on the two private ranges:

```yaml
egressDeny:
  - toCIDRSet:
      - cidr: 10.10.10.0/24      # home LAN, except the NAS
        except: [10.10.10.101/32]
  - toCIDRSet:
      - cidr: 10.10.100.0/24     # cluster VLAN
```

`egressDeny` rather than a default-deny `egress:` rule was the right
instinct — deny rules subtract destinations without requiring every
legitimate one to be enumerated, so nothing breaks silently at 3am looking
like a DNS problem. The selector was the mistake.

**First failure.** A third rule denied `toEntities: [kube-apiserver]`,
reasoned as safe because a tenant's pods talk to their *own* vcluster API
over a ClusterIP and never need the host's. The first vcluster brought up
under it went straight into CrashLoopBackOff:

```
error: using secret annotations: get secret: Get
https://10.96.0.1:443/api/v1/namespaces/homelab/secrets/vc-config-homelab:
dial tcp 10.96.0.1:443: i/o timeout
```

`endpointSelector: {}` means *every* pod in the namespace — including the
vcluster control plane, which lives there and whose entire job is talking to
the host apiserver.

**Second failure, and the one that kills the approach.** Removing that rule
changed nothing: the pod still could not reach `10.96.0.1`. That ClusterIP
DNATs to the apiserver's real backends, and on this cluster those are

```
$ kubectl get endpoints kubernetes -n default
10.10.100.11  10.10.100.12  10.10.100.13
```

— inside the `10.10.100.0/24` deny. Cilium evaluates policy against the
post-translation destination for service traffic, so the VLAN deny catches
the apiserver by the back door.

There is no way out of this with one selector. The control plane *must*
reach `10.10.100.0/24`; a workload pod *must not*. Those are two policies,
and the hand-rolled version only ever had one.

## What to do instead

The vcluster chart already ships it, and gets the polarity right.
`policies.networkPolicy.enabled: true` renders three NetworkPolicies:

| Policy | Selects | Allows |
|---|---|---|
| `vc-cp-<name>` | `release: <name>` — the control plane | host apiserver (443/8443/6443), host kube-dns, peers, workloads |
| `vc-work-<name>` | `vcluster.loft.sh/managed-by: <name>` — the workload pods | the vcluster's DNS and API, other workloads, and `workload.publicEgress` |
| `vc-kube-dns-<name>` | the vcluster's CoreDNS | host kube-dns, the control plane |

`workload.publicEgress` is exactly the primitive wanted here. Its default
`except` list is already

```
100.64.0.0/10  127.0.0.0/8  10.0.0.0/8  172.16.0.0/12  192.168.0.0/16
```

`10.0.0.0/8` alone covers the home LAN, the cluster VLAN, the Service CIDR
and the pod CIDR — so it closes the ClusterIP exposure this repo had been
documenting as open, which the hand-rolled policy never did.

Selecting on `vcluster.loft.sh/managed-by` is also not forgeable from inside
a tenant: the syncer stamps that label on every host pod it creates, and a
workload cannot make its host pod lack it.

## Why it is not switched on yet

Two things have to be worked out first, against Hubble, on a live vcluster:

1. **`vc-work-*` is default-deny for ingress too.** It allows traffic only
   from the control plane and from other workloads. Traefik would stop
   receiving anything from the UDM Pro's port-forward, which takes
   `homelab` offline. Needs a `workload.ingress` rule.
2. **`homelab` needs egress to `10.10.10.101`** for `nas-passthrough` —
   Traefik proxying Plex on the NAS. Needs a `workload.egress` rule.
   (The NFS mounts in Nextcloud, Jellyfin, Immich and Paperless are *not*
   affected: the kubelet performs those from the node's network namespace,
   not from the pod, so pod policy never applies to them.)

For `pave` and `recomend` neither exception is needed, so they can likely
go first — which also makes them the safer place to validate the mechanism.
