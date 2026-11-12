import { type Obj, list, record } from "./json";

export const SERIES_TYPES =
  "bar line scatter pie heatmap funnel gauge boxplot candlestick sankey treemap radar".split(
    " ",
  );
const OPTION_KEYS = new Set(
  "legend grid xAxis yAxis polar radiusAxis angleAxis radar dataZoom visualMap tooltip axisPointer dataset series color backgroundColor textStyle useUTC animation animationDuration animationEasing animationDelay animationDurationUpdate animationThreshold aria stateAnimation blendMode".split(
    " ",
  ),
);
// Prototype keys; components that draw arbitrary content or open UI (graphic,
// toolbox, brush, timeline/media option swaps); links; images; HTML tooltip
// escape hatches.
const DROPPED_KEYS = new Set([
  ...["__proto__", "constructor", "prototype"],
  ...["graphic", "toolbox", "brush", "timeline", "media", "baseOption"],
  ...["options", "geo", "map", "renderItem", "dataView"],
  ...["link", "sublink", "image"],
  ...["extraCssText", "className", "appendTo", "appendToBody"],
  ...["renderMode", "enterable"],
  // CSS font shorthand (written raw into SVG style) and dataset filter regexes (ReDoS).
  ...["font", "reg"],
  // zrender SVG pattern elements, built verbatim into the DOM.
  ...["svgElement", "svgWidth", "svgHeight"],
  // Custom decals build one SVG node per dash cell for every distinct decal
  // object. Only aria.decal.show, which uses ECharts' built-in cached
  // patterns, is kept; see sanitizeOption.
  ...["decal", "decals"],
]);
const MAX_DEPTH = 64;
// zrender writes colors, font properties and cursor straight into SVG
// attributes and CSS, and turns pattern objects ({image} or {svgElement})
// under color keys into raw SVG. So every key containing "color" accepts only
// a color string or a linear/radial gradient; the other style keys must match
// a strict grammar. Anything else is dropped.
const STYLE_VALUES: Record<string, RegExp> = {
  fontStyle: /^(normal|italic|oblique)$/,
  fontWeight: /^(normal|bold|bolder|lighter|[1-9]00)$/,
  fontSize: /^\d{1,3}(\.\d{1,3})?(px|em|rem)?$/,
  fontFamily: /^[\w ,'".-]{1,200}$/,
  cursor:
    /^(auto|default|pointer|crosshair|move|text|grab|grabbing|help|not-allowed|zoom-in|zoom-out|ew-resize|ns-resize)$/,
};
// Linear-time color grammar: hex, a color keyword, or rgb()/hsl() with 3–4 plain numbers.
function colorString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const t = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(t) || /^[a-z]{3,24}$/i.test(t)) return t;
  const m = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(t);
  if (!m) return undefined;
  const parts = (m[2] ?? "").split(/[\s,/]+/).filter(Boolean);
  return parts.length >= 3 &&
    parts.length <= 4 &&
    parts.every((p) =>
      /^-?(\d{1,4}(\.\d{1,6})?|\.\d{1,6})(e-?\d{1,2})?(%|deg)?$/i.test(p),
    )
    ? t
    : undefined;
}
const finiteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
function cleanColor(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw Error("Chart option is nested too deeply");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumber(value) ? value : undefined;
  if (typeof value === "string") return colorString(value);
  if (Array.isArray(value))
    return value
      .slice(0, 256)
      .map((item) => cleanColor(item, depth + 1) ?? null);
  if (
    record(value) &&
    (value.type === "linear" || value.type === "radial") &&
    Array.isArray(value.colorStops)
  ) {
    const out: Obj = { type: value.type };
    for (const k of ["x", "y", "x2", "y2", "r"])
      if (finiteNumber(value[k])) out[k] = value[k];
    if (typeof value.global === "boolean") out.global = value.global;
    out.colorStops = value.colorStops
      .slice(0, 32)
      .filter(record)
      .map((stop) => ({
        offset: finiteNumber(stop.offset)
          ? Math.min(1, Math.max(0, stop.offset))
          : 0,
        color: colorString(stop.color),
      }))
      .filter((stop) => stop.color);
    return out;
  }
  return undefined;
}
// Defense in depth for any sink not covered above: decode CSS escapes, then
// drop strings that would reference a resource. Ordinary backslashes
// (C:\data) are kept.
const CSS_FUNCTION = /(url|image-set|src|cross-fade|expression)\(/;
function cssReference(value: string): boolean {
  const decoded = value
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/\\(.)/gs, "$1")
    .replace(/\s+/g, "")
    .toLowerCase();
  return CSS_FUNCTION.test(decoded);
}
// Counts that multiply drawn elements or layout work; ECharts does not bound them.
const COUNT_LIMITS: Record<string, number> = {
  splitNumber: 50,
  layoutIterations: 64,
};
const ARRAY_LIMITS: Record<string, number> = {
  grid: 12,
  xAxis: 12,
  yAxis: 12,
  polar: 12,
  radiusAxis: 12,
  angleAxis: 12,
  radar: 12,
  dataset: 12,
  visualMap: 8,
  dataZoom: 8,
  legend: 4,
};
// Strings under icon and symbol keys reach zrender's SVG path parser, which
// loops forever on a "z" command followed by a number, and createIcon parses
// any string, with or without "path://". Only built-in symbol names and plain
// path data with argument-free z are kept. Matches symbol, itemSymbol, icon,
// handleIcon and pageIcons, not symbolSize, symbolOffset or showSymbol.
const ICON_KEY = /^(?!show)\w*(symbol|icons?)$/i;
const BUILTIN_SYMBOLS = new Set(
  "circle rect roundRect triangle diamond pin arrow none line emptyCircle emptyRect emptyRoundRect emptyTriangle emptyDiamond emptyPin emptyArrow".split(
    " ",
  ),
);
const safePath = (data: string) =>
  data.length <= 8192 &&
  /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]*$/.test(data) &&
  !/[zZ][eE+\-.,\s]*\d/.test(data);
