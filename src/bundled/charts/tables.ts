import { type Obj, list, record } from "./json";
import type { ChartSpec } from "./spec";

// Plain-text tables of the plotted values for the data disclosure. Budgets
// keep a small message from expanding into an unbounded table (for example
// one new key per row).
export const TABLE_LIMITS = { columns: 50, rows: 2000, cells: 20_000 };
export type Table = {
  caption: string;
  columns: string[];
  rows: string[][];
  omitted: number;
};
type RawTable = Omit<Table, "omitted">;
const cell = (v: unknown): string =>
  v === null || v === undefined
    ? ""
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);
const pad = (rows: string[][], width: number) =>
  rows.map((r) => [...r, ...Array(Math.max(0, width - r.length)).fill("")]);
function datasetTable(dataset: Obj, caption: string): RawTable {
  const source = dataset.source as unknown[];
  if (record(source[0])) {
    const columns: string[] = [];
    for (const r of source)
      if (record(r))
        for (const k of Object.keys(r))
          if (!columns.includes(k) && columns.length < TABLE_LIMITS.columns)
            columns.push(k);
    return {
      caption,
      columns,
      rows: source.map((r) =>
        columns.map((c) => cell(record(r) ? r[c] : undefined)),
      ),
    };
  }
  // ECharts: sourceHeader true/false/N rows; otherwise a first row of strings is the header.
  const headerRows =
    typeof dataset.sourceHeader === "number"
      ? Math.max(0, Math.floor(dataset.sourceHeader))
      : dataset.sourceHeader === true
        ? 1
        : dataset.sourceHeader === false
          ? 0
          : Array.isArray(source[0]) &&
              source[0].every((v) => typeof v === "string")
            ? 1
            : 0;
  const rows = source.map((r) =>
    list(r).slice(0, TABLE_LIMITS.columns).map(cell),
  );
  const width = Math.max(0, ...rows.map((r) => r.length));
  return {
    caption,
    columns: headerRows
      ? (pad([rows[headerRows - 1] ?? []], width)[0] ?? [])
      : Array.from({ length: width }, (_, i) => `Column ${i + 1}`),
    rows: pad(rows.slice(headerRows), width),
  };
}
function treemapRows(
  nodes: unknown,
  path: string[] = [],
  out: string[][] = [],
) {
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (out.length >= TABLE_LIMITS.rows) break;
    if (!record(n)) continue;
    const here = [...path, cell(n.name)];
    out.push([here.join(" / "), cell(n.value)]);
    treemapRows(n.children, here, out);
  }
  return out;
}
// Category labels for a series come from the axes it is plotted on.
function seriesLabels(option: Obj, s: Obj): string[] | null {
  const pick = (axes: unknown, index: unknown) => {
    const a = list(axes)[Number.isInteger(index) ? (index as number) : 0];
    return record(a) && Array.isArray(a.data) ? a : undefined;
  };
  const axis =
    pick(option.xAxis, s.xAxisIndex) ?? pick(option.yAxis, s.yAxisIndex);
  return axis
    ? (axis.data as unknown[]).map((d) => cell(record(d) ? d.value : d))
    : null;
}
function seriesTable(option: Obj, s: Obj, i: number): RawTable {
  const count = list(option.series).length;
  const caption = cell(s.name ?? (count > 1 ? `Series ${i + 1}` : ""));
  if (s.type === "sankey")
    return {
      caption,
      columns: ["Source", "Target", "Value"],
      rows: list(s.links ?? s.edges)
        .filter(record)
        .map((l) => [cell(l.source), cell(l.target), cell(l.value)]),
    };
  if (s.type === "treemap")
    return { caption, columns: ["Name", "Value"], rows: treemapRows(s.data) };
  const labels = seriesLabels(option, s);
  const rows = (Array.isArray(s.data) ? s.data : []).map(
    (d: unknown, j: number) => {
      const value = record(d) ? d.value : d;
      const label =
        record(d) && d.name !== undefined
          ? cell(d.name)
          : (labels?.[j] ?? String(j + 1));
      return [
        label,
        ...(Array.isArray(value)
          ? value.slice(0, TABLE_LIMITS.columns - 1).map(cell)
          : [cell(value)]),
      ];
    },
  );
  const radar = option.radar;
  const indicator =
    s.type === "radar" && record(radar) && Array.isArray(radar.indicator)
      ? radar.indicator
          .slice(0, TABLE_LIMITS.columns - 1)
          .map((x: unknown) => cell(record(x) ? x.name : x))
      : null;
  const width = Math.max(2, ...rows.map((r) => r.length));
  const columns = indicator
    ? ["Name", ...indicator]
    : [
        "Label",
        ...(width > 2
          ? Array.from({ length: width - 1 }, (_, k) => `Value ${k + 1}`)
          : ["Value"]),
      ];
  return { caption, columns, rows: pad(rows, columns.length) };
}
// Truncate to the row and cell budgets, recording how many rows were left out.
function budget(tables: RawTable[]): Table[] {
  let rows = 0;
  let cells = 0;
  return tables
    .map((t) => {
      const width = Math.max(1, t.columns.length);
      const room = Math.max(
        0,
        Math.min(
          TABLE_LIMITS.rows - rows,
          Math.floor((TABLE_LIMITS.cells - cells) / width),
        ),
      );
      const kept = t.rows.slice(0, room);
      rows += kept.length;
      cells += kept.length * width;
      return { ...t, rows: kept, omitted: t.rows.length - kept.length };
    })
    .filter((t) => t.rows.length || t.omitted);
}
export function chartTables(spec: ChartSpec): Table[] {
  if (spec.version === 1) {
    const { series, x, y } = spec;
    return budget([
      {
        caption: "",
        columns: [...(series ? [series] : []), x, y],
        rows: spec.data.map((r) => [
          ...(series ? [String(r[series])] : []),
          String(r[x]),
          String(r[y]),
        ]),
      },
    ]);
  }
  const option = spec.option;
  const series = list(option.series).filter(record);
  const datasets = list(option.dataset).filter(
    (d): d is Obj =>
      record(d) && Array.isArray(d.source) && d.source.length > 0,
  );
  return budget([
    ...datasets.map((d, i) =>
      datasetTable(d, datasets.length > 1 ? `Dataset ${i + 1}` : ""),
    ),
    // Series with their own data plot alongside any dataset, so list them too.
    ...series
      .map((s, i) => [s, i] as const)
      .filter(
        ([s]) =>
          !datasets.length || Array.isArray(s.data) || s.type === "sankey",
      )
      .map(([s, i]) => seriesTable(option, s, i))
      .filter((t) => t.rows.length),
  ]);
}
