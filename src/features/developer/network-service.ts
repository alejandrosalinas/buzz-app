import type { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { isLogLevel, type LogLevel } from "./logging";
import { networkMetrics, type NativeTraffic } from "./network-metrics";
import {
  networkRecorder,
  captureExpiry,
  validCaptureReset,
  type CaptureReset,
  type NetworkEvent,
} from "./network-diagnostics";

/** Host-backed, sanitized diagnostics for independently built plugins. */
export type NetworkDiagnosticsSnapshot = ReturnType<
  typeof networkRecorder.snapshot
> & {
  metrics?: ReturnType<typeof networkMetrics.snapshot>;
  writer?: { pendingRecords: number; peakRecords: number };
  archive?: { path: string | null; error: string | null };
};

type Archive = { path: string | null; error: string | null };
export type NetworkDiagnostics = {
  readonly version: 1;
  snapshot(): NetworkDiagnosticsSnapshot;
  setLevel(level: LogLevel): Promise<void>;
  setAutoReset(reset: CaptureReset): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  export(): Promise<{ path: string } | { report: unknown }>;
  clear(): Promise<void>;
  refresh(): Promise<void>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    networkDiagnostics: NetworkDiagnostics;
  }
}

/** Plugin activation owns capture; its settings view only polls while visible.
 * IPC batches and user actions share ordering; export/clear wait for earlier records. */