function cleanIcon(value: string): string | undefined {
  if (BUILTIN_SYMBOLS.has(value)) return value;
  const m = /^path:\/\/(.*)$/s.exec(value);
  return m && safePath(m[1] ?? "") ? value : undefined;
}
function cleanString(
  value: string,
  key: string,
  icon: boolean,
): string | undefined {
  if (icon) return cleanIcon(value);
  if (/^\s*path:\/\//i.test(value)) return cleanIcon(value.trim());
  if (cssReference(value)) return undefined;
  if (/^\s*image:\/\//i.test(value)) return undefined;
  const style = STYLE_VALUES[key];
  if (Object.hasOwn(STYLE_VALUES, key) && style && !style.test(value.trim()))
    return undefined;
  return value;
}
function clean(
  value: unknown,
  key: string,
  depth: number,
  icon = false,
): unknown {
  if (depth > MAX_DEPTH) throw Error("Chart option is nested too deeply");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw Error("Chart option numbers must be finite");
    const limit = COUNT_LIMITS[key];
    return limit === undefined ? value : Math.max(0, Math.min(limit, value));
  }
  if (typeof value === "string") return cleanString(value, key, icon);
  if (Array.isArray(value))
    return value.map((item) => clean(item, key, depth + 1, icon) ?? null);
  if (record(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROPPED_KEYS.has(k)) continue;
      const c = /color/i.test(k)
        ? cleanColor(v, depth + 1)
        : clean(v, k, depth + 1, icon || ICON_KEY.test(k));
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}
// dataset.source rows are data, not configuration: keep every field name
// except prototype keys.
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function cleanData(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw Error("Chart option is nested too deeply");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return cssReference(value) ? undefined : value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw Error("Chart option numbers must be finite");
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => cleanData(item, depth + 1) ?? null);
  if (record(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (PROTO_KEYS.has(k)) continue;
      const c = cleanData(v, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}
function cleanDataset(dataset: unknown): unknown {
  if (!record(dataset)) return clean(dataset, "dataset", 2);
  const { source, ...config } = dataset;
  const out = clean(config, "dataset", 2) as Obj;
  if (source !== undefined) out.source = cleanData(source, 3);
  return out;
}
const AXIS_SERIES = ["bar", "line", "candlestick", "boxplot"];
// Applied to every option we render, including converted version 1 charts.
export function harden(option: Obj): Obj {
  const series = list(option.series).filter(record);
  const axisTrigger =
    series.length > 0 &&
    series.every((s) => AXIS_SERIES.includes(s.type as string)) &&
    (option.xAxis !== undefined || option.yAxis !== undefined);
  const first = list(option.tooltip)[0];
  const tooltip = record(first)
    ? first
    : { trigger: axisTrigger ? "axis" : "item" };
  return {
    ...option,
    // richText tooltips are drawn by the chart renderer as text, never as HTML.
    tooltip: { ...tooltip, renderMode: "richText", confine: true },
    aria: { ...(record(option.aria) ? option.aria : {}), enabled: true },
  };
}
export function sanitizeOption(input: unknown): Obj {
  if (!record(input)) throw Error("option must be an ECharts option object");
  const out: Obj = {};
  for (const k of Object.keys(input)) {
    if (!OPTION_KEYS.has(k)) continue;
    const c =
      k === "dataset"
        ? Array.isArray(input.dataset)
          ? input.dataset.map(cleanDataset)
          : cleanDataset(input.dataset)
        : /color/i.test(k)
          ? cleanColor(input[k], 1)
          : clean(input[k], k, 1);
    if (c !== undefined) out[k] = c;
  }
  const aria = list(input.aria)[0];
  if (record(aria) && record(aria.decal) && aria.decal.show === true)
    out.aria = {
      ...(record(out.aria) ? out.aria : {}),
      decal: { show: true },
    };
  for (const [k, max] of Object.entries(ARRAY_LIMITS)) {
    const value = out[k];
    if (Array.isArray(value) && value.length > max)
      throw Error(`Use at most ${max} ${k} entries`);
  }
  // Wheel and drag zoom inside the plot would capture scrolling of the conversation.
  if (out.dataZoom !== undefined) {
    const zooms = list(out.dataZoom).filter(
      (z) => record(z) && z.type !== "inside",
    );
    if (zooms.length) out.dataZoom = zooms;
    else delete out.dataZoom;
  }
  const series = list(out.series);
  if (series.length < 1) throw Error("option.series needs at least one series");
  if (series.length > 50) throw Error("Use at most 50 series");
  for (const s of series) {
    if (!record(s)) throw Error("Each series must be an object");
    if (!SERIES_TYPES.includes(s.type as string))
      throw Error(
        `Unsupported series type ${JSON.stringify(s.type ?? null)}; use one of ${SERIES_TYPES.join(", ")}`,
      );
  }
  out.series = series;
  return harden(out);
}
