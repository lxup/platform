#!/usr/bin/env python3
"""Generates homelab-apps.json. Run from this directory after editing
APPS, then commit the regenerated homelab-apps.json alongside this script.
"""
import json

APPS = [
    ("ArgoCD", "argocd", "🔄"),
    ("Traefik", "traefik", "🌐"),
    ("Vaultwarden", "vaultwarden", "🔐"),
    ("Nextcloud", "nextcloud", "☁️"),
    ("Immich", "immich", "📸"),
    ("Jellyfin", "jellyfin", "🎬"),
    ("Paperless", "paperless", "📄"),
    ("Syncthing", "syncthing", "🔁"),
    ("Gatus", "gatus", "🚦"),
    ("Longhorn", "longhorn-system", "💾"),
    ("cert-manager", "cert-manager", "🔏"),
    ("Monitoring", "monitoring", "📊"),
]

DS = {"type": "prometheus", "uid": "${DS_PROMETHEUS}"}


def stat_panel(id_, title, expr, x, y, w, h, unit="short", decimals=1):
    return {
        "id": id_,
        "type": "stat",
        "title": title,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "decimals": decimals,
                "color": {"mode": "thresholds"},
                "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}]},
            },
            "overrides": [],
        },
        "options": {
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "orientation": "auto",
            "textMode": "auto",
            "colorMode": "value",
            "graphMode": "area",
            "justifyMode": "auto",
        },
        "targets": [{"expr": expr, "refId": "A", "datasource": DS}],
    }


def timeseries_panel(id_, title, exprs, x, y, w, h, unit="short", legend="{{pod}}"):
    targets = []
    for i, expr in enumerate(exprs):
        targets.append({
            "expr": expr,
            "refId": chr(65 + i),
            "legendFormat": legend,
            "datasource": DS,
        })
    return {
        "id": id_,
        "type": "timeseries",
        "title": title,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "custom": {
                    "drawStyle": "line",
                    "lineWidth": 1,
                    "fillOpacity": 15,
                    "showPoints": "never",
                    "spanNulls": True,
                    "stacking": {"mode": "none"},
                },
            },
            "overrides": [],
        },
        "options": {
            "legend": {"displayMode": "list", "placement": "bottom", "calcs": ["mean", "max"]},
            "tooltip": {"mode": "multi", "sort": "desc"},
        },
        "targets": targets,
    }


def row_panel(id_, title, y, collapsed=False):
    return {
        "id": id_,
        "type": "row",
        "title": title,
        "collapsed": collapsed,
        "gridPos": {"x": 0, "y": y, "w": 24, "h": 1},
        "panels": [],
    }


def main():
    panels = []
    pid = 1
    y = 0

    panels.append(row_panel(pid, "🖥️ Cluster Summary", y)); pid += 1; y += 1
    panels.append(stat_panel(pid, "Nodes Ready", 'sum(kube_node_status_condition{condition="Ready",status="true"})', 0, y, 4, 4)); pid += 1
    panels.append(stat_panel(pid, "Pods Running", 'sum(kube_pod_status_phase{phase="Running"})', 4, y, 4, 4)); pid += 1
    panels.append(stat_panel(pid, "CPU Used (cores)", 'sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]))', 8, y, 4, 4, unit="short", decimals=2)); pid += 1
    panels.append(stat_panel(pid, "Memory Used", 'sum(container_memory_working_set_bytes{container!="",container!="POD"})', 12, y, 4, 4, unit="bytes", decimals=1)); pid += 1
    panels.append(stat_panel(pid, "Pods Restarting (1h)", 'sum(increase(kube_pod_container_status_restarts_total[1h]))', 16, y, 4, 4)); pid += 1
    panels.append(stat_panel(pid, "PVC Used %", 'avg((1 - kubelet_volume_stats_available_bytes / kubelet_volume_stats_capacity_bytes) * 100)', 20, y, 4, 4, unit="percent")); pid += 1
    y += 4

    for name, ns, emoji in APPS:
        panels.append(row_panel(pid, f"{emoji} {name}", y)); pid += 1
        y += 1
        cpu_expr = f'sum(rate(container_cpu_usage_seconds_total{{namespace="{ns}",container!="",container!="POD"}}[5m])) by (pod)'
        mem_expr = f'sum(container_memory_working_set_bytes{{namespace="{ns}",container!="",container!="POD"}}) by (pod)'
        net_rx = f'sum(rate(container_network_receive_bytes_total{{namespace="{ns}"}}[5m])) by (pod)'
        net_tx = f'sum(rate(container_network_transmit_bytes_total{{namespace="{ns}"}}[5m])) by (pod)'
        restarts_expr = f'sum(kube_pod_container_status_restarts_total{{namespace="{ns}"}})'

        panels.append(timeseries_panel(pid, "CPU Usage", [cpu_expr], 0, y, 8, 7, unit="short")); pid += 1
        panels.append(timeseries_panel(pid, "Memory Usage", [mem_expr], 8, y, 8, 7, unit="bytes")); pid += 1
        panels.append(timeseries_panel(pid, "Network I/O", [net_rx, net_tx], 16, y, 6, 7, unit="Bps", legend="rx {{pod}}")); pid += 1
        panels.append(stat_panel(pid, "Restarts", restarts_expr, 22, y, 2, 7)); pid += 1
        y += 7

    dashboard = {
        "id": None,
        "uid": "homelab-apps",
        "title": "Homelab Apps",
        "tags": ["homelab"],
        "timezone": "browser",
        "schemaVersion": 39,
        "version": 1,
        "refresh": "30s",
        "time": {"from": "now-6h", "to": "now"},
        "templating": {
            "list": [
                {
                    "name": "DS_PROMETHEUS",
                    "type": "datasource",
                    "query": "prometheus",
                    "current": {},
                    "hide": 0,
                    "label": "Datasource",
                }
            ]
        },
        "panels": panels,
    }

    with open("homelab-apps.json", "w") as f:
        json.dump(dashboard, f, indent=2)
    print(f"Wrote homelab-apps.json: {len(panels)} panels, {sum(1 for p in panels if p['type'] == 'row')} rows")


if __name__ == "__main__":
    main()
