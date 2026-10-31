# Talos patches

Raw Talos machine config fragments merged into every node's generated
config by `talhelper`.

- `cluster-proxy-disabled.yaml` — turns off kube-proxy; Cilium replaces it
  (eBPF kube-proxy replacement, enabled in `talos/manifests/cilium-values.yaml`).
  Referenced from `talconfig.yaml` via `"@./patches/<file>"`.

## Control-plane VIP

The `controlPlane.patches` block directly in `talconfig.yaml` (not a
separate file here) gives all 3 nodes a shared VIP at `10.10.100.2` —
that's what `endpoint` points at, so the API stays reachable if any single
control-plane node goes down. It uses `deviceSelector: physical: true`
instead of a named interface (e.g. `enp2s0`) so it doesn't matter what the
NIC is actually called — safe as long as each node has exactly one NIC. If
a node ever gets a second NIC, check real names with
`talosctl get links -n <ip>` and switch to a named `interface:` selector.
