import { localStore, type AgentStore } from "../../features/agents/store";
import {
  followRecommended,
  onRecommended,
  type RecommendedRun,
} from "../../features/agents/recommended";
import { config, type Config } from "./runtime";

export type ClaudeProviderDefaults = Readonly<{
  model: string;
  effort?: string;
}>;
const NATIVE_DEFAULTS: ClaudeProviderDefaults = Object.freeze({ model: "" });
const STORAGE_KEY = "buzz.claude-code.provider-defaults.v1";

/** Device-wide defaults are separate from agent records; a blank agent value
 * inherits this store and a blank store value leaves Claude Code in charge. */
export class ClaudeDefaults {
  private state: ClaudeProviderDefaults;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: AgentStore = localStore(),
    /** What agents on Recommended run on, once found. */
    private readonly recommended?: RecommendedRun,
  ) {
    this.state = this.read();
  }

  snapshot = () => this.state;
  /** Also told when the recommendation is found, which `resolve` reads, so
   * a runtime made before then picks it up. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const unsubscribe = this.recommended?.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      unsubscribe?.();
    };
  };
  /** Settles once what `raw`, when on Recommended, runs on is known, so
   * `resolve` names it rather than the device default. Only the first
   * finding waits; a retry after nothing was offered runs alongside. */
  async follow(raw: unknown) {
    if (!this.recommended || !onRecommended(raw)) return;
    const finding = this.recommended.find();
    if (this.recommended.current() === undefined) await finding;
  }
  resolve(raw: unknown): Config {
    // Recommended picks the model and level, as an explicit choice would.
    const explicit = followRecommended(
      raw,
      config(raw),
      this.recommended?.current(),
    );
    return {
      ...explicit,
      model: explicit.model.trim() ? explicit.model : this.state.model,
      effort:
        explicit.effort ||
        (!explicit.model.trim() || explicit.model === this.state.model
          ? (this.state.effort ?? "")
          : ""),
    };
  }
  /** Settles once the defaults are saved, and only then uses them; rejects,
   * keeping the saved ones, when they could not be saved. */
  async save(next: ClaudeProviderDefaults) {
    const { model, effort = "" } = next;
    await this.storage.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, model, effort }),
    );
    this.state = Object.freeze({ model, effort });
    for (const listener of this.listeners) listener();
  }
  private read(): ClaudeProviderDefaults {
    try {
      const value: unknown = JSON.parse(
        this.storage.get(STORAGE_KEY) ?? "null",
      );
      if (
        value &&
        typeof value === "object" &&
        (value as { version?: unknown }).version === 1 &&
        typeof (value as { model?: unknown }).model === "string"
      )
        return Object.freeze({
          model: (value as { model: string }).model,
          ...(typeof (value as { effort?: unknown }).effort === "string"
            ? { effort: (value as { effort: string }).effort }
            : {}),
        });
    } catch {
      // Malformed local preferences preserve Claude Code's native default.
    }
    return NATIVE_DEFAULTS;
  }
}
