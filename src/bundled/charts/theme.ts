import { PALETTE_SIZE } from "./spec";

/** An ECharts theme from the host's semantic roles. ECharts parses only
 * simple color syntaxes, so each role is resolved through a canvas pixel. */
export function hostTheme(node: HTMLElement) {
  const style = getComputedStyle(node);
  const context = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  const resolve = (role: string) => {
    const value = style.getPropertyValue(role).trim();
    if (!context || !value) return value;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`;
  };
  const text = resolve("--text-standard");
  const subtle = resolve("--text-subtle");
  const border = resolve("--border-standard");
  const axis = {
    axisLine: { lineStyle: { color: border } },
    axisTick: { lineStyle: { color: border } },
    axisLabel: { color: subtle },
    splitLine: { lineStyle: { color: border } },
    nameTextStyle: { color: subtle },
  };
  return {
    color: Array.from({ length: PALETTE_SIZE }, (_, i) =>
      resolve(`--chart-series-${i + 1}`),
    ),
    backgroundColor: "transparent",
    textStyle: {
      color: text,
      fontFamily: style.fontFamily,
      fontSize: Math.round((Number.parseFloat(style.fontSize) || 14) * 0.85),
    },
    legend: {
      textStyle: { color: text },
      pageTextStyle: { color: text },
      pageIconColor: text,
      pageIconInactiveColor: border,
    },
    tooltip: {
      backgroundColor: resolve("--surface-panel"),
      borderColor: border,
      textStyle: { color: text },
    },
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    logAxis: axis,
    radar: {
      axisName: { color: text },
      axisLine: { lineStyle: { color: border } },
      splitLine: { lineStyle: { color: border } },
    },
    line: { symbol: "circle" },
    label: { color: text },
  };
}
