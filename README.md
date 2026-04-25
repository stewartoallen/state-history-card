# HA State History Card

Lovelace history graph replacement focused on discrete states and explicit colors per state value.

```yaml
type: custom:ha-state-history-card
title: Presence
hours_to_show: 24
refresh_interval: 300
show_legend: true
state_colors:
  "on": "#22c55e"
  "off": "#64748b"
  unavailable: "#a1a1aa"
  unknown: "#a1a1aa"
entities:
  - entity: binary_sensor.kitchen_presence
    name: Kitchen
  - entity: sensor.ac_state
    name: AC
    state_colors:
      idle: "#64748b"
      cooling: "#0284c7"
      heating: "#dc2626"
```

Options:

- `entities`: Required. Same shape as the native history graph card: entity ID strings or objects with `entity` and optional `name`.
- `hours_to_show`: Optional. Defaults to `24`.
- `refresh_interval`: Optional. Seconds between history API refreshes. Defaults to `300`.
- `show_legend`: Optional. Set to `false` to hide the state legend.
- `state_colors`: Optional. Global state-to-color map.
- `entities[].state_colors`: Optional. Per-entity state-to-color map. This overrides the global map for that entity.

The card also accepts `colors` as an alias for `state_colors`.
