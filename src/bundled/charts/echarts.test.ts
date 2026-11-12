import { describe, expect, it } from "vitest";
import { echarts } from "./echarts";
import { chartOption, validateChart } from "./spec";

// Server-side SVG rendering with the same tree-shaken build the plugin ships.
function render(spec: Record<string, unknown>, colors?: string[]) {
  const chart = echarts.init(null, colors ? { color: colors } : null, {
    renderer: "svg",
    ssr: true,
    width: 640,
    height: 360,
  });
  chart.setOption({
    ...chartOption(validateChart(spec)),
    animation: false,
  } as Parameters<typeof chart.setOption>[0]);
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg;
}
const source = { name: "Test fixture" };
const chart = (option: Record<string, unknown>) => ({
  version: 2,
  title: "t",
  source,
  option,
});

describe("rendering through the tree-shaken build", () => {
  it("draws version 1 charts", () => {
    const bars = render({
      version: 1,
      type: "bar",
      title: "Bars",
      x: "topic",
      y: "n",
      source,
      data: [
        { topic: "Access", n: 4 },
        { topic: "Planning", n: -2 },
      ],
    });
    expect(bars).toMatch(/Access/);
    expect(bars).toMatch(/Planning/);
    expect(bars).toMatch(/-2/);
    const lines = render({
      version: 1,
      type: "line",
      title: "Lines",
      x: "q",
      y: "volume",
      series: "year",
      source,
      data: [
        { q: 1, volume: 30, year: "2021" },
        { q: 2, volume: 39, year: "2021" },
        { q: 1, volume: 61, year: "2026" },
      ],
    });
    expect(lines).toMatch(/>2021</);
    expect(lines).toMatch(/>2026</);
    expect(
      render({
        version: 1,
        type: "line",
        title: "Wide",
        x: "x",
        y: "y",
        source,
        data: [
          { x: 1_000_000, y: 1 },
          { x: 1_000_001, y: 2 },
        ],
      }),
    ).not.toMatch(/1\.00e\+6/);
  });

  it("draws every registered series type from a version 2 option", () => {
    const category = { type: "category", data: ["A", "B"] };
    const options: Record<string, Record<string, unknown>> = {
      bar: {
        xAxis: category,
        yAxis: {},
        series: [{ type: "bar", data: [1, 2] }],
      },
      line: {
        xAxis: category,
        yAxis: {},
        series: [{ type: "line", areaStyle: {}, data: [1, 2] }],
      },
      scatter: {
        xAxis: {},
        yAxis: {},
        series: [
          {
            type: "scatter",
            data: [
              [1, 2],
              [3, 4],
            ],
          },
        ],
      },
      pie: {
        legend: {},
        series: [
          {
            type: "pie",
            radius: ["40%", "70%"],
            data: [
              { name: "Alpha", value: 1 },
              { name: "Beta", value: 2 },
            ],
          },
        ],
      },
      heatmap: {
        xAxis: { type: "category", data: ["a", "b"] },
        yAxis: { type: "category", data: ["c", "d"] },
        visualMap: { min: 0, max: 5 },
        series: [
          {
            type: "heatmap",
            data: [
              [0, 0, 1],
              [1, 1, 5],
            ],
          },
        ],
      },
      funnel: {
        series: [
          {
            type: "funnel",
            data: [
              { name: "Visit", value: 100 },
              { name: "Buy", value: 20 },
            ],
          },
        ],
      },
      gauge: {
        series: [{ type: "gauge", data: [{ value: 72, name: "Score" }] }],
      },
      boxplot: {
        xAxis: { type: "category", data: ["a"] },
        yAxis: {},
        series: [{ type: "boxplot", data: [[1, 2, 3, 4, 5]] }],
      },
      candlestick: {
        xAxis: { type: "category", data: ["d1"] },
        yAxis: {},
        series: [{ type: "candlestick", data: [[1, 3, 0, 4]] }],
      },
      sankey: {
        series: [
          {
            type: "sankey",
            data: [{ name: "In" }, { name: "Out" }],
            links: [{ source: "In", target: "Out", value: 3 }],
          },
        ],
      },
      treemap: {
        series: [
          {
            type: "treemap",
            data: [
              {
                name: "Root",
                value: 5,
                children: [{ name: "Leaf", value: 5 }],
              },
            ],
          },
        ],
      },
      radar: {
        radar: {
          indicator: [
            { name: "Speed", max: 5 },
            { name: "Power", max: 5 },
            { name: "Range", max: 5 },
          ],
        },
        series: [{ type: "radar", data: [{ name: "Bee", value: [3, 4, 5] }] }],
      },
      dataset: {
        dataset: {
          source: [
            ["product", "2025", "2026"],
            ["Alpha", 1, 2],
            ["Beta", 3, 4],
          ],
        },
        legend: {},
        xAxis: { type: "category" },
        yAxis: {},
        series: [{ type: "bar" }, { type: "bar" }],
      },
    };
    for (const [name, option] of Object.entries(options)) {
      const svg = render(chart(option));
      expect(svg, name).toMatch(/^<svg/);
      expect(svg.length, `${name} drew marks`).toBeGreaterThan(500);
    }
  });

  it("uses only the four theme colors and folds the rest into Other", () => {
    const palette = ["#111111", "#222222", "#333333", "#444444"];
    const svg = render(
      {
        version: 1,
        type: "bar",
        title: "Many",
        x: "x",
        y: "y",
        series: "s",
        source,
        data: ["a", "b", "c", "d", "e", "f"].map((s, i) => ({
          x: "row",
          y: i + 1,
          s,
        })),
      },
      palette,
    );
    const fills = new Set(
      svg.match(/#[0-9a-f]{6}/gi)?.map((c) => c.toLowerCase()),
    );
    for (const color of palette) expect(fills.has(color), color).toBe(true);
    expect(svg).toMatch(/>Other</);
    expect(svg).not.toMatch(/>(d|e|f)</);
  });

  it("draws no images, links, HTML or remote references for hostile options", () => {
    const svg = render(
      chart({
        title: { text: "T", link: "javascript:alert(1)" },
        graphic: [
          { type: "image", style: { image: "https://example.com/a.png" } },
        ],
        backgroundColor: { image: "https://example.com/bg.png" },
        tooltip: { formatter: "<img src=x>" },
        xAxis: { type: "category", data: ["<script>alert(1)</script>"] },
        yAxis: {},
        series: [
          {
            type: "line",
            symbol: "image://https://example.com/s.png",
            data: [1],
            label: { show: true, formatter: "<b>{c}</b>" },
          },
        ],
      }),
    );
    expect(svg).not.toMatch(
      /<image|<script|<foreignObject|example\.com|javascript:/,
    );
    expect(svg).toMatch(/&lt;script&gt;/);
  });

  it("renders the reviewed DoS and CSS payloads quickly and inertly", () => {
    const time = (option: Record<string, unknown>) => {
      const started = Date.now();
      let svg = "";
      try {
        svg = render(chart(option));
      } catch {}
      return { svg, ms: Date.now() - started };
    };
    const redos = time({
      dataset: [
        {
          source: [
            ["k", "v"],
            [`${"a".repeat(40)}!`, 1],
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
      yAxis: {},
      series: [{ type: "bar", datasetIndex: 1 }],
    });
    const gauge = time({
      series: [
        {
          type: "gauge",
          splitNumber: 1e6,
          axisTick: { splitNumber: 1e6 },
          data: [{ value: 1 }],
        },
      ],
    });
    const pieces = time({
      visualMap: { type: "piecewise", min: 0, max: 1e9, splitNumber: 1e6 },
      xAxis: {},
      yAxis: {},
      series: [{ type: "scatter", data: [[1, 2]] }],
    });
    for (const r of [redos, gauge, pieces]) expect(r.ms).toBeLessThan(2000);
    expect(gauge.svg.length).toBeLessThan(2e6);
    expect(
      render(
        chart({
          xAxis: { type: "category", data: ["a"] },
          yAxis: {},
          series: [
            {
              type: "bar",
              data: [1],
              cursor: "pointer;mask-image:none",
              itemStyle: { color: "red;filter:blur(2px)" },
              label: {
                show: true,
                fontWeight: "bold;mask-image:none",
                fontStyle: "italic;filter:x",
                fontSize: "12px;cursor:x",
              },
            },
          ],
        }),
      ),
    ).not.toMatch(/mask-image|filter:|blur\(|cursor:x/);
  });

  it("keeps svgElement patterns and escaped CSS out of the SVG", () => {
    const pattern = (tag: string, attrs: Record<string, string>) => ({
      svgElement: { tag, attrs },
      svgWidth: 10,
      svgHeight: 10,
    });
    expect(
      render(
        chart({
          backgroundColor: pattern("image", {
            href: "data:,x",
            onerror: "alert(1)",
          }),
          color: [pattern("script", { href: "https://e.example/x.js" })],
          xAxis: { type: "category", data: ["a", "b"] },
          yAxis: {},
          series: [
            {
              type: "bar",
              data: [1],
              itemStyle: {
                color: pattern("image", { href: "https://e.example/a.png" }),
              },
            },
            {
              type: "candlestick",
              data: [
                [1, 2, 0, 3],
                [2, 1, 0, 3],
              ],
              itemStyle: {
                color0: "\\u\\r\\l(https://e.example/a)",
                borderColor0: "red;mask:x",
                borderColorDoji: "u\\72 l(https://e.example/b)",
              },
            },
          ],
        }),
      ),
    ).not.toMatch(/<image|<script|<pattern|onerror|e\.example|url\(|mask:|\\/);
  });

  it("renders oversized decal tiles and numeric-z path icons without hanging", () => {
    const decal = {
      symbol: "rect",
      symbolSize: 1,
      dashArrayX: [
        [1, 1],
        [1, 2],
        [1, 4],
        [1, 6],
        [1, 10],
      ],
      dashArrayY: [1, 1],
      maxTileWidth: 1e6,
      maxTileHeight: 1e6,
    };
    const started = Date.now();
    const svg = render(
      chart({
        aria: { decal: { show: true, decals: [decal] } },
        xAxis: { type: "category", data: ["a", "b"] },
        yAxis: {},
        series: [
          {
            type: "bar",
            itemStyle: { decal },
            data: [{ value: 1, itemStyle: { decal } }, 2],
          },
        ],
      }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(svg.length).toBeLessThan(2e5);
    for (const icon of ["path://Z1", "Z1", "path://m0 0z1"])
      render(
        chart({
          legend: { icon },
          xAxis: { axisPointer: { handle: { show: true, icon } } },
          yAxis: {},
          dataZoom: [{ type: "slider", handleIcon: icon }],
          series: [
            {
              type: "scatter",
              name: "s",
              symbol: icon,
              data: [[1, 2]],
              markPoint: { symbol: icon, data: [{ type: "max" }] },
            },
          ],
        }),
      );
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
