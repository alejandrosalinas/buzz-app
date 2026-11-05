import { networkMetrics } from "../developer/network-metrics.ts";
import type { VerifiedEvent } from "nostr-tools";
import { publicationRefusal } from "../developer/traffic.ts";
import { eventDto } from "./events.ts";
import {
  isCatalogKind,
  MAX_EVENT_BYTES as CATALOG_EVENT_BYTES,
} from "../agents/catalog-envelope.ts";
import { CANVAS_FRAME_BYTES } from "../channel-templates/canvas-limits.ts";

/** False means proven non-delivery, not merely a negative or missing OK.
 * `refusal` is the log-safe summary; `reason` is the relay's own bounded text
 * for a proven refusal, for the client only and never for logs. */
export class SocketRequestError extends Error {
  constructor(
    message: string,
    readonly sent: boolean,
    readonly refusal?: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}
type Publication = {
  event: VerifiedEvent;
  sent: boolean;
  acknowledge?: (() => void) | undefined;
  finish(receipt?: string, error?: Error): void;
};
/** Correlation only. The live owner supplies auth, socket, cooldown and recovery;
 * the existing outbox owns retry. Never replay publications on reconnect. */
export function createSocketPublications(
  wake: () => void,
  relay = "unknown-relay",
) {
  const pending = new Map<string, Publication>();
  const metrics = networkMetrics.relay(relay);
  return {
    async publish(input: VerifiedEvent, signal: AbortSignal): Promise<string> {
      if (signal.aborted)
        throw new SocketRequestError("Publication cancelled", false);
      const event = eventDto(input);
      if (pending.has(event.id))
        throw new SocketRequestError("Publication already in flight", false);
      if (pending.size >= 32)
        throw new SocketRequestError("Publication capacity reached", false);
      // NIP-AP catalog and Canvas events may exceed the ordinary frame, up
      // to their own bounds within the relay's default frame limit.
      const frame = isCatalogKind(event.kind)
        ? CATALOG_EVENT_BYTES
        : event.kind === 40100
          ? CANVAS_FRAME_BYTES
          : 65536;
      if (
        new TextEncoder().encode(JSON.stringify(["EVENT", event])).length >
        frame
      )
        throw new SocketRequestError("Publication exceeds frame limit", false);
      const metric = networkMetrics.enabled()
        ? metrics.operation("publish")
        : undefined;
      return new Promise((resolve, reject) => {
        const abort = () =>
          job.finish(
            undefined,
            new SocketRequestError("Publication cancelled", job.sent),
          );
        // Includes time queued before authentication or shared quota admission.
        const timer = setTimeout(
          () =>
            job.finish(
              undefined,
              new SocketRequestError("Publication timed out", job.sent),
            ),
          10000,
        );
        const job: Publication = {
          event,
          sent: false,
          finish(receipt, error) {
            if (pending.get(event.id) !== job) return;
            pending.delete(event.id);
            metric?.(
              error?.message === "Publication cancelled"
                ? "cancelled"
                : error
                  ? "failed"
                  : "ok",
            );
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve(receipt ?? "");
            wake();
          },
        };
        pending.set(event.id, job);
        signal.addEventListener("abort", abort, { once: true });
        wake();
      });
    },
    next() {
      const jobs = [...pending.values()];
      if (jobs.filter((job) => job.sent).length >= 3) return;
      return jobs.find((job) => !job.sent);
    },
    dispatch(job: Publication, send: (frame: unknown[]) => void) {
      if (pending.get(job.event.id) !== job) return;
      job.sent = true; // A throwing send cannot prove no bytes left the process.
      job.acknowledge = metrics.timer("publicationAck");
      try {
        send(["EVENT", job.event]);
      } catch {
        job.finish(
          undefined,
          new SocketRequestError("Socket send interrupted", true),
        );
      }
    },
    receive(data: unknown[]): boolean {
      if (data[0] !== "OK" || typeof data[1] !== "string") return false;
      const job = pending.get(data[1]);
      if (!job?.sent) return false;
      if (
        data.length !== 4 ||
        typeof data[2] !== "boolean" ||
        typeof data[3] !== "string" ||
        new TextEncoder().encode(data[3]).length > 16384
      )
        job.finish(
          undefined,
          new SocketRequestError("Invalid publication receipt", true),
        );
      else if (data[2]) {
        job.acknowledge?.();
        job.finish(data[3]);
      } else {
        job.acknowledge?.();
        // Relay internal errors can follow command side effects. Unknown prefixes
        // are conservative too; only documented admission/validation refusals prove rejection.
        const rejected =
          /^(invalid|blocked|restricted|auth-required|rate-limited):/.test(
            data[3],
          ) ||
          // Buzz workflow CAS/authority and Canvas/artifact CAS refusals precede
          // domain mutation.
          ([30620, 46020].includes(job.event.kind) &&
            /^(conflict|forbidden):/.test(data[3])) ||
          ([40100, 45010].includes(job.event.kind) &&
            data[3].startsWith("conflict:"));
        job.finish(
          undefined,
          new SocketRequestError(
            "Relay publication not confirmed",
            !rejected,
            publicationRefusal(data[3]),
            rejected ? data[3] : undefined,
          ),
        );
      }
      return true;
    },
    clear() {
      for (const job of [...pending.values()])
        job.finish(
          undefined,
          new SocketRequestError("Socket connection interrupted", job.sent),
        );
    },
  };
}
