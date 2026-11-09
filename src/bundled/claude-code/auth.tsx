// How Buzz's Claude authenticates: with an Anthropic API key, pasted in
// setup and kept by native code in the OS credential store (`claude_key.rs`),
// which gives it to every `claude` as `ANTHROPIC_API_KEY`, never as an
// argument, and never back to the app.
//
// Builds can replace this one file with another way to sign in, so the rest
// of the plugin reaches authentication only through its exports: keep their
// names and shapes when changing it.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import inlineStyles from "../../shared/InlineReference.module.css";
import type { Spawn } from "./claude";
import type { ClaudeSetup } from "./setup";

const NO_KEY =
  "Claude needs an Anthropic API key. Add one in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";
/** What setup says first: the key is one for all of Claude, not per agent. */
const KEY_ONCE =
  "Claude requires an API key to connect to your account. Create one at console.anthropic.com and paste it below. You only have to set this up once, and Buzz keeps it securely on this computer.";
const REJECTED_KEY =
  "Anthropic rejected the Claude API key. It may have been revoked or run out of credit. Paste a working key in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";

/** Runs one process as a setup step, its output shown; throws unless it
 * succeeds. */
export type Step = (
  id: string,
  args: readonly string[],
  label: string,
) => Promise<void>;
type Env = Readonly<Record<string, string | null>>;

/** Runs a `claude.sh` step; its output, or throws what it printed. */
async function output(spawn: Spawn, id: string) {
  let stdout = "";
  let stderr = "";
  const process = await spawn(id, {
    onStdout: (text) => {
      stdout += text;
    },
    onStderr: (text) => {
      stderr += text;
    },
  });
  await process.end();
  const code = await process.exited;
  if (code !== 0)
    throw new Error(stderr.trim() || `${id} ended (${code ?? "stopped"}).`);
  return stdout;
}

/** The key's native store (`claude_key.rs`): the OS credential store,
 * which hands the key to the Claude processes that ask for it. Nothing
 * here reads it back; native code relies on that, as it gives the key to
 * `claude-sh`, which runs whatever script it is given. */
const nativeStore = ():
  | Readonly<{
      /** Whether a key is saved. */
      status(): Promise<boolean>;
      /** Saves the key; it is never read back. */
      save(key: string): Promise<void>;
    }>
  | undefined =>
  isTauri()
    ? {
        status: async () => (await invoke("claude_api_key_status")) === true,
        save: (value) => invoke("claude_api_key_set", { value }),
      }
    : undefined;

/** Whether Claude leads the Harness list and is new agents' default
 * (`src/bundled/index.ts`). Not here: Claude asks for an API key before its
 * first agent, so Codex leads. A build whose Claude signs in without that
 * friction can put it first. */
export const leadsHarnesses = false;

/** Claude's credentials on this computer. */
export class ClaudeAuth {
  /** Which way this build authenticates. */
  readonly id = "buzz-claude-auth:api-key";
  /** What the agent type's row asks for while Claude cannot run. */
  readonly attentionLabel = "Add Claude API key";
  /** Ends "Claude 2.1.0 …" while Claude cannot run. */
  readonly needs = "needs an Anthropic API key";
  /** An interactive sign-in setup runs as its step, when there is one. */
  readonly signIn: ((step: Step) => Promise<void>) | undefined = undefined;
  private saved: Promise<boolean> | undefined;
  private readonly listeners = new Set<() => void>();

  private readonly store;

  constructor(private readonly spawn: Spawn | undefined) {
    this.store = spawn ? nativeStore() : undefined;
  }

  /** Told when the credentials change, so running sessions start again. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Whether a key is saved, asked once until it is saved again or checked;
   * no key is asked again each time. */
  private has() {
    const store = this.store;
    if (!store) return Promise.resolve(false);
    if (this.saved) return this.saved;
    const asking = store.status();
    this.saved = asking;
    // Only a saved key is kept: another Buzz on this computer may save one.
    const forget = () => {
      if (this.saved === asking) this.saved = undefined;
    };
    asking.then((saved) => saved || forget(), forget);
    return asking;
  }

  /** Whether Claude can run turns: an account to show, or undefined. */
  async check(): Promise<Readonly<{ account?: string }> | undefined> {
    this.saved = undefined;
    return (await this.has()) ? {} : undefined;
  }

  /** Saves `key` for every `claude` started from now on; what to say. A
   * save can't be stopped once it reaches the store, so `signal` only
   * stops one that hasn't. */
  async save(key: string, signal?: AbortSignal) {
    const store = this.store;
    if (!store) throw new Error("Claude runs only in the desktop app");
    signal?.throwIfAborted();
    try {
      await store.save(key);
    } finally {
      // A refused save leaves the key as it was; anything else may not.
      this.saved = undefined;
    }
    for (const listener of this.listeners) listener();
    return "Saved the Anthropic API key.";
  }

  /** `spawn`, starting each `claude` with the saved key, which native code
   * sets itself. `required` refuses to start one without a key, so no turn
   * falls back on an account sign-in that `~/.claude` may hold. */
  authorize(spawn: Spawn, required = false): Spawn {
    return async (id, options) => {
      // Buzz's copy, and the protected release (`claude-protected-*`).
      if (id !== "claude" && !id.startsWith("claude-protected-"))
        return spawn(id, options);
      if (required && !(await this.has())) throw new Error(NO_KEY);
      return spawn(id, {
        ...options,
        secrets: [...(options?.secrets ?? []), "anthropic-api-key"],
      });
    };
  }

