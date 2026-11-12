import type { EChartsCoreOption } from "echarts/core";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Chart.module.css";
import { chartHeight, chartOption, parseChart } from "./spec";
import { chartTables, type Table } from "./tables";
import { hostTheme } from "./theme";

const SOURCE_PREVIEW = 2000;

function DataTable({ caption, columns, rows, omitted }: Table) {
  return (
    <div className={styles.tableWrap}>
      <table className={`${styles.table} text-body-sm`}>
        {caption && <caption className="text-label-sm">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns may repeat
              <th key={i} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static snapshot
            <tr key={i}>
              {row.map((value, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static snapshot
                <td key={j}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {omitted > 0 && (
        <p className="text-body-sm text-subtle">
          {omitted} more rows not shown.
        </p>
      )}
    </div>
  );
}

export function Chart({
  code,
  expanded = false,
}: {
  code: string;
  expanded?: boolean;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<{ code: string; message: string }>();
  const parsed = useMemo(() => {
    try {
      const spec = parseChart(code);
      return { spec, option: chartOption(spec), tables: chartTables(spec) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [code]);
  const option = "option" in parsed ? parsed.option : undefined;

  useEffect(() => {
    const node = plot.current;
    if (!node || !option) return;
    let live = true;
    let stop = () => {};
    const fail = () => {
      stop();
      if (live) setFailure({ code, message: "This chart couldn't be drawn." });
    };
    void import("./echarts").then(({ echarts }) => {
      if (!live) return;
      let chart: ReturnType<typeof echarts.init> | undefined;
      let themeKey = "";
      let frame = 0;
      // Redraw only when the resolved host colors or text size change.
      const draw = (animate: boolean) => {
        const theme = hostTheme(node);
        const key = JSON.stringify(theme);
        if (chart && key === themeKey) return;
        chart?.dispose();
        themeKey = key;
        chart = echarts.init(node, theme, { renderer: "svg" });
        const still =
          !animate ||
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        chart.setOption(
          (still
            ? { ...option, animation: false }
            : option) as EChartsCoreOption,
        );
      };
      const attempt = (run: () => void) => {
        try {
          run();
        } catch {
          fail();
        }
      };
      const resize = new ResizeObserver(() => attempt(() => chart?.resize()));
      const appearance = new MutationObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => attempt(() => draw(false)));
      });
      stop = () => {
        cancelAnimationFrame(frame);
        resize.disconnect();
        appearance.disconnect();
        chart?.dispose();
        chart = undefined;
      };
      attempt(() => draw(true));
      if (!chart) return;
      resize.observe(node);
      appearance.observe(document.documentElement, {
        attributes: true,
        attributeFilter: [
          "data-color-mode",
          "data-accent",
          "data-color-level",
          "class",
          "style",
        ],
      });
    }, fail);
    return () => {
      live = false;
      stop();
    };
  }, [code, option]);

  if ("error" in parsed || failure?.code === code) {
    const message = "error" in parsed ? parsed.error : failure?.message;
    return (
      <>
        <div className={styles.error} role="alert">
          {message}
        </div>
        <div className={styles.source}>
          {code.length > SOURCE_PREVIEW
            ? `${code.slice(0, SOURCE_PREVIEW)}\n… (source truncated)`
            : code}
        </div>
      </>
    );
  }
  const { spec, tables } = parsed;
  const rowCount = tables.reduce((n, t) => n + t.rows.length, 0);
  const more = tables.some((t) => t.omitted > 0) ? "+" : "";
  const url = spec.source?.url;
  return (
    <figure
      className={`${styles.chart} ${expanded ? styles.expanded : ""} text-body-sm`}
      aria-label={spec.title}
    >
      <figcaption className="text-label">{spec.title}</figcaption>
      <div
        ref={plot}
        className={styles.plot}
        role="img"
        aria-label={`Chart: ${spec.title}`}
        style={{ "--chart-height": `${chartHeight(spec)}px` } as CSSProperties}
      />
      {spec.source && (
        <p className={styles.meta}>
          Source:{" "}
          {url ? (
            <Button
              variant="link"
              size="text"
              nativeButton={false}
              role="link"
              render={(props) => (
                <a
                  {...props}
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                />
              )}
            >
              {spec.source?.name} ({new URL(url).host})
            </Button>
          ) : (
            spec.source.name
          )}
          {spec.source.metric && ` · ${spec.source.metric}`}
        </p>
      )}
      {spec.note && <p className={styles.note}>{spec.note}</p>}
      {rowCount > 0 && (
        <Accordion
          items={[
            {
              value: "rows",
              title: `View ${rowCount}${more} data rows`,
              content: tables.map((table, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static snapshot
                <DataTable key={i} {...table} />
              )),
            },
          ]}
        />
      )}
    </figure>
  );
}
