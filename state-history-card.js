class StateHistoryCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("state-history-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:state-history-card",
      hours_to_show: 24,
      entities: [],
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = undefined;
    this._hass = undefined;
    this._history = new Map();
    this._loading = false;
    this._error = "";
    this._lastFetchKey = "";
    this._labelFrame = undefined;
    this._axisWidth = 0;
    this._rangeStartMs = undefined;
    this._rangeEndMs = undefined;
    this._lastStateSignature = "";
    this._activeTooltipSegment = undefined;
    this._tooltipPinned = false;
    this._handleDocumentPointerDown = (event) => {
      if (!event.composedPath().includes(this)) this._hideTooltip();
    };
    this.shadowRoot.addEventListener("pointermove", (event) => this._handlePointerMove(event));
    this.shadowRoot.addEventListener("pointerdown", (event) => this._handlePointerDown(event));
    this.shadowRoot.addEventListener("pointerleave", () => {
      if (!this._tooltipPinned) this._hideTooltip();
    });
  }

  disconnectedCallback() {
    document.removeEventListener("pointerdown", this._handleDocumentPointerDown);
    if (this._labelFrame) cancelAnimationFrame(this._labelFrame);
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.entities)) {
      throw new Error("entities is required");
    }

    this._config = {
      hours_to_show: 24,
      refresh_interval: 300,
      legend: "on",
      timestamps: "on",
      title_position: "left",
      title_size: undefined,
      show_legend: true,
      state_colors: {},
      state_labels: {},
      ...config,
    };
    this._lastFetchKey = "";
    this._rangeStartMs = undefined;
    this._rangeEndMs = undefined;
    this._lastStateSignature = "";
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;

    if (this._entityIds().length === 0) {
      if (this._lastStateSignature !== "empty") {
        this._lastStateSignature = "empty";
        this._render();
      }
      return;
    }

    const now = Date.now();
    const fetchKey = [
      this._entityIds().join(","),
      this._config.hours_to_show,
      Math.floor(now / (this._config.refresh_interval * 1000)),
    ].join("|");

    if (fetchKey !== this._lastFetchKey && !this._loading) {
      this._lastFetchKey = fetchKey;
      this._fetchHistory();
      return;
    }

    const stateSignature = this._stateSignature();
    if (stateSignature !== this._lastStateSignature) {
      this._lastStateSignature = stateSignature;
      this._render();
    }
  }

  getCardSize() {
    return Math.max(3, this._entityIds().length + 1);
  }

  _entityConfigs() {
    return this._config.entities.map((entry) =>
      typeof entry === "string" ? { entity: entry } : entry
    );
  }

  _entityIds() {
    return this._entityConfigs().map((entry) => entry.entity).filter(Boolean);
  }

  _stateSignature() {
    return this._entityIds()
      .map((entityId) => {
        const stateObj = this._hass?.states?.[entityId];
        return [
          entityId,
          stateObj?.state || "",
          stateObj?.last_changed || "",
          stateObj?.last_updated || "",
        ].join(":");
      })
      .join("|");
  }

  async _fetchHistory() {
    if (!this._hass || !this._config) return;

    const entityIds = this._entityIds();
    if (entityIds.length === 0) return;

    this._loading = true;
    this._error = "";
    this._render();

    const end = new Date();
    end.setSeconds(0, 0);
    const start = new Date(end.getTime() - this._config.hours_to_show * 60 * 60 * 1000);
    this._rangeStartMs = start.getTime();
    this._rangeEndMs = end.getTime();
    const params = new URLSearchParams({
      filter_entity_id: entityIds.join(","),
      end_time: end.toISOString(),
    });
    params.set("minimal_response", "");
    params.set("no_attributes", "");

    try {
      const response = await this._hass.callApi(
        "GET",
        `history/period/${encodeURIComponent(start.toISOString())}?${params.toString()}`
      );
      const nextHistory = new Map();

      for (const series of response || []) {
        if (!series.length) continue;
        const entityId = series[0].entity_id;
        nextHistory.set(entityId, series);
      }

      for (const entityId of entityIds) {
        if (!nextHistory.has(entityId) && this._hass.states[entityId]) {
          nextHistory.set(entityId, [this._hass.states[entityId]]);
        }
      }

      this._history = nextHistory;
      this._lastStateSignature = this._stateSignature();
    } catch (err) {
      this._error = err?.message || String(err);
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _displayName(entry) {
    if (entry.name) return entry.name;
    const stateObj = this._hass?.states?.[entry.entity];
    return stateObj?.attributes?.friendly_name || entry.entity;
  }

  _colorForState(entry, state) {
    const entityColors = entry.state_colors || entry.colors || {};
    const globalColors = this._config.state_colors || this._config.colors || {};
    const candidates = this._stateLookupCandidates(entry, state);
    const stateKey = String(state).toLowerCase();
    const color =
      this._lookupMappedValue(entityColors, candidates) ||
      this._lookupMappedValue(globalColors, candidates) ||
      DEFAULT_STATE_COLORS[stateKey];

    return color || this._fallbackColor(state);
  }

  _labelForState(entry, state) {
    const entityLabels = this._asMap(entry.state_labels || entry.labels);
    const globalLabels = this._asMap(this._config.state_labels || this._config.labels);
    const candidates = this._stateLookupCandidates(entry, state);
    const configured =
      this._lookupMappedValue(entityLabels, candidates) ||
      this._lookupMappedValue(globalLabels, candidates);

    if (configured) return configured;
    return this._defaultLabelForState(entry, state);
  }

  _stateLookupCandidates(entry, state) {
    const raw = String(state);
    const defaultLabel = this._defaultLabelForState(entry, state);
    const candidates = [raw, raw.toLowerCase()];

    if (defaultLabel) {
      candidates.push(defaultLabel, String(defaultLabel).toLowerCase());
    }

    return [...new Set(candidates.map((item) => String(item).trim()).filter(Boolean))];
  }

  _lookupMappedValue(map, candidates) {
    for (const [key, value] of Object.entries(this._asMap(map))) {
      const aliases = String(key)
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean);

      for (const alias of aliases) {
        if (candidates.includes(alias) || candidates.includes(alias.toLowerCase())) {
          return value;
        }
      }
    }

    return undefined;
  }

  _asMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  }

  _stateLabelsVisible() {
    const value = this._config.labels;
    if (typeof value !== "string") return true;

    const normalized = value.trim().toLowerCase();
    return !(normalized === "off" || normalized === "false" || normalized === "none" || normalized === "hidden");
  }

  _defaultLabelForState(entry, state) {
    const stateKey = String(state).toLowerCase();
    const stateObj = this._hass?.states?.[entry.entity];
    const domain = entry.entity?.split(".")[0];
    const deviceClass = stateObj?.attributes?.device_class;
    const translated = this._translatedLabelForState(domain, deviceClass, stateKey);
    if (translated) return translated;

    const domainLabels = DEFAULT_STATE_LABELS[`${domain}.${deviceClass}`] || DEFAULT_STATE_LABELS[domain];
    return domainLabels?.[stateKey] || DEFAULT_STATE_LABELS.common[stateKey] || String(state);
  }

  _translatedLabelForState(domain, deviceClass, state) {
    if (!this._hass?.localize || !domain || !state) return undefined;

    const keys = [
      deviceClass ? `component.${domain}.entity_component.${deviceClass}.state.${state}` : "",
      `component.${domain}.entity_component._.state.${state}`,
      `component.${domain}.state.${state}`,
    ].filter(Boolean);

    for (const key of keys) {
      const translated = this._hass.localize(key);
      if (translated && translated !== key) return translated;
    }

    return undefined;
  }

  _fallbackColor(state) {
    let hash = 0;
    const value = String(state);
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) % 360;
    }
    return `hsl(${hash} 64% 48%)`;
  }

  _intervalsFor(entry, startMs, endMs) {
    const raw = this._history.get(entry.entity) || [];
    const points = raw
      .map((item) => ({
        state: item.state,
        changed: Date.parse(item.last_changed || item.last_updated),
      }))
      .filter((item) => item.state !== undefined && Number.isFinite(item.changed))
      .sort((a, b) => a.changed - b.changed);

    const current = this._hass?.states?.[entry.entity];
    if (current) {
      const currentChanged = Date.parse(current.last_changed || current.last_updated);
      const lastPoint = points[points.length - 1];
      if (
        Number.isFinite(currentChanged) &&
        (!lastPoint || lastPoint.state !== current.state || lastPoint.changed !== currentChanged)
      ) {
        points.push({ state: current.state, changed: currentChanged });
        points.sort((a, b) => a.changed - b.changed);
      }
    }

    if (!points.length) return [];

    const intervals = [];
    let active = points[0];
    for (const point of points) {
      if (point.changed <= startMs) {
        active = point;
        continue;
      }
      intervals.push({
        state: active.state,
        start: Math.max(startMs, active.changed),
        end: Math.min(endMs, point.changed),
      });
      active = point;
    }

    intervals.push({
      state: active.state,
      start: Math.max(startMs, active.changed),
      end: endMs,
    });

    return intervals.filter((item) => item.end > item.start);
  }

  _render() {
    if (!this._config) return;

    this._axisWidth = this._estimatedAxisWidth();

    const fallbackEndMs = this._roundedNowMs();
    const endMs = this._rangeEndMs || fallbackEndMs;
    const startMs = this._rangeStartMs || endMs - this._config.hours_to_show * 60 * 60 * 1000;
    const spanMs = endMs - startMs;
    const rows = this._entityConfigs()
      .filter((entry) => entry.entity)
      .map((entry) => ({
        entry,
        intervals: this._intervalsFor(entry, startMs, endMs),
      }));
    const states = this._legendStates(rows);
    const legendPosition = this._legendPosition();
    const titlePosition = this._positionValue(this._config.title_position, "left");
    const titleSize = this._titleSize();
    const labelMode = this._labelMode();
    const axisTicks = labelMode === "on" ? this._axisTicks(startMs, endMs) : [];
    const showStateLabels = this._stateLabelsVisible();

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }

        ha-card {
          overflow: visible;
        }

        .content {
          padding: 16px;
        }

        .header {
          color: var(--ha-card-header-color, var(--primary-text-color));
          font-family: var(--ha-card-header-font-family, inherit);
          font-size: var(--title-size, var(--ha-card-header-font-size, 24px));
          line-height: 1.2;
          padding: 16px 16px 0;
          text-align: left;
        }

        .header[data-position="center"] {
          text-align: center;
        }

        .header[data-position="right"] {
          text-align: right;
        }

        .status {
          color: var(--secondary-text-color);
          font-size: 13px;
          min-height: 18px;
          padding: 0 16px 8px;
        }

        .status.error {
          color: var(--error-color);
        }

        .empty {
          color: var(--secondary-text-color);
          font-size: 14px;
          padding: 4px 0;
        }

        .chart {
          display: grid;
          gap: 10px;
          position: relative;
          z-index: 1;
        }

        .row {
          display: grid;
          grid-template-columns: minmax(72px, 18%) minmax(0, 1fr);
          gap: 8px;
          align-items: center;
        }

        .name {
          color: var(--primary-text-color);
          font-size: 13px;
          line-height: 18px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .track {
          position: relative;
          height: var(--state-history-row-height, 18px);
          overflow: hidden;
          border-radius: 4px;
          background:
            repeating-linear-gradient(
              90deg,
              transparent 0,
              transparent calc(25% - 1px),
              var(--divider-color) calc(25% - 1px),
              var(--divider-color) 25%
            ),
            var(--secondary-background-color);
        }

        .segment {
          position: absolute;
          display: flex;
          align-items: center;
          justify-content: center;
          top: 0;
          bottom: 0;
          min-width: 1px;
          background: var(--segment-color);
          outline: 0;
        }

        .segment:hover,
        .segment:focus-visible {
          filter: brightness(1.08);
          z-index: 1;
        }

        .segment-label {
          box-sizing: border-box;
          display: block;
          max-width: 100%;
          overflow: hidden;
          padding: 0 5px;
          color: var(--text-primary-color, #fff);
          font-size: 11px;
          font-weight: 500;
          line-height: var(--state-history-row-height, 18px);
          text-overflow: ellipsis;
          text-shadow: 0 1px 1px rgb(0 0 0 / 45%);
          white-space: nowrap;
          pointer-events: none;
        }

        .segment-label[data-hidden="true"] {
          visibility: hidden;
        }

        .tooltip {
          position: fixed;
          z-index: 1000;
          display: none;
          max-width: min(320px, calc(100vw - 24px));
          padding: 8px 10px;
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          background: var(--mdc-theme-surface, var(--ha-card-background, var(--card-background-color)));
          color: var(--primary-text-color);
          box-shadow: var(--ha-card-box-shadow, 0 6px 18px rgb(0 0 0 / 24%));
          font-size: 12px;
          line-height: 1.35;
          pointer-events: none;
          white-space: nowrap;
        }

        .tooltip[data-visible="true"] {
          display: block;
        }

        .tooltip-state {
          margin-bottom: 4px;
          font-weight: 600;
        }

        .tooltip-row {
          display: flex;
          justify-content: space-between;
          gap: 14px;
        }

        .axis {
          display: grid;
          grid-template-columns: minmax(72px, 18%) minmax(0, 1fr);
          gap: 8px;
          align-items: start;
          margin-top: 2px;
          color: var(--secondary-text-color);
          font-size: 11px;
        }

        .axis-track {
          position: relative;
          min-width: 0;
          min-height: 24px;
        }

        .axis-tick {
          position: absolute;
          bottom: 22px;
          left: var(--tick-center);
          width: 1px;
          height: var(--tick-height, 0px);
          background: var(--divider-color);
          opacity: 0.45;
          transform: translateX(-0.5px);
          pointer-events: none;
        }

        .axis-label {
          position: absolute;
          bottom: 0;
          left: var(--tick-left);
          width: var(--axis-label-width);
          overflow: hidden;
          text-align: center;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .legend {
          display: flex;
          flex-wrap: wrap;
          gap: 8px 14px;
          justify-content: flex-start;
          margin-top: 14px;
          color: var(--secondary-text-color);
          font-size: 12px;
        }

        .legend[data-position="center"] {
          justify-content: center;
        }

        .legend[data-position="right"] {
          justify-content: flex-end;
        }

        .legend-item {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }

        .swatch {
          width: 10px;
          height: 10px;
          border-radius: 2px;
          background: var(--swatch-color);
          box-shadow: inset 0 0 0 1px rgb(0 0 0 / 18%);
        }

        @media (max-width: 520px) {
          .content {
            padding: 12px;
          }

          .row,
          .axis {
            grid-template-columns: 68px minmax(0, 1fr);
            gap: 6px;
          }

          .name {
            font-size: 12px;
          }
        }
      </style>
      <ha-card>
        ${
          this._config.title
            ? `<div class="header" data-position="${this._escapeAttr(
                titlePosition
              )}" style="--title-size:${this._escapeAttr(titleSize)}">${this._escape(this._config.title)}</div>`
            : ""
        }
        ${
          this._loading || this._error
            ? `<div class="status ${this._error ? "error" : ""}">${
                this._error ? this._escape(this._error) : "Loading history..."
              }</div>`
            : ""
        }
        <div class="content">
          ${
            rows.length === 0
              ? `<div class="empty">No entities configured</div>`
              : `<div class="chart">
                  ${rows
                    .map(
                      ({ entry, intervals }) => `
                        <div class="row">
                          <div class="name" title="${this._escape(this._displayName(entry))}">
                            ${this._escape(this._displayName(entry))}
                          </div>
                          <div class="track">
                            ${intervals
                              .map((interval) => {
                                const left = ((interval.start - startMs) / spanMs) * 100;
                                const width = ((interval.end - interval.start) / spanMs) * 100;
                                const color = this._colorForState(entry, interval.state);
                                const label = this._labelForState(entry, interval.state);
                                return `<div
                                  class="segment"
                                  tabindex="0"
                                  data-state="${this._escapeAttr(label)}"
                                  data-raw-state="${this._escapeAttr(interval.state)}"
                                  data-start="${this._escapeAttr(this._formatDateTime(interval.start))}"
                                  data-end="${this._escapeAttr(this._formatDateTime(interval.end))}"
                                  data-duration="${this._escapeAttr(
                                    this._formatDuration(interval.end - interval.start)
                                  )}"
                                  aria-label="${this._escapeAttr(
                                    `${label}, ${this._formatDateTime(interval.start)} to ${this._formatDateTime(
                                      interval.end
                                    )}, ${this._formatDuration(interval.end - interval.start)}`
                                  )}"
                                  style="left:${left}%;width:${width}%;--segment-color:${this._escapeAttr(color)}">
                                  ${showStateLabels ? `<span class="segment-label">${this._escape(label)}</span>` : ""}
                                </div>`;
                              })
                              .join("")}
                          </div>
                        </div>
                      `
                    )
                    .join("")}
                </div>
                <div class="axis">
                  <div></div>
                  <div class="axis-track">
                    ${axisTicks
                      .map(
                        (tick) => `
                          <span
                            class="axis-tick"
                            style="--tick-center:${tick.centerPercent}%;--tick-height:${this._axisTickHeight()}px"
                          ></span>
                          <span
                            class="axis-label"
                            style="--tick-left:${tick.leftPercent}%;--axis-label-width:${tick.labelWidth}px"
                          >
                            ${this._escape(tick.label)}
                          </span>
                        `
                      )
                      .join("")}
                  </div>
                </div>`
          }
          ${
            legendPosition === "off" || states.length === 0
              ? ""
              : `<div class="legend" data-position="${this._escapeAttr(legendPosition)}">
                  ${states
                    .map(
                      ({ label, color }) => `
                        <span class="legend-item">
                          <span class="swatch" style="--swatch-color:${this._escapeAttr(color)}"></span>
                          <span>${this._escape(label)}</span>
                        </span>
                      `
                    )
                    .join("")}
                </div>`
          }
        </div>
        <div class="tooltip" role="tooltip"></div>
      </ha-card>
    `;
    this._scheduleLabelSync();
  }

  _legendPosition() {
    if (this._config.show_legend === false) return "off";

    const value = String(this._config.legend || "on").trim().toLowerCase();
    if (value === "off" || value === "false" || value === "none" || value === "hidden") return "off";
    return this._positionValue(value, "left");
  }

  _labelMode() {
    const value = String(this._config.timestamps || "on").trim().toLowerCase();
    if (value === "off" || value === "false" || value === "none" || value === "hidden") return "off";
    return "on";
  }

  _positionValue(value, fallback) {
    const normalized = String(value || fallback).trim().toLowerCase();
    if (normalized === "center" || normalized === "middle") return "center";
    if (normalized === "right" || normalized === "end") return "right";
    return "left";
  }

  _titleSize() {
    const value = this._config.title_size;
    if (value === undefined || value === null || value === "") {
      return "var(--ha-card-header-font-size, 24px)";
    }

    if (typeof value === "number") return `${value}px`;
    return String(value);
  }

  _legendStates(rows) {
    const seen = new Map();
    for (const { entry, intervals } of rows) {
      for (const interval of intervals) {
        if (!seen.has(interval.state)) {
          seen.set(interval.state, {
            state: interval.state,
            label: this._labelForState(entry, interval.state),
            color: this._colorForState(entry, interval.state),
          });
        }
      }
    }
    return [...seen.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  _formatTime(value) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  }

  _formatDateTime(value) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  }

  _roundedNowMs() {
    const now = new Date();
    now.setSeconds(0, 0);
    return now.getTime();
  }

  _axisTickHeight() {
    const rows = this._entityIds().length;
    const rowHeight = 18;
    const rowGap = 10;
    return rows > 0 ? rows * rowHeight + Math.max(0, rows - 1) * rowGap + 3 : 0;
  }

  _axisTicks(startMs, endMs) {
    const width = this._axisWidth || 320;
    const labelWidth = width < 260 ? 64 : 76;
    const intervals = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168, 336, 720, 2160, 8760];

    for (const intervalHours of intervals) {
      const ticks = this._candidateAxisTicks(startMs, endMs, intervalHours);
      const kept = this._centeredNonOverlappingTicks(ticks, startMs, endMs, labelWidth);
      const visibleTickCount = ticks.filter((tick) => this._tickCanFit(tick, startMs, endMs, labelWidth)).length;

      if (kept.length > 0 && kept.length === visibleTickCount) return kept;
    }

    return this._centeredNonOverlappingTicks(
      this._candidateAxisTicks(startMs, endMs, intervals[intervals.length - 1]),
      startMs,
      endMs,
      labelWidth
    );
  }

  _candidateAxisTicks(startMs, endMs, intervalHours) {
    const ticks = [];
    const cursor = this._intervalBoundaryDate(startMs, intervalHours);

    while (cursor.getTime() <= endMs) {
      const time = cursor.getTime();
      const isMidnight = this._isMidnight(time);
      ticks.push({
        time,
        label: isMidnight ? this._formatDay(time, startMs, endMs) : this._formatTime(time),
        priority: isMidnight ? 1 : 0,
      });
      cursor.setHours(cursor.getHours() + intervalHours);
    }

    return ticks;
  }

  _tickCanFit(tick, startMs, endMs, labelWidth) {
    const width = this._axisWidth || 320;
    const center = ((tick.time - startMs) / (endMs - startMs)) * width;
    const left = center - labelWidth / 2;
    const right = left + labelWidth;
    return tick.time >= startMs && tick.time <= endMs && left >= 0 && right <= width;
  }

  _centeredNonOverlappingTicks(ticks, startMs, endMs, labelWidth) {
    const width = this._axisWidth || 320;
    const spanMs = endMs - startMs;
    const minGap = 8;
    const kept = [];

    for (const tick of ticks) {
      const center = ((tick.time - startMs) / spanMs) * width;
      const left = center - labelWidth / 2;
      const right = left + labelWidth;

      if (left < 0 || right > width) continue;
      const prepared = {
        ...tick,
        labelWidth,
        left,
        right,
        centerPercent: (center / width) * 100,
        leftPercent: (left / width) * 100,
      };

      const previous = kept[kept.length - 1];
      if (previous && left < previous.right + minGap) {
        if ((tick.priority || 0) > (previous.priority || 0) && right <= width) {
          kept[kept.length - 1] = prepared;
        }
        continue;
      }

      kept.push(prepared);
    }

    return kept;
  }

  _intervalBoundaryDate(value, intervalHours) {
    const date = new Date(value);
    date.setMinutes(0, 0, 0);

    if (intervalHours < 24) {
      date.setHours(Math.ceil(date.getHours() / intervalHours) * intervalHours);
      if (date.getTime() < value) date.setHours(date.getHours() + intervalHours);
      return date;
    }

    date.setHours(0, 0, 0, 0);
    while (date.getTime() < value) {
      date.setHours(date.getHours() + intervalHours);
    }

    return date;
  }

  _isMidnight(value) {
    const date = new Date(value);
    return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
  }

  _formatDay(value, startMs = 0, endMs = 0) {
    const sameWeekRange = endMs - startMs <= 7 * 86400000;
    return new Intl.DateTimeFormat(undefined, sameWeekRange ? { weekday: "short" } : {
      month: "short",
      day: "numeric",
    }).format(new Date(value));
  }

  _formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  _estimatedAxisWidth() {
    const cardWidth = this.getBoundingClientRect().width;
    if (!cardWidth) return 320;

    const compact = cardWidth <= 520;
    const contentPadding = compact ? 24 : 32;
    const gap = compact ? 6 : 8;
    const innerWidth = Math.max(0, cardWidth - contentPadding);
    const labelWidth = compact ? 68 : Math.max(72, innerWidth * 0.18);

    return Math.max(120, Math.round(innerWidth - labelWidth - gap));
  }

  _scheduleLabelSync() {
    if (this._labelFrame) cancelAnimationFrame(this._labelFrame);
    this._labelFrame = requestAnimationFrame(() => {
      this._labelFrame = undefined;
      this._syncSegmentLabels();
    });
  }

  _syncSegmentLabels() {
    const labels = this.shadowRoot.querySelectorAll(".segment-label");
    for (const label of labels) {
      label.dataset.hidden = "false";
      const segment = label.closest(".segment");
      const availableWidth = Math.max(0, segment.clientWidth - 8);
      label.dataset.hidden = label.scrollWidth > availableWidth ? "true" : "false";
    }
  }

  _handlePointerDown(event) {
    const segment = event.target.closest?.(".segment");
    if (!segment) {
      this._hideTooltip();
      return;
    }

    if (this._tooltipPinned && this._activeTooltipSegment === segment) {
      this._hideTooltip();
      return;
    }

    this._tooltipPinned = true;
    document.addEventListener("pointerdown", this._handleDocumentPointerDown);
    this._showTooltip(segment, event.clientX, event.clientY);
  }

  _handlePointerMove(event) {
    if (this._tooltipPinned) return;

    const segment = event.target.closest?.(".segment");
    if (!segment) {
      this._hideTooltip();
      return;
    }

    this._showTooltip(segment, event.clientX, event.clientY);
  }

  _showTooltip(segment, clientX, clientY) {
    const tooltip = this.shadowRoot.querySelector(".tooltip");
    if (!tooltip) return;

    this._activeTooltipSegment = segment;
    tooltip.innerHTML = `
      <div class="tooltip-state">${this._escape(segment.dataset.state || "")}</div>
      <div class="tooltip-row"><span>Start</span><span>${this._escape(segment.dataset.start || "")}</span></div>
      <div class="tooltip-row"><span>Stop</span><span>${this._escape(segment.dataset.end || "")}</span></div>
      <div class="tooltip-row"><span>Duration</span><span>${this._escape(segment.dataset.duration || "")}</span></div>
    `;
    tooltip.dataset.visible = "true";

    const margin = 12;
    const offset = 14;
    const rect = tooltip.getBoundingClientRect();
    let left = clientX + offset;
    let top = clientY + offset;

    if (left + rect.width + margin > window.innerWidth) {
      left = clientX - rect.width - offset;
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = clientY - rect.height - offset;
    }

    tooltip.style.left = `${Math.max(margin, left)}px`;
    tooltip.style.top = `${Math.max(margin, top)}px`;
  }

  _hideTooltip() {
    this._tooltipPinned = false;
    this._activeTooltipSegment = undefined;
    document.removeEventListener("pointerdown", this._handleDocumentPointerDown);
    const tooltip = this.shadowRoot.querySelector(".tooltip");
    if (tooltip) tooltip.dataset.visible = "false";
  }

  _escape(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  _escapeAttr(value) {
    return this._escape(value).replaceAll(";", "");
  }
}

class StateHistoryCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = undefined;
    this._entityDraft = [];
    this._colorDraft = [];
    this._labelDraft = [];
    this._configDebounce = undefined;
    this.shadowRoot.addEventListener("focusout", () => this._flushConfigChangeSoon());
  }

  setConfig(config) {
    this._config = { ...config };
    if (this._isEditorFieldFocused()) return;

    this._entityDraft = this._entityConfigs(config.entities || []);
    this._colorDraft = this._mapEntries(config.state_colors || config.colors || {});
    this._labelDraft = this._mapEntries(this._labelsEditable(config) ? config.state_labels || config.labels || {} : {});
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  _render() {
    const config = this._config || {};
    const entities = this._entityDraft;
    const stateColors = this._colorDraft;
    const stateLabels = this._labelDraft;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }

        .editor {
          display: grid;
          gap: 18px;
        }

        fieldset {
          display: grid;
          gap: 12px;
          min-width: 0;
          margin: 0;
          padding: 0;
          border: 0;
        }

        legend {
          margin-bottom: 2px;
          padding: 0;
          color: var(--primary-text-color);
          font-size: 14px;
          font-weight: 600;
        }

        label {
          display: grid;
          gap: 5px;
          color: var(--secondary-text-color);
          font-size: 12px;
        }

        input,
        select {
          box-sizing: border-box;
          width: 100%;
          min-height: 40px;
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          padding: 8px 10px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font: inherit;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
          gap: 8px;
          align-items: end;
        }

        .map-row {
          grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) auto;
        }

        .map-row.color-row {
          grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) auto auto;
        }

        button {
          min-height: 40px;
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          padding: 8px 12px;
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font: inherit;
          cursor: pointer;
        }

        button[data-action^="remove"] {
          width: 40px;
          padding: 0;
        }

        .color-preview {
          width: 40px;
          height: 40px;
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          background:
            linear-gradient(45deg, rgb(128 128 128 / 22%) 25%, transparent 25%),
            linear-gradient(-45deg, rgb(128 128 128 / 22%) 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, rgb(128 128 128 / 22%) 75%),
            linear-gradient(-45deg, transparent 75%, rgb(128 128 128 / 22%) 75%);
          background-color: var(--card-background-color);
          background-position: 0 0, 0 8px, 8px -8px, -8px 0;
          background-size: 16px 16px;
          overflow: hidden;
        }

        .color-preview::after {
          display: block;
          width: 100%;
          height: 100%;
          background: var(--preview-color, transparent);
          content: "";
        }

        .add {
          justify-self: start;
        }

        @media (max-width: 640px) {
          .grid,
          .row,
          .map-row {
            grid-template-columns: 1fr;
          }

          button[data-action^="remove"] {
            width: auto;
          }
        }
      </style>
      <div class="editor">
        <fieldset>
          <legend>Title</legend>
          <div class="grid">
            <label>
              Text
              <input data-field="title" value="${this._escapeAttr(config.title || "")}" placeholder="Hidden when empty">
            </label>
            <label>
              Size
              <input data-field="title_size" value="${this._escapeAttr(config.title_size || "")}" placeholder="24px">
            </label>
            <label>
              Position
              <select data-field="title_position">
                ${this._option("left", "Left", config.title_position || "left")}
                ${this._option("center", "Center", config.title_position)}
                ${this._option("right", "Right", config.title_position)}
              </select>
            </label>
            <label>
              Legend
              <select data-field="legend">
                ${this._option("on", "On / left", config.legend || "on")}
                ${this._option("center", "Center", config.legend)}
                ${this._option("right", "Right", config.legend)}
                ${this._option("off", "Off", config.legend)}
              </select>
            </label>
            <label>
              Time labels
              <select data-field="timestamps">
                ${this._option("on", "On", config.timestamps || "on")}
                ${this._option("off", "Off", config.timestamps)}
              </select>
            </label>
            <label>
              State labels
              <select data-field="labels">
                ${this._option("", "On", this._inlineLabelsValue(config))}
                ${this._option("off", "Off", this._inlineLabelsValue(config))}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>History</legend>
          <div class="grid">
            <label>
              Hours to show
              <input data-field="hours_to_show" type="number" min="1" step="1" value="${this._escapeAttr(
                config.hours_to_show ?? 24
              )}">
            </label>
            <label>
              Refresh interval
              <input data-field="refresh_interval" type="number" min="10" step="10" value="${this._escapeAttr(
                config.refresh_interval ?? 300
              )}">
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Entities</legend>
          <div class="entity-rows">
            ${entities.map((entry, index) => this._entityRow(entry, index)).join("")}
          </div>
          <button class="add" data-action="add-entity" type="button">Add entity</button>
        </fieldset>

        <fieldset>
          <legend>State colors</legend>
          <div class="color-rows">
            ${stateColors.map(([key, value], index) => this._mapRow("color", key, value, index)).join("")}
          </div>
          <button class="add" data-action="add-color" type="button">Add color</button>
        </fieldset>

        <fieldset>
          <legend>State labels</legend>
          <div class="label-rows">
            ${stateLabels.map(([key, value], index) => this._mapRow("label", key, value, index)).join("")}
          </div>
          <button class="add" data-action="add-label" type="button">Add label</button>
        </fieldset>
      </div>
    `;

    this.shadowRoot.querySelector(".editor").addEventListener("input", (event) => this._handleInput(event));
    this.shadowRoot.querySelector(".editor").addEventListener("change", (event) => this._handleInput(event));
    this.shadowRoot.querySelector(".editor").addEventListener("click", (event) => this._handleClick(event));
  }

  _entityRow(entry, index) {
    return `
      <div class="row">
        <label>
          Entity
          <input data-entity-index="${index}" data-entity-field="entity" value="${this._escapeAttr(
            entry.entity || ""
          )}" placeholder="binary_sensor.kitchen_presence">
        </label>
        <label>
          Name
          <input data-entity-index="${index}" data-entity-field="name" value="${this._escapeAttr(
            entry.name || ""
          )}" placeholder="Optional">
        </label>
        <button data-action="remove-entity" data-index="${index}" type="button" aria-label="Remove entity">x</button>
      </div>
    `;
  }

  _mapRow(type, key, value, index) {
    return `
      <div class="row map-row ${type === "color" ? "color-row" : ""}">
        <label>
          State
          <input data-map-type="${type}" data-map-index="${index}" data-map-field="key" value="${this._escapeAttr(
            key
          )}" placeholder="on|Home">
        </label>
        <label>
          ${type === "color" ? "Color" : "Label"}
          <input data-map-type="${type}" data-map-index="${index}" data-map-field="value" value="${this._escapeAttr(
            value
          )}" placeholder="${type === "color" ? "#22c55e" : "Home"}">
        </label>
        <button data-action="remove-${type}" data-index="${index}" type="button" aria-label="Remove ${type}">x</button>
        ${
          type === "color"
            ? `<span class="color-preview" style="--preview-color:${this._escapeAttr(value || "transparent")}"></span>`
            : ""
        }
      </div>
    `;
  }

  _handleInput(event) {
    const target = event.target;
    const debounce = event.type === "input";
    if (target.dataset.field) {
      this._updateField(target.dataset.field, target.value, target.type, debounce);
      return;
    }

    if (target.dataset.entityField) {
      this._updateEntity(Number(target.dataset.entityIndex), target.dataset.entityField, target.value, debounce);
      return;
    }

    if (target.dataset.mapField) {
      this._updateMap(
        target.dataset.mapType,
        Number(target.dataset.mapIndex),
        target.dataset.mapField,
        target.value,
        debounce
      );
    }
  }

  _handleClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    if (action === "add-entity") this._addEntity();
    if (action === "remove-entity") this._removeEntity(Number(button.dataset.index));
    if (action === "add-color") this._addMapEntry("color");
    if (action === "remove-color") this._removeMapEntry("color", Number(button.dataset.index));
    if (action === "add-label") this._addMapEntry("label");
    if (action === "remove-label") this._removeMapEntry("label", Number(button.dataset.index));
  }

  _updateField(field, value, type, debounce = false) {
    const config = { ...this._config };

    if (value === "" && field !== "title") {
      delete config[field];
    } else if (field === "title" && value === "") {
      delete config.title;
    } else if (type === "number") {
      config[field] = Number(value);
    } else {
      config[field] = value;
    }
    this._configChanged(config, false, debounce);
  }

  _updateEntity(index, field, value, debounce = false) {
    this._entityDraft[index] = { ...(this._entityDraft[index] || {}), [field]: value };
    if (field === "name" && value === "") delete this._entityDraft[index].name;
    this._configChanged({ ...this._config, entities: this._entityDraft.filter((entry) => entry.entity) }, false, debounce);
  }

  _addEntity() {
    this._entityDraft.push({ entity: "" });
    this._render();
  }

  _removeEntity(index) {
    this._entityDraft.splice(index, 1);
    this._configChanged({ ...this._config, entities: this._entityDraft.filter((entry) => entry.entity) }, true);
  }

  _updateMap(type, index, field, value, debounce = false) {
    const configKey = type === "color" ? "state_colors" : "state_labels";
    const entries = type === "color" ? this._colorDraft : this._labelDraft;
    entries[index] = entries[index] || ["", ""];
    entries[index][field === "key" ? 0 : 1] = value;
    this._updateColorPreview(type, index, entries[index][1]);
    this._configChanged({ ...this._config, [configKey]: this._entriesToMap(entries) }, false, debounce);
  }

  _addMapEntry(type) {
    const entries = type === "color" ? this._colorDraft : this._labelDraft;
    entries.push(["", ""]);
    this._render();
  }

  _removeMapEntry(type, index) {
    const configKey = type === "color" ? "state_colors" : "state_labels";
    const entries = type === "color" ? this._colorDraft : this._labelDraft;
    entries.splice(index, 1);
    this._configChanged({ ...this._config, [configKey]: this._entriesToMap(entries) }, true);
  }

  _configChanged(config, rerender = false, debounce = false) {
    this._config = config;
    if (this._configDebounce) clearTimeout(this._configDebounce);

    if (debounce) {
      this._configDebounce = setTimeout(() => {
        this._configDebounce = undefined;
        this._emitConfigChanged();
      }, 450);
    } else {
      this._emitConfigChanged();
    }

    if (rerender) this._render();
  }

  _flushConfigChangeSoon() {
    setTimeout(() => {
      if (this._isEditorFieldFocused() || !this._configDebounce) return;

      clearTimeout(this._configDebounce);
      this._configDebounce = undefined;
      this._emitConfigChanged();
    });
  }

  _isEditorFieldFocused() {
    const active = this.shadowRoot.activeElement;
    return active instanceof HTMLInputElement || active instanceof HTMLSelectElement;
  }

  _emitConfigChanged() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _updateColorPreview(type, index, value) {
    if (type !== "color") return;

    const row = this.shadowRoot.querySelector(`.color-row input[data-map-index="${index}"]`)?.closest(".color-row");
    const preview = row?.querySelector(".color-preview");
    if (preview) preview.style.setProperty("--preview-color", value || "transparent");
  }

  _entityConfigs(entities) {
    return entities.map((entry) => (typeof entry === "string" ? { entity: entry } : { ...entry }));
  }

  _mapEntries(map) {
    return Object.entries(map && typeof map === "object" && !Array.isArray(map) ? map : {});
  }

  _labelsEditable(config) {
    return !config.state_labels || typeof config.state_labels === "object";
  }

  _inlineLabelsValue(config) {
    return typeof config.labels === "string" && config.labels.trim().toLowerCase() === "off" ? "off" : "";
  }

  _entriesToMap(entries) {
    return entries.reduce((map, [key, value]) => {
      if (key) map[key] = value;
      return map;
    }, {});
  }

  _option(value, label, selectedValue) {
    const selected = String(selectedValue || "").toLowerCase() === value ? " selected" : "";
    return `<option value="${this._escapeAttr(value)}"${selected}>${this._escape(label)}</option>`;
  }

  _escape(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  _escapeAttr(value) {
    return this._escape(value).replaceAll(";", "");
  }
}

const DEFAULT_STATE_COLORS = {
  on: "var(--state-active-color, #fdd835)",
  off: "var(--disabled-color, #9e9e9e)",
  open: "var(--state-active-color, #fdd835)",
  closed: "var(--disabled-color, #9e9e9e)",
  home: "var(--state-person-home-color, #4caf50)",
  not_home: "var(--state-person-not-home-color, #9e9e9e)",
  unavailable: "var(--state-unavailable-color, #bdbdbd)",
  unknown: "var(--state-unknown-color, #bdbdbd)",
};

const DEFAULT_STATE_LABELS = {
  common: {
    on: "On",
    off: "Off",
    open: "Open",
    closed: "Closed",
    home: "Home",
    not_home: "Away",
    unavailable: "Unavailable",
    unknown: "Unknown",
  },
  person: {
    home: "Home",
    not_home: "Away",
  },
  device_tracker: {
    home: "Home",
    not_home: "Away",
  },
  "binary_sensor.presence": {
    on: "Home",
    off: "Away",
  },
  "binary_sensor.motion": {
    on: "Detected",
    off: "Clear",
  },
  "binary_sensor.occupancy": {
    on: "Detected",
    off: "Clear",
  },
  "binary_sensor.opening": {
    on: "Open",
    off: "Closed",
  },
  "binary_sensor.door": {
    on: "Open",
    off: "Closed",
  },
  "binary_sensor.window": {
    on: "Open",
    off: "Closed",
  },
};

customElements.define("state-history-card-editor", StateHistoryCardEditor);
customElements.define("state-history-card", StateHistoryCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "state-history-card",
  name: "State History Card",
  description: "History graph replacement with explicit colors per state value.",
});