export function provideNetworkDiagnostics(ctx: Context) {
  const native = isTauri();
  let active = false;
  let configured = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let nativeTraffic: NativeTraffic[] = [];
  let writer: { pendingRecords: number; peakRecords: number } | undefined;
  let archive: Archive | undefined;
  let pending = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>) => {
    const result = pending.then(action);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const events: NetworkEvent[] = [];
  let scheduled = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let requested = false;
  let clearing = false;
  let forwardingError: string | null = null;
  const writes = new Set<Promise<void>>();
  const failed = () => {
    forwardingError =
      "Session capture is incomplete. Some records could not be saved. Clear history to start again.";
    archive = {
      path: archive?.path ?? null,
      error: forwardingError,
    };
  };
  const flush = () => {
    scheduled = false;
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (clearing) return;
    while (events.length) {
      const batch = events.splice(0, 64);
      const write = invoke<void>("network_diagnostics_append", {
        events: batch,
      }).catch(failed);
      writes.add(write);
      void write.then(() => writes.delete(write));
    }
  };
  const refresh = async () => {
    if (!native) return;
    try {
      const status = await invoke<{
        archive: Archive;
        traffic?: NativeTraffic[];
        writer?: typeof writer;
      }>("network_diagnostics_read", { recent: false });
      nativeTraffic = status.traffic ?? [];
      writer = status.writer ?? undefined;
      archive = {
        ...status.archive,
        error: forwardingError ?? status.archive.error,
      };
    } catch {
      failed();
    }
  };
  const configureLevel = async (
    level: LogLevel,
    reset = networkRecorder.snapshot().autoReset,
  ) => {
    if (!isLogLevel(level)) throw new Error("Invalid network capture level");
    if (!validCaptureReset(reset))
      throw new Error("Enter a positive whole number of capture minutes");
    if (!active)
      throw new Error("Enable Network diagnostics before changing capture");
    const until = captureExpiry(level, reset);
    if (level === "silent") {
      networkRecorder.configure(level, reset);
      networkMetrics.setEnabled(false);
    }
    if (native)
      await invoke("network_diagnostics_configure", {
        level,
        enabled: true,
        resetAt: until ?? null,
      });
    if (!requested || !active) return;
    networkRecorder.configure(level, reset, until);
    if (!networkMetrics.enabled()) nativeTraffic = [];
    networkMetrics.setEnabled(level !== "silent");
  };
  if (native) {
    ctx.effect(() => {
      events.push(...networkRecorder.snapshot().events);
      const stop = networkRecorder.subscribe((event) => {
        if (!active) return;
        events.push(event);
        if (!scheduled) {
          scheduled = true;
          flushTimer = setTimeout(flush, 100);
        }
      });
      void flush();
      return async () => {
        clearInterval(timer);
        networkRecorder.setEnabled(false);
        networkMetrics.setEnabled(false);
        stop();
        flush();
        await pending;
        await Promise.all([...writes]);
        if (configured)
          await invoke("network_diagnostics_configure", {
            level: "info",
            enabled: false,
            resetAt: null,
          });
      };
    });
  }
  ctx.effect(() => () => {
    requested = false;
    active = false;
    clearInterval(timer);
    networkRecorder.setEnabled(false);
    networkMetrics.setEnabled(false);
  });
  const service: NetworkDiagnostics = {
    version: 1,
    refresh,
    snapshot: () => ({
      ...networkRecorder.snapshot(),
      metrics: networkMetrics.snapshot(nativeTraffic),
      ...(writer ? { writer } : {}),
      ...(archive ? { archive } : {}),
    }),
    setEnabled(next) {
      requested = next;
      // Stop producers immediately; native drains already queued records in order.
      if (!next) {
        active = false;
        networkRecorder.setEnabled(false);
        networkMetrics.setEnabled(false);
        clearInterval(timer);
        timer = undefined;
      }
      return serialize(async () => {
        flush();
        await Promise.all([...writes]);
        if (native) {
          configured = true;
          await invoke("network_diagnostics_configure", {
            level: "info",
            enabled: next,
            resetAt: null,
          });
        }
        active = next && requested;
        networkRecorder.configure("info");
        networkRecorder.setEnabled(active);
        networkMetrics.setEnabled(active);
        nativeTraffic = [];
        clearInterval(timer);
        if (active) {
          if (native) await refresh();
          if (!requested || !active) return;
          timer = setInterval(() => {
            void serialize(async () => {
              if (!active || !networkMetrics.enabled()) return;
              if (native) await refresh();
              for (const metrics of networkMetrics.snapshot(nativeTraffic)
                .relays)
                networkRecorder.record({
                  level: "info",
                  event: "metrics.summary",
                  relay: metrics.relay,
                  metrics,
                });
              flush();
            });
          }, 5000);
        }
      }).catch((error: unknown) => {
        if (next && requested) {
          active = false;
          networkRecorder.setEnabled(false);
          networkMetrics.setEnabled(false);
        }
        failed();
        throw error;
      });
    },
    setLevel: (level) => serialize(() => configureLevel(level)),
    setAutoReset: (reset) =>
      serialize(() => configureLevel(networkRecorder.snapshot().level, reset)),
    export() {
      flush();
      return serialize(async () => {
        if (active && networkMetrics.enabled()) {
          if (native) await refresh();
          for (const metrics of networkMetrics.snapshot(nativeTraffic).relays)
            networkRecorder.record({
              level: "info",
              event: "metrics.summary",
              relay: metrics.relay,
              metrics,
            });
          flush();
        }
        await Promise.all([...writes]);
        if (native) {
          if (archive?.error) throw new Error(archive.error);
          return { path: await invoke<string>("network_diagnostics_export") };
        }
        return {
          report: {
            version: 1,
            host: "browser",
            exportedAt: new Date().toISOString(),
            native: null,
            client: networkRecorder.snapshot(),
            metrics: networkMetrics.snapshot(),
          },
        };
      });
    },
    clear() {
      flush();
      return serialize(async () => {
        flush();
        clearing = true;
        const cutoff = networkRecorder.snapshot().events.at(-1)?.sequence ?? 0;
        try {
          await Promise.all([...writes]);
          if (native) await invoke("network_diagnostics_clear");
          networkRecorder.clear(cutoff);
          networkMetrics.reset();
          nativeTraffic = [];
          forwardingError = null;
          if (archive) archive = { ...archive, error: null };
        } finally {
          clearing = false;
          flush();
        }
      });
    },
  };
  ctx.provide("networkDiagnostics", service);
}
