# HA State History Card

Lovelace history graph replacement focused on discrete states and explicit colors per state value.

```yaml
type: custom:ha-state-history-card
title: Presence
title_position: left
title_size: 24px
hours_to_show: 24
refresh_interval: 300
legend: on
state_colors:
  "on|Home": "#22c55e"
  "off|Away": "#64748b"
  unavailable: "#a1a1aa"
  unknown: "#a1a1aa"
state_labels:
  "on": Home
  "off": Away
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
- `title`: Optional. Omit it to hide the title.
- `title_position`: Optional. Use `left`, `center`, or `right`. Defaults to `left`.
- `title_size`: Optional. CSS font size for the title, such as `20px`, `1.1rem`, or a number treated as pixels.
- `hours_to_show`: Optional. Defaults to `24`.
- `refresh_interval`: Optional. Seconds between history API refreshes. Defaults to `300`.
- `legend`: Optional. State legend display. Use `on`, `off`, `left`, `center`, or `right`. `on` and `left` are synonyms. Defaults to `on`.
- `show_legend`: Optional legacy alias. Set to `false` to hide the state legend.
- `state_colors`: Optional. Global state-to-color map.
- `state_labels`: Optional. Global raw-state-to-label map.
- `entities[].state_colors`: Optional. Per-entity state-to-color map. This overrides the global map for that entity.
- `entities[].state_labels`: Optional. Per-entity raw-state-to-label map. This overrides the global map for that entity.

The card also accepts `colors` as an alias for `state_colors` and `labels` as an alias for `state_labels`.

State color and label keys can match either the raw state from history or the displayed label. Use `|` to list aliases:

```yaml
state_colors:
  "on|Home": "#22c55e"
  "off|Away": "#64748b"
state_labels:
  "on|Home": Present
  "off|Away": Clear
```

Long enough state segments are labeled inline. Hovering a segment shows the state, start time, stop time, and duration.

The visual editor supports the common card options, entity rows, and global state color/label maps. Advanced per-entity `state_colors` and `state_labels` remain available through the raw YAML editor.
