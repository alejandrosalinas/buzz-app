import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import {
  PROFILE_CACHE_BASE,
  profileRosterRoom,
} from "../../features/relay/budget";
import type { ChannelSummary } from "../../features/relay/contracts";
import { useProfileGeneration } from "../../features/relay/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import type { RelaySession } from "../../features/relay/session";
import { avatarMedia } from "../../shared/avatar-source";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  PopoverPopup,
  PopoverRoot,
} from "../../shared/design-system/ui/Popover";
import {
  Textarea,
  type TextareaProps,
} from "../../shared/design-system/ui/Textarea";
import { mentionQuery, pendingMentionQuery } from "../mentions/mention-query";
import {
  matchingMentions,
  rankMentions,
  type MentionChoice,
} from "../mentions/mention-ranking";

export type WorkflowMentionMember = Readonly<{
  pubkey: string;
  /** The profile display name the relay matches an `@Name` against. */
  name: string;
  /** The composer's label, which qualifies namesakes. */
  label: string;
  avatar?: string | undefined;
  agent?: boolean;
}>;

/** The workflow channel's named members: the only `@Name` the relay resolves. */
export const WorkflowMentionMembers = createContext<
  readonly WorkflowMentionMember[]
>([]);

const none: readonly string[] = [];
// The composer's row budget.
const SUGGESTION_LIMIT = 50;

