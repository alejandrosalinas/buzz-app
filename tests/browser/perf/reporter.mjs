import { appendFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, arch } from "node:os";

export default class Reporter {
  runs = [];
  errors = [];
  onBegin() {
    this.startedAt = new Date().toISOString();
    this.load = loadavg();
  }
  onError(error) {
    this.errors.push(error.message);
  }
  onTestEnd(test, result) {
    const attachment = result.attachments.find((a) => a.name === "perf-sample");
    this.runs.push({
      scenario: test.title.replace(/ sample \d+$/, ""),
      status: result.status,
      executionMs: result.duration,
      errors: result.errors.map((error) => error.message),
      sample: attachment ? JSON.parse(attachment.body.toString()) : null,
      evidence: result.attachments.filter((a) => a.path).map((a) => a.path),
    });
  }
  onEnd(result) {
    const missing = this.runs.filter(
      (run) => run.status === "passed" && !run.sample,
    );
    if (missing.length)
      this.errors.push(
        `Missing performance samples: ${missing.map((run) => run.scenario).join(", ")}`,
      );
    const status =
      result.status === "passed" && (missing.length || !this.runs.length)
        ? "failed"
        : result.status;
    const summary = {};
    for (const run of this.runs.filter(
      (r) => r.status === "passed" && r.sample,
    )) {
      summary[run.scenario] ??= {};
      const group = summary[run.scenario];
      for (const [key, value] of Object.entries(run.sample.metrics)) {
        if (!Number.isFinite(value))
          throw new Error(`Non-finite metric: ${key}`);
        group[key] ??= [];
        group[key].push(value);
      }
    }
    for (const group of Object.values(summary)) {
      for (const [key, values] of Object.entries(group)) {
        values.sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        group[key] = {
          n: values.length,
          median:
            values.length % 2
              ? values[middle]
              : (values[middle - 1] + values[middle]) / 2,
          min: values[0],
          max: values.at(-1),
        };
      }
    }
    writeFileSync(
      process.env.PERF_OUT,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status,
          startedAt: this.startedAt,
          durationMs: result.duration,
          settings: {
            scenario: process.env.PERF_SCENARIO,
            repeat: Number(process.env.PERF_REPEAT),
            cpu: Number(process.env.PERF_CPU),
            browser: process.env.PERF_BROWSER ?? "chromium",
            viewport: { width: 1440, height: 950 },
          },
          host: {
            platform: platform(),
            arch: arch(),
            cpu: cpus()[0]?.model,
            loadAtStart: this.load,
            loadAtEnd: loadavg(),
          },
          evidenceDir: process.env.PERF_RUN_DIR,
          runs: this.runs,
          errors: this.errors,
          summary,
        },
        null,
        2,
      )}\n`,
    );
    // CI shows medians on the run page; the JSON artifact keeps every sample.
    if (process.env.GITHUB_STEP_SUMMARY && Object.keys(summary).length)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        [
          `### Browser measurements (${process.env.PERF_BROWSER === "webkit" ? "WebKit" : `Chromium, CPU ×${process.env.PERF_CPU}`})`,
          "",
          "| Case | Median metrics |",
          "| --- | --- |",
          ...Object.entries(summary).map(
            ([scenario, metrics]) =>
              `| ${scenario} | ${Object.entries(metrics)
                .map(([key, { median }]) => `${key} ${Math.round(median)}`)
                .join(", ")} |`,
          ),
          "",
        ].join("\n"),
      );
    console.log(`Results written to ${process.env.PERF_OUT}`);
    return { status };
  }
}
