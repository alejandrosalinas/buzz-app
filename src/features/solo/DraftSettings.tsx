import { ChannelDurationField } from "../../bundled/channels/ChannelDurationField";
import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../relay/channel-details-protocol";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../relay/channel-writes";
import { useEffect, useState, type ComponentProps } from "react";
import type { RelaySession } from "../relay/session";
import type { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import {
  emptyWorkspace,
  loadChatSetup,
  readWorkspace,
  workspaceCanvas,
} from "./workspace";
import {
  ChatInstructions,
  ChatSettingsDialog,
  instructionsCanvas,
} from "./ChatSettingsDialog";

/** Edits only the local draft; first-send owns remote setup and its retry receipt. */
export function DraftSettings({
  session,
  projectId,
  canvas,
  name = "",
  save,
  close,
  ttlSeconds,
  finalFocus,
}: {
  session: RelaySession;
  projectId?: string | undefined;
  canvas?: string | undefined;
  name?: string | undefined;
  ttlSeconds?: number | undefined;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
  save(canvas: string, ttlSeconds?: number, name?: string): void;
  close(): void;
}) {
  // A persisted name arrives unchecked; a malformed one opens blank.
  const openedName = typeof name === "string" ? name : "";
  const [value, setValue] = useState(openedName);
  const normalized = canonicalDetailsName(value);
  const nameError = normalized
    ? detailsDraftErrors({
        name: normalized,
        description: "",
        visibility: "private",
      }).name
      ? "Use a chat name of at most 120 characters."
      : undefined
    : undefined;
  const [ttl, setTtl] = useState(ttlSeconds);
  const [temporaryTtl, setTemporaryTtl] = useState(
    ttlSeconds ?? DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
  );
  const lifetimeError = detailsDraftErrors({
    name: "Chat",
    description: "",
    visibility: "private",
    ttlSeconds: ttl,
  }).lifetime;
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [raw, setRaw] = useState<string>();
  // The Canvas the dialog opened with; undefined until it has loaded.
  const [opened, setOpened] = useState<string>();
  const loaded = opened !== undefined;
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed settings read.
  useEffect(() => {
    let active = true;
    setError("");
    void (async () => {
      try {
        const content =
          canvas ??
          (projectId ? (await loadChatSetup(session, projectId)).canvas : "");
        if (!active) return;
        try {
          setWorkspace(readWorkspace(content));
        } catch {
          setRaw(content);
        }
        setOpened(content);
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      active = false;
    };
  }, [session, projectId, canvas, attempt]);
  return (
    <ChatSettingsDialog
      dismissOnOutsideClick={false}
      dirty={
        canonicalDetailsName(value) !== canonicalDetailsName(openedName) ||
        ttl !== ttlSeconds ||
        (loaded && instructionsCanvas(workspace, raw) !== opened)
      }
      finalFocus={finalFocus}
      close={close}
      saveDisabled={!loaded || !!nameError || !!lifetimeError}
      onSave={() => {
        try {
          save(
            raw === undefined
              ? workspaceCanvas(workspace)
              : workspaceCanvas({ folders: [], canvas: raw }),
            ttl,
            normalized,
          );
          close();
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }}
    >
      <Field label="Chat name" optional error={nameError}>
        <Input
          value={value}
          disabled={!loaded}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      {loaded ? (
        <ChatInstructions
          workspace={workspace}
          onWorkspaceChange={setWorkspace}
          raw={raw}
          onRawChange={setRaw}
        />
      ) : (
        !error && <p role="status">Loading settings…</p>
      )}
      <ChannelDurationField
        label="Lifetime"
        temporary={ttl !== undefined}
        ttlSeconds={temporaryTtl}
        disabled={!loaded}
        error={lifetimeError}
        onChange={(next) => {
          setTtl(next);
          if (next !== undefined) setTemporaryTtl(next);
        }}
      />
      {error && <p role="alert">{error}</p>}
      {!loaded && error && (
        <Button onClick={() => setAttempt((value) => value + 1)}>
          Retry settings
        </Button>
      )}
    </ChatSettingsDialog>
  );
}
