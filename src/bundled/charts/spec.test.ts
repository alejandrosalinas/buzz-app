import { describe, expect, it } from "vitest";
import {
  type ChartSpec,
  chartHeight,
  type OptionSpec,
  type PlotSpec,
  parseChart,
  plotOption,
  validateChart,
} from "./spec";
import { chartTables, TABLE_LIMITS } from "./tables";

type Json = Record<string, unknown>;
const plot = (input: Json) => validateChart(input) as PlotSpec;
const config = (input: Json) => validateChart(input) as OptionSpec;
const bar = (spec: ChartSpec) =>
  plotOption(spec as PlotSpec) as Json & {
    yAxis: { data: unknown[]; type: string };
    xAxis: { type: string };
    series: { data: { value: number; label: { position: string } }[] }[];
    tooltip: { renderMode: string; trigger: string };
    aria: { enabled: boolean };
  };

const base = {
  source: { name: "Test fixture" },
  version: 1,
  type: "bar",
  title: "Topic counts",
  x: "topic",
  y: "messages",
  data: [
    { topic: "Access", messages: 4 },
    { topic: "Planning", messages: -2 },
  ],
};
const echart = {
  version: 2,
  title: "Products",
  source: { name: "Test fixture" },
  option: {
    xAxis: { type: "category", data: ["A", "B"] },
    yAxis: { type: "value" },
    series: [{ type: "bar", name: "2026", data: [1, 2] }],
  },
};
const option = (o: Json) =>
  config({ ...echart, option: { xAxis: {}, yAxis: {}, ...o } }).option as Json;

