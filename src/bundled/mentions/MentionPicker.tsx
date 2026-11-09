import { useProfileGeneration } from "../../features/relay/react";
import { TeamMentionAvatars } from "./TeamMentionAvatars";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import {
  AtIcon,
  CaretDownIcon,
  CheckIcon,
  RobotIcon,
} from "../../shared/design-system/icons/index";
import { useEffect, useId, useRef, useState } from "react";
import { useTeamMentions } from "./use-team-mentions";
import { useMentionChoices } from "./use-mention-choices";
import type { ComposerSession } from "../../features/messages/composer-session";
import {
  outsideMentionDetail,
  remoteMentionDetail,
} from "./mention-candidates";
import { matchPerson } from "../../features/search/person-match";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import "../../shared/design-system/styles/scrollbars.css";
import styles from "./Mentions.module.css";

import type { ComposerToolProps } from "../../features/conversation/contracts";
import { avatarMedia } from "../../shared/avatar-source";

/** Select identities from the shared relay roster, never from display-name matching. */
export function MentionPicker({
  session,
  channelId,
  disabled,
  inviteAgents,
  audience,
  select,
  selectTeam,
  focusDraft,
}: {
  session: ComposerSession;
  scope: string;
  channelId: string;
  disabled: boolean;
  inviteAgents?: boolean | undefined;
  audience?: ComposerToolProps["audience"];
  select: ComposerToolProps["insertMention"];
  selectTeam?: ComposerToolProps["insertMentions"];
  /** Return typing to the draft when the agent menu closes. */
  focusDraft?: ComposerToolProps["focus"];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLFieldSetElement>(null);
  const accepted = useRef(false);
  // How the agent menu last closed: undefined while open.
  const closedBy = useRef<"outside" | "inside">(undefined);
  const searchInput = useRef<HTMLElement>(null);
  // The picker stays mounted while closed; each opening is its own lifetime.
  const [opening, setOpening] = useState(0);
  const lifetime = `picker:${useId()}:${opening}`;
  const model = useMentionChoices(
    session,
    channelId,
    inviteAgents,
    search,
    lifetime,
    open && !disabled,
  );
  const {
    profiles,
    agents,
    list,
    channel,
    roster: draftRoster,
    choices: candidates,
  } = model;
  const teams = useTeamMentions(
    session,
    channelId,
    inviteAgents,
    search,
    model,
    open && !disabled && !!selectTeam,
  );
  const parentAdmission = !!channel && channel.channelType !== "solo";
  const members =
    draftRoster?.map((person) => person.pubkey) ?? channel?.members;
  // Only an open chooser demands names; typing must not join every member.
  const memberKey = open && !draftRoster ? (members?.join(":") ?? "") : "";
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (draftRoster || !open || !memberKey) return;
    let current = true;
    void session.profiles
      .ensure(memberKey.split(":"), "background")
      .catch(() => {
        if (current)
          setError(
            "Names unavailable. Exact public keys still identify recipients.",
          );
      });
    return () => {
      current = false;
    };
  }, [session, open, memberKey, draftRoster, profileGeneration]);
  const chooseRecipient = (
    recipient: (typeof candidates)[number]["recipient"],
  ) => {
    if (!model.canSelect(recipient.pubkey)) return;
    // Alone with agents: a pick adds or removes that agent, never the last,
    // and the menu stays open for more.
    if (audience) {
      audience.toggle(recipient);
      return;
    }
    if (select(recipient)) {
      accepted.current = true;
      setOpen(false);
    }
  };
  const chooseTeam = (team: (typeof teams.choices)[number]) => {
    if (audience) {
      if (!team.canSelect() || !team.recipients.length) return;
      audience.only(team.recipients);
      accepted.current = true;
      setOpen(false);
      return;
    }
    if (team.canSelect() && selectTeam?.(team.recipients)) {
      accepted.current = true;
      setOpen(false);
    }
  };
  const personKey = (pubkey: string) => `person:${pubkey}`;
  const teamKey = (id: string) => `team:${id}`;
  // Order stays rankMentions', shared with inline @ completion and mobile.
  // The highlight skips rows that cannot be chosen, as the arrow keys did.
  const highlight = useSearchHighlight({
    query: search,
    keys: disabled
      ? []
      : [
          ...candidates
            .filter((choice) => !choice.disabled)
            .map((choice) => personKey(choice.recipient.pubkey)),
          ...teams.choices
            .filter((team) => !team.disabled)
            .map((team) => teamKey(team.id)),
        ],
    onChoose: (key) => {
      const person = candidates.find(
        (choice) => personKey(choice.recipient.pubkey) === key,
      );
      if (person) return chooseRecipient(person.recipient);
      const team = teams.choices.find((choice) => teamKey(choice.id) === key);
      if (team) chooseTeam(team);
    },
    open: open && !disabled,
    // Enter chose the first row before anything was typed; keep that, and
    // show which row it is. The agent menu marks who is addressed instead,
    // so nothing looks hovered until the pointer or keyboard says so.
    highlightEmpty: !audience,
    wrap: true,
  });
  const highlightedLabel =
    candidates.find(
      (choice) => personKey(choice.recipient.pubkey) === highlight.active,
    )?.label ??
    teams.choices.find((team) => teamKey(team.id) === highlight.active)?.name;
  // Underline with the same rule that ranks mentions.
  const matched = (label: string) =>
    search.trim() ? matchPerson(label, search)?.positions : undefined;
  return (
    <PopoverRoot
      open={open && !disabled}
      onOpenChange={(next, details) => {
        setOpen(next);
        // Focus that left by a click or Tab keeps its new destination.
        closedBy.current = next
          ? undefined
          : details.reason === "outside-press" || details.reason === "focus-out"
            ? "outside"
            : "inside";
        if (next) {
          setOpening((value) => value + 1);
          accepted.current = false;
          if (!draftRoster) session.channels.ensureList();
        }
      }}
    >
      <fieldset
        ref={controls}
        disabled={disabled}
        className={styles.pickerControls}
        aria-label="Mention controls"
      >
        <PopoverTrigger
          disabled={disabled}
          render={
            audience && audience.recipients.length > 1 ? (
              // Several agents: the composer shows them as removable
              // avatars, and this opens the menu.
              <IconButton
                disabled={disabled}
                size="toolbar"
                ref={trigger}
                type="button"
                aria-label={`Sending to ${audience.recipients
                  .map((person) => person.name)
                  .join(", ")}. Change agents`}
                title="Change agents"
                icon={<CaretDownIcon size={16} aria-hidden="true" />}
              />
            ) : audience ? (
              <Button
                variant="subtle"
                size="sm"
                disabled={disabled}
                ref={trigger}
                type="button"
                aria-label={
                  audience.recipients.length
                    ? `Sending to ${audience.recipients
                        .map((person) => person.name)
                        .join(", ")}. Change agents`
                    : "Choose agent"
                }
              >
                <AvatarStack
                  size="small"
                  items={audience.recipients.map((person) => ({
                    id: person.pubkey,
                    name: person.name,
                    src: avatarMedia(
                      profiles.get(person.pubkey)?.picture,
                      session.media,
                    ),
                    shape: "squircle",
                  }))}
                />
                {audience.recipients[0]?.name ?? "Choose agent"}
                <CaretDownIcon size={12} aria-hidden="true" />
              </Button>
            ) : (
              <IconButton
                hint="familiar"
                disabled={disabled}
                size="toolbar"
                ref={trigger}
                type="button"
                aria-label="Mention a member"
                title="Mention a member"
                icon={<AtIcon size={20} aria-hidden="true" />}
              />
            )
          }
        />
        <PopoverPopup
          side="top"
          sideOffset={4}
          anchor={() => controls.current?.closest("form") ?? trigger.current}
          padding="none"
          initialFocus={searchInput}
          style={{
            width: 380,
            height: "min(360px, var(--available-height))",
            overflow: "hidden",
            display: "flex",
          }}
          aria-label="Mention a member or agent"
          finalFocus={
            // The agent menu stays open across picks; closing it resumes
            // typing in the draft, unless focus went somewhere else. The
            // popup also asks while open, when the trigger changes shape.
            audience && focusDraft
              ? () => {
                  if (closedBy.current === "inside") focusDraft();
                  return false;
                }
              : !accepted.current
          }
        >
          <div className={styles.mentionContent}>
            <SearchField
              variant="capsule"
              inputRef={searchInput}
              label={
                draftRoster
                  ? "Search recipients"
                  : inviteAgents
                    ? "Search members and agents"
                    : "Search community people and agents"
              }
              value={search}
              onValueChange={setSearch}
              disabled={disabled}
              aria-controls={highlight.listId}
              {...highlight.fieldProps}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
                // Shift+Enter and Shift+arrows stay text keys, as before.
                const handled = !event.shiftKey && highlight.keyDown(event);
                // Keep these keys from the composer behind the popup.
                if (handled || event.key === "Enter") event.stopPropagation();
              }}
            />
            {!draftRoster && inviteAgents && (
              <p>
                {parentAdmission
                  ? "Agents you mention join this channel when you send, with access to its history."
                  : "Agents you mention join this chat when you send, with access to its history."}
              </p>
            )}
            {model.directory.loading && (
              <p role="status">Searching community…</p>
            )}
            {model.directory.error && (
              <>
                <p role="status">{model.directory.error}</p>
                <Button type="button" onClick={model.directory.retry}>
                  Retry community search
                </Button>
              </>
            )}
            {agents.status === "loading" && !candidates.length && (
              <p role="status">Loading agents…</p>
            )}
            {(agents.status === "error" || !!agents.error) && (
              <Button
                type="button"
                onClick={() =>
                  void session.agentChoices.refresh(
                    !!inviteAgents || teams.includeLegacy,
                  )
                }
              >
                Retry agent list
              </Button>
            )}
            {model.archives.status === "error" && (
              <Button
                type="button"
                onClick={() => void session.archives?.refresh()}
              >
                Retry archive information
              </Button>
            )}
            {teams.status && (
              <p role="status">
                {teams.status}{" "}
                {teams.canRetry && (
                  <Button onClick={teams.retry}>Retry legacy teams</Button>
                )}
              </p>
            )}
            {error && <p role="status">{error}</p>}
            {!draftRoster && list.error && (
              <>
                <p role="alert">Could not refresh channel membership.</p>
                <Button
                  disabled={disabled}
                  type="button"
                  onClick={() => session.channels.refreshList?.()}
                >
                  Retry channel membership
                </Button>
              </>
            )}
            {!draftRoster && (!inviteAgents || !!channel) && !members && (
              <p role="status">Channel membership unavailable.</p>
            )}
            <div
              className={`${styles.mentionChoices} buzz-thin-scrollbar`}
              id={highlight.listId}
              {...highlight.listProps}
            >
              {candidates.map(
                ({
                  recipient,
                  label,
                  agent,
                  elsewhere,
                  disabled: reason,
                  otherName,
                  execution,
                }) => {
                  const managedBy = model.managedBy.get(recipient.pubkey);
                  const remoteDetail = remoteMentionDetail(execution);
                  // Each addressed agent's row shows a check; fill is only
                  // the keyboard and pointer highlight.
                  const addressed = !!audience?.recipients.some(
                    (person) => person.pubkey === recipient.pubkey,
                  );
                  const focused =
                    highlight.active === personKey(recipient.pubkey);
                  return (
                    <NavigationItem
                      variant="option"
                      // The exact key the row picks; its label may not show it.
                      data-mention-choice={recipient.pubkey}
                      type="button"
                      key={recipient.pubkey}
                      {...highlight.rowProps(personKey(recipient.pubkey))}
                      selected={audience ? false : focused}
                      highlighted={audience ? focused : false}
                      aria-current={false}
                      aria-pressed={audience ? addressed : undefined}
                      disabled={disabled || !!reason}
                      onClick={() => chooseRecipient(recipient)}
                      label={
                        <span className="flex flex-col whitespace-normal">
                          {/* One element, so the flex column keeps the
                            underlined name on one line. */}
                          <span>
                            <MatchedLabel
                              label={label}
                              positions={matched(label)}
                            />
                            {agent && (
                              <span
                                aria-hidden="true"
                                className={styles.agentMark}
                              >
                                <RobotIcon />
                              </span>
                            )}
                            {agent && <span className="sr-only"> Agent</span>}
                          </span>
                          {reason && <small>{reason}</small>}
                          {(remoteDetail ||
                            otherName ||
                            managedBy ||
                            !members?.includes(recipient.pubkey)) && (
                            <small className="text-caption text-subtle">
                              {/* The other verified name sits beside the detail. */}
                              {[
                                otherName,
                                remoteDetail,
                                managedBy,
                                members?.includes(recipient.pubkey)
                                  ? undefined
                                  : inviteAgents
                                    ? parentAdmission
                                      ? "Adds to channel when you send"
                                      : "Adds to chat when you send"
                                    : outsideMentionDetail(channel, elsewhere),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </small>
                          )}
                        </span>
                      }
                      trailing={
                        addressed && <CheckIcon size={16} aria-hidden="true" />
                      }
                      icon={
                        <Avatar
                          alt=""
                          fallback={label}
                          src={avatarMedia(
                            profiles.get(recipient.pubkey)?.picture ??
                              model.directory.people.find(
                                (person) => person.pubkey === recipient.pubkey,
                              )?.picture,
                            session.media,
                          )}
                          size="large"
                          shape={
                            agent || !members?.includes(recipient.pubkey)
                              ? "squircle"
                              : "circle"
                          }
                        />
                      }
                    />
                  );
                },
              )}
              {teams.choices.map((team) => (
                <NavigationItem
                  key={team.id}
                  variant="option"
                  data-mention-choice=""
                  type="button"
                  {...highlight.rowProps(teamKey(team.id))}
                  selected={highlight.active === teamKey(team.id)}
                  aria-current={false}
                  disabled={disabled || !!team.disabled}
                  label={
                    <MatchedLabel
                      label={team.name}
                      positions={matched(team.name)}
                    />
                  }
                  icon={
                    <TeamMentionAvatars
                      session={session}
                      recipients={team.recipients}
                    />
                  }
                  trailing={
                    <span className="text-caption text-subtle">
                      {team.detail}
                    </span>
                  }
                  aria-label={`${team.name} · ${team.detail}`}
                  onClick={() => chooseTeam(team)}
                />
              ))}
              {members && !candidates.length && !teams.choices.length && (
                <p>No matching channel members.</p>
              )}
              {audience?.named && (
                <p className="text-caption text-subtle">
                  Your message tags{" "}
                  {audience.recipients.map((person) => person.name).join(", ")},
                  so picks here add or remove tags.
                </p>
              )}
              <p role="status" className="sr-only">
                {highlightedLabel
                  ? `${highlightedLabel}. Press Enter to ${audience ? "add or remove this agent" : "mention"}.`
                  : ""}
              </p>
            </div>
          </div>
        </PopoverPopup>
      </fieldset>
    </PopoverRoot>
  );
}
