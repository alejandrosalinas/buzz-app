// Chart fences are untrusted message content, so the grammar is strict JSON:
// version 1 is a bounded bar/line/scatter plot and version 2 wraps an Apache
// ECharts option that is copied through an allowlist. Nothing in a chart is
// executed, fetched or parsed as HTML.
import { type Obj, record } from "./json";
import { harden, sanitizeOption } from "./sanitize";

export const MAX_BYTES = 60_000;
export const PALETTE_SIZE = 4;
export const OTHER = "Other";

type Row = Record<string, string | number>;
type XType = "nominal" | "quantitative" | "temporal";
export type Source = { name: string; url?: string; metric?: string };
export type PlotSpec = {
  version: 1;
  type: "bar" | "line" | "scatter";
  title: string;
  x: string;
  y: string;
  xType: XType;
  series?: string;
  data: Row[];
  source?: Source;
  note?: string;
};
export type OptionSpec = {
  version: 2;
  title: string;
  option: Obj;
  height?: number;
  source?: Source;
  note?: string;
};
export type ChartSpec = PlotSpec | OptionSpec;

const byteLength = (value: string) => new TextEncoder().encode(value).length;

function bounded(x: unknown, name: string, max = 120): string {
  if (typeof x !== "string" || !x.trim() || x.length > max)
    throw Error(`${name} must be nonempty text, at most ${max} characters`);
  return x;
}
function finite(x: unknown, name: string): number {
  if (typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 1e15)
    throw Error(`${name} must be a finite number within ±1e15`);
  return x;
}

/** Date-only values are UTC; date-times must carry an explicit zone. */
export function temporalX(value: unknown): number {
  const match =
    typeof value === "string" &&
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(
      value,
    );
  if (!match)
    throw Error(
      "Temporal x requires ISO dates or date-times with seconds and an explicit timezone",
    );
  const [, year, month, day, hour, minute, second, , zone] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) ||
    (hour !== undefined &&
      (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) ||
    (zone &&
      zone !== "Z" &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  )
    throw Error("Temporal x contains an invalid calendar date or time");
  const timestamp = Date.parse(value as string);
  if (!Number.isFinite(timestamp))
    throw Error("Temporal x contains an invalid date");
  return timestamp;
}

function validateSource(input: unknown): Source | undefined {
  if (input === undefined) return undefined;
  if (!record(input)) throw Error("source must be an object with a name");
  const source: Source = { name: bounded(input.name, "source name", 200) };
  if (input.url !== undefined) {
    const url = bounded(input.url, "source URL", 2000);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw Error("Source URL must be HTTPS");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      throw Error("Source URL must be HTTPS");
    source.url = parsed.href;
  }
  if (input.metric !== undefined)
    source.metric = bounded(input.metric, "source metric", 200);
  return source;
}

function finish<T extends ChartSpec>(result: T, input: Obj): T {
  const source = validateSource(input.source);
  if (source) result.source = source;
  if (input.note !== undefined) result.note = bounded(input.note, "note", 1200);
  if (byteLength(JSON.stringify(result)) > MAX_BYTES)
    throw Error("Chart exceeds 60KB; reduce the data");
  return result;
}

function validatePlot(input: Obj): PlotSpec {
  if (input.type !== "bar" && input.type !== "line" && input.type !== "scatter")
    throw Error("Choose bar, line or scatter");
  const type = input.type;
  const title = bounded(input.title, "title");
  const x = bounded(input.x, "x field", 80);
  const y = bounded(input.y, "y field", 80);
  if (x === y) throw Error("Choose different x and y fields");
  const xType = (input.xType ??
    (type === "bar" ? "nominal" : "quantitative")) as XType;
  if (
    type === "bar"
      ? xType !== "nominal"
      : !["quantitative", "temporal"].includes(xType)
  )
    throw Error(
      "Bars need nominal x; line/scatter need quantitative or temporal x",
    );
  const max = type === "bar" ? 40 : 200;
  if (
    !Array.isArray(input.data) ||
    input.data.length < 1 ||
    input.data.length > max
  )
    throw Error(`Supply 1–${max} rows; aggregate or limit your query`);
  const series =
    input.series === undefined
      ? undefined
      : bounded(input.series, "series field", 80);
  if (series === x || series === y)
    throw Error("Series must differ from x and y");
  const groups = new Set<string>();
  const seen = new Set<string>();
  const data = input.data.map((row: unknown): Row => {
    if (!record(row) || !Object.hasOwn(row, x) || !Object.hasOwn(row, y))
      throw Error("Every row must contain the x and y fields");
    let value = row[x];
    if (xType === "nominal") {
      if (typeof value === "number") value = String(finite(value, "x"));
      bounded(value, "x value", 200);
    } else if (xType === "temporal") temporalX(value);
    else finite(value, "x");
    const group = series
      ? bounded(String(row[series] ?? ""), "series value", 80)
      : "";
    groups.add(group);
    if (groups.size > 12) throw Error("Use at most 12 series");
    const key = JSON.stringify([
      group,
      xType === "temporal" ? Date.parse(value as string) : value,
    ]);
    if (type !== "scatter" && seen.has(key))
      throw Error("Duplicate x values: aggregate first, or use scatter");
    seen.add(key);
    return {
      [x]: value as string | number,
      [y]: finite(row[y], "y"),
      ...(series ? { [series]: group } : {}),
    };
  });
  const result: PlotSpec = { version: 1, type, title, x, y, xType, data };
  if (series) result.series = series;
  return finish(result, input);
}

