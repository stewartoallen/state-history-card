# Changelog

## 0.1.5

- Adds recorder statistics support for eligible bucketed numeric rows.
- Uses Home Assistant 5-minute statistics for `bucket_minutes: 5`, `15`, and `30` when available.
- Uses Home Assistant hourly statistics for `bucket_minutes: 60` when available.
- Falls back to raw history automatically when recorder statistics are unavailable.
- Defaults `recorder` to `true`; set `recorder: false` globally or per entity to force raw history.
- Adds a global Recorder statistics control to the visual editor.
- Documents recorder statistics behavior and defaults in the README.
- Gates load/render benchmark console logging behind `ENABLE_BENCHMARK_LOGS`, disabled by default.

## 0.1.4

- Adds `bucket_minutes` for numeric rows, with global and per-entity support.
- Averages bucketed numeric values using duration-weighted buckets aligned to the top of each hour.
- Keeps `bucket_minutes: 0` as the default for unbucketed raw history behavior.
- Formats bucketed raw hover values with `decimals` when configured, or a compact fallback precision.
- Fixes bucketed numeric color rendering when `scale` is configured.
- Preserves cached history during visual editor and raw YAML edits unless the entity list or history range changes.
- Improves hover cleanup so fast pointer movement does not leave stale popups visible.
- Adjusts hover positioning for edit-mode layouts and right-edge clipping.

## 0.1.3

- Improves performance for dense numeric history rows by rendering them as a single gradient-backed track instead of one DOM element per segment.
- Preserves numeric row hover/touch details with pointer hit-testing against cached intervals.
- Keeps inline numeric labels for wide enough runs without rendering segment elements for every sample.
- Formats tooltip start, stop, and duration values lazily when the tooltip opens.
- Adds delta history fetching after the initial full load, reducing refresh-time API/database work.
- Merges, deduplicates, and prunes cached history while retaining the last state before the visible range.
- Avoids showing the loading overlay for routine delta refreshes.

## 0.1.2

- Adds global `scale` support for numeric rows.
- Adds per-entity `scale` overrides.
- Applies `scale` before `decimals`.
- Uses scaled values for numeric color selection, visible numeric labels, and numeric segment merging.
- Keeps the raw unscaled value visible in hover details.
- Accepts `factor` as an alias for `scale`.
- Adds a global Scale field to the visual editor.
- Documents `scale` and `entities[].scale` in the README.

## 0.1.1

- Improves mobile touch behavior for history popups. Swiping across a graph no longer opens a sticky popup, and active popups dismiss when the page scrolls.
- Adds automatic left label column sizing based on the widest displayed entity label.
- Adds configurable `label_width` support for overriding the left label column width.
- Keeps graph rows and timestamp labels aligned by sharing the same computed label column width.
- Merges adjacent numeric segments when their rounded `decimals` value matches, making numeric value labels more likely to fit.

## 0.1.0

- Initial public release candidate.
- Adds a Lovelace state history card for discrete state timelines.
- Supports explicit colors and labels per raw or translated state value.
- Supports inline state labels, hover details, visual editor controls, legends, and adaptive timeline labels.