describe("version 1 grammar", () => {
  it("rejects malformed or misleading chart inputs", () => {
    const changes: Json[] = [
      { version: 3 },
      { type: "vega" },
      { data: [] },
      { data: [{ topic: "x", messages: null }] },
      { data: [{ topic: "x", messages: "3" }] },
      { data: [{ topic: "x", messages: Number.POSITIVE_INFINITY }] },
      { data: [{ topic: "x", messages: 1e30 }] },
      {
        data: [
          { topic: "x", messages: 1 },
          { topic: "x", messages: 2 },
        ],
      },
      { x: "messages" },
      {
        data: Array.from({ length: 41 }, (_, i) => ({
          topic: String(i),
          messages: i,
        })),
      },
      { type: "line", xType: "nominal" },
      { title: "x".repeat(121) },
    ];
    for (const change of changes)
      expect(() => validateChart({ ...base, ...change })).toThrow();
    expect(() => parseChart("{bad json")).toThrow();
    expect(() => parseChart(" ".repeat(60_001))).toThrow();
  });

  it("projects only known fields and keeps labels as text", () => {
    const spec = plot({
      ...base,
      data: [{ topic: "<img src=x onerror=alert(1)>```", messages: 1 }],
      url: "https://example.com",
      expression: "alert(1)",
    });
    expect(spec).not.toHaveProperty("url");
    expect(spec).not.toHaveProperty("expression");
    expect(parseChart(JSON.stringify(spec))).toEqual(spec);
    expect(spec.data[0]?.topic).toBe("<img src=x onerror=alert(1)>```");
  });

  it("bars include negative values, label each side of zero and keep row order", () => {
    const spec = validateChart(base);
    const drawn = bar(spec);
    expect(drawn.yAxis.data).toEqual(["Access", "Planning"]);
    expect(drawn.yAxis.type).toBe("category");
    expect(drawn.xAxis.type).toBe("value");
    expect(
      drawn.series[0]?.data.map((d) => [d.value, d.label.position]),
    ).toEqual([
      [4, "right"],
      [-2, "left"],
    ]);
    expect(drawn.tooltip.renderMode).toBe("richText");
    expect(drawn.aria.enabled).toBe(true);
    expect(chartHeight(spec)).toBeGreaterThanOrEqual(190);
  });

  it("sorts lines by time in UTC and lets scatter repeat x", () => {
    const line = {
      source: base.source,
      version: 1,
      type: "line",
      title: "Trend",
      x: "day",
      y: "count",
      xType: "temporal",
      data: [
        { day: "2026-11-03", count: 4 },
        { day: "2026-11-01", count: 2 },
      ],
    };
    const drawn = plotOption(plot(line)) as Json & {
      xAxis: { type: string };
      series: { data: number[][] }[];
    };
    expect(drawn.xAxis.type).toBe("time");
    expect(drawn.useUTC).toBe(true);
    expect(drawn.series[0]?.data).toEqual([
      [Date.UTC(2026, 10, 1), 2],
      [Date.UTC(2026, 10, 3), 4],
    ]);
    expect(() =>
      validateChart({ ...line, data: [{ day: "not-a-date", count: 2 }] }),
    ).toThrow();
    const scatter = plotOption(
      plot({
        ...line,
        type: "scatter",
        xType: "quantitative",
        data: [
          { day: 1, count: 2 },
          { day: 1, count: 2 },
        ],
      }),
    ) as Json & { series: { data: unknown[] }[]; tooltip: { trigger: string } };
    expect(scatter.series[0]?.data).toHaveLength(2);
    expect(scatter.tooltip.trigger).toBe("item");
  });

  it("allows repeated x across series but not within one", () => {
    const spec = {
      source: base.source,
      version: 1,
      type: "line",
      title: "Volume",
      x: "quarter",
      y: "volume",
      series: "year",
      data: [
        { quarter: 1, volume: 30, year: "2021" },
        { quarter: 1, volume: 61, year: "2026" },
      ],
    };
    expect(plot(spec).data[1]?.year).toBe("2026");
    expect(() =>
      validateChart({ ...spec, data: [...spec.data, spec.data[0]] }),
    ).toThrow(/Duplicate/);
    expect(() => validateChart({ ...spec, series: "quarter" })).toThrow(
      /differ/,
    );
    expect(() =>
      validateChart({ ...spec, data: [{ quarter: 1, volume: 30 }] }),
    ).toThrow(/series value/);
  });

  it("rejects impossible calendars and viewer-local times", () => {
    const temporal = (value: string) =>
      plot({
        ...base,
        type: "line",
        xType: "temporal",
        data: [{ topic: value, messages: 1 }],
      });
    for (const value of [
      "2026-02-30",
      "2025-02-29",
      "2026-04-31",
      "2026-00-01",
      "2026-11-03T00:00:00",
      "2026-11-03T24:00:00Z",
      "2026-11-03T09:60:00Z",
      "2026-11-03T09:00:00+24:00",
      "2026-02-30T00:00:00Z",
    ])
      expect(() => temporal(value), value).toThrow(/Temporal/);
    for (const value of [
      "2024-02-29",
      "0099-01-01",
      "2026-11-03T09:00:00Z",
      "2026-11-03T09:00:00.123-08:00",
    ])
      expect(temporal(value).data[0]?.topic).toBe(value);
    expect(() =>
      validateChart({
        ...base,
        type: "line",
        xType: "temporal",
        data: [
          { topic: "2026-11-03", messages: 1 },
          { topic: "2026-11-02T16:00:00-08:00", messages: 2 },
        ],
      }),
    ).toThrow(/Duplicate/);
  });

  it("lists series, x and y as text rows", () => {
    const spec = validateChart({
      version: 1,
      type: "line",
      title: "Volume",
      x: "quarter",
      y: "volume",
      series: "year",
      data: [
        { quarter: 1, volume: 30, year: "2021" },
        { quarter: 1, volume: 61, year: "2026" },
      ],
    });
    expect(chartTables(spec)).toEqual([
      {
        caption: "",
        columns: ["year", "quarter", "volume"],
        rows: [
          ["2021", "1", "30"],
          ["2026", "1", "61"],
        ],
        omitted: 0,
      },
    ]);
  });
});