function validateOption(input: Obj): OptionSpec {
  const fallbackTitle =
    record(input.option) && record(input.option.title)
      ? input.option.title.text
      : undefined;
  const result: OptionSpec = {
    version: 2,
    title: bounded(input.title ?? fallbackTitle, "title"),
    option: sanitizeOption(input.option),
  };
  if (input.height !== undefined) {
    if (
      !Number.isInteger(input.height) ||
      (input.height as number) < 160 ||
      (input.height as number) > 900
    )
      throw Error("height must be a whole number of pixels from 160 to 900");
    result.height = input.height as number;
  }
  return finish(result, input);
}

export function validateChart(input: unknown): ChartSpec {
  if (!record(input) || (input.version !== 1 && input.version !== 2))
    throw Error("Use buzz-chart version 1 or 2");
  return input.version === 2 ? validateOption(input) : validatePlot(input);
}
export function parseChart(code: string): ChartSpec {
  if (byteLength(code) > MAX_BYTES) throw Error("Chart exceeds 60KB");
  return validateChart(JSON.parse(code));
}

// Series past the palette share the last role as "Other". Bars and lines sum
// the folded series at each x; scatter points keep their own values.
function foldSeries(spec: PlotSpec): Row[] {
  const { series, x, y, xType } = spec;
  if (!series) return spec.data;
  const names = [...new Set(spec.data.map((r) => r[series]))];
  if (names.length <= PALETTE_SIZE) return spec.data;
  const kept = new Set(names.slice(0, PALETTE_SIZE - 1));
  let other = OTHER;
  for (let n = 2; kept.has(other); n++) other = `${OTHER} ${n}`;
  if (spec.type === "scatter")
    return spec.data.map((r) =>
      kept.has(r[series] as string) ? r : { ...r, [series]: other },
    );
  const sums = new Map<string | number, Row>();
  const rows: Row[] = [];
  for (const r of spec.data) {
    if (kept.has(r[series] as string)) {
      rows.push(r);
      continue;
    }
    const key =
      xType === "temporal"
        ? Date.parse(r[x] as string)
        : (r[x] as string | number);
    const sum = sums.get(key);
    if (sum) sum[y] = (sum[y] as number) + (r[y] as number);
    else {
      const row = { ...r, [series]: other };
      sums.set(key, row);
      rows.push(row);
    }
  }
  return rows;
}

export function plotOption(spec: PlotSpec): Obj {
  const rows = foldSeries(spec);
  const groups = spec.series
    ? [...new Set(rows.map((r) => r[spec.series as string] as string))]
    : [""];
  const inGroup = (group: string) => (row: Row) =>
    !spec.series || row[spec.series] === group;
  const legend = spec.series ? { legend: { type: "scroll", top: 0 } } : {};
  const top = spec.series ? 36 : 16;
  if (spec.type === "bar") {
    const categories = [...new Set(rows.map((r) => r[spec.x]))];
    return harden({
      ...legend,
      grid: { top, left: 8, right: 56, bottom: 36, containLabel: true },
      yAxis: {
        type: "category",
        data: categories,
        inverse: true,
        axisLabel: { width: 160, overflow: "truncate" },
      },
      // Padding on both ends keeps value labels inside the grid, clear of category labels.
      xAxis: {
        type: "value",
        name: spec.y,
        nameLocation: "middle",
        nameGap: 28,
        boundaryGap: ["12%", "12%"],
      },
      series: groups.map((group) => ({
        type: "bar",
        name: spec.series ? group : spec.y,
        data: categories.map((c) => {
          const row = rows.find((r) => r[spec.x] === c && inGroup(group)(r));
          // Labels sit past the end of each bar, on whichever side of zero it extends.
          return row
            ? {
                value: row[spec.y],
                label: {
                  position: (row[spec.y] as number) < 0 ? "left" : "right",
                },
              }
            : null;
        }),
        label: { show: groups.length === 1 },
      })),
    });
  }
  const temporal = spec.xType === "temporal";
  return harden({
    ...legend,
    useUTC: true,
    grid: { top: top + 16, left: 8, right: 24, bottom: 40, containLabel: true },
    xAxis: {
      type: temporal ? "time" : "value",
      scale: !temporal,
      name: spec.x,
      nameLocation: "middle",
      nameGap: 28,
    },
    yAxis: { type: "value", name: spec.y },
    series: groups.map((group) => {
      const points = rows
        .filter(inGroup(group))
        .map(
          (r) =>
            [
              temporal ? temporalX(r[spec.x]) : (r[spec.x] as number),
              r[spec.y] as number,
            ] as const,
        );
      if (spec.type === "line") points.sort((a, b) => a[0] - b[0]);
      return {
        type: spec.type,
        name: spec.series ? group : spec.y,
        data: points,
        showSymbol: true,
        symbolSize: spec.type === "scatter" ? 9 : 6,
      };
    }),
  });
}
export const chartOption = (spec: ChartSpec): Obj =>
  spec.version === 2 ? spec.option : plotOption(spec);
export function chartHeight(spec: ChartSpec): number {
  if (spec.version === 2) return spec.height ?? 360;
  if (spec.type !== "bar") return 320;
  return Math.max(
    190,
    new Set(spec.data.map((r) => r[spec.x])).size * 30 +
      (spec.series ? 110 : 70),
  );
}