export function useWorkflowMentionMembers(
  session: RelaySession,
  channel: Pick<ChannelSummary, "id" | "members"> | undefined,
): readonly WorkflowMentionMember[] {
  const ids = channel?.members ?? none;
  const selection = useMemo(
    () => selectProfiles(session.profiles, ids),
    [session, ids],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const generation = useProfileGeneration(session.profiles);
  // Evictions also count cancelled reads, so a shrink asks again for this roster.
  const readEvictions = () => session.profiles.evictions?.() ?? 0;
  const evictions = useSyncExternalStore(
    session.profiles.subscribe,
    readEvictions,
    readEvictions,
  );
  const label = useChannelIdentityNames(session, channel?.id);
  // As an open channel does (ConversationChannel), keep room for the whole
  // roster on top of the base, so the base stays free for every other name. A
  // layout effect, so the reads below see the grown limit.
  useLayoutEffect(
    () => (ids.length ? session.profiles.reserve?.(ids.length) : undefined),
    [session, ids.length],
  );
  useEffect(() => {
    // An access purge, an eviction or a cancelled read drops names; names still
    // loaded cost no read when requested again.
    void generation;
    void evictions;
    const roster = ids.slice(
      0,
      profileRosterRoom(session.profiles.limit?.() ?? PROFILE_CACHE_BASE),
    );
    // The profile directory's per-call budget, as for workflow owners.
    for (let offset = 0; offset < roster.length; offset += 500)
      void session.profiles
        .ensure(roster.slice(offset, offset + 500), "background")
        .catch(() => {});
  }, [session, ids, generation, evictions]);
  return useMemo(
    () =>
      ids.flatMap((pubkey) => {
        const profile = profiles.get(pubkey);
        // A fallback key fragment is not a display name the relay can match.
        if (!profile?.name || profile.nameIsFallback) return [];
        return [
          {
            pubkey,
            name: profile.name,
            label: label(pubkey, profile.name),
            avatar: avatarMedia(profile.picture, session.media),
            agent: !!profile.isAgent,
          },
        ];
      }),
    [ids, profiles, label, session],
  );
}

function mentionChoice(member: WorkflowMentionMember): MentionChoice {
  return {
    recipient: { pubkey: member.pubkey, name: member.name },
    member: true,
    agent: !!member.agent,
    owned: false,
    managed: false,
    aliases: [member.name],
    label: member.label,
  };
}

/**
 * Message text whose `@` suggests the workflow channel's members as the
 * composer does, inserting the plain `@Name` the relay resolves.
 */
export function WorkflowMessageText({
  value,
  onValueChange,
  ...props
}: Omit<TextareaProps, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const members = useContext(WorkflowMentionMembers);
  const choices = useMemo(() => members.map(mentionChoice), [members]);
  const avatars = useMemo(
    () => new Map(members.map((member) => [member.pubkey, member.avatar])),
    [members],
  );
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const placeCaret = useRef<number | null>(null);
  const reveal = useRef(false);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  // Escape or a pick closes this `@`; a later one opens again.
  const [dismissed, setDismissed] = useState<number>();
  // Only navigation pins a member; otherwise the first result is selected.
  const [pinned, setPinned] = useState<{ start: number; pubkey: string }>();
  const query =
    caret === null || !choices.length ? null : mentionQuery(value, caret);
  const search = query?.query;
  const matches = useMemo(
    () =>
      search === undefined
        ? []
        : rankMentions(matchingMentions(choices, search), search),
    [choices, search],
  );
  const results = matches.slice(0, SUGGESTION_LIMIT);
  // A trailing space or punctuation, or no one left to match, means the
  // person moved on to prose.
  const open =
    !!query &&
    query.start !== dismissed &&
    results.length > 0 &&
    (!query.query || pendingMentionQuery(query.query));
  const pinnedIndex =
    pinned?.start === query?.start
      ? results.findIndex(
          (choice) => choice.recipient.pubkey === pinned?.pubkey,
        )
      : -1;
  const selected = Math.max(0, pinnedIndex);

  const readCaret = (element: HTMLTextAreaElement) =>
    setCaret(
      element.selectionStart === element.selectionEnd
        ? element.selectionStart
        : null,
    );
  const select = (index: number) => {
    const choice = results[index];
    if (query && choice)
      setPinned({ start: query.start, pubkey: choice.recipient.pubkey });
  };
  const accept = (choice: MentionChoice) => {
    if (!query) return;
    const after = value.slice(query.end);
    const spaced = /^\s/.test(after);
    const inserted = `@${choice.recipient.name}${spaced ? "" : " "}`;
    // Past the following space, so the finished name is no longer a query.
    const position = query.start + inserted.length + (spaced ? 1 : 0);
    onValueChange(value.slice(0, query.start) + inserted + after);
    setDismissed(query.start);
    setCaret(position);
    placeCaret.current = position;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: New results reveal their selection, as in the composer.
  useLayoutEffect(() => {
    reveal.current = true;
  }, [search]);
  // After the new value commits, before the next keystroke.
  useLayoutEffect(() => {
    if (placeCaret.current !== null) {
      input.current?.setSelectionRange(placeCaret.current, placeCaret.current);
      placeCaret.current = null;
    }
    if (reveal.current && open) {
      list.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView?.({ block: "nearest" });
      reveal.current = false;
    }
  });

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next, details) => {
        // Pressing in the text moves the caret; that decides the query.
        if (next || input.current?.contains(details.event.target as Node))
          return;
        if (query) setDismissed(query.start);
      }}
    >
      <Textarea
        {...props}
        ref={input}
        value={value}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && results[selected] ? `${listId}-${selected}` : undefined
        }
        onChange={(event) => {
          const element = event.currentTarget;
          onValueChange(element.value);
          readCaret(element);
          // Once that `@` is gone, a new one in its place suggests again.
          if (!mentionQuery(element.value, element.selectionStart))
            setDismissed(undefined);
        }}
        onSelect={(event) => readCaret(event.currentTarget)}
        onBlur={() => setCaret(null)}
        onKeyDown={(event) => {
          // The composer's key handling, without its chip-only Space rule.
          if (
            !open ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(query?.start);
            return;
          }
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
            return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            reveal.current = true;
            const step = event.key === "ArrowDown" ? 1 : results.length - 1;
            select((selected + step) % results.length);
          } else if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            const choice = results[selected];
            if (choice) accept(choice);
          }
        }}
      />
      <PopoverPopup
        anchor={input}
        initialFocus={false}
        finalFocus={false}
        aria-label="Mention suggestions"
      >
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label="Mention suggestions"
          className="workflow-mention-list"
        >
          {results.map((choice, index) => (
            // The textarea keeps focus and names the active row.
            // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard acceptance belongs to the focused textarea.
            <div
              key={choice.recipient.pubkey}
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === selected}
              className="workflow-mention-option"
              onPointerDown={(event) => {
                if (event.button === 0) event.preventDefault();
              }}
              onPointerMove={() => select(index)}
              onClick={() => accept(choice)}
            >
              <span aria-hidden="true" className="workflow-mention-preview">
                <Avatar
                  alt=""
                  fallback={choice.label}
                  src={avatars.get(choice.recipient.pubkey)}
                  size="default"
                  shape={choice.agent ? "squircle" : "circle"}
                />
              </span>
              <span className="workflow-mention-label">
                <span className="workflow-mention-name">{choice.label}</span>
                <small title={choice.recipient.pubkey}>
                  {choice.recipient.pubkey}
                </small>
              </span>
            </div>
          ))}
        </div>
        {matches.length > SUGGESTION_LIMIT && (
          <p role="status" className="workflow-mention-status">
            Narrow your search to see more members.
          </p>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}
