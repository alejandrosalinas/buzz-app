import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { Agent, Agents } from "../../features/agents/service";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import type { CommunityReader } from "../../features/communities/service";
import {
  AgentCommunityScope,
  useAgentScopeCommunity,
} from "../../features/agents/AgentCommunityScope";
import { uncropped } from "../../features/profiles/avatar-upload";
import { AgentAvatarPicker, type AvatarSelection } from "./AgentAvatarPicker";
import styles from "./AgentCreate.module.css";

/** Avatar edits use creation's picker and only publish on Save. */
export function AgentIdentityDialog({
  agent,
  agents,
  onClose,
  finalFocus,
  communities,
}: {
  agent: Agent;
  agents: Agents;
  onClose(): void;
  finalFocus: RefObject<HTMLButtonElement | null>;
  communities?: CommunityReader | undefined;
}) {
  const community = useAgentScopeCommunity(agent, agents, communities);
  const [scopeOpen, setScopeOpen] = useState(false);
  useEffect(() => {
    if (!community) setScopeOpen(false);
  }, [community]);
  const [avatar, setAvatar] = useState<AvatarSelection>(() => ({
    kind: agentAvatars.some((item) => item.url === agent.picture)
      ? "gloopie"
      : "image",
    picture: agent.picture ?? "",
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarRef = useRef<{ prepare(): Promise<string> }>(null);
  const { zoom, x, y } = (avatar.kind === "image" && avatar.crop) || uncropped;
  const changed =
    avatar.kind === "emoji" ||
    zoom !== 1 ||
    !!x ||
    !!y ||
    avatar.picture !== (agent.picture ?? "");
  const form = useId();
  const save = async () => {
    const picker = avatarRef.current;
    if (pending || avatarBusy || !changed || !picker) return;
    setPending(true);
    setError("");
    try {
      const picture = await picker.prepare();
      await agents.save(agent.key, { picture: picture || null });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      title="Change avatar"
      description={
        community ? (
          <AgentCommunityScope
            community={community}
            scope="Avatar"
            open={scopeOpen}
            onOpenChange={setScopeOpen}
          />
        ) : undefined
      }
      size="default"
      height="content"
      chromeSpacing="padded"
      finalFocus={finalFocus}
      preventClose={pending || avatarBusy}
      dismissOnOutsideClick={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onEscape={() => {
        if (pending || avatarBusy) return true;
        if (scopeOpen) {
          setScopeOpen(false);
          return true;
        }
        return changed;
      }}
      leadingActions={
        (avatar.kind === "emoji" || avatar.picture) && (
          <Button
            disabled={pending || avatarBusy}
            onClick={() => {
              setAvatar({ kind: "image", picture: "" });
              setError("");
            }}
          >
            Remove avatar
          </Button>
        )
      }
      actions={
        <Button
          variant="primary"
          type="submit"
          form={form}
          loading={pending}
          disabled={pending || avatarBusy || !changed}
        >
          Save changes
        </Button>
      }
    >
      <form
        id={form}
        className={styles.form}
        data-error={error ? "" : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <AgentAvatarPicker
          name={agent.name}
          selection={avatar}
          disabled={pending}
          community={agent.relay}
          onBusyChange={setAvatarBusy}
          onChange={(selection) => {
            setAvatar(selection);
            setError("");
          }}
          avatarRef={avatarRef}
        />
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
