class StateHistoryCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("state-history-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:state-history-card",
      title: "Title",
      title_position: "center",
      timestamps: "on",
      labels: "",
      decimals: 0,
      entities: ["sun.sun"],
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
    this._historyFetchSignature = "";
    this._loadedEndMs = undefined;
    this._labelFrame = undefined;
    this._axisWidth = 0;
    this._rangeStartMs = undefined;
    this._rangeEndMs = undefined;
    this._renderedRows = new Map();
    this._lastStateSignature = "";
    this._activeTooltipSegment = undefined;
    this._tooltipPinned = false;
    this._pendingTooltipTap = undefined;
    this._labelPressTimer = undefined;
    this._labelLongPressed = false;
    this._labelPressTarget = undefined;
    this._handleDocumentPointerDown = (event) => {
      if (!event.composedPath().includes(this)) this._hideTooltip();
    };
    this._handleDocumentPointerMove = (event) => {
      if (!this._tooltipPinned && !event.composedPath().includes(this)) this._hideTooltip();
    };
    this._handleWindowScroll = () => this._hideTooltip();
    this.shadowRoot.addEventListener("pointermove", (event) => this._handlePointerMove(event));
    this.shadowRoot.addEventListener("pointerdown", (event) => this._handlePointerDown(event));
    this.shadowRoot.addEventListener("pointerup", (event) => this._handlePointerUp(event));
    this.shadowRoot.addEventListener("pointercancel", () => this._handlePointerCancel());
    this.shadowRoot.addEventListener("click", (event) => this._handleClick(event));
    this.shadowRoot.addEventListener("keydown", (event) => this._handleKeyDown(event));
    this.shadowRoot.addEventListener("pointerleave", () => {
      if (!this._tooltipPinned) this._hideTooltip();
    });
  }

  disconnectedCallback() {
    document.removeEventListener("pointerdown", this._handleDocumentPointerDown);
    document.removeEventListener("pointermove", this._handleDocumentPointerMove);
    window.removeEventListener("scroll", this._handleWindowScroll, true);
    this._clearLabelPress();
    if (this._labelFrame) cancelAnimationFrame(this._labelFrame);
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.entities)) {
      throw new Error("entities is required");
    }

    const previousHistoryConfigSignature = this._historyConfigSignature(this._config);
    this._config = {
      hours_to_show: 24,
      refresh_interval: 300,
      legend: "on",
      timestamps: "on",
      title_position: "left",
      title_size: undefined,
      show_legend: true,
      recorder: false,
      state_colors: {},
      state_labels: {},
      ...config,
    };
    const historyConfigSignature = this._historyConfigSignature(this._config);
    if (previousHistoryConfigSignature !== historyConfigSignature) {
      this._lastFetchKey = "";
      this._historyFetchSignature = "";
      this._loadedEndMs = undefined;
      this._rangeStartMs = undefined;
      this._rangeEndMs = undefined;
    }
    this._lastStateSignature = "";
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._syncLabelActionColors();

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
    } else {
      this._syncLabelActionColors();
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

  _historyConfigSignature(config) {
    if (!config) return "";

    const entities = (config.entities || [])
      .map((entry) => (typeof entry === "string" ? entry : entry?.entity))
      .filter(Boolean);
    return JSON.stringify({
      entities,
      hours_to_show: config.hours_to_show ?? 24,
      recorder: config.recorder === true,
      bucket_minutes: config.bucket_minutes ?? 0,
      entity_buckets: (config.entities || []).map((entry) =>
        typeof entry === "string"
          ? ""
          : `${entry?.entity || ""}:${entry?.mode ?? ""}:${entry?.bucket_minutes ?? ""}:${entry?.recorder ?? ""}:${
              entry?.color_stops ? "stops" : ""
            }`
      ),
      global_color_stops: config.color_stops ? "stops" : "",
    });
  }

  _stateSignature() {
    return this._entityConfigs()
      .filter((entry) => entry.entity)
      .map((entry) => {
        const entityId = entry.entity;
        const stateObj = this._hass?.states?.[entityId];
        return [
          entityId,
          stateObj?.state || "",
          stateObj?.last_changed || "",
          stateObj?.last_updated || "",
          this._liveAttributeSignature(entry, stateObj),
        ].join(":");
      })
      .join("|");
  }

  _liveAttributeSignature(entry, stateObj) {
    if (!stateObj || this._colorSource(entry) !== "light") return "";

    const attributes = stateObj.attributes || {};
    return JSON.stringify({
      rgb_color: attributes.rgb_color || null,
      hs_color: attributes.hs_color || null,
      xy_color: attributes.xy_color || null,
      color_temp_kelvin: attributes.color_temp_kelvin || null,
      color_temp: attributes.color_temp || null,
    });
  }

  async _fetchHistory() {
    if (!this._hass || !this._config) return;

    const loadStart = performance.now();
    const entityIds = this._entityIds();
    if (entityIds.length === 0) return;

    const end = new Date();
    end.setSeconds(0, 0);
    const endMs = end.getTime();
    const startMs = endMs - this._config.hours_to_show * 60 * 60 * 1000;
    const signature = [entityIds.join(","), this._config.hours_to_show].join("|");
    const fullFetch =
      signature !== this._historyFetchSignature ||
      !Number.isFinite(this._loadedEndMs) ||
      this._loadedEndMs < startMs;
    const overlapMs = 2 * 60 * 1000;
    const fetchStartMs = fullFetch ? startMs : Math.max(startMs, this._loadedEndMs - overlapMs);
    const fetchStart = new Date(fetchStartMs);

    this._loading = fullFetch;
    this._error = "";
    this._rangeStartMs = startMs;
    this._rangeEndMs = endMs;
    if (fullFetch) this._render();

    const params = new URLSearchParams({
      filter_entity_id: entityIds.join(","),
      end_time: end.toISOString(),
    });
    params.set("minimal_response", "");
    params.set("no_attributes", "");

    let historyMs = 0;
    let recorderMs = 0;
    let historyEntities = 0;
    let recorderEntities = 0;
    let historyPoints = 0;
    let recorderPoints = 0;

    try {
      const nextHistory = fullFetch ? new Map() : new Map(this._history);
      const recorderStart = performance.now();
      const recorderHistory = await this._fetchRecorderHistory(startMs, endMs);
      recorderMs = performance.now() - recorderStart;
      const historyFetchEntityIds = entityIds.filter((entityId) => !recorderHistory.has(entityId));

      for (const [entityId, series] of recorderHistory.entries()) {
        nextHistory.set(entityId, series);
        recorderEntities += 1;
        recorderPoints += series.length;
      }

      let response = [];
      if (historyFetchEntityIds.length > 0) {
        const historyStart = performance.now();
        const historyParams = new URLSearchParams(params);
        historyParams.set("filter_entity_id", historyFetchEntityIds.join(","));
        response = await this._hass.callApi(
          "GET",
          `history/period/${encodeURIComponent(fetchStart.toISOString())}?${historyParams.toString()}`
        );
        historyMs = performance.now() - historyStart;
      }

      for (const series of response || []) {
        if (!series.length) continue;
        const entityId = this._seriesEntityId(series, historyFetchEntityIds);
        if (!entityId) continue;

        nextHistory.set(
          entityId,
          fullFetch ? this._prunedHistorySeries(series, startMs) : this._mergedHistorySeries(nextHistory.get(entityId), series, startMs)
        );
        historyEntities += 1;
        historyPoints += series.length;
      }

      for (const entityId of historyFetchEntityIds) {
        if (!nextHistory.has(entityId) && this._hass.states[entityId]) {
          nextHistory.set(entityId, [this._hass.states[entityId]]);
        }
      }

      for (const entityId of [...nextHistory.keys()]) {
        if (!entityIds.includes(entityId)) {
          nextHistory.delete(entityId);
          continue;
        }

        nextHistory.set(entityId, this._prunedHistorySeries(nextHistory.get(entityId), startMs));
      }

      this._history = nextHistory;
      this._historyFetchSignature = signature;
      this._loadedEndMs = endMs;
      this._lastStateSignature = this._stateSignature();
    } catch (err) {
      this._error = err?.message || String(err);
    } finally {
      this._loading = false;
      this._render();
      this._logBenchmark("load", {
        total_ms: performance.now() - loadStart,
        history_ms: historyMs,
        recorder_ms: recorderMs,
        full: fullFetch,
        history_entities: historyEntities,
        recorder_entities: recorderEntities,
        history_points: historyPoints,
        recorder_points: recorderPoints,
      });
    }
  }

  async _fetchRecorderHistory(startMs, endMs) {
    if (!this._hass?.callWS) return new Map();

    const candidates = this._entityConfigs().filter((entry) => {
      const bucketMinutes = this._bucketMinutes(entry);
      return entry.entity && this._isNumericEntry(entry) && this._recorderEnabled(entry) && this._recorderPeriod(bucketMinutes);
    });
    if (candidates.length === 0) return new Map();

    const byPeriod = new Map();
    for (const entry of candidates) {
      const period = this._recorderPeriod(this._bucketMinutes(entry));
      if (!byPeriod.has(period)) byPeriod.set(period, []);
      byPeriod.get(period).push(entry);
    }

    const history = new Map();
    for (const [period, entries] of byPeriod.entries()) {
      let result;
      try {
        result = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: new Date(startMs).toISOString(),
          end_time: new Date(endMs).toISOString(),
          statistic_ids: entries.map((entry) => entry.entity),
          period,
          types: ["mean"],
        });
      } catch (err) {
        console.warn("[state-history-card] recorder statistics unavailable; falling back to history", err);
        continue;
      }

      for (const entry of entries) {
        const series = this._statisticsSeriesToHistory(entry.entity, result?.[entry.entity], startMs, endMs);
        if (series.length > 0) history.set(entry.entity, series);
      }
    }

    return history;
  }

  _statisticsSeriesToHistory(entityId, statistics = [], startMs = 0, endMs = 0) {
    return (statistics || [])
      .map((point) => {
        const changed = this._statisticsTimeMs(point.start);
        const state = Number(point.mean);
        if (!Number.isFinite(changed) || !Number.isFinite(state) || changed < startMs || changed > endMs) return undefined;

        return {
          entity_id: entityId,
          state: String(state),
          last_changed: new Date(changed).toISOString(),
          last_updated: new Date(changed).toISOString(),
          __source: "recorder",
        };
      })
      .filter(Boolean)
      .sort((a, b) => this._stateChangedMs(a) - this._stateChangedMs(b));
  }

  _statisticsTimeMs(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : Date.parse(value);
  }

  _seriesEntityId(series, entityIds) {
    const explicit = series.find((item) => item?.entity_id)?.entity_id;
    if (explicit) return explicit;

    if (entityIds.length === 1) return entityIds[0];
    return undefined;
  }

  _mergedHistorySeries(existing = [], incoming = [], startMs = 0) {
    return this._prunedHistorySeries([...(existing || []), ...(incoming || [])], startMs);
  }

  _prunedHistorySeries(series = [], startMs = 0) {
    const byKey = new Map();
    for (const point of series || []) {
      const changed = this._stateChangedMs(point);
      if (!Number.isFinite(changed)) continue;

      byKey.set(`${changed}|${point.state ?? ""}`, point);
    }

    const sorted = [...byKey.values()].sort((a, b) => this._stateChangedMs(a) - this._stateChangedMs(b));
    let previous;
    const kept = [];
    for (const point of sorted) {
      const changed = this._stateChangedMs(point);
      if (changed <= startMs) {
        previous = point;
      } else {
        kept.push(point);
      }
    }

    return previous ? [previous, ...kept] : kept;
  }

  _stateChangedMs(stateObj) {
    return Date.parse(stateObj?.last_changed || stateObj?.last_updated);
  }

  _displayName(entry) {
    if (entry.name) return entry.name;
    const stateObj = this._hass?.states?.[entry.entity];
    return stateObj?.attributes?.friendly_name || entry.entity;
  }

  _colorForState(entry, state, attributes = {}) {
    if (this._isNumericEntry(entry)) {
      const numericColor = this._numericColorForState(entry, state);
      if (numericColor) return numericColor;
    }

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

  _colorSource(entry) {
    return String(entry.color_source || this._config.color_source || "state").trim().toLowerCase();
  }

  _lightColorForState(state, attributes = {}) {
    if (String(state).toLowerCase() !== "on") return undefined;

    const rgb = this._lightRgbColor(attributes);
    return rgb ? `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})` : undefined;
  }

  _lightRgbColor(attributes = {}) {
    if (Array.isArray(attributes.rgb_color) && attributes.rgb_color.length >= 3) {
      const rgb = attributes.rgb_color.slice(0, 3).map((value) => Number(value));
      if (rgb.every((value) => Number.isFinite(value))) return rgb.map((value) => Math.min(255, Math.max(0, Math.round(value))));
    }

    if (Array.isArray(attributes.hs_color) && attributes.hs_color.length >= 2) {
      return this._hsvToRgb(Number(attributes.hs_color[0]), Number(attributes.hs_color[1]), 100);
    }

    if (Array.isArray(attributes.xy_color) && attributes.xy_color.length >= 2) {
      return this._xyToRgb(Number(attributes.xy_color[0]), Number(attributes.xy_color[1]));
    }

    const kelvin = Number(attributes.color_temp_kelvin);
    if (Number.isFinite(kelvin)) return this._kelvinToRgb(kelvin);

    const mireds = Number(attributes.color_temp);
    if (Number.isFinite(mireds) && mireds > 0) return this._kelvinToRgb(1000000 / mireds);

    return undefined;
  }

  _hsvToRgb(hue, saturation, value) {
    if (!Number.isFinite(hue) || !Number.isFinite(saturation) || !Number.isFinite(value)) return undefined;

    const h = ((hue % 360) + 360) % 360;
    const s = Math.min(100, Math.max(0, saturation)) / 100;
    const v = Math.min(100, Math.max(0, value)) / 100;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const [r, g, b] =
      h < 60 ? [c, x, 0] :
      h < 120 ? [x, c, 0] :
      h < 180 ? [0, c, x] :
      h < 240 ? [0, x, c] :
      h < 300 ? [x, 0, c] :
      [c, 0, x];

    return [r, g, b].map((channel) => Math.round((channel + m) * 255));
  }

  _kelvinToRgb(kelvin) {
    const temperature = Math.min(40000, Math.max(1000, kelvin)) / 100;
    let red;
    let green;
    let blue;

    if (temperature <= 66) {
      red = 255;
      green = 99.4708025861 * Math.log(temperature) - 161.1195681661;
      blue = temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
    } else {
      red = 329.698727446 * ((temperature - 60) ** -0.1332047592);
      green = 288.1221695283 * ((temperature - 60) ** -0.0755148492);
      blue = 255;
    }

    return [red, green, blue].map((channel) => Math.round(Math.min(255, Math.max(0, channel))));
  }

  _xyToRgb(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return undefined;

    const brightness = 1;
    const z = 1 - x - y;
    const bigY = brightness;
    const bigX = (bigY / y) * x;
    const bigZ = (bigY / y) * z;
    let red = bigX * 1.656492 - bigY * 0.354851 - bigZ * 0.255038;
    let green = -bigX * 0.707196 + bigY * 1.655397 + bigZ * 0.036152;
    let blue = bigX * 0.051713 - bigY * 0.121364 + bigZ * 1.01153;

    red = red <= 0.0031308 ? 12.92 * red : 1.055 * (red ** (1 / 2.4)) - 0.055;
    green = green <= 0.0031308 ? 12.92 * green : 1.055 * (green ** (1 / 2.4)) - 0.055;
    blue = blue <= 0.0031308 ? 12.92 * blue : 1.055 * (blue ** (1 / 2.4)) - 0.055;

    const max = Math.max(red, green, blue);
    if (max > 1) {
      red /= max;
      green /= max;
      blue /= max;
    }

    return [red, green, blue].map((channel) => Math.round(Math.min(255, Math.max(0, channel * 255))));
  }

  _labelForState(entry, state) {
    if (this._isNumericEntry(entry)) return this._formatNumericState(entry, state);

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

  _isNumericEntry(entry) {
    const mode = String(entry.mode || "").trim().toLowerCase();
    if (mode === "state" || mode === "discrete") return false;
    if (mode === "numeric" || entry.color_stops) return true;
    if (!this._hasColorStops(this._config.color_stops)) return false;

    const domain = entry.entity?.split(".")[0];
    if (domain === "number" || domain === "input_number") return true;
    if (domain !== "sensor") return false;

    return this._sensorLooksNumeric(entry.entity);
  }

  _sensorLooksNumeric(entityId) {
    const stateObj = this._hass?.states?.[entityId];
    if (!stateObj) return false;
    if (Number.isFinite(Number(stateObj.state))) return true;

    const attributes = stateObj.attributes || {};
    return Boolean(attributes.unit_of_measurement || attributes.device_class || attributes.state_class);
  }

  _numericColorForState(entry, state) {
    const value = this._numericValueForColor(entry, state);
    const stops = this._colorStops(entry.color_stops || this._config.color_stops);
    if (!Number.isFinite(value) || stops.length === 0) return this._nullColor(entry);

    if (value <= stops[0].value) return stops[0].color;
    if (value >= stops[stops.length - 1].value) return stops[stops.length - 1].color;

    for (let index = 1; index < stops.length; index += 1) {
      const high = stops[index];
      const low = stops[index - 1];
      if (value > high.value) continue;

      const ratio = (value - low.value) / (high.value - low.value);
      return this._interpolateColor(low.color, high.color, ratio);
    }

    return undefined;
  }

  _nullColor(entry) {
    return entry.null_color || this._config.null_color || "var(--secondary-background-color)";
  }

  _trackBackground(entry) {
    return this._isNumericEntry(entry) ? this._nullColor(entry) : "var(--secondary-background-color)";
  }

  _labelActionColor(entry, intervals) {
    const stateObj = this._hass?.states?.[entry.entity];
    if (this._colorSource(entry) === "light") {
      const lightColor = this._lightColorForState(stateObj?.state, stateObj?.attributes || {});
      if (lightColor) return lightColor;
    }

    if (stateObj) {
      return this._colorForState(entry, stateObj.state, stateObj.attributes || {});
    }

    const current = intervals[intervals.length - 1];
    if (!current) return this._trackBackground(entry);

    return this._colorForState(entry, current.state, current.attributes || {});
  }

  _formatNumericState(entry, state) {
    const value = this._numericValueForColor(entry, state);
    if (!Number.isFinite(value)) return String(state);

    const decimals = this._decimals(entry);
    if (decimals !== undefined) return value.toFixed(decimals);
    return this._numericScale(entry) === 1 ? String(state) : String(value);
  }

  _rawLabelForState(entry, state) {
    return this._isNumericEntry(entry) ? String(state) : "";
  }

  _rawLabelForInterval(entry, interval) {
    return this._isNumericEntry(entry) ? String(interval.rawLabel ?? interval.state) : "";
  }

  _numericValueForColor(entry, state) {
    const raw = String(state ?? "").trim();
    if (!raw || ["unknown", "unavailable", "none", "null", "nan"].includes(raw.toLowerCase())) return NaN;

    const value = this._numericScaledValue(entry, state);
    if (!Number.isFinite(value)) return NaN;

    const decimals = this._decimals(entry);
    if (decimals === undefined) return value;

    const scale = 10 ** decimals;
    return Math.round(value * scale) / scale;
  }

  _decimals(entry) {
    const value = entry.decimals ?? this._config.decimals;
    if (value === undefined || value === null || value === "") return undefined;

    const decimals = Number(value);
    return Number.isFinite(decimals) ? Math.max(0, Math.min(10, Math.round(decimals))) : undefined;
  }

  _numericScale(entry) {
    const value = entry.scale ?? entry.factor ?? this._config.scale ?? this._config.factor;
    if (value === undefined || value === null || value === "") return 1;

    const scale = Number(value);
    return Number.isFinite(scale) ? scale : 1;
  }

  _numericScaledValue(entry, state) {
    const raw = String(state ?? "").trim();
    if (!raw || ["unknown", "unavailable", "none", "null", "nan"].includes(raw.toLowerCase())) return NaN;

    const value = Number(raw);
    return Number.isFinite(value) ? value * this._numericScale(entry) : NaN;
  }

  _hasColorStops(stops) {
    return this._colorStops(stops).length > 0;
  }

  _colorStops(stops) {
    const entries = Array.isArray(stops)
      ? stops.map((stop) => [stop.value, stop.color])
      : Object.entries(stops || {});

    return entries
      .map(([value, color]) => ({
        value: Number(value),
        color: String(color || "").trim(),
      }))
      .filter((stop) => Number.isFinite(stop.value) && stop.color)
      .sort((a, b) => a.value - b.value);
  }

  _interpolateColor(start, end, ratio) {
    const from = this._parseColor(start);
    const to = this._parseColor(end);
    if (!from || !to) return ratio < 0.5 ? start : end;

    const clamped = Math.min(1, Math.max(0, ratio));
    const channels = from.map((value, index) => Math.round(value + (to[index] - value) * clamped));
    return `rgb(${channels[0]} ${channels[1]} ${channels[2]})`;
  }

  _parseColor(color) {
    const value = String(color || "").trim();
    const named = BASIC_COLOR_NAMES[value.toLowerCase()];
    if (named) return named;

    const shortHex = value.match(/^#([0-9a-f]{3})$/i);
    if (shortHex) {
      return shortHex[1].split("").map((part) => parseInt(part + part, 16));
    }

    const hex = value.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      return [0, 2, 4].map((offset) => parseInt(hex[1].slice(offset, offset + 2), 16));
    }

    const rgb = value.match(/^rgb\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*\)$/i);
    if (rgb) {
      return rgb.slice(1).map((part) => Math.min(255, Math.max(0, Number(part))));
    }

    return undefined;
  }

  _textColorForBackground(color) {
    const rgb = this._parseColor(color);
    if (!rgb) {
      return {
        color: "var(--text-primary-color, #fff)",
        shadow: "0 1px 1px rgb(0 0 0 / 45%)",
      };
    }

    const [red, green, blue] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;

    if (luminance > 0.48) {
      return {
        color: "#111827",
        shadow: "0 1px 1px rgb(255 255 255 / 35%)",
      };
    }

    return {
      color: "#ffffff",
      shadow: "0 1px 1px rgb(0 0 0 / 45%)",
    };
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
        attributes: item.attributes || {},
        source: item.__source || "",
      }))
      .filter((item) => item.state !== undefined && Number.isFinite(item.changed))
      .sort((a, b) => a.changed - b.changed);

    const current = this._hass?.states?.[entry.entity];
    const fromRecorder = points.some((point) => point.source === "recorder");
    if (current && !fromRecorder) {
      const currentChanged = Date.parse(current.last_changed || current.last_updated);
      const lastPoint = points[points.length - 1];
      if (
        Number.isFinite(currentChanged) &&
        (!lastPoint || lastPoint.state !== current.state || lastPoint.changed !== currentChanged)
      ) {
        points.push({ state: current.state, changed: currentChanged, attributes: current.attributes || {} });
        points.sort((a, b) => a.changed - b.changed);
      } else if (lastPoint && lastPoint.state === current.state) {
        lastPoint.attributes = current.attributes || lastPoint.attributes || {};
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
        attributes: active.attributes || {},
        start: Math.max(startMs, active.changed),
        end: Math.min(endMs, point.changed),
      });
      active = point;
    }

    const currentAttributes =
      current && current.state === active.state ? current.attributes || active.attributes || {} : active.attributes || {};

    intervals.push({
      state: active.state,
      attributes: currentAttributes,
      start: Math.max(startMs, active.changed),
      end: endMs,
    });

    const visibleIntervals = intervals.filter((item) => item.end > item.start);
    const bucketedIntervals = this._bucketNumericIntervals(entry, visibleIntervals, startMs, endMs);
    return this._mergeIntervals(entry, bucketedIntervals);
  }

  _bucketNumericIntervals(entry, intervals, startMs, endMs) {
    const bucketMinutes = this._bucketMinutes(entry);
    if (!this._isNumericEntry(entry) || bucketMinutes <= 0 || intervals.length < 2) return intervals;

    const bucketMs = bucketMinutes * 60 * 1000;
    const buckets = [];
    let bucketStart = this._bucketStartMs(startMs, bucketMs);

    while (bucketStart < endMs) {
      const bucketEnd = Math.min(endMs, bucketStart + bucketMs);
      const bucket = this._numericBucketInterval(entry, intervals, Math.max(startMs, bucketStart), bucketEnd);
      if (bucket) buckets.push(bucket);
      bucketStart += bucketMs;
    }

    return buckets;
  }

  _numericBucketInterval(entry, intervals, start, end) {
    let weightedTotal = 0;
    let totalDuration = 0;
    let rawTotal = 0;
    let rawDuration = 0;
    let attributes = {};

    for (const interval of intervals) {
      if (interval.end <= start || interval.start >= end) continue;

      const overlapStart = Math.max(start, interval.start);
      const overlapEnd = Math.min(end, interval.end);
      const duration = overlapEnd - overlapStart;
      if (duration <= 0) continue;

      const value = this._numericScaledValue(entry, interval.state);
      if (Number.isFinite(value)) {
        weightedTotal += value * duration;
        totalDuration += duration;
        attributes = interval.attributes || attributes;
      }

      const rawValue = Number(String(interval.state ?? "").trim());
      if (Number.isFinite(rawValue)) {
        rawTotal += rawValue * duration;
        rawDuration += duration;
      }
    }

    if (totalDuration <= 0) return undefined;

    const scale = this._numericScale(entry);
    const state = String(scale === 0 ? weightedTotal / totalDuration : (weightedTotal / totalDuration) / scale);
    const rawLabel = rawDuration > 0 ? this._formatBucketRawValue(entry, rawTotal / rawDuration) : state;
    return {
      state,
      rawLabel,
      attributes,
      start,
      end,
    };
  }

  _bucketStartMs(value, bucketMs) {
    const date = new Date(value);
    date.setMinutes(0, 0, 0);
    const hourStart = date.getTime();
    const offset = Math.floor((value - hourStart) / bucketMs) * bucketMs;
    return hourStart + offset;
  }

  _bucketMinutes(entry) {
    const value = entry.bucket_minutes ?? this._config.bucket_minutes;
    if (value === undefined || value === null || value === "") return 0;

    const minutes = Number(value);
    return Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
  }

  _recorderEnabled(entry) {
    return (entry?.recorder ?? this._config?.recorder) === true;
  }

  _recorderPeriod(bucketMinutes) {
    if (bucketMinutes === 60) return "hour";
    if (bucketMinutes > 0 && bucketMinutes < 60 && bucketMinutes % 5 === 0) return "5minute";
    return "";
  }

  _formatBucketRawValue(entry, value) {
    if (!Number.isFinite(value)) return String(value);

    const decimals = this._decimals(entry);
    if (decimals !== undefined) return value.toFixed(decimals);

    return String(Math.round(value * 1000) / 1000);
  }

  _mergeIntervals(entry, intervals) {
    if (!this._isNumericEntry(entry) || intervals.length < 2) return intervals;

    const merged = [];
    for (const interval of intervals) {
      const previous = merged[merged.length - 1];
      if (previous && this._numericMergeKey(entry, previous.state) === this._numericMergeKey(entry, interval.state)) {
        previous.end = interval.end;
        previous.state = interval.state;
        previous.attributes = interval.attributes;
        continue;
      }

      merged.push({ ...interval });
    }

    return merged;
  }

  _numericMergeKey(entry, state) {
    const value = this._numericValueForColor(entry, state);
    return Number.isFinite(value) ? `value:${value}` : `raw:${String(state)}`;
  }

  _render() {
    if (!this._config) return;

    const renderStart = performance.now();
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
    this._renderedRows = new Map(rows.map((row) => [row.entry.entity, row]));
    const states = this._legendStates(rows);
    const legendPosition = this._legendPosition();
    const titlePosition = this._positionValue(this._config.title_position, "left");
    const titleSize = this._titleSize();
    const labelMode = this._labelMode();
    const axisTicks = labelMode === "on" ? this._axisTicks(startMs, endMs) : [];
    const showStateLabels = this._stateLabelsVisible();
    const layout = this._layoutMetrics();

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }

        ha-card {
          overflow: visible;
          position: relative;
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
          position: absolute;
          top: 8px;
          right: 12px;
          z-index: 2;
          max-width: calc(100% - 24px);
          box-sizing: border-box;
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          background: var(--mdc-theme-surface, var(--ha-card-background, var(--card-background-color)));
          color: var(--secondary-text-color);
          box-shadow: var(--ha-card-box-shadow, 0 3px 10px rgb(0 0 0 / 16%));
          font-size: 12px;
          line-height: 1.3;
          padding: 4px 8px;
          pointer-events: none;
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
          grid-template-columns: var(--entity-label-width) minmax(0, 1fr);
          gap: var(--entity-label-gap);
          align-items: center;
        }

        .name {
          appearance: none;
          color: var(--primary-text-color);
          font: inherit;
          font-size: 13px;
          line-height: 18px;
          overflow: hidden;
          border: 0;
          padding: 0;
          background: transparent;
          text-overflow: ellipsis;
          text-align: left;
          white-space: nowrap;
        }

        .name[data-action],
        .name[data-more-info] {
          cursor: pointer;
        }

        .name[data-action] {
          text-decoration: underline;
          text-decoration-color: var(--label-action-color, var(--secondary-text-color));
          text-underline-offset: 2px;
        }

        .name[data-action]:hover,
        .name[data-action]:focus-visible {
          color: var(--primary-color);
          outline: 0;
        }

        .name:focus {
          outline: 0;
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
            var(--track-background, var(--secondary-background-color));
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
          color: var(--segment-text-color, var(--text-primary-color, #fff));
          font-size: 11px;
          font-weight: 500;
          line-height: var(--state-history-row-height, 18px);
          text-overflow: ellipsis;
          text-shadow: var(--segment-text-shadow, 0 1px 1px rgb(0 0 0 / 45%));
          white-space: nowrap;
          pointer-events: none;
        }

        .segment-label[data-hidden="true"] {
          visibility: hidden;
        }

        .numeric-label {
          position: absolute;
          top: 0;
          bottom: 0;
          left: var(--label-left);
          width: var(--label-width);
          box-sizing: border-box;
          overflow: hidden;
          padding: 0 2px;
          color: var(--segment-text-color, var(--text-primary-color, #fff));
          font-size: 11px;
          font-weight: 500;
          line-height: var(--state-history-row-height, 18px);
          text-align: center;
          text-overflow: clip;
          text-shadow: var(--segment-text-shadow, 0 1px 1px rgb(0 0 0 / 45%));
          white-space: nowrap;
          pointer-events: none;
        }

        .tooltip {
          position: absolute;
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
          grid-template-columns: var(--entity-label-width) minmax(0, 1fr);
          gap: var(--entity-label-gap);
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
            gap: var(--entity-label-gap);
          }

          .name {
            font-size: 12px;
          }
        }
      </style>
      <ha-card style="--entity-label-width:${layout.labelWidth}px;--entity-label-gap:${layout.gap}px">
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
                      ({ entry, intervals }) => {
                        const labelAction = this._labelAction(entry);
                        const labelActionColor = this._labelActionColor(entry, intervals);
                        return `
                        <div class="row">
                          <button
                            class="name"
                            title="${this._escape(this._displayName(entry))}"
                            data-entity-id="${this._escapeAttr(entry.entity)}"
                            data-more-info-entity="${this._escapeAttr(this._moreInfoEntity(entry))}"
                            data-more-info="true"
                            ${labelAction ? `data-action="${this._escapeAttr(labelAction)}"` : ""}
                            style="--label-action-color:${this._escapeAttr(labelActionColor)}"
                            type="button"
                          >
                            ${this._escape(this._displayName(entry))}
                          </button>
                          ${this._trackHtml(entry, intervals, startMs, spanMs, showStateLabels)}
                        </div>
                      `;
                      }
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
    this._logBenchmark("render", {
      total_ms: performance.now() - renderStart,
      rows: rows.length,
      intervals: rows.reduce((total, row) => total + row.intervals.length, 0),
    });
  }

  _trackHtml(entry, intervals, startMs, spanMs, showStateLabels) {
    return this._isNumericEntry(entry)
      ? this._numericTrackHtml(entry, intervals, startMs, spanMs, showStateLabels)
      : this._discreteTrackHtml(entry, intervals, startMs, spanMs, showStateLabels);
  }

  _discreteTrackHtml(entry, intervals, startMs, spanMs, showStateLabels) {
    return `<div class="track" style="--track-background:${this._escapeAttr(this._trackBackground(entry))}">
      ${intervals
        .map((interval) => {
          const left = ((interval.start - startMs) / spanMs) * 100;
          const width = ((interval.end - interval.start) / spanMs) * 100;
          const color = this._colorForState(entry, interval.state, interval.attributes);
          const textColor = this._textColorForBackground(color);
          const label = this._labelForState(entry, interval.state);
          const rawLabel = this._rawLabelForInterval(entry, interval);
          return `<div
            class="segment"
            tabindex="0"
            data-state="${this._escapeAttr(label)}"
            data-raw-state="${this._escapeAttr(interval.state)}"
            data-raw-label="${this._escapeAttr(rawLabel)}"
            data-start-ms="${interval.start}"
            data-end-ms="${interval.end}"
            aria-label="${this._escapeAttr(
              `${label}, ${this._formatDateTime(interval.start)} to ${this._formatDateTime(interval.end)}, ${this._formatDuration(
                interval.end - interval.start
              )}`
            )}"
            style="left:${left}%;width:${width}%;--segment-color:${this._escapeAttr(
              color
            )};--segment-text-color:${this._escapeAttr(textColor.color)};--segment-text-shadow:${this._escapeAttr(textColor.shadow)}">
            ${showStateLabels ? `<span class="segment-label" data-hidden="true">${this._escape(label)}</span>` : ""}
          </div>`;
        })
        .join("")}
    </div>`;
  }

  _numericTrackHtml(entry, intervals, startMs, spanMs, showStateLabels) {
    const background = this._numericGradient(entry, intervals, startMs, spanMs);
    return `<div
      class="track"
      data-numeric="true"
      data-entity-id="${this._escapeAttr(entry.entity)}"
      data-start-ms="${startMs}"
      data-end-ms="${startMs + spanMs}"
      style="--track-background:${this._escapeAttr(this._trackBackground(entry))};background:${this._escapeAttr(background)}"
    >
      ${showStateLabels ? this._numericLabelsHtml(entry, intervals, startMs, spanMs) : ""}
    </div>`;
  }

  _numericGradient(entry, intervals, startMs, spanMs) {
    if (!intervals.length) return "var(--track-background)";

    const stops = intervals.flatMap((interval) => {
      const left = Math.max(0, Math.min(100, ((interval.start - startMs) / spanMs) * 100));
      const right = Math.max(left, Math.min(100, ((interval.end - startMs) / spanMs) * 100));
      const color = this._colorForState(entry, interval.state, interval.attributes);
      return [`${color} ${left}%`, `${color} ${right}%`];
    });

    return `repeating-linear-gradient(90deg, transparent 0, transparent calc(25% - 1px), var(--divider-color) calc(25% - 1px), var(--divider-color) 25%), linear-gradient(90deg, ${stops.join(", ")}), var(--track-background)`;
  }

  _numericLabelsHtml(entry, intervals, startMs, spanMs) {
    const widthPx = this._axisWidth || 320;
    return intervals
      .map((interval) => {
        const left = ((interval.start - startMs) / spanMs) * 100;
        const width = ((interval.end - interval.start) / spanMs) * 100;
        const label = this._labelForState(entry, interval.state);
        const availableWidth = (widthPx * width) / 100;
        if (availableWidth < Math.ceil(this._measureTextWidth(label, 11, 500)) + 4) return "";

        const color = this._colorForState(entry, interval.state, interval.attributes);
        const textColor = this._textColorForBackground(color);
        return `<span
          class="numeric-label"
          style="--label-left:${left}%;--label-width:${width}%;--segment-text-color:${this._escapeAttr(
            textColor.color
          )};--segment-text-shadow:${this._escapeAttr(textColor.shadow)}"
        >${this._escape(label)}</span>`;
      })
      .join("");
  }

  _legendPosition() {
    if (this._config.show_legend === false) return "off";

    const value = String(this._config.legend || "on").trim().toLowerCase();
    if (value === "off" || value === "false" || value === "none" || value === "hidden") return "off";
    return this._positionValue(value, "left");
  }

  _labelAction(entry) {
    const action = entry.label_action;
    if (action === false) return "";

    if (action === undefined || action === null || action === "") {
      const domain = entry.entity?.split(".")[0];
      return ["light", "switch", "fan", "input_boolean"].includes(domain) ? "toggle" : "";
    }

    const value = typeof action === "string" ? action : action.action;
    if (["off", "false", "none", "disabled"].includes(String(value || "").trim().toLowerCase())) return "";
    return String(value || "").trim().toLowerCase() === "toggle" ? "toggle" : "";
  }

  _moreInfoEntity(entry) {
    return entry.more_info_entity || entry.more_info || entry.entity;
  }

  async _performLabelAction(target) {
    const action = target.dataset.action;
    const entityId = target.dataset.entityId;
    if (!action) {
      this._showMoreInfo(target.dataset.moreInfoEntity || entityId);
      return;
    }

    if (!this._hass || action !== "toggle" || !entityId) return;

    try {
      await this._hass.callService("homeassistant", "toggle", { entity_id: entityId });
      this._render();
    } catch (err) {
      this._error = err?.message || String(err);
      this._render();
    }
  }

  _showMoreInfo(entityId) {
    if (!entityId) return;

    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      })
    );
  }

  _releaseLabelFocus(target) {
    if (typeof target?.blur === "function") target.blur();
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
      if (this._isNumericEntry(entry)) continue;

      for (const interval of intervals) {
        if (!seen.has(interval.state)) {
          seen.set(interval.state, {
            state: interval.state,
            label: this._labelForState(entry, interval.state),
            color: this._colorForState(entry, interval.state, interval.attributes),
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
    return this._layoutMetrics().axisWidth;
  }

  _layoutMetrics() {
    const cardWidth = this.getBoundingClientRect().width;
    if (!cardWidth) {
      return {
        axisWidth: 320,
        gap: 8,
        labelWidth: this._configuredLabelWidthPx(400) || 72,
      };
    }

    const compact = cardWidth <= 520;
    const contentPadding = compact ? 24 : 32;
    const gap = compact ? 6 : 8;
    const innerWidth = Math.max(0, cardWidth - contentPadding);
    const minLabelWidth = compact ? 68 : 72;
    const configuredLabelWidth = this._configuredLabelWidthPx(innerWidth);
    const autoLabelWidth = this._autoLabelWidthPx(innerWidth, minLabelWidth);
    const desiredLabelWidth = configuredLabelWidth || Math.min(240, autoLabelWidth);
    const maxLabelWidth = Math.max(minLabelWidth, innerWidth - gap - 120);
    const labelWidth = Math.round(Math.min(maxLabelWidth, Math.max(minLabelWidth, desiredLabelWidth)));

    return {
      axisWidth: Math.max(120, Math.round(innerWidth - labelWidth - gap)),
      gap,
      labelWidth,
    };
  }

  _configuredLabelWidthPx(innerWidth) {
    const value = this._config?.label_width;
    if (value === undefined || value === null || value === "" || String(value).trim().toLowerCase() === "auto") {
      return undefined;
    }

    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

    const text = String(value).trim();
    const number = Number(text);
    if (Number.isFinite(number)) return number;

    const match = text.match(/^(-?\d+(?:\.\d+)?)(px|%|rem|em)$/i);
    if (!match) return undefined;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return undefined;

    const unit = match[2].toLowerCase();
    if (unit === "px") return amount;
    if (unit === "%") return (innerWidth * amount) / 100;

    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return amount * rootFontSize;
  }

  _autoLabelWidthPx(innerWidth, minLabelWidth) {
    const labels = this._entityConfigs()
      .filter((entry) => entry.entity)
      .map((entry) => this._displayName(entry));
    if (!labels.length) return minLabelWidth;

    const measured = labels.reduce((width, label) => Math.max(width, this._measureTextWidth(label)), 0);
    const defaultWidth = Math.max(minLabelWidth, innerWidth * 0.18);
    return Math.max(defaultWidth, Math.ceil(measured + 4));
  }

  _measureTextWidth(value, fontSize = 13, fontWeight = 400) {
    if (!this._measureCanvas) this._measureCanvas = document.createElement("canvas");

    const context = this._measureCanvas.getContext("2d");
    if (!context) return String(value || "").length * 7;

    const style = getComputedStyle(this);
    context.font = `${fontWeight} ${fontSize}px ${style.fontFamily || "sans-serif"}`;
    return context.measureText(String(value || "")).width;
  }

  _scheduleLabelSync() {
    if (this._labelFrame) cancelAnimationFrame(this._labelFrame);
    this._labelFrame = requestAnimationFrame(() => {
      this._labelFrame = undefined;
      this._syncSegmentLabels();
      this._syncLabelActionColors();
    });
  }

  _syncLabelActionColors() {
    if (!this.shadowRoot) return;

    for (const button of this.shadowRoot.querySelectorAll(".name[data-entity-id]")) {
      const entry = this._entityConfigs().find((item) => item.entity === button.dataset.entityId);
      const stateObj = this._hass?.states?.[button.dataset.entityId];
      if (!entry || !stateObj) continue;

      const color =
        this._colorSource(entry) === "light"
          ? this._lightColorForState(stateObj.state, stateObj.attributes || {}) ||
            this._colorForState(entry, stateObj.state, stateObj.attributes || {})
          : this._colorForState(entry, stateObj.state, stateObj.attributes || {});
      button.style.setProperty("--label-action-color", color);
    }
  }

  _syncSegmentLabels() {
    const labels = this.shadowRoot.querySelectorAll(".segment-label");
    for (const label of labels) {
      const segment = label.closest(".segment");
      const availableWidth = Math.max(0, segment.clientWidth - 8);
      label.dataset.hidden = label.scrollWidth > availableWidth ? "true" : "false";
    }
  }

  _handleClick(event) {
    const target = event.target.closest?.(".name[data-more-info]");
    if (!target) return;

    event.stopPropagation();
    if (this._labelLongPressed) {
      this._labelLongPressed = false;
      this._releaseLabelFocus(target);
      return;
    }

    this._performLabelAction(target);
    this._releaseLabelFocus(target);
  }

  _handleKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;

    const target = event.target.closest?.(".name[data-more-info]");
    if (!target) return;

    event.preventDefault();
    if (event.key === "Enter") {
      this._performLabelAction(target);
    } else {
      this._showMoreInfo(target.dataset.moreInfoEntity || target.dataset.entityId);
    }
    this._releaseLabelFocus(target);
  }

  _handlePointerDown(event) {
    this._pendingTooltipTap = undefined;
    const label = event.target.closest?.(".name[data-more-info]");
    if (label) {
      this._startLabelPress(label);
      return;
    }

    const tooltipTarget = this._tooltipTarget(event.target);
    if (!tooltipTarget) {
      this._hideTooltip();
      return;
    }

    if (event.pointerType === "touch") {
      this._pendingTooltipTap = {
        target: tooltipTarget,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      return;
    }

    if (this._tooltipPinned && this._activeTooltipSegment === tooltipTarget) {
      this._hideTooltip();
      return;
    }

    this._tooltipPinned = true;
    document.addEventListener("pointerdown", this._handleDocumentPointerDown);
    window.addEventListener("scroll", this._handleWindowScroll, true);
    this._showTooltip(tooltipTarget, event.clientX, event.clientY);
  }

  _handlePointerUp(event) {
    this._clearLabelPress(!this._labelLongPressed);

    const pending = this._pendingTooltipTap;
    this._pendingTooltipTap = undefined;
    if (!pending || pending.pointerId !== event.pointerId) return;

    const moved = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
    const tooltipTarget = this._tooltipTarget(event.target);
    if (moved > 8 || tooltipTarget !== pending.target) {
      this._hideTooltip();
      return;
    }

    if (this._tooltipPinned && this._activeTooltipSegment === pending.target) {
      this._hideTooltip();
      return;
    }

    this._tooltipPinned = true;
    document.addEventListener("pointerdown", this._handleDocumentPointerDown);
    window.addEventListener("scroll", this._handleWindowScroll, true);
    this._showTooltip(pending.target, event.clientX, event.clientY);
  }

  _handlePointerCancel() {
    this._pendingTooltipTap = undefined;
    this._clearLabelPress(!this._labelLongPressed);
  }

  _startLabelPress(target) {
    this._clearLabelPress();
    this._labelLongPressed = false;
    this._labelPressTarget = target;
    this._labelPressTimer = setTimeout(() => {
      if (this._labelPressTarget !== target) return;

      this._labelLongPressed = true;
      this._showMoreInfo(target.dataset.moreInfoEntity || target.dataset.entityId);
      this._releaseLabelFocus(target);
      this._clearLabelPress(false);
      setTimeout(() => {
        this._labelLongPressed = false;
      }, 750);
    }, 550);
  }

  _clearLabelPress(resetLongPress = true) {
    if (this._labelPressTimer) clearTimeout(this._labelPressTimer);
    this._labelPressTimer = undefined;
    this._labelPressTarget = undefined;
    if (resetLongPress) this._labelLongPressed = false;
  }

  _handlePointerMove(event) {
    if (this._pendingTooltipTap && this._pendingTooltipTap.pointerId === event.pointerId) {
      const moved = Math.hypot(event.clientX - this._pendingTooltipTap.x, event.clientY - this._pendingTooltipTap.y);
      if (moved > 8) {
        this._pendingTooltipTap = undefined;
        this._hideTooltip();
      }
      return;
    }

    if (event.pointerType === "touch") return;
    if (this._tooltipPinned) return;

    const tooltipTarget = this._tooltipTarget(event.target);
    if (!tooltipTarget) {
      this._hideTooltip();
      return;
    }

    this._showTooltip(tooltipTarget, event.clientX, event.clientY);
  }

  _tooltipTarget(target) {
    return target.closest?.(".segment") || target.closest?.('.track[data-numeric="true"]');
  }

  _showTooltip(target, clientX, clientY) {
    const tooltip = this.shadowRoot.querySelector(".tooltip");
    if (!tooltip) return;

    const data = this._tooltipData(target, clientX);
    if (!data) {
      this._hideTooltip();
      return;
    }

    this._activeTooltipSegment = target;
    const rawRow = data.rawLabel
      ? `<div class="tooltip-row"><span>Raw</span><span>${this._escape(data.rawLabel)}</span></div>`
      : "";
    tooltip.innerHTML = `
      <div class="tooltip-state">${this._escape(data.state || "")}</div>
      ${rawRow}
      <div class="tooltip-row"><span>Start</span><span>${this._escape(this._formatDateTime(data.start))}</span></div>
      <div class="tooltip-row"><span>Stop</span><span>${this._escape(this._formatDateTime(data.end))}</span></div>
      <div class="tooltip-row"><span>Duration</span><span>${this._escape(this._formatDuration(data.end - data.start))}</span></div>
    `;
    tooltip.dataset.visible = "true";
    document.addEventListener("pointermove", this._handleDocumentPointerMove);

    const margin = 12;
    const offset = 14;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const rect = tooltip.getBoundingClientRect();
    let left = clientX + offset;
    let top = clientY + offset;

    if (left + rect.width + margin > viewportWidth) {
      left = clientX - rect.width - offset;
    }
    if (top + rect.height + margin > viewportHeight) {
      top = clientY - rect.height - offset;
    }

    left = Math.min(viewportWidth - rect.width - margin, Math.max(margin, left));
    top = Math.min(viewportHeight - rect.height - margin, Math.max(margin, top));

    const hostRect = this.getBoundingClientRect();
    const localLeft = left - hostRect.left;
    const localTop = top - hostRect.top;
    tooltip.style.left = `${localLeft}px`;
    tooltip.style.top = `${localTop}px`;
  }

  _tooltipData(target, clientX) {
    if (target.classList?.contains("segment")) {
      return {
        state: target.dataset.state || "",
        rawLabel: target.dataset.rawLabel || "",
        start: Number(target.dataset.startMs),
        end: Number(target.dataset.endMs),
      };
    }

    if (target.dataset?.numeric === "true") {
      const interval = this._numericIntervalAt(target, clientX);
      if (!interval) return undefined;

      const row = this._renderedRows.get(target.dataset.entityId);
      if (!row) return undefined;

      return {
        state: this._labelForState(row.entry, interval.state),
        rawLabel: this._rawLabelForInterval(row.entry, interval),
        start: interval.start,
        end: interval.end,
      };
    }

    return undefined;
  }

  _numericIntervalAt(track, clientX) {
    const row = this._renderedRows.get(track.dataset.entityId);
    if (!row?.intervals?.length) return undefined;

    const startMs = Number(track.dataset.startMs);
    const endMs = Number(track.dataset.endMs);
    const rect = track.getBoundingClientRect();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || rect.width <= 0) return undefined;

    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const time = startMs + ratio * (endMs - startMs);
    let low = 0;
    let high = row.intervals.length - 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const interval = row.intervals[middle];
      if (time < interval.start) {
        high = middle - 1;
      } else if (time > interval.end) {
        low = middle + 1;
      } else {
        return interval;
      }
    }

    return row.intervals[Math.min(row.intervals.length - 1, Math.max(0, low))];
  }

  _hideTooltip() {
    this._tooltipPinned = false;
    this._activeTooltipSegment = undefined;
    this._pendingTooltipTap = undefined;
    document.removeEventListener("pointerdown", this._handleDocumentPointerDown);
    document.removeEventListener("pointermove", this._handleDocumentPointerMove);
    window.removeEventListener("scroll", this._handleWindowScroll, true);
    const tooltip = this.shadowRoot.querySelector(".tooltip");
    if (tooltip) tooltip.dataset.visible = "false";
  }

  _logBenchmark(event, data = {}) {
    const label = this._config?.title || this._entityIds().slice(0, 3).join(",") || "untitled";
    const rounded = Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, typeof value === "number" ? Math.round(value * 10) / 10 : value])
    );
    console.log("[state-history-card]", event, label, rounded);
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
    this._colorStopDraft = [];
    this._labelDraft = [];
    this._configDebounce = undefined;
    this.shadowRoot.addEventListener("focusout", () => this._flushConfigChangeSoon());
  }

  setConfig(config) {
    this._config = { ...config };
    if (this._isEditorFieldFocused()) return;

    this._entityDraft = this._entityConfigs(config.entities || []);
    this._colorDraft = this._mapEntries(config.state_colors || config.colors || {});
    this._colorStopDraft = this._sortColorStopEntries(this._mapEntries(config.color_stops || {}));
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
    const colorStops = this._colorStopDraft;
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

        .map-row.stop-row {
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
            <label>
              Bucket minutes
              <input data-field="bucket_minutes" type="number" min="0" step="1" value="${this._escapeAttr(
                config.bucket_minutes ?? 0
              )}">
            </label>
            <label>
              Recorder statistics
              <select data-field="recorder">
                ${this._option("", "Off", config.recorder === true ? "on" : "")}
                ${this._option("on", "On", config.recorder === true ? "on" : "")}
              </select>
            </label>
            <label>
              Label width
              <input data-field="label_width" value="${this._escapeAttr(config.label_width || "")}" placeholder="Auto">
            </label>
            <label>
              Scale
              <input data-field="scale" type="number" step="any" value="${this._escapeAttr(config.scale ?? "")}" placeholder="1">
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
          <legend>Color stops</legend>
          <div class="stop-rows">
            ${colorStops.map(([key, value], index) => this._mapRow("stop", key, value, index)).join("")}
          </div>
          <button class="add" data-action="add-stop" type="button">Add stop</button>
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
      <div class="row map-row ${type === "color" ? "color-row" : ""} ${type === "stop" ? "stop-row" : ""}">
        <label>
          ${type === "stop" ? "Value" : "State"}
          <input data-map-type="${type}" data-map-index="${index}" data-map-field="key" value="${this._escapeAttr(
            key
          )}" placeholder="${type === "stop" ? "70" : "on|Home"}">
        </label>
        <label>
          ${type === "label" ? "Label" : "Color"}
          <input data-map-type="${type}" data-map-index="${index}" data-map-field="value" value="${this._escapeAttr(
            value
          )}" placeholder="${type === "label" ? "Home" : "#22c55e"}">
        </label>
        <button data-action="remove-${type}" data-index="${index}" type="button" aria-label="Remove ${type}">x</button>
        ${
          type === "color" || type === "stop"
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
    if (action === "add-stop") this._addMapEntry("stop");
    if (action === "remove-stop") this._removeMapEntry("stop", Number(button.dataset.index));
    if (action === "add-label") this._addMapEntry("label");
    if (action === "remove-label") this._removeMapEntry("label", Number(button.dataset.index));
  }

  _updateField(field, value, type, debounce = false) {
    const config = { ...this._config };

    if (field === "recorder") {
      if (value === "" || value === "off") delete config.recorder;
      else config.recorder = true;
    } else if (value === "" && field !== "title") {
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
    const configKey = this._mapConfigKey(type);
    const entries = this._mapDraft(type);
    entries[index] = entries[index] || ["", ""];
    entries[index][field === "key" ? 0 : 1] = value;
    this._updateColorPreview(type, index, entries[index][1]);
    this._configChanged({ ...this._config, [configKey]: this._entriesToMap(this._mapDraft(type)) }, false, debounce);
  }

  _addMapEntry(type) {
    this._mapDraft(type).push(["", ""]);
    this._render();
  }

  _removeMapEntry(type, index) {
    const configKey = this._mapConfigKey(type);
    const entries = this._mapDraft(type);
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
    const config = this._normalizedConfig(this._config);
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _normalizedConfig(config) {
    if (!config?.color_stops || typeof config.color_stops !== "object" || Array.isArray(config.color_stops)) {
      return config;
    }

    return {
      ...config,
      color_stops: this._entriesToMap(this._sortColorStopEntries(Object.entries(config.color_stops))),
    };
  }

  _updateColorPreview(type, index, value) {
    if (type !== "color" && type !== "stop") return;

    const row = this.shadowRoot.querySelector(`input[data-map-type="${type}"][data-map-index="${index}"]`)?.closest(".map-row");
    const preview = row?.querySelector(".color-preview");
    if (preview) preview.style.setProperty("--preview-color", value || "transparent");
  }

  _mapConfigKey(type) {
    if (type === "color") return "state_colors";
    if (type === "stop") return "color_stops";
    return "state_labels";
  }

  _mapDraft(type) {
    if (type === "color") return this._colorDraft;
    if (type === "stop") return this._colorStopDraft;
    return this._labelDraft;
  }

  _sortColorStopEntries(entries) {
    return [...entries].sort(([left], [right]) => {
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      const leftFinite = Number.isFinite(leftNumber);
      const rightFinite = Number.isFinite(rightNumber);

      if (leftFinite && rightFinite) return leftNumber - rightNumber;
      if (leftFinite) return -1;
      if (rightFinite) return 1;
      return String(left).localeCompare(String(right));
    });
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

const BASIC_COLOR_NAMES = {
  black: [0, 0, 0],
  blue: [0, 0, 255],
  cyan: [0, 255, 255],
  gray: [128, 128, 128],
  green: [0, 128, 0],
  grey: [128, 128, 128],
  lime: [0, 255, 0],
  magenta: [255, 0, 255],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  red: [255, 0, 0],
  white: [255, 255, 255],
  yellow: [255, 255, 0],
};

customElements.define("state-history-card-editor", StateHistoryCardEditor);
customElements.define("state-history-card", StateHistoryCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "state-history-card",
  name: "State History Card",
  preview: true,
  description: "History graph replacement with explicit colors per state value.",
  documentationURL: "https://github.com/stewartoallen/state-history-card",
});
