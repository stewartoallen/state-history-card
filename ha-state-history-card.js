class HaStateHistoryCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("hui-history-graph-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:ha-state-history-card",
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
    this.shadowRoot.addEventListener("pointermove", (event) => this._handlePointerMove(event));
    this.shadowRoot.addEventListener("pointerleave", () => this._hideTooltip());
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.entities) || config.entities.length === 0) {
      throw new Error("entities is required");
    }

    this._config = {
      hours_to_show: 24,
      refresh_interval: 300,
      show_legend: true,
      state_colors: {},
      state_labels: {},
      ...config,
    };
    this._lastFetchKey = "";
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;

    const now = Date.now();
    const fetchKey = [
      this._entityIds().join(","),
      this._config.hours_to_show,
      Math.floor(now / (this._config.refresh_interval * 1000)),
    ].join("|");

    if (fetchKey !== this._lastFetchKey && !this._loading) {
      this._lastFetchKey = fetchKey;
      this._fetchHistory();
    } else {
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

  async _fetchHistory() {
    if (!this._hass || !this._config) return;

    this._loading = true;
    this._error = "";
    this._render();

    const end = new Date();
    const start = new Date(end.getTime() - this._config.hours_to_show * 60 * 60 * 1000);
    const entityIds = this._entityIds();
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
    const entityLabels = entry.state_labels || entry.labels || {};
    const globalLabels = this._config.state_labels || this._config.labels || {};
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
    for (const [key, value] of Object.entries(map || {})) {
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

    const end = new Date();
    const start = new Date(end.getTime() - this._config.hours_to_show * 60 * 60 * 1000);
    const startMs = start.getTime();
    const endMs = end.getTime();
    const spanMs = endMs - startMs;
    const rows = this._entityConfigs().map((entry) => ({
      entry,
      intervals: this._intervalsFor(entry, startMs, endMs),
    }));
    const states = this._legendStates(rows);

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
          font-size: var(--ha-card-header-font-size, 24px);
          line-height: 1.2;
          padding: 16px 16px 0;
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

        .chart {
          display: grid;
          gap: 10px;
        }

        .row {
          display: grid;
          grid-template-columns: minmax(96px, 28%) minmax(0, 1fr);
          gap: 12px;
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
          border-radius: 4px;
          background: var(--primary-text-color);
          color: var(--card-background-color);
          box-shadow: 0 6px 18px rgb(0 0 0 / 24%);
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
          grid-template-columns: minmax(96px, 28%) minmax(0, 1fr);
          gap: 12px;
          align-items: start;
          margin-top: 2px;
          color: var(--secondary-text-color);
          font-size: 11px;
        }

        .ticks {
          display: flex;
          justify-content: space-between;
          min-width: 0;
        }

        .legend {
          display: flex;
          flex-wrap: wrap;
          gap: 8px 14px;
          margin-top: 14px;
          color: var(--secondary-text-color);
          font-size: 12px;
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
            grid-template-columns: 84px minmax(0, 1fr);
            gap: 8px;
          }

          .name {
            font-size: 12px;
          }
        }
      </style>
      <ha-card>
        ${this._config.title ? `<div class="header">${this._escape(this._config.title)}</div>` : ""}
        ${
          this._loading || this._error
            ? `<div class="status ${this._error ? "error" : ""}">${
                this._error ? this._escape(this._error) : "Loading history..."
              }</div>`
            : ""
        }
        <div class="content">
          <div class="chart">
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
                            data-duration="${this._escapeAttr(this._formatDuration(interval.end - interval.start))}"
                            aria-label="${this._escapeAttr(
                              `${label}, ${this._formatDateTime(interval.start)} to ${this._formatDateTime(
                                interval.end
                              )}, ${this._formatDuration(interval.end - interval.start)}`
                            )}"
                            style="left:${left}%;width:${width}%;--segment-color:${this._escapeAttr(
                            color
                          )}">
                            <span class="segment-label">${this._escape(label)}</span>
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
            <div class="ticks">
              <span>${this._formatTime(startMs)}</span>
              <span>${this._formatTime(startMs + spanMs / 2)}</span>
              <span>${this._formatTime(endMs)}</span>
            </div>
          </div>
          ${
            this._config.show_legend === false
              ? ""
              : `<div class="legend">
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

  _handlePointerMove(event) {
    const segment = event.target.closest?.(".segment");
    if (!segment) {
      this._hideTooltip();
      return;
    }

    const tooltip = this.shadowRoot.querySelector(".tooltip");
    if (!tooltip) return;

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
    let left = event.clientX + offset;
    let top = event.clientY + offset;

    if (left + rect.width + margin > window.innerWidth) {
      left = event.clientX - rect.width - offset;
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = event.clientY - rect.height - offset;
    }

    tooltip.style.left = `${Math.max(margin, left)}px`;
    tooltip.style.top = `${Math.max(margin, top)}px`;
  }

  _hideTooltip() {
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

customElements.define("ha-state-history-card", HaStateHistoryCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ha-state-history-card",
  name: "HA State History Card",
  description: "History graph replacement with explicit colors per state value.",
});