  /** Security reviews' own Claude folder (absolute), which contained agents
   * cannot write, and what they authenticate with: the key, which
   * `authorize` asks native code for. */
  async review(): Promise<Readonly<{ home: string; env: Env }>> {
    const spawn = this.spawn;
    if (!spawn) throw new Error("Claude reviews need the desktop app");
    if (!(await this.has())) throw new Error(NO_KEY);
    const home = (await output(spawn, "review")).trim();
    if (!home.startsWith("/"))
      throw new Error("Claude's review folder is unreadable");
    return { home, env: {} };
  }

  /** A failed review's error, as the person can act on it. */
  explain(error: string) {
    return rejected(error) ? REJECTED_KEY : error;
  }

  /** A failed turn's error as its report in the conversation says it, in
   * Markdown: a missing or rejected key links to `settings`, where it is
   * added once for every Claude agent. */
  explainTurn(error: string, settings: string) {
    if (error.includes(NO_KEY))
      return `Claude is missing an API key. Head to [Settings](${settings}) to add one.`;
    return rejected(error)
      ? `Anthropic rejected Claude's API key. It may have been revoked or run out of credit. Head to [Settings](${settings}) to replace it.`
      : error;
  }
}

/** Whether Claude's error says Anthropic refused the key; turns end with
 * "Invalid API key · Fix external API key". */
const rejected = (error: string) =>
  /authentication_error|invalid x-api-key|invalid api key/i.test(error);

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Setup's ask while Claude cannot run: the key, once for every agent.
 * `onSaved` follows a saved key, so a surface can close. */
export function SignIn({
  setup,
  disabled = false,
  variant = "full",
  onSaved,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  variant?: "full" | "compact";
  onSaved?: (() => void) | undefined;
}) {
  return (
    <div className="grid gap-3">
      {/* One paragraph says it all; the field adds no description of its own. */}
      <p className="m-0 text-body-sm text-secondary">{KEY_ONCE}</p>
      <KeyForm
        setup={setup}
        disabled={disabled}
        compact={variant === "compact"}
        onSaved={onSaved}
      />
    </div>
  );
}

/** Claude's settings once it can run: replacing the key. `onSaved` follows
 * a saved key, so a surface can close. */
export function SignedIn({
  setup,
  onSaved,
}: {
  setup: ClaudeSetup;
  onSaved?: (() => void) | undefined;
}) {
  return (
    <div className="grid gap-2">
      <p className="m-0 text-body-sm text-subtle">
        Claude runs with your Anthropic API key.
      </p>
      <KeyForm setup={setup} replace onSaved={onSaved} />
    </div>
  );
}

/** Where an agent's own surface, such as its library card, says Claude
 * cannot run: setup is one step in Settings, not one per agent. */
export function Missing({
  openSettings,
}: {
  openSettings?: (() => void) | undefined;
}) {
  return (
    <p className="m-0 text-body-sm text-secondary">
      Claude is missing an API key.{" "}
      {openSettings ? (
        <>
          Head to{" "}
          <button
            type="button"
            className={inlineStyles.link}
            onClick={openSettings}
          >
            Settings
          </button>{" "}
          to add one.
        </>
      ) : (
        "Add one in Settings → Agent setup."
      )}
    </p>
  );
}

function KeyForm({
  setup,
  disabled = false,
  compact = false,
  replace = false,
  onSaved,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  compact?: boolean;
  replace?: boolean;
  onSaved?: (() => void) | undefined;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState<AbortController>();
  // Kept until the form closes.
  const [saved, setSaved] = useState<{ ok: boolean; text: string }>();
  // Closing the form cancels a save.
  useEffect(() => () => saving?.abort(), [saving]);
  const save = async () => {
    if (!key.trim() || saving || disabled) return;
    const controller = new AbortController();
    setSaving(controller);
    setSaved(undefined);
    try {
      const text = await setup.auth.save(key.trim(), controller.signal);
      setKey("");
      setSaved({ ok: true, text });
      await setup.check();
      onSaved?.();
    } catch (error) {
      if (!controller.signal.aborted)
        setSaved({ ok: false, text: message(error) });
    } finally {
      setSaving(undefined);
    }
  };
  return (
    // Not a form: it sits inside agent creation's and Settings' own.
    <div className="grid gap-2" aria-busy={saving ? true : undefined}>
      <Field
        label={replace ? "Replace API key" : "Anthropic API key"}
        {...(replace && {
          description:
            "Create a key at console.anthropic.com. Buzz keeps it securely on this computer and gives it only to Claude, so commands your Claude agents run can read it.",
        })}
      >
        <Input
          type="password"
          autoComplete="off"
          value={key}
          readOnly={!!saving}
          aria-disabled={saving || disabled ? true : undefined}
          onValueChange={setKey}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void save();
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          {...(!replace && { variant: "prominent" as const })}
          size={compact ? "sm" : "md"}
          disabled={disabled || !key.trim()}
          focusableWhenDisabled
          loading={!!saving}
          onClick={() => void save()}
        >
          Save key
        </Button>
        {saved && (
          <p
            role={saved.ok ? "status" : "alert"}
            className={
              saved.ok ? "m-0 text-body-sm text-subtle" : "buzz-field-error m-0"
            }
          >
            {saved.text}
          </p>
        )}
      </div>
    </div>
  );
}