describe("source attribution", () => {
  it("is optional, and a present source needs a name and an https URL", () => {
    expect(plot({ ...base, source: undefined })).not.toHaveProperty("source");
    expect(config({ ...echart, source: undefined })).not.toHaveProperty(
      "source",
    );
    for (const source of [
      {},
      { name: " " },
      "text",
      { name: "X", url: "javascript:alert(1)" },
      { name: "X", url: "http://example.com" },
      { name: "X", url: "https://user:pass@example.com" },
      { name: "X", url: "not a url" },
    ])
      expect(() => validateChart({ ...base, source })).toThrow();
    expect(
      plot({
        ...base,
        source: {
          name: "X",
          url: "https://example.com/a",
          metric: "m",
          certification: "certified",
        },
      }).source,
    ).toEqual({ name: "X", url: "https://example.com/a", metric: "m" });
  });
});

describe("series colors", () => {
  const rows = (names: string[]) =>
    names.flatMap((name, i) => [
      { x: 1, y: i + 1, s: name },
      { x: 2, y: 10 * (i + 1), s: name },
    ]);
  const spec = (type: string, names: string[]) => ({
    version: 1,
    type,
    title: "Fold",
    x: "x",
    y: "y",
    series: "s",
    data: rows(names),
  });
  const series = (type: string, names: string[]) =>
    (plotOption(plot(spec(type, names))) as { series: Json[] }).series;

  it("keeps up to four series distinct", () => {
    expect(series("line", ["a", "b", "c", "d"]).map((s) => s.name)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("folds series past the third into Other, summing bars and lines per x", () => {
    const names = ["a", "b", "c", "d", "e"];
    const lines = series("line", names);
    expect(lines.map((s) => s.name)).toEqual(["a", "b", "c", "Other"]);
    expect(lines[3]?.data).toEqual([
      [1, 4 + 5],
      [2, 40 + 50],
    ]);
    const bars = series("bar", names);
    expect(bars.map((s) => s.name)).toEqual(["a", "b", "c", "Other"]);
    expect(bars[3]?.data).toEqual([
      { value: 9, label: { position: "right" } },
      { value: 90, label: { position: "right" } },
    ]);
  });

  it("keeps the folded bucket distinct from an input series named Other", () => {
    const names = ["Other", "b", "c", "d", "e"];
    const bars = series("bar", names);
    expect(bars.map((s) => s.name)).toEqual(["Other", "b", "c", "Other 2"]);
    expect(bars[0]?.data).toEqual([
      { value: 1, label: { position: "right" } },
      { value: 10, label: { position: "right" } },
    ]);
    expect(bars[3]?.data).toEqual([
      { value: 9, label: { position: "right" } },
      { value: 90, label: { position: "right" } },
    ]);
    const lines = series("line", names);
    expect(lines.map((s) => s.name)).toEqual(["Other", "b", "c", "Other 2"]);
    expect(lines[0]?.data).toEqual([
      [1, 1],
      [2, 10],
    ]);
  });

  it("relabels scatter points without summing them", () => {
    const scatter = series("scatter", ["a", "b", "c", "d", "e"]);
    expect(scatter.map((s) => s.name)).toEqual(["a", "b", "c", "Other"]);
    expect(scatter[3]?.data).toEqual([
      [1, 4],
      [2, 40],
      [1, 5],
      [2, 50],
    ]);
  });

  it("leaves the plotted table with every original row", () => {
    const [table] = chartTables(plot(spec("line", ["a", "b", "c", "d", "e"])));
    expect(table?.rows).toHaveLength(10);
  });
});

describe("version 2 options", () => {
  it("keeps ECharts options and rejects unsupported or non-JSON values", () => {
    const spec = config(echart);
    expect(spec.option.series).toEqual(echart.option.series);
    expect((spec.option.tooltip as Json).trigger).toBe("axis");
    expect(parseChart(JSON.stringify(spec))).toEqual(spec);
    for (const bad of [
      undefined,
      [],
      {},
      { series: [] },
      { series: [{ type: "custom" }] },
      { series: [{ type: "map" }] },
      { series: [{ data: [1] }] },
      { series: ["bar"] },
      { series: Array.from({ length: 51 }, () => ({ type: "line" })) },
    ])
      expect(() => validateChart({ ...echart, option: bad })).toThrow();
    expect(() =>
      parseChart(JSON.stringify(echart).replace("[1,2]", "[1,1e999]")),
    ).toThrow(/finite/);
    expect(
      config({
        ...echart,
        option: {
          ...echart.option,
          color: ["url(https://example.com/x.svg#a)"],
        },
      }).option.color,
    ).toEqual([null]);
    expect(() => validateChart({ ...echart, height: 5000 })).toThrow(/height/);
    let deep: Json = { type: "bar" };
    for (let i = 0; i < 70; i++) deep = { nested: deep };
    expect(() =>
      validateChart({
        ...echart,
        option: { series: [{ type: "bar", extra: deep }] },
      }),
    ).toThrow(/deeply/);
    expect(
      config({
        ...echart,
        title: undefined,
        option: { ...echart.option, title: { text: "From option" } },
      }).title,
    ).toBe("From option");
  });

  it("strips links, images, graphics, HTML tooltips and prototype keys", () => {
    const hostile = JSON.stringify({
      ...echart,
      option: {
        ...echart.option,
        title: { text: "t", link: "javascript:alert(1)" },
        graphic: [
          { type: "image", style: { image: "https://example.com/a.png" } },
        ],
        toolbox: { feature: { saveAsImage: {} } },
        tooltip: {
          formatter: "<img src=x onerror=alert(1)>",
          renderMode: "html",
          extraCssText: "background:red",
          appendTo: "body",
          className: "x",
        },
        backgroundColor: {
          image: "https://example.com/bg.png",
          repeat: "repeat",
        },
        textStyle: {
          fontFamily: "x;background:red",
          rich: {
            a: { backgroundColor: { image: "https://example.com/r.png" } },
          },
        },
        series: [
          {
            type: "scatter",
            symbol: "image://https://example.com/s.png",
            data: [[1, 2]],
          },
        ],
        media: [{ option: { graphic: [] } }],
      },
    }).replace('"series"', '"__proto__":{"polluted":true},"series"');
    const drawn = (parseChart(hostile) as OptionSpec).option as Json & {
      tooltip: Json;
      series: Json[];
    };
    expect(JSON.stringify(drawn)).not.toMatch(
      /example\.com|javascript:|extraCssText|appendTo|className|graphic|toolbox|media|polluted|background:red/,
    );
    expect(drawn.title).toBeUndefined();
    expect(drawn.tooltip.renderMode).toBe("richText");
    expect(drawn.tooltip.confine).toBe(true);
    expect(drawn.tooltip.formatter).toBe("<img src=x onerror=alert(1)>");
    expect(drawn.series[0]?.symbol).toBeUndefined();
    expect(({} as Json).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(drawn)).toBe(Object.prototype);
  });

  it("keeps dataset field names that are option keys elsewhere", () => {
    const spec = config({
      ...echart,
      option: {
        dataset: {
          source: [{ topic: "A", options: 12, link: "x", image: "y" }],
        },
        xAxis: { type: "category" },
        yAxis: {},
        series: [{ type: "bar", encode: { x: "topic", y: "options" } }],
      },
    });
    expect((spec.option.dataset as Json).source).toEqual([
      { topic: "A", options: 12, link: "x", image: "y" },
    ]);
    const hostile = parseChart(
      '{"version":2,"title":"t","source":{"name":"x"},"option":{"dataset":{"source":[{"__proto__":{"polluted":1},"a":1}],"link":"javascript:1"},"series":[{"type":"pie"}]}}',
    ) as OptionSpec;
    expect(hostile.option.dataset).toEqual({ source: [{ a: 1 }] });
    expect(({} as Json).polluted).toBeUndefined();
    expect(() =>
      parseChart(
        '{"version":2,"title":"t","option":{"dataset":{"source":[[1e999]]},"series":[{"type":"pie"}]}}',
      ),
    ).toThrow(/finite/);
  });

  it("holds style strings to strict grammars and drops CSS resource references", () => {
    const [style] = option({
      xAxis: { type: "category", data: ["a"] },
      series: [
        {
          type: "bar",
          data: [1],
          cursor: "pointer;background:red",
          itemStyle: {
            color: "red;filter:blur(1px)",
            borderColor: "#abcdef",
            shadowColor: "rgba(0, 0, 0, 0.5)",
          },
          label: {
            show: true,
            fontWeight: "bold;mask-image:none",
            fontStyle: "italic",
            fontSize: "12px;x",
            fontFamily: "Inter, sans-serif",
            font: "12px x",
          },
        },
      ],
    }).series as { cursor: unknown; itemStyle: Json; label: Json }[];
    expect(style?.cursor).toBeUndefined();
    expect(style?.itemStyle.color).toBeUndefined();
    expect(style?.itemStyle.borderColor).toBe("#abcdef");
    expect(style?.itemStyle.shadowColor).toBe("rgba(0, 0, 0, 0.5)");
    expect(style?.label).toEqual({
      show: true,
      fontStyle: "italic",
      fontFamily: "Inter, sans-serif",
    });
    expect(
      option({
        color: [
          "#123",
          "steelblue",
          "x;y",
          {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "hsl(10, 50%, 50%)" },
              { offset: 1, color: "red)" },
            ],
          },
        ],
        series: [{ type: "bar", data: [1] }],
      }).color,
    ).toEqual([
      "#123",
      "steelblue",
      null,
      {
        type: "linear",
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [{ offset: 0, color: "hsl(10, 50%, 50%)" }],
      },
    ]);
    for (const bad of [
      "u\\72 l(https://e.example/a.svg#a)",
      "\\u\\r\\l(https://e.example/a)",
      'image-set("https://e.example/a.png" 1x)',
      'src("https://e.example/a")',
      "URL(x)",
      "red;x",
    ])
      for (const key of [
        "color",
        "color0",
        "borderColor0",
        "borderColorDoji",
        "backgroundColor",
      ]) {
        const [candle] = option({
          series: [
            {
              type: "candlestick",
              data: [[1, 2, 0, 3]],
              itemStyle: { [key]: bad },
            },
          ],
        }).series as { itemStyle: Json }[];
        expect(candle?.itemStyle[key], `${key}: ${bad}`).toBeUndefined();
      }
    const text = config({
      ...echart,
      option: {
        dataset: {
          source: [
            ["k", "v"],
            ["C:\\data", 1],
            ["\\u\\r\\l(x)", 2],
          ],
        },
        series: [{ type: "pie", label: { formatter: "{b} in C:\\temp" } }],
      },
    }).option as Json & { dataset: Json; series: { label: Json }[] };
    expect(text.dataset.source).toEqual([
      ["k", "v"],
      ["C:\\data", 1],
      [null, 2],
    ]);
    expect(text.series[0]?.label.formatter).toBe("{b} in C:\\temp");
  });

  it("drops pattern fills: color keys take only colors and linear or radial gradients", () => {
    const pattern = {
      svgElement: {
        tag: "image",
        attrs: { href: "data:,x", onerror: "alert(1)" },
      },
      svgWidth: 10,
      svgHeight: 10,
    };
    const script = {
      svgElement: { tag: "script", attrs: { href: "https://e.example/x.js" } },
      svgWidth: 1,
      svgHeight: 1,
    };
    const o = option({
      backgroundColor: pattern,
      color: [script, "red"],
      xAxis: { type: "category", data: ["a"] },
      series: [
        {
          type: "bar",
          data: [{ value: 1, itemStyle: { color: pattern } }],
          itemStyle: {
            color: { image: "https://e.example/a.png", repeat: "repeat" },
            borderColor: { type: "pattern", ...pattern },
          },
          label: {
            show: true,
            rich: {
              a: { backgroundColor: { image: "https://e.example/a.png" } },
            },
          },
          extra: pattern,
        },
      ],
    }) as Json & { series: Json[] };
    expect(o.backgroundColor).toBeUndefined();
    expect(o.color).toEqual([null, "red"]);
    const s = o.series[0] as {
      data: { itemStyle: Json }[];
      itemStyle: Json;
      label: { rich: { a: Json } };
      extra: Json;
    };
    expect(s.data[0]?.itemStyle.color).toBeUndefined();
    expect(s.itemStyle).toEqual({});
    expect(s.label.rich.a).toEqual({});
    expect(s.extra).toEqual({});
    expect(JSON.stringify(o)).not.toMatch(
      /svgElement|onerror|e\.example|script/,
    );
    const gradient = (
      option({
        series: [
          {
            type: "pie",
            data: [1],
            itemStyle: {
              color: {
                type: "radial",
                x: 0.5,
                y: 0.5,
                r: 0.5,
                global: false,
                onload: "x",
                colorStops: [{ offset: 2, color: "#fff", extra: 1 }],
              },
            },
          },
        ],
      }).series as { itemStyle: Json }[]
    )[0]?.itemStyle.color;
    expect(gradient).toEqual({
      type: "radial",
      x: 0.5,
      y: 0.5,
      r: 0.5,
      global: false,
      colorStops: [{ offset: 1, color: "#fff" }],
    });
  });

  it("parses colors in linear time and caps component arrays", () => {
    const started = performance.now();
    for (const color of [
      `rgb(${" ".repeat(400)}1${" ".repeat(400)}2${" ".repeat(400)}x)`,
      `rgb(1${" ,".repeat(5000)})`,
      `#${"a".repeat(10_000)}`,
    ])
      option({ series: [{ type: "pie", data: [1], itemStyle: { color } }] });
    expect(performance.now() - started).toBeLessThan(200);
    expect(() =>
      option({
        radar: Array.from({ length: 13 }, () => ({ indicator: [] })),
        series: [{ type: "radar", data: [] }],
      }),
    ).toThrow(/at most 12 radar/);
    expect(() =>
      option({
        grid: Array.from({ length: 13 }, () => ({})),
        series: [{ type: "line", data: [] }],
      }),
    ).toThrow(/at most 12 grid/);
    expect(
      option({
        color: ["rgba(0,0,0,.5)", "hsla(120,100%,50%,.3)", "rgb(1e2,0,0)"],
        series: [{ type: "line", data: [] }],
      }).color,
    ).toEqual(["rgba(0,0,0,.5)", "hsla(120,100%,50%,.3)", "rgb(1e2,0,0)"]);
  });

  it("clamps counts that multiply drawn elements and refuses regex filters and inside zoom", () => {
    const [gauge] = option({
      series: [
        {
          type: "gauge",
          splitNumber: 1e6,
          axisTick: { splitNumber: 1e6 },
          data: [{ value: 1 }],
        },
      ],
    }).series as { splitNumber: number; axisTick: { splitNumber: number } }[];
    expect(gauge?.splitNumber).toBe(50);
    expect(gauge?.axisTick.splitNumber).toBe(50);
    expect(
      (
        option({
          series: [
            {
              type: "sankey",
              layoutIterations: 1e9,
              data: [{ name: "a" }, { name: "b" }],
              links: [{ source: "a", target: "b", value: 1 }],
            },
          ],
        }).series as { layoutIterations: number }[]
      )[0]?.layoutIterations,
    ).toBe(64);
    expect(
      (
        option({
          visualMap: {
            type: "piecewise",
            min: 0,
            max: 1e9,
            splitNumber: 20_000,
          },
          series: [{ type: "scatter", data: [[1, 2]] }],
        }).visualMap as { splitNumber: number }
      ).splitNumber,
    ).toBe(50);
    const filtered = option({
      dataset: [
        {
          source: [
            ["k", "v"],
            ["a", 1],
          ],
        },
        {
          transform: {
            type: "filter",
            config: { dimension: "k", reg: "^(a+)+$" },
          },
        },
      ],
      xAxis: { type: "category" },
      series: [{ type: "bar", datasetIndex: 1 }],
    }).dataset as unknown[];
    expect(filtered[1]).toEqual({
      transform: { type: "filter", config: { dimension: "k" } },
    });
    const line = [{ type: "line", data: [[1, 2]] }];
    expect(
      option({
        dataZoom: [{ type: "inside" }, { type: "slider" }],
        series: line,
      }).dataZoom,
    ).toEqual([{ type: "slider" }]);
    expect(
      option({ dataZoom: { type: "inside" }, series: line }).dataZoom,
    ).toBeUndefined();
  });

  it("drops custom decals and keeps built-in aria decals", () => {
    const decal = {
      symbol: "rect",
      symbolSize: 1,
      dashArrayX: [[1, 1]],
      dashArrayY: [1, 1],
      maxTileWidth: 1e6,
    };
    const o = option({
      aria: {
        label: { enabled: true },
        decal: { show: true, decals: [decal] },
      },
      xAxis: { type: "category", data: ["a"] },
      series: [
        {
          type: "bar",
          decal,
          itemStyle: { decal },
          data: [{ value: 1, itemStyle: { decal } }],
        },
      ],
    }) as Json & {
      series: { data: unknown[]; itemStyle: Json; decal: unknown }[];
    };
    expect(o.aria).toEqual({
      label: { enabled: true },
      decal: { show: true },
      enabled: true,
    });
    expect(o.series[0]?.itemStyle).toEqual({});
    expect(o.series[0]?.data[0]).toEqual({ value: 1, itemStyle: {} });
    expect(o.series[0]?.decal).toBeUndefined();
    expect(
      (
        option({
          aria: { decal: { show: "yes" } },
          series: [{ type: "pie", data: [1] }],
        }).aria as { decal?: unknown }
      ).decal,
    ).toBeUndefined();
  });

  it("keeps icon and symbol strings away from the path parser", () => {
    for (const bad of [
      "path://Z1",
      "path://m0 0z1",
      "path://M0 0L1 1z 1",
      "path://M0 0Ze5",
      "path://M0 0z,-.5",
      "Z1",
      "Z;x:1",
      "path://<script>",
    ])
      for (const o of [
        {
          series: [
            {
              type: "scatter",
              data: [[1, 2]],
              symbol: bad,
              markPoint: { symbol: bad, data: [{ type: "max" }] },
            },
          ],
          legend: { icon: bad, pageIcons: { horizontal: [bad, bad] } },
          dataZoom: [{ type: "slider", handleIcon: bad, moveHandleIcon: bad }],
          visualMap: { type: "piecewise", inRange: { symbol: [bad] } },
        },
        {
          xAxis: { axisPointer: { handle: { show: true, icon: bad } } },
          series: [{ type: "line", data: [[1, 2]] }],
        },
      ])
        expect(JSON.stringify(option(o)), bad).not.toMatch(
          /[zZ][\s,]*[-.\de]|script/,
        );
    const ok = option({
      legend: { icon: "roundRect" },
      series: [
        {
          type: "scatter",
          data: [[1, 2]],
          symbol: "path://M0,0L10,0L10,10Z",
          symbolOffset: ["50%", 0],
          showAllSymbol: "auto",
          markLine: { symbol: ["none", "arrow"], data: [{ yAxis: 1 }] },
        },
        {
          type: "line",
          data: [[1, 2]],
          symbol: "emptyCircle",
          label: { show: true, formatter: "Zone 1" },
        },
      ],
    }) as Json & { legend: Json; series: Json[] & { label: Json }[] };
    expect(ok.legend.icon).toBe("roundRect");
    const [first, second] = ok.series as unknown as {
      symbol: string;
      symbolOffset: unknown;
      showAllSymbol: string;
      markLine: { symbol: string[] };
      label: Json;
    }[];
    expect(first?.symbol).toBe("path://M0,0L10,0L10,10Z");
    expect(first?.symbolOffset).toEqual(["50%", 0]);
    expect(first?.showAllSymbol).toBe("auto");
    expect(first?.markLine.symbol).toEqual(["none", "arrow"]);
    expect(second?.label.formatter).toBe("Zone 1");
  });
});

describe("data tables", () => {
  const table = (o: Json) => chartTables(config({ ...echart, option: o }));

  it("cover datasets, category series, pies, sankey and treemaps", () => {
    expect(chartTables(validateChart(echart))).toEqual([
      {
        caption: "2026",
        columns: ["Label", "Value"],
        rows: [
          ["A", "1"],
          ["B", "2"],
        ],
        omitted: 0,
      },
    ]);
    expect(
      table({
        dataset: {
          source: [
            ["product", "2025", "2026"],
            ["A", 1, 2],
            ["B", 3, 4],
          ],
        },
        xAxis: { type: "category" },
        yAxis: {},
        series: [{ type: "bar" }, { type: "bar" }],
      }),
    ).toEqual([
      {
        caption: "",
        columns: ["product", "2025", "2026"],
        rows: [
          ["A", "1", "2"],
          ["B", "3", "4"],
        ],
        omitted: 0,
      },
    ]);
    expect(
      table({
        dataset: {
          source: [
            { p: "A", v: 1 },
            { p: "B", v: 2, w: 3 },
          ],
        },
        series: [{ type: "pie" }],
      })[0]?.columns,
    ).toEqual(["p", "v", "w"]);
    expect(
      table({
        series: [
          {
            type: "pie",
            data: [
              { name: "A", value: 3 },
              { name: "B", value: 4 },
            ],
          },
        ],
      })[0]?.rows,
    ).toEqual([
      ["A", "3"],
      ["B", "4"],
    ]);
    expect(
      table({
        series: [
          {
            type: "sankey",
            data: [{ name: "a" }, { name: "b" }],
            links: [{ source: "a", target: "b", value: 5 }],
          },
        ],
      })[0]?.rows,
    ).toEqual([["a", "b", "5"]]);
    expect(
      table({
        series: [
          {
            type: "treemap",
            data: [
              { name: "a", value: 5, children: [{ name: "b", value: 2 }] },
            ],
          },
        ],
      })[0]?.rows,
    ).toEqual([
      ["a", "5"],
      ["a / b", "2"],
    ]);
  });

  it("stay within row, column and cell budgets", () => {
    const [wide] = table({
      dataset: {
        source: Array.from({ length: 2000 }, (_, i) => ({ [`k${i}`]: i })),
      },
      series: [{ type: "pie" }],
    });
    expect(wide?.columns).toHaveLength(TABLE_LIMITS.columns);
    expect(
      (wide?.rows.length ?? 0) * (wide?.columns.length ?? 0),
    ).toBeLessThanOrEqual(TABLE_LIMITS.cells);
    expect(wide?.omitted).toBeGreaterThan(0);
    const [long] = table({
      xAxis: { type: "category" },
      series: [
        { type: "line", data: Array.from({ length: 5000 }, (_, i) => i % 10) },
      ],
    });
    expect(long?.rows).toHaveLength(TABLE_LIMITS.rows);
    expect(long?.omitted).toBe(3000);
  });

  it("use each series' own axes beside datasets, and honor explicit headers", () => {
    expect(
      table({
        xAxis: [
          { type: "category", data: ["Jan", "Feb"] },
          { type: "category", data: ["Mar", "Apr"] },
        ],
        yAxis: {},
        series: [
          { type: "bar", name: "a", data: [1, 2] },
          { type: "bar", name: "b", xAxisIndex: 1, data: [3, 4] },
        ],
      }).map((t) => t.rows),
    ).toEqual([
      [
        ["Jan", "1"],
        ["Feb", "2"],
      ],
      [
        ["Mar", "3"],
        ["Apr", "4"],
      ],
    ]);
    expect(
      table({
        dataset: {
          source: [
            ["p", "v"],
            ["A", 1],
          ],
        },
        xAxis: { type: "category" },
        yAxis: {},
        series: [{ type: "bar" }, { type: "line", name: "Target", data: [5] }],
      }).map((t) => t.caption),
    ).toEqual(["", "Target"]);
    expect(
      table({
        dataset: {
          sourceHeader: true,
          source: [
            ["team", 2025, 2026],
            ["A", 1, 2],
          ],
        },
        xAxis: { type: "category" },
        yAxis: {},
        series: [{ type: "bar" }, { type: "bar" }],
      })[0],
    ).toEqual({
      caption: "",
      columns: ["team", "2025", "2026"],
      rows: [["A", "1", "2"]],
      omitted: 0,
    });
    const [headerless] = table({
      dataset: {
        sourceHeader: false,
        source: [
          ["a", "b"],
          ["c", "d"],
        ],
      },
      series: [{ type: "pie" }],
    });
    expect(headerless?.columns).toEqual(["Column 1", "Column 2"]);
    expect(headerless?.rows).toHaveLength(2);
  });
});
