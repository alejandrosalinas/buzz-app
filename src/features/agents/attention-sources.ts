import { interestPaused } from "./attention";
// Lifecycle for plugin producers. The host owns registration, cancellation and delivery;
// plugins own execution. A resolved run is terminal until its watch is edited.
import type { ComponentType } from "react";
import type { DefinedIcon } from "../../shared/design-system/icons";
import type { HostProcess, HostProcessOptions } from "../host/service";
import type { Agent } from "./service";
import type { AttentionObject, SourceWatch } from "./attention";

/** How Agent Attention shows a provider's watch, in place of its name. */
export type SourcePresentation = Readonly<{
  /** The kind of watch, such as "GitHub PR". */
  type: string;
  icon?: DefinedIcon;
  /** What it watches, shown beside its kind, with `subtitle` after it. */
  target?: string;
  subtitle?: string;
  /** Opens what it watches. */
  link?: Readonly<{ href: string; title: string }>;
  /** Replaces the name in its details. */
  details?: ComponentType;
}>;
export type AttentionSource = Readonly<{
  id: string;
  /** Discovery metadata for tools that configure this provider. */
  description?: string;
  configExample?: Readonly<Record<string, unknown>>;
  /** `title` is the watch's display name. */
  present?(watch: SourceWatch, title: string): SourcePresentation;
  run(
    input: Readonly<{
      /** Stable Attention object slug, unique within the agent. */
      id: string;
      /** The agent's membership key, as `Agents.wake` takes. */
      agent: string;
      watch: SourceWatch;
      signal: AbortSignal;
      /** Runs a declared process as this watch's agent and destination.
       * On macOS and Linux, only one instance of each declared process may run
       * per agent, provider and watch, including across Buzz builds. A concurrent
       * instance waits for its predecessor to stop. Await `process.exited` before respawning.
       * Buzz revokes access when this run returns, throws or is cancelled. */
      spawn(
        process: string,
        options: Omit<HostProcessOptions, "mcp">,
      ): Promise<HostProcess>;
      /** Empty output wakes nothing. Throws when delivery cannot be queued. */
      emit(text: string): void;
    }>,
  ): Promise<void>;
}>;
/** Host registration after binding the plugin's command capability. */
export type AttentionProducer = Omit<AttentionSource, "run"> & {
  run(
    input: Omit<Parameters<AttentionSource["run"]>[0], "spawn">,
  ): Promise<void>;
};
type SourceObject = AttentionObject & { value: SourceWatch };
export class AttentionSources {
  private registrations = new Map<
    string,
    { object: SourceObject; type: string; stop: AbortController | undefined }
  >();
  constructor(
    private host: {
      emit(
        agent: string,
        object: SourceObject,
        text: string,
        current: () => boolean,
      ): void;
      completed(agent: string, object: SourceObject): boolean;
      finish(agent: string, object: SourceObject): Promise<void>;
    },
    private tails = new Map<string, Promise<void>>(),
  ) {}
  reconcile(
    provider: string,
    source: AttentionProducer,
    agents: readonly Agent[],
    suspended: (agent: string) => boolean = () => false,
  ) {
    const wanted = new Map<string, { agent: Agent; object: SourceObject }>();
    for (const agent of agents) {
      if (!agent.attentionEnabled) continue;
      for (const object of Object.values(agent.attention)) {
        const value = object.value;
        if (
          value.type === "source" &&
          value.provider === provider &&
          value.enabled &&
          !interestPaused(agent.attention, value.interest_id) &&
          agent.attention[`interest/${value.interest_id}`]?.value.type ===
            "interest"
        )
          wanted.set(`${provider}/${agent.key}/${object.slug}`, {
            agent,
            object: object as SourceObject,
          });
      }
    }
    for (const [key, registration] of this.registrations) {
      if (wanted.get(key)?.object === registration.object) continue;
      this.registrations.delete(key);
      registration.stop?.abort();
    }
    for (const [key, { agent, object }] of wanted) {
      const registration = this.registrations.get(key) ?? {
        object,
        type: agent.type,
        stop: undefined,
      };
      this.registrations.set(key, registration);
      if (registration.type !== agent.type) {
        registration.stop?.abort();
        registration.stop = undefined;
        registration.type = agent.type;
      }
      if (
        suspended(agent.key) ||
        registration.stop ||
        this.host.completed(agent.key, object)
      )
        continue;
      const stop = new AbortController();
      registration.stop = stop;
      const current = () => this.registrations.get(key) === registration;
      let finished = false;
      const emit = (text: string) => {
        if (stop.signal.aborted || finished)
          throw new Error("This source watch is no longer running");
        // A harness change stops new output from the old producer. Accepted output belongs to
        // the registration and remains valid until the watch is invalidated.
        if (text.trim()) this.host.emit(agent.key, object, text, current);
      };
      const previous = this.tails.get(key);
      const done = Promise.resolve(previous).then(async () => {
        try {
          if (stop.signal.aborted || this.host.completed(agent.key, object))
            return;
          await source.run({
            id: object.slug,
            agent: agent.key,
            watch: object.value,
            signal: stop.signal,
            emit,
          });
          finished = true;
          if (!stop.signal.aborted)
            await this.host
              .finish(agent.key, object)
              .catch((error) =>
                console.warn(
                  "Attention source completion was not saved",
                  error,
                ),
              );
        } catch (error) {
          if (!stop.signal.aborted)
            console.warn(`Attention source ${provider} failed`, error);
        } finally {
          finished = true;
          if (this.tails.get(key) === done) this.tails.delete(key);
        }
      });
      this.tails.set(key, done);
    }
  }
  stop() {
    const registrations = this.registrations;
    this.registrations = new Map();
    for (const registration of registrations.values())
      registration.stop?.abort();
  }
}
