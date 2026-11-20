import { workflowLabel } from "../../features/relay/workflow-attribution";
import {
  useIdentityNames,
  useNamesRevision,
} from "../../features/identity-names/react";
import { npubEncode } from "nostr-tools/nip19";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelayEvent } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import type { InboxItem } from "../../features/relay/inbox";
import type { KeyBinding } from "../../features/shortcuts/bindings";
import {
  useChannelList,
  useProfileGeneration,
} from "../../features/relay/react";
import { useSavedHiddenDmIds } from "../../bundled/channels/useHiddenDms";
import {
  useUnreadChannelIds,
  useUnreadReasons,
  useUnreadThreadOnly,
} from "../../bundled/channels/useSidebarFilters";
import { useAgentChoices } from "../../features/agents/use-choices";
import {
  agentUnavailable,
  canMessageAgent,
} from "../../features/agents/choices";
import { useMentionArchives } from "../../features/messages/use-mention-archives";
import { archiveHides } from "../../features/relay/identity-archives";
import { searchedProfiles } from "../../features/relay/profile-search";
import { foldProfiles } from "../../features/relay/profiles";
import {
  ArrowsDownUpIcon,
  AtIcon,
  CalendarIcon,
  ChatCircleIcon,
  ChatsCircleIcon,
  ClockIcon,
  GearIcon,
  HashIcon,
  InfoIcon,
  RobotIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  ThreadIcon,
  XIcon,
  UserIcon,
  UsersIcon,
} from "../../shared/design-system/icons/index";
import { useDefaultAgent } from "../../features/solo/default-agent";
import type { MentionRecipient } from "../../features/messages/mention-draft";
import { searchTerms, snippet } from "../../features/search/snippet";
import {
  readRecentSearches,
  recordRecentSearch,
} from "../../features/search/recent-searches";
import { type PreviewCache, SearchPreview } from "./SearchPreview";
import { formatItemTimestamp } from "../../shared/datetime";
import { Badge } from "../../shared/design-system/ui/Badge";
import { Button } from "../../shared/design-system/ui/Button";
import { Calendar } from "../../shared/design-system/ui/Calendar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import type {
  SearchDestination,
  SearchGroup,
  SearchInputProps,
  SearchViews,
} from "./SearchChoices";
import { type SearchChip, SearchChoices } from "./SearchChoices";
import {
  FilterGuidePreview,
  FilterSyntax,
  guideFilters,
  syntaxOf,
} from "./SearchFilterGuide";
import { MatchRank, matchName, matchRank } from "../../features/search/match";
import { useUnreadFirstPreference } from "../../features/search/unread-first-preference";
import { messageSortPreference } from "../../features/search/message-sort-preference";
import {
  noSearchUsage,
  readSearchUsage,
  recordChoice,
  searchOrder,
} from "../../features/search/usage";
import { usePublicChannelSearch } from "../../features/channels/usePublicChannelSearch";
import { useMemberCounts } from "../../features/channels/useChannelDirectory";
import {
  channelIcon,
  channelIconLabel,
} from "../../features/channels/channel-icon";
import { type SearchSort, useSearchMessages } from "./useSearchMessages";
import type { Decisions } from "../../features/decisions/service";
import { RERANK_PAGES, useCanRerank, useMessageRerank } from "./message-rerank";
import {
  MESSAGE_SEARCH_MIN_CHARS,
  SEARCH_MIN_CHARS,
  searchDebounce,
  searchable,
} from "../../shared/search-debounce";
import { matchPerson, normalizeName } from "../../features/search/person-match";
import {
  personKey,
  rankPeople,
  type PersonCandidate,
} from "../../features/search/people-rank";
import { peopleRelationships } from "../../features/profiles/relationships";
import { knownAgentPubkeys } from "../../features/agents/known";
import { useBestieConversation } from "./bestie-context";
import { usePersonDirectory } from "./usePersonDirectory";
import {
  isChannelUuid,
  isHexPubkey,
  isViewerHandle,
  normalizeFromHandle,
  normalizeInChannel,
  operatorMatches,
  parseSearchOperators,
} from "./parseSearchOperators";
import { avatarMedia } from "../../shared/avatar-source";
import {
  PreviewText,
  withMentionedIds,
} from "../../features/messages/PreviewText";
import {
  useVerifiedNames,
  withVerifiedNames,
} from "../../features/profiles/useVerifiedNames";
import {
  otherVerifiedName,
  useNamePreference,
  verifiedLabel,
} from "../../features/profiles/name-preference";
import { sortParticipantNames } from "../../features/identity-names/participant-order";
import {
  directMessageWith,
  messagePerson,
} from "../../features/direct-messages/message-person";

function conversationName(
  channel: ChannelSummary,
  profiles: ReadonlyMap<string, Profile>,
  resolveName: ReturnType<typeof useIdentityNames>,
) {
  if (channel.channelType !== "dm" || !channel.participants)
    return channel.name;
  return (
    sortParticipantNames(
      channel.participants.map((id) =>
        resolveName(
          id,
          profiles.get(id)?.name ?? id.slice(0, 10),
          channel.participants,
        ),
      ),
    ).join(", ") || "Notes to self"
  );
}

const noMutes: readonly string[] = [];
/** Confirmed mutes only: optimistic menu intents do not quiet unread. */
const confirmedMutes = (
  snapshot: ReturnType<RelaySession["sidebarPreferences"]["snapshot"]>,
) => (snapshot.cached ? noMutes : (snapshot.data?.muted ?? noMutes));

/** The most rows the People and Agents groups each show. */
const PERSON_ROWS = 6;
const noMembers: readonly string[] = [];

/** "Show more messages" extends the search and "Ask" hands it to an agent;
 * neither is a result. */
const isSearchAction = (key: string) =>
  key === "more-messages" || key === "ask";

function useDelayedSearch(pending: boolean) {
  const [slow, setSlow] = useState(false);
  const shown = useRef(false);
  useEffect(() => {
    // Even a no-op set re-renders, and re-ranks, the results on every key.
    if (shown.current) {
      shown.current = false;
      setSlow(false);
    }
    if (!pending) return;
    const timer = setTimeout(() => {
      shown.current = true;
      setSlow(true);
    }, 1000);
    return () => clearTimeout(timer);
  }, [pending]);
  return pending && slow;
}

function useSearchAnnouncement(
  channels: boolean,
  people: boolean,
  messages: boolean,
) {
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const sources = [
      channels && "channels",
      people && "people",
      messages && "messages",
    ].filter(Boolean);
    setAnnouncement((previous) => {
      if (!sources.length) return "";
      const names =
        sources.length === 3
          ? `${sources.slice(0, 2).join(", ")}, and ${sources[2]}`
          : sources.join(" and ");
      return previous || `Searching ${names}…`;
    });
  }, [channels, people, messages]);
  return announcement;
}

export function SearchResults({
  session,
  inlineSettings,
  query,
  onQueryChange,
  input,
  open,
  pages,
  scopedChannelId,
  currentChannelId,
  conversationBinding,
  onScopeChange,
  openConversation,
  openNewMessage,
  openAgentSession,
  usageScope,
  sidebarScope,
  views,
  offline,
  openAsk,
  decisions,
  community,
}: {
  session: RelaySession;
  /** Reranks message hits by how well each answers the query. */
  decisions?: Decisions | undefined;
  /** The community (its relay URL) a decision call bills. */
  community?: string | undefined;
  /** Open a new chat with `agent` that starts with `question`. */
  openAsk?:
    | ((question: string, agent: { pubkey: string; name: string }) => void)
    | undefined;
  /** Tabs that switch this search to other views of it. */
  views?: SearchViews | undefined;
  pages: readonly SearchDestination[];
  scopedChannelId?: string | undefined;
  currentChannelId?: string | undefined;
  /** The chord that searches the current conversation, hinted below. */
  conversationBinding?: KeyBinding | undefined;
  onScopeChange?: ((channelId?: string) => void) | undefined;
  openConversation: (
    channelId: string,
    messageId?: string,
    threadRootId?: string,
  ) => void;
  /** Open a New message draft to someone the viewer has no DM with. */
  openNewMessage: (pubkey: string) => void;
  /** Open a new Solo chat with one of the viewer's agents. Without it,
   * choosing one of their agents opens a direct message, as for anyone else. */
  openAgentSession?: ((pubkey: string) => void) | undefined;
  /** View-state partition whose visits and search choices rank results. */
  usageScope?: string | undefined;
  /** The sidebar's view scope, whose hidden DMs search leaves out too. */
  sidebarScope?: string | undefined;
  /** Why only saved conversations are searched. The relay's message, people
   * and open-channel lookups wait for the connection instead of failing. */
  offline?: ReactNode;
} & SearchInputProps) {
  const resolveName = useIdentityNames(session.names);
  const list = useChannelList(session.channels);
  // Chosen filters render as chips ahead of the typed text: the query holds
  // their exact operands first, then whatever the input shows.
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  /**
   * Reads chips back from a query's leading filter operands, as choosing them
   * made them. A query remembered between openings, or searched again, keeps
   * the exact operands but not the chips that show them by name.
   */
  const restoreChips = (text: string) => {
    const restored: SearchChip[] = [];
    const token = /(\S+)(?: |$)/y;
    let end = 0;
    for (let match = token.exec(text); match; match = token.exec(text)) {
      const operand = match[1] ?? "";
      const [, operator = "", value = ""] =
        /^([a-z]+):(.*)$/i.exec(operand) ?? [];
      const kind = operator.toLowerCase();
      const pubkey = value.replace(/^@/, "");
      const person =
        (kind === "from" && isHexPubkey(value)) ||
        (kind === "in" && value.startsWith("@") && isHexPubkey(pubkey));
      const channel =
        kind === "in" && !person
          ? list.channels.find(({ id }) => id === value)
          : undefined;
      if (kind === "from" && isViewerHandle(value))
        restored.push({
          operand,
          text: operand,
          edit: operand,
          label: "Remove author me",
        });
      else if (person) {
        const name = resolveName(
          pubkey,
          profiles.get(pubkey)?.name ?? pubkey.slice(0, 10),
        );
        restored.push({
          operand,
          text: `${kind}:@${name}`,
          edit: `${kind}:@${name.split(/\s/)[0]}`,
          label: `Remove ${kind === "in" ? "conversation with" : "author"} ${name}`,
          title: npubEncode(pubkey),
        });
      } else if (channel)
        restored.push({
          operand,
          text: `in:#${channel.name}`,
          edit: `in:#${channel.name}`,
          label: `Remove channel ${channel.name}`,
          title: channel.id,
        });
      // Only a date the parser reads; anything else is literal text.
      else if (
        /^(after|before|on|during)$/.test(kind) &&
        !parseSearchOperators(operand).text
      )
        restored.push({
          operand,
          text: operand,
          edit: operand,
          label: `Remove date ${operand}`,
        });
      else break;
      end = token.lastIndex;
    }
    return { chips: restored, visible: text.slice(end) };
  };
  const [chipState, setChipState] = useState<{
    query: string;
    chips: readonly SearchChip[];
  }>();
  const [openingQuery] = useState(query);
  const chips =
    chipState?.query === query
      ? chipState.chips
      : query === openingQuery
        ? restoreChips(query).chips
        : [];
  const chipPrefix = chips.map(({ operand }) => `${operand} `).join("");
  const displayQuery = chips.length
    ? query.slice(chipPrefix.length)
    : undefined;
  // `ask:` hands the question to the default agent instead of searching. It
  // follows any chosen filters, which stay in the question as they read.
  const visibleQuery = displayQuery ?? query;
  const askMatch = /^\s*ask:\s*/i.exec(visibleQuery);
  const asking = !!askMatch;
  const askText = askMatch ? visibleQuery.slice(askMatch[0].length).trim() : "";
  const question = askMatch
    ? [...chips.map(({ text }) => text), askText].filter(Boolean).join(" ")
    : "";
  // The filter guide shows over the results until the query changes, so
  // choosing a filter, or typing, goes back to them for good.
  const [guideQuery, setGuideQuery] = useState<string>();
  if (guideQuery !== undefined && guideQuery !== query)
    setGuideQuery(undefined);
  const guideOpen = guideQuery === query && !asking;
  const parsed = useMemo(
    () => parseSearchOperators(asking ? "" : query.trim()),
    [query, asking],
  );
  // `in:@` names a person too, so it shares the author picker. A question
  // for an agent is prose: its operators open no picker.
  const authorPrompt = asking
    ? undefined
    : operatorMatches(query, /(?:^|\s)(from:@?|in:@)([^\s]*)$/gi).at(-1);
  // `me` is the viewer, never a name to pick.
  const pickerPrompt =
    !!authorPrompt &&
    !isHexPubkey(authorPrompt[2] ?? "") &&
    !isViewerHandle(authorPrompt[2] ?? "");
  const channels = useMemo(
    () =>
      list.channels.filter(
        (channel) =>
          !channel.huddle &&
          !channel.metadataPending &&
          (!channel.archived ||
            // A saved member row stays read-only until the relay confirms it.
            // A guest's archived row stays out, as it does live.
            ((!channel.readOnly ||
              (channel.cached && channel.viewerRole !== "guest")) &&
              (channel.channelType === "stream" ||
                channel.channelType === "forum" ||
                channel.channelType === "solo"))) &&
          (!channel.hidden || channel.channelType === "dm") &&
          (!scopedChannelId || channel.id === scopedChannelId),
      ),
    [list.channels, scopedChannelId],
  );
  // A DM hidden from the sidebar (Close conversation, or Hide conversation) has
  // no row here either. Its messages still match, and choosing the person
  // opens it again through the confirmed open, which restores its sidebar row.
  const dmVisibility = useSyncExternalStore(
    session.channelLifecycle.subscribe,
    session.channelLifecycle.snapshot,
    session.channelLifecycle.snapshot,
  );
  const savedHidden = useSavedHiddenDmIds(sidebarScope);
  const sidebarHidden = (channel: ChannelSummary) =>
    channel.channelType === "dm" &&
    (savedHidden.has(channel.id) || dmVisibility.hidden.includes(channel.id));
  const setChipQuery = (next: readonly SearchChip[], visible: string) => {
    const nextQuery = `${next.map(({ operand }) => `${operand} `).join("")}${visible}`;
    setChipState(next.length ? { query: nextQuery, chips: next } : undefined);
    onQueryChange(nextQuery);
  };
  const updateDisplayQuery = (value: string) => {
    // `?` typed alone opens the filter guide rather than searching for it.
    if (value.trim() === "?" && !visibleQuery.trim()) {
      setGuideQuery(query);
      return;
    }
    if (chips.length) setChipQuery(chips, value.trimStart());
    else onQueryChange(value);
  };
  const removeChip = (chip: SearchChip) => {
    setChipQuery(
      chips.filter((other) => other !== chip),
      displayQuery ?? "",
    );
    input.current?.focus();
  };
  /**
   * Backspace before the text turns the last chip back into its text. It ends
   * the query, where its picker opens again to choose an exact value.
   */
  const editLastChip = () => {
    const last = chips.at(-1);
    if (!last) return;
    const text = displayQuery?.trimEnd();
    setChipQuery(chips.slice(0, -1), text ? `${text} ${last.edit}` : last.edit);
  };
  /**
   * Replace the operator token at `tokenStart` with a chip. A chip for the
   * same operator is replaced; other operators are independent filters. The
   * parser keeps the last `from:` or `in:`, so a typed one ahead of the chip
   * would win: it goes too, outside quotes. Date bounds intersect instead.
   */
  const selectChip = (
    tokenStart: number,
    tokenEnd: number,
    chip: SearchChip,
  ) => {
    const operator = (operand: string) =>
      operand.slice(0, operand.indexOf(":")).toLowerCase();
    const visible = `${query.slice(chipPrefix.length, tokenStart)}${query.slice(tokenEnd).trimStart()}`;
    const kind = operator(chip.operand);
    setChipQuery(
      [...chips.filter((other) => operator(other.operand) !== kind), chip],
      kind === "from" || kind === "in"
        ? visible
            .replace(
              new RegExp(`"[^"]*"?|(^|\\s)${kind}:\\S*`, "gi"),
              (token, lead?: string) =>
                token.startsWith('"') ? token : (lead ?? ""),
            )
            .trimStart()
        : visible,
    );
    input.current?.focus();
  };
  const [authorSuggestions, setAuthorSuggestions] = useState<{
    query: string;
    savedOnly: boolean;
    lookupFailed?: boolean;
    remote: readonly RelayEvent[];
  }>();
  // Completing either from:name or from:@name selects an exact signed key.
  const datePrompt = asking
    ? undefined
    : operatorMatches(query, /(?:^|\s)(after|before|on|during):([^\s]*)$/gi).at(
        -1,
      );
  const showDateChoices =
    !!datePrompt && parseSearchOperators(datePrompt[0]).text !== "";
  const dateOperator = showDateChoices ? datePrompt?.[1]?.toLowerCase() : "";
  /** Replace the unfinished date token with a completed `operator:value`. */
  const completeDate = (operand: string) =>
    selectChip(
      (datePrompt?.index ?? query.length) +
        (datePrompt?.[0].match(/^\s*/)?.[0].length ?? 0),
      query.length,
      {
        operand,
        text: operand,
        edit: operand,
        label: `Remove date ${operand}`,
      },
    );
  const localDate = (day: Date) =>
    `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  // `on:` picks a day from the calendar instead; `during:` names periods.
  const datePresets =
    dateOperator === "during"
      ? ([
          "Past 7 days",
          "Past 30 days",
          "Past 3 months",
          "Past 12 months",
          "Today",
          "Yesterday",
          "This week",
          "This month",
          "This year",
        ] as const)
      : dateOperator === "on"
        ? []
        : ([
            "Today",
            "Yesterday",
            "This week",
            "Last week",
            "This month",
          ] as const);
  const dateChoices: SearchDestination[] = datePresets.map((label) => {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    if (label === "Yesterday") day.setDate(day.getDate() - 1);
    if (label === "This week" || label === "Last week")
      day.setDate(
        day.getDate() -
          ((day.getDay() + 6) % 7) -
          (label === "Last week" ? 7 : 0),
      );
    if (label === "This month") day.setDate(1);
    const date = localDate(day);
    // There is no week period, so `during:` this week starts after its Monday.
    const rolling = {
      "Past 7 days": "7d",
      "Past 30 days": "30d",
      "Past 3 months": "3m",
      "Past 12 months": "12m",
    }[label as string];
    const operand = rolling
      ? `during:${rolling}`
      : dateOperator !== "during"
        ? `${datePrompt?.[1]}:${date}`
        : label === "This week"
          ? `after:${date}`
          : label === "This month"
            ? `during:${date.slice(0, 7)}`
            : label === "This year"
              ? `during:${date.slice(0, 4)}`
              : `during:${date}`;
    return {
      key: `date:${label}`,
      label,
      detail: operand.slice(operand.indexOf(":") + 1),
      icon: CalendarIcon,
      run: () => completeDate(operand),
    };
  });
  // Every keystroke renders; DM names only change with their inputs.
  const names = useMemo(
    () =>
      new Map(
        channels.map((channel) => [
          channel.id,
          conversationName(channel, profiles, resolveName),
        ]),
      ),
    [channels, profiles, resolveName],
  );
  const operatorChannel = parsed.in ? normalizeInChannel(parsed.in) : "";
  // `in:@person` names your direct message with them, by key, `me` or name.
  const operatorPerson = operatorChannel.startsWith("@")
    ? normalizeFromHandle(operatorChannel)
    : undefined;
  const operatorPersonKey =
    operatorPerson && isViewerHandle(operatorPerson)
      ? session.viewer
      : operatorPerson && isHexPubkey(operatorPerson)
        ? operatorPerson.toLowerCase()
        : undefined;
  const sameName = (name: string | undefined, wanted: string) =>
    !!name && !!wanted && normalizeName(name) === normalizeName(wanted);
  /** Whether `channel` is the conversation the `in:` operator names. */
  const matchesInOperator = (channel: ChannelSummary) => {
    if (channel.huddle) return false;
    if (operatorPerson === undefined)
      return (
        channel.name.toLowerCase() === operatorChannel.toLowerCase() ||
        names.get(channel.id)?.toLowerCase() === operatorChannel.toLowerCase()
      );
    if (channel.channelType !== "dm") return false;
    const others = channel.participants;
    // A self-DM lists no other participants.
    if (operatorPersonKey && operatorPersonKey === session.viewer)
      return others?.length === 0;
    // Only a one-to-one DM names a single person.
    if (others?.length !== 1) return false;
    if (operatorPersonKey) return others[0] === operatorPersonKey;
    return (
      sameName(names.get(channel.id), operatorPerson) ||
      sameName(profiles.get(others[0] ?? "")?.name, operatorPerson)
    );
  };
  const namedChannels =
    !operatorChannel || isChannelUuid(operatorChannel)
      ? []
      : list.channels.filter(matchesInOperator);
  const needsPublicLookup =
    !offline &&
    !scopedChannelId &&
    !!operatorChannel &&
    operatorPerson === undefined &&
    !isChannelUuid(operatorChannel);
  const operatorPublicChannels = usePublicChannelSearch(
    session,
    needsPublicLookup ? operatorChannel : "",
    list.status === "ready",
    true,
  );
  const operatorLookupPending =
    needsPublicLookup &&
    (list.status !== "ready" || operatorPublicChannels.loading);
  const operatorLookupError = needsPublicLookup
    ? operatorPublicChannels.error
    : undefined;
  // Joined and open namesakes compete together. A live conversation outranks
  // an archived namesake; live namesakes are ambiguous, so the search waits
  // for a clearer name rather than guess. Cached rows shown while the exact
  // lookup runs may miss a namesake, so only its settled answer resolves.
  const namedCandidates = [
    ...namedChannels,
    ...operatorPublicChannels.channels.filter(
      ({ id }) => !namedChannels.some((channel) => channel.id === id),
    ),
  ];
  const liveNamed = namedCandidates.filter((channel) => !channel.archived);
  const inMatches = liveNamed.length ? liveNamed : namedCandidates;
  const operatorChannelId = isChannelUuid(operatorChannel)
    ? operatorChannel
    : !operatorLookupPending && !operatorLookupError && inMatches.length === 1
      ? inMatches[0]?.id
      : undefined;
  const operatorChannelAmbiguous = inMatches.length > 1;
  // An unfinished `in:` or `in:#` names a channel to pick, as `from:` names a
  // person.
  const channelPrompt = asking
    ? undefined
    : operatorMatches(query, /(?:^|\s)in:(?!@)(#?)([^\s]*)$/gi).at(-1);
  const showChannelPicker =
    !!channelPrompt && !isChannelUuid(channelPrompt[2] ?? "");
  const channelNeedle = (channelPrompt?.[2] ?? "").toLowerCase();
  const startsWithNeedle = (channel: ChannelSummary) =>
    channel.name.toLowerCase().startsWith(channelNeedle);
  const channelChoices: SearchDestination[] =
    showChannelPicker && channelPrompt
      ? channels
          .filter(
            (channel) =>
              channel.channelType !== "dm" &&
              channel.channelType !== "solo" &&
              channel.name.toLowerCase().includes(channelNeedle),
          )
          .sort(
            (a, b) =>
              Number(startsWithNeedle(b)) - Number(startsWithNeedle(a)) ||
              Number(!!a.archived) - Number(!!b.archived),
          )
          .slice(0, 12)
          .map((channel) => ({
            key: `in:${channel.id}`,
            label: channel.name,
            detail: channel.archived ? "Archived channel" : "Channel",
            icon: ChatCircleIcon,
            // The id keeps the choice exact past any namesake; the chip shows
            // its name.
            run: () =>
              selectChip(
                channelPrompt.index +
                  (channelPrompt[0].match(/^\s*/)?.[0].length ?? 0),
                query.length,
                {
                  operand: `in:${channel.id}`,
                  text: `in:#${channel.name}`,
                  edit: `in:#${channel.name}`,
                  label: `Remove channel ${channel.name}`,
                  title: channel.id,
                },
              ),
          }))
      : [];
  // The author picker also matches a selectable agent by its own name, so a
  // completed from: name resolves against the same names.
  const agentSnapshot = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  // `ask:` and the Ask row start a chat with the agent New chat would tag,
  // read only once there is something to ask.
  const [askAgent, setAskAgent] = useState<MentionRecipient>();
  // Search unmounts as it closes, so each opening reads previews afresh.
  const [previews] = useState<PreviewCache>(() => new Map());
  // Each opening starts from the saved order; the Sort menu overrides it
  // for this search only.
  const [sort, setSort] = useState<SearchSort>(messageSortPreference);
  // The chip or a single resolved `in:` limits results to one conversation.
  const effectiveChannelId = scopedChannelId ?? operatorChannelId;
  const canRerank = useCanRerank(decisions);
  // One search: its text within its conversation. Changing either reads a
  // new set of hits.
  const searchKey = JSON.stringify([effectiveChannelId ?? null, query]);
  // A provider that stops being able to answer, as a key found missing does,
  // leaves this search's hits and order as they are: only a new search drops
  // them.
  const [rerankFor, setRerankFor] = useState<string>();
  if (canRerank && rerankFor !== searchKey) setRerankFor(searchKey);
  const rerankable = canRerank || rerankFor === searchKey;
  const search = useSearchMessages(
    session,
    offline || asking ? "" : query,
    scopedChannelId,
    operatorChannelId,
    new Map(
      agentSnapshot.selectable
        .filter(
          (agent) =>
            !archiveHides(session.archives, agent.pubkey, session.viewer),
        )
        .map((agent) => [agent.pubkey, agent.name]),
    ),
    // Only one conversation's results offer the choice; across
    // conversations, search keeps relevance.
    effectiveChannelId ? sort : "relevance",
    rerankable ? RERANK_PAGES : 1,
  );
  // Offline or asking, nothing is searched, so there is no order to choose.
  const sortable =
    !offline &&
    !asking &&
    !!effectiveChannelId &&
    session.searchSort &&
    !!parsed.text;
  const order = search.newestFirst ? "Most recent" : "Most relevant";
  const showAmbiguousPicker = !!search.ambiguousAuthor && !pickerPrompt;
  // Ambiguity is known only after a completed token. Keep its original span so
  // choosing a key does not discard free text or other operators after it.
  const completedAuthor = showAmbiguousPicker
    ? operatorMatches(query, /(?:^|\s)from:(@?)(\S+)/gi).at(-1)
    : undefined;
  const authorToken = authorPrompt ?? completedAuthor;
  const authorNeedle = (authorPrompt?.[2] ?? parsed.from ?? "")
    .replace(/^@/, "")
    .toLowerCase();
  const showAuthorPicker = pickerPrompt || showAmbiguousPicker;
  const agents = useAgentChoices(session, showAuthorPicker && !offline);
  // People and agents are destinations for plain typed text outside a
  // conversation scope; an operator asks for messages. `@` asks for a person
  // and `#` for a channel.
  const peopleText = parsed.text.trim();
  const peopleNeedle = peopleText.replace(/^@/, "");
  const hasOperator =
    parsed.from !== null ||
    parsed.in !== null ||
    parsed.since !== null ||
    parsed.until !== null;
  const peopleActive =
    !offline &&
    !scopedChannelId &&
    !hasOperator &&
    !showAuthorPicker &&
    !showDateChoices &&
    !showChannelPicker &&
    !!peopleNeedle &&
    !peopleText.startsWith("#");
  const personDirectory = usePersonDirectory(
    session,
    peopleNeedle,
    peopleActive,
  );
  // Typing cancels the page's read; the next settled page reads again.
  const directoryVerified = useVerifiedNames(session, personDirectory.people, {
    key: peopleNeedle,
    settled: !personDirectory.loading,
  });
  useMentionArchives(session, (showAuthorPicker && !offline) || peopleActive);
  // People labels come from one names scope built each render.
  useNamesRevision(session.names, peopleActive || showAuthorPicker);
  // The viewer's own agents open a new chat, not a direct message: the
  // same agents the new-chat composer accepts. Their earlier chats
  // still show as conversations.
  const sessionSearch = !!openAgentSession && peopleActive;
  const ownAgents = useAgentChoices(session, sessionSearch, sessionSearch);
  const sessionAgents = new Map(
    (sessionSearch ? ownAgents.selectable : []).map((agent) => [
      agent.pubkey,
      agent,
    ]),
  );
  // The notice is a new element each render; the lookup below reruns only
  // when search goes offline or back.
  const savedOnly = !!offline;
  useEffect(() => {
    if (!showAuthorPicker) return;
    const controller = new AbortController();
    const cancel = searchDebounce(() => {
      void (async () => {
        const members = effectiveChannelId
          ? (session.channels.get?.(effectiveChannelId)?.members ?? [])
          : [];
        // Offline, the picker offers only members and profiles already known.
        // No longer name finds more, so it asks for the connection instead.
        if (members.length && !savedOnly) {
          try {
            await session.profiles.ensure(members, "foreground");
          } catch (error) {
            if (controller.signal.aborted) throw error;
            // A partial directory still contains verified member profiles.
          }
        }
        let remote: readonly RelayEvent[] = [];
        let lookupFailed = false;
        if (!savedOnly && searchable(authorNeedle)) {
          try {
            remote = await session.searchProfiles(authorNeedle, {
              limit: 40,
              signal: controller.signal,
            });
          } catch (error) {
            if (controller.signal.aborted) throw error;
            lookupFailed = true;
          }
        }
        controller.signal.throwIfAborted();
        setAuthorSuggestions({ query, savedOnly, lookupFailed, remote });
      })().catch(() => {
        if (!controller.signal.aborted)
          setAuthorSuggestions({
            query,
            savedOnly,
            remote: [],
            lookupFailed: true,
          });
      });
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [
    session,
    effectiveChannelId,
    query,
    authorNeedle,
    showAuthorPicker,
    savedOnly,
  ]);
  // The lookup answers this text in this connection state: once the session
  // is live, saved data's answer no longer stands.
  const authorAnswer =
    authorSuggestions?.query === query &&
    authorSuggestions.savedOnly === savedOnly
      ? authorSuggestions
      : undefined;
  const members = effectiveChannelId
    ? (session.channels.get?.(effectiveChannelId)?.members ?? [])
    : [];
  const knownAgents = new Set(agents.identities.map(({ pubkey }) => pubkey));
  const selectableAgents = new Map(
    agents.selectable.map((agent) => [agent.pubkey, agent]),
  );
  const remoteAuthors = searchedProfiles(
    authorAnswer?.remote ?? [],
    session.profiles.verifiedAuthority?.(),
  );
  const candidates = new Map([
    ...members.map(
      (pubkey) =>
        [
          pubkey,
          profiles.get(pubkey) ?? {
            name: pubkey.slice(0, 10),
            nameIsFallback: true,
          },
        ] as const,
    ),
    ...agents.selectable.map(
      (agent) =>
        [
          agent.pubkey,
          profiles.get(agent.pubkey) ?? {
            name: agent.name,
            isAgent: true as const,
            ...(agent.avatar ? { picture: agent.avatar } : {}),
          },
        ] as const,
    ),
    ...remoteAuthors,
  ]);
  const authorPeople = (showAuthorPicker ? [...candidates] : []).map(
    ([pubkey, profile]) => ({
      pubkey,
      ...profile,
    }),
  );
  const authorVerified = useVerifiedNames(
    session,
    [...candidates].map(([pubkey, profile]) => ({
      pubkey,
      isAgent: profile.isAgent || knownAgents.has(pubkey),
    })),
    {
      key: query,
      settled: showAuthorPicker && !!authorAnswer && !savedOnly,
    },
  );
  const preference = useNamePreference();
  const namedAuthors = withVerifiedNames(
    authorPeople,
    authorVerified,
    profiles,
    preference,
  );
  const authorNames = session.names.scope(
    effectiveChannelId ? members : undefined,
    namedAuthors.filter(
      ({ pubkey }) =>
        authorVerified.has(pubkey) && !profiles.get(pubkey)?.verified,
    ),
  );
  // Match both verified names regardless of the display preference, retaining
  // the profile and selectable-agent aliases the picker already accepted.
  const originalAuthors = foldProfiles(
    [...candidates.keys()].flatMap((pubkey) => {
      const event = session.profiles.event?.(pubkey);
      return event ? [event] : [];
    }),
  );
  const rankedAuthors = namedAuthors.map((profile) => {
    const { pubkey } = profile;
    const original = originalAuthors.get(pubkey);
    const found = authorNames(pubkey);
    const verified =
      profiles.get(pubkey)?.verified ?? authorVerified.get(pubkey);
    const label =
      (found?.source === "public-profile" && authorVerified.has(pubkey)
        ? undefined
        : found?.name) ?? profile.name;
    const tier = Math.min(
      ...[
        label,
        profile.name,
        profile.username,
        profile.fullName,
        ...(profile.profileNames ?? []),
        original?.name,
        original?.username,
        selectableAgents.get(pubkey)?.name,
      ].map((alias) =>
        alias === undefined
          ? Infinity
          : (matchPerson(alias, authorNeedle)?.tier ?? Infinity),
      ),
    );
    return { pubkey, profile, label, verified, tier };
  });
  const authorChoices =
    authorToken && showAuthorPicker && authorAnswer
      ? rankedAuthors
          .filter(({ tier }) => tier < 4)
          .filter(
            ({ pubkey }) =>
              !archiveHides(session.archives, pubkey, session.viewer) &&
              (!knownAgents.has(pubkey) || selectableAgents.has(pubkey)),
          )
          // Exact names survive the cap when the resolver reports ambiguity.
          .sort(
            (
              { pubkey: left, profile: leftProfile, tier: leftTier },
              { pubkey: right, profile: rightProfile, tier: rightTier },
            ) =>
              Number(rightTier === 0) - Number(leftTier === 0) ||
              Number(!!leftProfile.isAgent || knownAgents.has(left)) -
                Number(!!rightProfile.isAgent || knownAgents.has(right)) ||
              Number(members.includes(right)) - Number(members.includes(left)),
          )
          .slice(0, 12)
          .map(({ pubkey, profile, label, verified }) => {
            const agent = selectableAgents.get(pubkey);
            const isAgent = !!agent || !!profile.isAgent;
            return {
              key: `author:${pubkey}`,
              label,
              detail: [
                verified &&
                  otherVerifiedName(
                    verifiedLabel(verified, preference),
                    verified,
                  ),
                pubkey.slice(0, 12),
              ]
                .filter(Boolean)
                .join(" · "),
              icon: ChatCircleIcon,
              avatar: {
                src: avatarMedia(
                  profile.picture ?? agent?.avatar,
                  session.media,
                ),
                shape: isAgent ? ("squircle" as const) : ("circle" as const),
              },
              isAgent,
              run: () => {
                const conversation = /^in:/i.test(authorToken[0].trimStart());
                const operator = conversation ? "in" : "from";
                const tokenEnd = authorToken.index + authorToken[0].length;
                selectChip(
                  tokenEnd - authorToken[0].trimStart().length,
                  tokenEnd,
                  {
                    operand: conversation ? `in:@${pubkey}` : `from:${pubkey}`,
                    text: `${operator}:@${label}`,
                    // Its first word reopens the picker on this person.
                    edit: `${operator}:@${label.split(/\s/)[0]}`,
                    label: `Remove ${conversation ? "conversation with" : "author"} ${label}`,
                    title: npubEncode(pubkey),
                  },
                );
              },
            };
          })
      : [];
  const publicChannels = usePublicChannelSearch(
    session,
    scopedChannelId || hasOperator || offline ? "" : parsed.text,
    list.status === "ready",
  );
  // Scoped search passes no text, so the lookup is idle there.
  const slowChannels = useDelayedSearch(publicChannels.loading);
  const slowPeople = useDelayedSearch(peopleActive && personDirectory.loading);

  const profileKey = withMentionedIds(
    [
      ...channels.flatMap((channel) =>
        channel.channelType === "dm" ? (channel.participants ?? []) : [],
      ),
      ...search.messages.flatMap((message) => [
        message.authorId,
        ...(message.workflowOwnerId ? [message.workflowOwnerId] : []),
      ]),
      ...personDirectory.people.flatMap((person) =>
        person.ownerPubkey ? [person.ownerPubkey] : [],
      ),
    ],
    search.messages.map((message) => message.mentioned),
  )
    .sort()
    .slice(0, 1024)
    .join(":");
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (profileKey)
      void session.profiles
        .ensure(profileKey.split(":"), "background")
        .catch(() => {});
  }, [session, profileKey, profileGeneration]);
  const needle = parsed.text.toLowerCase().replace(/^#/, "");
  // Read once per opening, so usage recorded while it is open cannot reorder it.
  const usage = useMemo(
    () => (usageScope ? readSearchUsage(usageScope) : noSearchUsage),
    [usageScope],
  );
  const recentSearches = useMemo(
    () => (usageScope ? readRecentSearches(usageScope) : []),
    [usageScope],
  );
  const remember = () => {
    if (usageScope && query.trim()) recordRecentSearch(usageScope, query);
  };
  const choose = (key: string, run: () => void) => () => {
    if (usageScope) recordChoice(usageScope, needle, key);
    remember();
    cancelPersonOpen(key);
    run();
  };
  const messageableAgents = new Map(
    agents.identities
      .filter(canMessageAgent)
      .map((agent) => [agent.pubkey, agent]),
  );
  const people: (PersonCandidate & { picture?: string | undefined })[] = [];
  if (peopleActive) {
    const relationships = peopleRelationships(
      list.channels,
      new Set(messageableAgents.keys()),
    );
    const knownAgents = knownAgentPubkeys(profiles, {
      definitions: [],
      identities: agents.identities,
    });
    const sources = new Map<
      string,
      {
        name: string;
        username?: string | undefined;
        picture?: string | undefined;
        isAgent?: boolean | undefined;
      }
    >();
    // Ties keep this order, as in New message: the directory's rows first, in
    // the relay's order, then cached profiles, then agents. A cached profile
    // still supplies a directory row's facts. Where the shared profiles have
    // not verified a row, a name verified for this page names it as they would.
    const cached = (pubkey: string) => {
      const profile = profiles.get(pubkey);
      return profile && (!profile.nameIsFallback || profile.username)
        ? profile
        : undefined;
    };
    const pageVerified = (pubkey: string) =>
      profiles.get(pubkey)?.verified
        ? undefined
        : directoryVerified.get(pubkey);
    const verifiedOf = (pubkey: string) =>
      profiles.get(pubkey)?.verified ?? pageVerified(pubkey);
    const searched = new Map<string, readonly string[]>();
    for (const person of personDirectory.people) {
      const source = cached(person.pubkey) ?? person;
      const found = pageVerified(person.pubkey);
      // The relay matched these names; a verified name must not lose the row.
      searched.set(
        person.pubkey,
        [person.name, person.username].filter((name) => name !== undefined),
      );
      sources.set(
        person.pubkey,
        found
          ? { ...source, name: verifiedLabel(found), username: found.username }
          : source,
      );
    }
    for (const [pubkey, profile] of profiles)
      if (!sources.has(pubkey) && cached(pubkey)) sources.set(pubkey, profile);
    for (const agent of [
      ...messageableAgents.values(),
      ...sessionAgents.values(),
    ])
      if (!sources.has(agent.pubkey))
        sources.set(agent.pubkey, {
          name: agent.name,
          picture: agent.avatar,
          isAgent: true,
        });
    const eligible = [...sources].flatMap(([pubkey, source]) => {
      const agent =
        !!source.isAgent ||
        knownAgents.has(pubkey) ||
        sessionAgents.has(pubkey);
      // As in New message, agent DM eligibility comes from the shared choices.
      return pubkey === session.viewer ||
        (agent &&
          !messageableAgents.has(pubkey) &&
          !sessionAgents.has(pubkey)) ||
        agentUnavailable(session, pubkey)
        ? []
        : [{ pubkey, source, agent }];
    });
    // Namesakes are told apart within these destinations. Directory rows that
    // the shared profile cache does not name supply their own names.
    const candidates = eligible.map(({ pubkey }) => pubkey);
    const displayFacts = personDirectory.people.flatMap((person) => {
      const source = sources.get(person.pubkey);
      return source && source !== profiles.get(person.pubkey)
        ? [
            {
              pubkey: person.pubkey,
              name: source.name,
              ...(person.isAgent ? { isAgent: true } : {}),
              ...(person.ownerPubkey
                ? { ownerPubkey: person.ownerPubkey }
                : {}),
            },
          ]
        : [];
    });
    const named = session.names?.scope(candidates, displayFacts);
    for (const { pubkey, source, agent } of eligible) {
      const dm = relationships.dm(pubkey);
      const agentName =
        messageableAgents.get(pubkey)?.name ?? sessionAgents.get(pubkey)?.name;
      // Without a naming policy the scope falls back to the public profile,
      // which must not outrank a name verified for this page.
      const found = named?.(pubkey);
      const label =
        (found?.source === "public-profile" && pageVerified(pubkey)
          ? undefined
          : found?.name) ?? source.name;
      const fullName = verifiedOf(pubkey)?.fullName;
      people.push({
        pubkey,
        label,
        // A verified username or full name is often the label itself.
        username: source.username !== source.name ? source.username : undefined,
        fullName: fullName !== label ? fullName : undefined,
        agentName: agentName !== source.name ? agentName : undefined,
        profileNames: searched.get(pubkey),
        agent,
        relationship: relationships.rank(pubkey),
        usageKeys: [personKey(pubkey), ...(dm ? [`channel:${dm}`] : [])],
        picture:
          source.picture ??
          messageableAgents.get(pubkey)?.avatar ??
          sessionAgents.get(pubkey)?.avatar,
      });
    }
  }
  // Several passes below rank the same names; rank each once per render.
  const ranks = new Map<string, MatchRank | undefined>();
  const rankName = (label: string) => {
    if (!ranks.has(label)) ranks.set(label, matchRank(label, needle));
    return ranks.get(label);
  };
  // What the viewer chose before for this typed text. Only candidates that
  // match count, so a stale choice cannot add a row.
  const picked = usage.pick(
    needle,
    new Set([
      ...channels
        .filter(
          ({ id }) =>
            parsed.text && rankName(names.get(id) ?? "") !== undefined,
        )
        .map(({ id }) => `channel:${id}`),
      ...publicChannels.channels.map(({ id }) => `channel:${id}`),
      ...pages.map(({ key }) => key),
      ...people.map(({ pubkey }) => personKey(pubkey)),
    ]),
  );
  // Rank before the limit, so an exact name beyond the first eight still shows.
  // The store matches public channels by the same rule (`matchRank`).
  // The shared search order, with archived channels half a step behind live
  // ones in the same place.
  const rankOf = (label: string, key: string, archived?: boolean) => {
    const rank = rankName(label) ?? MatchRank.words + 1;
    return searchOrder(usage, picked, { key, rank }) + (archived ? 0.5 : 0);
  };
  /** Whether a search order is an exact name, live (-2) or archived (-1.5). */
  const exact = (rank: number) => rank < -1;
  const byMatch = <T,>(rows: readonly T[], rank: (row: T) => number) =>
    rows
      .map((row) => ({ row, rank: rank(row) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ row }) => row);
  const channelRank = (channel: ChannelSummary) =>
    rankOf(
      names.get(channel.id) ?? channel.name,
      `channel:${channel.id}`,
      channel.archived,
    );
  const matchingAll = byMatch(
    channels.filter(
      (channel) =>
        parsed.text &&
        !sidebarHidden(channel) &&
        rankName(names.get(channel.id) ?? "") !== undefined,
    ),
    channelRank,
  );
  // One of the viewer's own agents leads with its "New chat" row. Its
  // existing chats follow that row, and its DM comes after them: chats, not
  // DMs, are where the viewer works with their agents. Removing DM-listed
  // people below only lifts the rest, so a row shown here still shows in the
  // Agents group.
  const bestieDmId = useBestieConversation(session);
  const newChats = new Map(
    rankPeople(
      people.filter(({ agent }) => agent),
      peopleNeedle,
      usage,
      picked,
    )
      .slice(0, PERSON_ROWS)
      .filter(({ person }) => sessionAgents.has(person.pubkey))
      .map(({ person, score }) => [
        person.pubkey,
        { score, label: person.label },
      ]),
  );
  /** The best-placed shown agent among these members, if any. */
  const newChatAmong = (members: readonly string[] | undefined) =>
    (members ?? [])
      .flatMap((pubkey) => newChats.get(pubkey) ?? [])
      .sort((a, b) => a.score - b.score)[0];
  const dmAgent = (channel: ChannelSummary) =>
    channel.participants?.length === 1
      ? newChats.get(channel.participants[0] ?? "")
      : undefined;
  const dmRank = (channel: ChannelSummary) => {
    const agent = dmAgent(channel);
    return Math.max(
      channelRank(channel),
      agent ? agent.score + 0.5 : -Infinity,
    );
  };
  const directMessageResults = byMatch(
    matchingAll.filter((channel) => channel.channelType === "dm"),
    dmRank,
  ).slice(0, 8);
  // A person whose DM row already shows needs no second row to the same
  // place. An agent's "New chat" row goes somewhere else, so it stays.
  const listedDms = new Set(
    directMessageResults.flatMap((channel) =>
      channel.participants?.length === 1 && !dmAgent(channel)
        ? channel.participants
        : [],
    ),
  );
  const rankedPeople = rankPeople(
    people.filter(({ pubkey }) => !listedDms.has(pubkey)),
    peopleNeedle,
    usage,
    picked,
  );
  // Solo chats, by name or by a shown agent among their members. A chat whose
  // name is the exact text comes first. Chats with that agent come next, in
  // the agent's order, so they follow its "New chat" row; other chats found
  // by name come after them. Live chats come before archived ones, and newer
  // before older.
  // A chat's exactness comes from its own name only. A chat found through an
  // exactly named agent inherits the agent's score but is not an exact name.
  const chatRank = (channel: ChannelSummary) => {
    const named = matchingAll.includes(channel)
      ? channelRank(channel)
      : Infinity;
    return exact(named)
      ? { rank: named, exactName: true }
      : {
          rank: newChatAmong(channel.members)?.score ?? named,
          exactName: false,
        };
  };
  const chatResults = channels
    .filter(
      (channel) =>
        channel.channelType === "solo" &&
        (!!newChatAmong(channel.members) || matchingAll.includes(channel)),
    )
    .map((channel) => ({
      channel,
      agent: !!newChatAmong(channel.members),
      ...chatRank(channel),
    }))
    .sort(
      (a, b) =>
        Number(b.exactName) - Number(a.exactName) ||
        Number(b.agent) - Number(a.agent) ||
        a.rank - b.rank ||
        Number(!!a.channel.archived) - Number(!!b.channel.archived) ||
        (b.channel.lastActivityAt ?? b.channel.updatedAt ?? 0) -
          (a.channel.lastActivityAt ?? a.channel.updatedAt ?? 0),
    )
    .slice(0, 8);

  const joinedAll = matchingAll.filter(
    (channel) => channel.channelType !== "dm" && channel.channelType !== "solo",
  );
  // Joined and public channels share one ranking before the limit, so the row
  // that gives the group its best rank, such as a remembered public channel,
  // is the row shown first. Joined channels win ties.
  const channelResults = byMatch(
    [
      ...joinedAll,
      ...publicChannels.channels.filter(
        (channel) => !joinedAll.some(({ id }) => id === channel.id),
      ),
    ],
    channelRank,
  ).slice(0, 8);
  // Display only; joined rows count the roster they carry.
  const memberCounts = useMemberCounts(session.channels);
  const memberCount = (channel: ChannelSummary) =>
    channel.members?.length || memberCounts.counts.get(channel.id);
  // A chat found by its agent, not its name, says which agent it has.
  const soloDetail = (channel: ChannelSummary) => {
    const agent = newChatAmong(channel.members);
    return agent && !matchingAll.includes(channel)
      ? `Chat with ${agent.label}`
      : "Chat";
  };
  const conversationDestination = (
    channel: ChannelSummary,
  ): SearchDestination => {
    const label = names.get(channel.id) ?? channel.name;
    const matches = needle ? matchName(label, needle)?.positions : undefined;
    const key = `channel:${channel.id}`;
    return {
      key,
      label,
      ...(matches ? { matches } : {}),
      detail: channel.archived
        ? channel.channelType === "solo"
          ? "Archived chat"
          : "Archived channel"
        : channel.readOnly && !channel.cached && channel.viewerRole !== "guest"
          ? channel.channelType === "solo"
            ? channel.joinRole === "guest"
              ? "View-only chat"
              : "Public chat · not joined"
            : "Public channel · not joined"
          : channel.channelType === "dm"
            ? "Direct message"
            : channel.channelType === "solo"
              ? soloDetail(channel)
              : "Conversation",
      icon: channelIcon(channel),
      kind:
        channel.channelType === "dm"
          ? "person"
          : channel.channelType === "solo"
            ? "chat"
            : "channel",
      peek: {
        kind: "channel",
        channelId: channel.id,
        about: channel.description,
      },
      run: choose(key, () => openConversation(channel.id)),
    };
  };
  // Channel rows add how many members they have, when the roster is known.
  const channelDestination = (channel: ChannelSummary): SearchDestination => {
    const destination = conversationDestination(channel);
    const count = memberCount(channel);
    return count
      ? {
          ...destination,
          detail: [
            destination.detail,
            `${count} ${count === 1 ? "member" : "members"}`,
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : destination;
  };
  // Choosing a person opens your DM with them, or a draft until the first send.
  const [personOpen, setPersonOpen] = useState<{
    name: string;
    error?: string;
  }>();
  const personAttempt = useRef<
    { key: string; controller: AbortController } | undefined
  >(undefined);
  useEffect(() => () => personAttempt.current?.controller.abort(), []);
  // The newest choice wins: another choice cancels a DM that is still opening.
  const cancelPersonOpen = (key?: string) => {
    if (!personAttempt.current || personAttempt.current.key === key) return;
    personAttempt.current.controller.abort();
    personAttempt.current = undefined;
    setPersonOpen(undefined);
  };
  // So does closing, or a reopen during the close animation would navigate,
  // and so does searching one conversation instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cancelPersonOpen reads only refs and setters.
  useEffect(() => {
    if (open === false || scopedChannelId) cancelPersonOpen();
  }, [open, scopedChannelId]);
  const openPerson = async (pubkey: string, name: string, agent: boolean) => {
    if (personAttempt.current) return;
    const existing = directMessageWith(
      session.channels.list().channels,
      pubkey,
    );
    // Opening a DM hidden on this device goes through the confirmed open,
    // which restores its sidebar row. So does any DM opened while the relay's
    // hidden set is not ready, since it may be hidden: before the first load,
    // during every refresh and after a failed one. A visible DM just opens.
    if (
      existing &&
      (!session.directMessages.available ||
        (dmVisibility.status === "ready" && !sidebarHidden(existing)))
    )
      return openConversation(existing.id);
    if (
      !existing &&
      // Whatever its profile says, by key.
      (agentUnavailable(session, pubkey) ||
        (agent &&
          !session.agentChoices
            .snapshot()
            .identities.some(
              (item) => canMessageAgent(item) && item.pubkey === pubkey,
            )))
    ) {
      setPersonOpen({
        name,
        error: agentUnavailable(session, pubkey)
          ? "This identity is archived or being deleted in this community."
          : "This agent is not ready to message in this community.",
      });
      return;
    }
    const controller = new AbortController();
    personAttempt.current = { key: personKey(pubkey), controller };
    setPersonOpen({ name });
    try {
      const destination = await messagePerson(
        session,
        pubkey,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setPersonOpen(undefined);
      if ("channelId" in destination) openConversation(destination.channelId);
      else openNewMessage(destination.draftTo);
    } catch (reason) {
      if (!controller.signal.aborted)
        setPersonOpen({
          name,
          error:
            reason instanceof Error
              ? reason.message
              : "Could not open the conversation. Try again.",
        });
    } finally {
      if (personAttempt.current?.controller === controller)
        personAttempt.current = undefined;
    }
  };
  const personDestination = ({
    person,
    score,
  }: (typeof rankedPeople)[number]): SearchDestination & {
    score: number;
  } => {
    const matches = matchPerson(person.label, peopleNeedle)?.positions;
    const key = personKey(person.pubkey);
    const newSession = !!openAgentSession && sessionAgents.has(person.pubkey);
    const dm = !!directMessageWith(list.channels, person.pubkey);
    return {
      key,
      label: person.label,
      ...(matches?.length ? { matches } : {}),
      detail: [
        person.fullName,
        person.username && `@${person.username}`,
        newSession
          ? "New chat"
          : dm
            ? "Direct message"
            : "Start a direct message",
      ]
        .filter(Boolean)
        .join(" · "),
      icon: ChatCircleIcon,
      avatar: {
        src: avatarMedia(person.picture, session.media),
        shape: person.agent ? "squircle" : "circle",
      },
      score,
      peek: { kind: "person", pubkey: person.pubkey },
      run: choose(key, () =>
        newSession
          ? openAgentSession(person.pubkey)
          : void openPerson(person.pubkey, person.label, person.agent),
      ),
    };
  };
  const personResults = rankedPeople
    .filter(({ person }) => !person.agent)
    .slice(0, PERSON_ROWS)
    .map(personDestination);
  // The viewer's Bestie is reached through its DM, so that DM follows its
  // "New chat" row directly rather than its chats; other agents keep #1471's
  // order. The row finds Bestie by any of its names (with or without "@"), so
  // its DM comes from the eligible channels, after the hidden-DM rule but
  // before the label match and the Direct messages cap, and shows only beside
  // Bestie's shown "New chat" row. Top results keeps the two together where
  // it cuts the Agents group short.
  const bestieDm = channels.find(
    (channel) =>
      channel.id === bestieDmId &&
      channel.channelType === "dm" &&
      !channel.archived &&
      !sidebarHidden(channel) &&
      dmAgent(channel),
  );
  const bestieKey = personKey(bestieDm?.participants?.[0] ?? "");
  const agentRows = rankedPeople
    .filter(({ person }) => person.agent)
    .slice(0, PERSON_ROWS)
    .map(personDestination);
  const bestieShown =
    !!openAgentSession &&
    !!bestieDm &&
    agentRows.some(({ key }) => key === bestieKey);
  const agentResults = agentRows.flatMap((row) =>
    bestieShown && bestieDm && row.key === bestieKey
      ? [
          row,
          {
            ...conversationDestination(bestieDm),
            score: row.score,
            attached: true,
          },
        ]
      : [row],
  );
  const dmResults = directMessageResults.filter(
    (channel) => !bestieShown || channel.id !== bestieDm?.id,
  );
  const suggestions = channels
    .filter(
      (channel) =>
        (!channel.readOnly ||
          channel.cached ||
          channel.viewerRole === "guest") &&
        !channel.archived &&
        !sidebarHidden(channel),
    )
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.updatedAt ?? 0) -
        (a.lastActivityAt ?? a.updatedAt ?? 0),
    );
  // Other unread conversations lead an empty search, so Enter opens the
  // first, unless turned off: DMs, then mentions of you, then threads you're
  // in, then the rest, each most recent first. Muted ones stay quiet, as in
  // the app's unread indicator, except for a mention of you.
  const unreadFirst = useUnreadFirstPreference().enabled;
  const unreadIds = useUnreadChannelIds(
    session.unread,
    JSON.stringify(suggestions.map(({ id }) => id)),
  );
  const reasons = useUnreadReasons(
    session.unread,
    JSON.stringify(
      suggestions.flatMap(({ id, channelType }) =>
        unreadIds.has(id) && channelType !== "dm" ? [id] : [],
      ),
    ),
  );
  // A DM's or chat's own newest unread message, as the Inbox shows it.
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
    session.unread.inbox,
  );
  const muted = useSyncExternalStore(
    session.sidebarPreferences.subscribe,
    () => confirmedMutes(session.sidebarPreferences.snapshot()),
    () => confirmedMutes(session.sidebarPreferences.snapshot()),
  );
  const isUnread = ({ id }: ChannelSummary) =>
    unreadFirst &&
    id !== currentChannelId &&
    unreadIds.has(id) &&
    (!muted.includes(id) || !!reasons.get(id)?.mention);
  const tier = ({ id, channelType }: ChannelSummary) =>
    channelType === "dm"
      ? 0
      : reasons.get(id)?.mention
        ? 1
        : reasons.get(id)?.thread
          ? 2
          : 3;
  const unreadChannels = suggestions
    .filter(isUnread)
    .sort((a, b) => tier(a) - tier(b));
  // A channel unread only through thread replies previews and opens the
  // newest one, as its sidebar activity does.
  const unreadThreads = useUnreadThreadOnly(
    session.unread,
    JSON.stringify(
      unreadChannels.map(({ id, channelType }) => [id, channelType === "dm"]),
    ),
  );
  const latestUnread = new Map<string, InboxItem>();
  for (const item of inbox.items) {
    const kept = latestUnread.get(item.channelId);
    if (
      item.id === `${item.channelId}:${item.channelId}` &&
      (!kept || item.createdAt > kept.createdAt)
    )
      latestUnread.set(item.channelId, item);
  }
  const threadAuthors = [
    ...new Set(
      [
        ...unreadThreads.values(),
        ...[...reasons.values()].flatMap(({ mention, thread }) => [
          ...(mention ? [mention] : []),
          ...(thread ? [thread] : []),
        ]),
        ...latestUnread.values(),
      ].map(({ authorId, workflowOwnerId }) => workflowOwnerId ?? authorId),
    ),
  ]
    .sort()
    .join(":");
  useEffect(() => {
    void profileGeneration;
    if (threadAuthors)
      void session.profiles
        .ensure(threadAuthors.split(":"), "background")
        .catch(() => {});
  }, [session, threadAuthors, profileGeneration]);
  const authorName = (
    {
      authorId,
      workflowOwnerId,
    }: { authorId: string; workflowOwnerId?: string | undefined },
    channel: ChannelSummary,
  ) => {
    const displayId = workflowOwnerId ?? authorId;
    const resolved = resolveName(
      displayId,
      profiles.get(displayId)?.name ?? displayId.slice(0, 10),
      channel.members ?? noMembers,
    );
    return workflowOwnerId ? workflowLabel(resolved) : resolved;
  };
  // The preview beside the row shows its latest messages, so the row names
  // its kind, as a search result does.
  const suggestion = (channel: ChannelSummary): SearchDestination => {
    const destination = channelDestination(channel);
    const thread = unreadThreads.get(channel.id);
    if (!thread) return destination;
    const name = authorName(thread, channel);
    return {
      ...destination,
      detailIcon: ThreadIcon,
      detailIconLabel: "Thread reply",
      detail: thread.preview.trim()
        ? `${name}: ${thread.preview}`
        : `${name} replied in a thread`,
      run: choose(destination.key, () =>
        openConversation(channel.id, thread.rootId, thread.rootId),
      ),
    };
  };
  // An unread row says why it leads, and shows the message that made it
  // unread: the mention, the thread reply, or a DM's or chat's newest.
  const unread = unreadChannels.map((channel): SearchDestination => {
    const reason = reasons.get(channel.id);
    const mention = reason?.mention;
    // The row shows the reply that earned it the Thread tier.
    const thread = !mention && reason?.thread;
    const threadOnly = unreadThreads.has(channel.id);
    // A channel unread only through threads opens the thread its row shows;
    // a mixed one opens to its conversation.
    const root = threadOnly
      ? (mention || thread || undefined)?.rootId
      : undefined;
    const row = suggestion(channel);
    const latest =
      threadOnly || thread ? undefined : latestUnread.get(channel.id);
    // Only a group conversation names who wrote it.
    const shown =
      latest?.preview.trim() &&
      ((channel.members?.length ?? 0) > 2
        ? `${authorName(latest, channel)}: ${latest.preview}`
        : latest.preview);
    const tag =
      channel.channelType === "dm"
        ? "DM"
        : mention
          ? "Mentioned"
          : reason?.thread
            ? "Thread"
            : undefined;
    return {
      ...row,
      ...(root && {
        run: choose(row.key, () => openConversation(channel.id, root, root)),
      }),
      ...(shown && { detail: shown }),
      ...(thread && {
        detailIcon: ThreadIcon,
        detailIconLabel: "Thread reply",
        detail: thread.preview.trim()
          ? `${authorName(thread, channel)}: ${thread.preview}`
          : `${authorName(thread, channel)} replied in a thread`,
      }),
      ...(mention && {
        detailIcon: AtIcon,
        detailIconLabel: "Mention",
        detail: mention.preview.trim()
          ? `${authorName(mention, channel)}: ${mention.preview}`
          : `${authorName(mention, channel)} mentioned you`,
      }),
      ...(tag && { trailing: <Badge size="xs">{tag}</Badge> }),
    };
  });
  const recent = suggestions
    .filter((channel) => !isUnread(channel))
    .slice(0, 4)
    .map(suggestion);
  const nameOf = (pubkey: string, channelId?: string) =>
    resolveName(
      pubkey,
      profiles.get(pubkey)?.name ?? pubkey.slice(0, 10),
      (channelId && session.channels.get?.(channelId)?.members) || noMembers,
    );
  const whereOf = (channelId: string) => {
    const channel = session.channels.get?.(channelId);
    const name = names.get(channelId) ?? channel?.name ?? "Conversation";
    return channel?.channelType === "stream" || channel?.channelType === "forum"
      ? `#${name}`
      : name;
  };
  const terms = useMemo(() => searchTerms(parsed.text), [parsed.text]);
  // The search whose results the person has started moving through: a
  // rerank that lands after that is dropped. Moving through one
  // conversation's hits doesn't hold the next search's.
  const [movedFor, setMovedFor] = useState<string>();
  if (movedFor !== undefined && movedFor !== searchKey) setMovedFor(undefined);
  const rerank = useMessageRerank({
    decisions,
    community,
    query: parsed.text,
    messages: search.messages,
    enabled:
      rerankable && !!parsed.text && !search.newestFirst && !search.loading,
    facts: (message) => {
      const channel = session.channels.get?.(message.channelId);
      return {
        where:
          channel?.channelType === "dm"
            ? `Direct message: ${whereOf(message.channelId)}`
            : whereOf(message.channelId),
        author: nameOf(
          message.workflowOwnerId ?? message.authorId,
          message.channelId,
        ),
        mine: message.authorId === session.viewer,
      };
    },
    held: movedFor === searchKey,
  });
  const messages: SearchDestination[] = rerank.messages.map((message) => {
    // Every listed hit's channel is readable here, with settled metadata.
    const channel = session.channels.get?.(message.channelId);
    const displayId = message.workflowOwnerId ?? message.authorId;
    const name = resolveName(
      displayId,
      profiles.get(displayId)?.name ?? displayId.slice(0, 10),
      list.channels.find((channel) => channel.id === message.channelId)
        ?.members ?? noMembers,
    );
    const text = message.text || message.preview;
    const shown = snippet(text, terms);
    return {
      key: message.id,
      label: shown.text || "Attachment",
      ...(shown.matches.length ? { matches: shown.matches } : {}),
      labelContent: shown.text ? (
        <PreviewText
          text={shown.text}
          full={text}
          start={shown.start}
          mentions={message.mentioned}
          matches={shown.matches}
          session={session}
          channelId={message.channelId}
        />
      ) : undefined,
      peek: {
        kind: "message" as const,
        channelId: message.channelId,
        messageId: message.id,
        createdAt: message.createdAt,
        authorId: message.workflowOwnerId ?? message.authorId,
        text,
        mentioned: message.mentioned,
      },
      detail: `${names.get(message.channelId) ?? channel?.name ?? "Conversation"} · ${message.workflowOwnerId ? workflowLabel(name) : name} · ${formatItemTimestamp(message.createdAt)}`,
      detailIcon: channel && channelIcon(channel),
      detailIconLabel: channel && channelIconLabel(channel),
      icon: ChatCircleIcon,
      avatar: {
        src: avatarMedia(profiles.get(displayId)?.picture, session.media),
        shape: "circle" as const,
        name,
      },
      run: () => {
        cancelPersonOpen();
        remember();
        openConversation(message.channelId, message.id);
      },
    };
  });
  const messageRows: SearchDestination[] = search.hasMore
    ? [
        ...messages,
        {
          key: "more-messages",
          label: search.loadingMore
            ? "Loading more messages…"
            : "Show more messages",
          icon: ChatCircleIcon,
          run: () => {
            cancelPersonOpen();
            search.loadMore();
          },
        },
      ]
    : messages;
  const askRow =
    openAsk && askAgent
      ? (text: string): SearchDestination => ({
          key: "ask",
          label: askAgent.name,
          detail: `Search Buzz to answer: ${text}`,
          icon: RobotIcon,
          trailing: (
            <span className="search-peek-start text-body-sm text-subtle">
              Start chat{" "}
              <span aria-hidden="true">
                <kbd>↵</kbd>
              </span>
            </span>
          ),
          run: () => {
            cancelPersonOpen();
            if (usageScope) recordRecentSearch(usageScope, `ask: ${text}`);
            openAsk(text, askAgent);
          },
        })
      : undefined;
  /** Types `text` after what's typed: a filter for its picker to complete,
   * or a whole one to try, which ends with a space for typing to carry on.
   * `ask:` leads instead, keeping the rest as the question. */
  const addFilter = (text: string, whole = false) => {
    if (text.startsWith("ask:"))
      setChipQuery(
        chips,
        text === "ask:" ? `ask: ${visibleQuery.trim()}` : text,
      );
    else
      updateDisplayQuery(
        `${visibleQuery.trimEnd()}${visibleQuery.trim() ? " " : ""}${text}${whole ? " " : ""}`,
      );
    input.current?.focus();
  };
  const sampleChannel = channels.find(
    (channel) =>
      channel.channelType !== "dm" &&
      channel.channelType !== "solo" &&
      !channel.archived,
  )?.name;
  const filters = guideOpen
    ? guideFilters({
        channel: sampleChannel,
        ask: !!openAsk && !offline,
        agent: askAgent?.name,
        scoped: !!scopedChannelId,
      })
    : [];
  const guideGroup: SearchGroup = {
    label: "Filters",
    why: "Type one, or press ↵ to add it",
    destinations: filters.map((filter) => ({
      key: `guide:${filter.key}`,
      label: filter.label,
      // A filter with no example here has no second line.
      ...(filter.examples.length
        ? { detail: filter.examples.map(([example]) => example).join(" · ") }
        : {}),
      icon: filter.icon,
      trailing: <FilterSyntax operator={filter.key} text={syntaxOf(filter)} />,
      run: () => addFilter(filter.syntax),
    })),
  };
  /** A guide example as the chip choosing it would make, when it is one. */
  const exampleChip = (example: string): SearchChip | undefined => {
    const restored = restoreChips(example).chips[0];
    if (restored) return restored;
    const channel = /^in:#(.+)$/.exec(example)?.[1];
    const found = channel
      ? channels.find(({ name }) => name === channel)
      : undefined;
    return found
      ? {
          operand: `in:${found.id}`,
          text: `in:#${found.name}`,
          edit: `in:#${found.name}`,
          label: `Remove channel ${found.name}`,
          title: found.id,
        }
      : undefined;
  };
  const guidePreview = (row: SearchDestination | undefined) => {
    const filter = filters.find(({ key }) => `guide:${key}` === row?.key);
    return filter ? (
      <FilterGuidePreview
        filter={filter}
        onTry={(example) => {
          const chip = exampleChip(example);
          // As a picker would: it replaces a typed filter of its kind.
          if (chip) selectChip(query.length, query.length, chip);
          else addFilter(example, true);
        }}
      />
    ) : null;
  };
  const hints = asking ? (
    <div className="search-peek-hints">
      <Button
        variant="outline-subtle"
        size="xs"
        tabIndex={-1}
        aria-label={`Remove Ask ${askAgent?.name ?? "your agent"}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setChipQuery(chips, askText);
          input.current?.focus();
        }}
      >
        <SparklesIcon
          size={14}
          aria-hidden="true"
          className="search-peek-filter-icon"
          data-operator="ask"
        />
        Ask {askAgent?.name ?? "your agent"}
        <XIcon size={12} aria-hidden="true" />
      </Button>
      <span className="text-body-sm text-subtle">
        {askAgent?.name ?? "Your agent"} searches Buzz for you in a new chat
      </span>
    </div>
  ) : undefined;
  const directoryPending = publicChannels.loading || personDirectory.loading;
  const messagesPending = operatorLookupPending || search.loading;
  const slowMessages = useDelayedSearch(messagesPending);
  // An author or date picker replaces the result groups, so it announces
  // none of their lookups.
  const resultsShown =
    !guideOpen && !showAuthorPicker && !showDateChoices && !showChannelPicker;
  /** Results with a preview beside them: not a question or a picker. */
  const previewed = !asking && resultsShown;
  const searchAnnouncement = useSearchAnnouncement(
    resultsShown && slowChannels,
    slowPeople,
    resultsShown && slowMessages,
  );
  const operatorChannelProblem =
    scopedChannelId ||
    !operatorChannel ||
    operatorChannelId ||
    operatorLookupPending ||
    operatorLookupError ||
    list.status === "loading"
      ? undefined
      : operatorChannelAmbiguous
        ? `More than one conversation is named “${operatorChannel}”. Search in that conversation instead.`
        : `No conversation named “${operatorChannel}”.`;
  const messageEmpty =
    offline || operatorLookupPending || search.loading
      ? undefined
      : operatorLookupError || search.error
        ? "Message search is unavailable."
        : operatorChannelProblem
          ? operatorChannelProblem
          : query.trim()
            ? directoryPending
              ? undefined
              : search.tooShort
                ? // Only the last word is matched as a prefix, so name it
                  // once earlier words make the whole query long enough.
                  `Type at least ${MESSAGE_SEARCH_MIN_CHARS} characters${/\s/.test(parsed.text.trim()) ? " in the last word" : ""} to search messages.`
                : search.onlyExclusions
                  ? "Add a word or “phrase” to search for alongside -exclusions."
                  : "No matching messages in accessible conversations."
            : scopedChannelId
              ? "Type to search messages in this conversation."
              : "Type to search messages in this community.";
  // A retry removes its own focused button. Return focus to the combobox,
  // which owns keyboard navigation, before the retry starts.
  const retryFromInput = (retry: () => unknown) => () => {
    input.current?.focus();
    retry();
  };
  // Named destinations lead, so typed text selects one first. The group with
  // the best match leads them, so Enter opens the "Work" page before a
  // channel that merely contains it. Every group scores on one scale, match
  // and usage, not the relationship band that orders rows inside People and
  // Agents. An exact name always leads. After exact names, when the text
  // finds one of the viewer's agents, its "New chat" row leads and its chats
  // follow. Messages then take their place among the rest by how strongly
  // they answer the text: a topic of three or more words, or many hits
  // against only weak name matches, puts them ahead.
  const namedGroups = [
    {
      label: "Agents",
      tone: "agent" as const,
      icon: RobotIcon,
      destinations: agentResults,
      best: Math.min(...agentResults.map(({ score }) => score)),
    },
    {
      label: "Chats",
      tone: "chat" as const,
      icon: ChatsCircleIcon,
      destinations: chatResults.map(({ channel }) =>
        conversationDestination(channel),
      ),
      best: Math.min(...chatResults.map(({ rank }) => rank)),
      exactName: chatResults.some(({ exactName }) => exactName),
    },
    {
      label: "Channels",
      tone: "channel" as const,
      icon: HashIcon,
      destinations: channelResults.map(channelDestination),
      best: Math.min(...channelResults.map(channelRank)),
      headingStatus: slowChannels ? "Searching…" : undefined,
    },
    {
      label: "People",
      tone: "person" as const,
      icon: UserIcon,
      destinations: personResults,
      headingStatus: slowPeople ? "Searching…" : undefined,
      best: Math.min(...personResults.map(({ score }) => score)),
    },
    {
      label: "Direct messages",
      tone: "person" as const,
      icon: UsersIcon,
      destinations: dmResults.map(conversationDestination),
      best: Math.min(...dmResults.map(dmRank)),
    },
    {
      label: "Pages",
      tone: "page" as const,
      icon: GearIcon,
      // PageSearch already ranked these by text and underlined them; here
      // usage and earlier choices adjust the order.
      destinations: byMatch(pages, (page) => rankOf(page.label, page.key)).map(
        (page) => ({
          ...page,
          action: `Open ${page.label}`,
          run: choose(page.key, page.run),
        }),
      ),
      best: Math.min(...pages.map((page) => rankOf(page.label, page.key))),
    },
  ]
    .map(({ exactName, ...group }) => {
      const named = exactName ?? exact(group.best);
      return {
        ...group,
        named,
        lead:
          named ||
          (newChats.size > 0 &&
            (group.label === "Agents" || group.label === "Chats")),
      };
    })
    .sort(
      (a, b) =>
        Number(b.named) - Number(a.named) ||
        Number(b.lead) - Number(a.lead) ||
        (a.lead ? 0 : a.best - b.best),
    )
    .map(({ best, lead, named, ...group }) => {
      const top = group.destinations[0];
      const tier = top ? rankName(top.label) : undefined;
      const remembered = !!top && top.key === picked;
      const why = named
        ? "Exact name"
        : lead
          ? "Your agent"
          : remembered
            ? "You picked this before"
            : tier === MatchRank.prefix
              ? "Name starts with it"
              : tier === MatchRank.wordStart
                ? "Words in the name"
                : "Part of a name";
      const strength =
        named || lead || remembered
          ? 100
          : tier === MatchRank.prefix
            ? 85
            : tier === MatchRank.wordStart
              ? 60
              : 40;
      // Inline settings slot in by rank, so they follow too.
      return { ...group, why, strength, rank: lead ? -Infinity : best };
    });
  const words = parsed.text.split(/\s+/).filter(Boolean).length;
  const hits = messages.length;
  // Messages stay below a name that starts with the text (85): a page of 20
  // tops out near 84, and later pages don't count. A topic of three or more
  // words takes that top score.
  const messageStrength = !hits
    ? -1
    : words >= 3
      ? 84
      : 40 + 10 * Math.log2(1 + Math.min(hits, 20)) - (search.hasMore ? 0 : 5);
  const messageCount = search.hasMore ? `${hits}+` : undefined;
  const messageLead = namedGroups.findIndex(
    (group) => group.destinations.length && group.strength < messageStrength,
  );
  const messageGroup: SearchGroup = {
    label: "Messages",
    icon: ChatCircleIcon,
    tone: "message",
    rank: messageLead === 0 ? -Infinity : Infinity,
    why: hits
      ? words >= 3
        ? "Reads like a topic"
        : `${messageCount ?? hits} mention it`
      : undefined,
    reranked: rerank.reranked,
    count: messageCount,
    destinations: messageRows,
    // Until the relay answers, Messages has no heading or empty state: after
    // a second, one line at the end says it is still looking.
    hideLabel: !hits && slowMessages,
    empty: hits
      ? undefined
      : slowMessages
        ? "Still searching messages…"
        : directMessageResults.length ||
            chatResults.length ||
            channelResults.length ||
            rankedPeople.length ||
            pages.length
          ? undefined
          : messageEmpty,
  };
  const rankedGroups: SearchGroup[] = namedGroups.map(
    ({ strength: _strength, ...group }) => group,
  );
  rankedGroups.splice(
    messageLead < 0 ? rankedGroups.length : messageLead,
    0,
    messageGroup,
  );
  // An agent can answer what search can't: offered for a question-like
  // query, or when nothing matched.
  const settledEmpty =
    !directoryPending &&
    !messagesPending &&
    !rankedGroups.some((group) => group.destinations.length);
  const offerAsk = !!parsed.text && (words >= 4 || settledEmpty);
  const resultGroups: readonly SearchGroup[] =
    pickerPrompt || showAmbiguousPicker
      ? [
          {
            label: "People",
            destinations: authorChoices.filter((choice) => !choice.isAgent),
            empty: authorChoices.length
              ? undefined
              : !authorAnswer
                ? "Searching people…"
                : authorAnswer.savedOnly
                  ? "Connect to this community to search people."
                  : authorAnswer.lookupFailed
                    ? "People search is unavailable. Try a longer name."
                    : authorNeedle && !searchable(authorNeedle)
                      ? `Type at least ${SEARCH_MIN_CHARS} characters to search people.`
                      : authorNeedle
                        ? "No matching people. Try a different name."
                        : "Type a name to search people.",
          },
          {
            label: "Agents",
            destinations: authorChoices.filter((choice) => choice.isAgent),
          },
        ]
      : showDateChoices || showChannelPicker
        ? [
            showDateChoices
              ? { label: "Dates", destinations: dateChoices }
              : {
                  label: "Channels",
                  destinations: channelChoices,
                  empty: "No matching channels.",
                },
          ]
        : asking
          ? [
              {
                label: `New chat with ${askAgent?.name ?? "your agent"}`,
                icon: RobotIcon,
                tone: "agent",
                multiline: true,
                destinations: question && askRow ? [askRow(question)] : [],
                empty: !askRow
                  ? "No agent is set up to ask yet. Add one in Agents."
                  : `Type a question for ${askAgent?.name ?? "your agent"}.`,
                notice: (
                  <p className="search-peek-note text-body-sm text-subtle">
                    <InfoIcon size={14} aria-hidden="true" />
                    <span>
                      Remove <code>ask:</code> to search messages yourself.
                    </span>
                  </p>
                ),
              },
            ]
          : scopedChannelId || hasOperator
            ? [
                {
                  label: "Messages",
                  rank: Infinity,
                  icon: ChatCircleIcon,
                  why: sortable
                    ? order
                    : hasOperator
                      ? "Filters apply to messages"
                      : undefined,
                  reranked: rerank.reranked,
                  destinations: messageRows,
                  headingStatus: slowMessages ? "Searching…" : undefined,
                  empty: messageEmpty,
                },
              ]
            : !query.trim()
              ? [
                  ...(unread.length
                    ? [{ label: "Unread", destinations: unread }]
                    : []),
                  // Conversations first, then searches: searches keep no
                  // time to interleave by.
                  ...(recent.length || recentSearches.length || !unread.length
                    ? [
                        {
                          label: "Recents",
                          destinations: [
                            ...recent,
                            ...recentSearches.map((text): SearchDestination => {
                              const restored = restoreChips(text);
                              return {
                                key: `recent:${text}`,
                                label: [
                                  ...restored.chips.map((chip) => chip.text),
                                  restored.visible,
                                ]
                                  .filter(Boolean)
                                  .join(" "),
                                icon: ClockIcon,
                                kind: "page",
                                action: "Search again",
                                run: () =>
                                  setChipQuery(
                                    restored.chips,
                                    restored.visible,
                                  ),
                              };
                            }),
                          ],
                          empty:
                            list.status === "loading"
                              ? "Loading recent conversations…"
                              : "No recent activity yet.",
                        },
                      ]
                    : []),
                  // Everything joined, by kind, from the list already held.
                  ...(
                    [
                      ["Channels", "channel", HashIcon],
                      ["Direct messages", "person", UsersIcon],
                      ["Chats", "chat", ChatsCircleIcon],
                    ] as const
                  ).flatMap(([label, tone, icon]) => {
                    const rows = suggestions
                      .filter(
                        ({ channelType }) =>
                          (channelType === "dm"
                            ? "person"
                            : channelType === "solo"
                              ? "chat"
                              : "channel") === tone,
                      )
                      .map(channelDestination)
                      .map((row) => ({ ...row, key: `browse:${row.key}` }));
                    return rows.length
                      ? [
                          {
                            label,
                            tone,
                            icon,
                            browse: true,
                            destinations: rows,
                          },
                        ]
                      : [];
                  }),
                ]
              : [
                  ...rankedGroups.filter(
                    (group) => hits || group !== messageGroup,
                  ),
                  ...(offerAsk && askRow
                    ? [
                        {
                          label: `Ask ${askAgent?.name ?? "your agent"}`,
                          icon: RobotIcon,
                          tone: "agent" as const,
                          destinations: [askRow(parsed.text)],
                        },
                      ]
                    : []),
                  // Until messages arrive, their status line comes last, so
                  // nothing moves when it goes.
                  ...(hits ? [] : [messageGroup]),
                ];
  const groups = guideOpen ? [guideGroup] : resultGroups;
  const askReader =
    openAsk && !offline && (asking || guideOpen || !!parsed.text) ? (
      <DefaultAgent
        session={session}
        scope={sidebarScope ?? ""}
        onAgent={setAskAgent}
      />
    ) : null;
  return (
    <>
      {askReader}
      <SearchChoices
        onRowsShown={(keys) => {
          // Only channel results without a roster read a count.
          const unknown = new Set(
            channelResults.flatMap((channel) =>
              channel.members?.length ? [] : [`channel:${channel.id}`],
            ),
          );
          memberCounts.show(
            keys.flatMap((key) =>
              unknown.has(key) ? [key.slice("channel:".length)] : [],
            ),
          );
        }}
        // The guide is the only list while it shows.
        inlineSettings={guideOpen ? undefined : inlineSettings}
        query={query}
        onQueryChange={onQueryChange}
        views={views}
        chips={chips}
        onRemoveChip={removeChip}
        onEditLastChip={editLastChip}
        displayQuery={displayQuery}
        onDisplayQueryChange={updateDisplayQuery}
        input={input}
        label={scopedChannelId ? "Search this conversation" : "Search Buzz"}
        onBack={guideOpen ? () => setGuideQuery(undefined) : undefined}
        fieldAction={
          <>
            {sortable && (
              <MenuRoot>
                <MenuTrigger
                  render={(props) => (
                    <IconButton
                      {...props}
                      variant="ghost"
                      // The heading's order is visual only; name it here.
                      aria-label={`Sort messages: ${order}`}
                      title="Sort messages"
                      icon={<ArrowsDownUpIcon size={16} aria-hidden="true" />}
                    />
                  )}
                />
                <MenuPopup
                  align="end"
                  size="compact"
                  aria-label="Sort messages"
                  finalFocus={input}
                >
                  <MenuRadioGroup
                    value={sort}
                    onValueChange={(value) =>
                      setSort(value === "newest" ? "newest" : "relevance")
                    }
                  >
                    <MenuRadioItem value="relevance" closeOnClick>
                      Most relevant
                    </MenuRadioItem>
                    <MenuRadioItem value="newest" closeOnClick>
                      Most recent
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuPopup>
              </MenuRoot>
            )}
            {!asking && (
              <IconButton
                variant={guideOpen ? "subtle" : "ghost"}
                size="sm"
                aria-label="Filters"
                aria-pressed={guideOpen}
                aria-keyshortcuts="?"
                data-search-filters=""
                title="Filters (type ?)"
                // The field keeps focus, so typing goes on from the guide.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setGuideQuery(guideOpen ? undefined : query);
                  input.current?.focus();
                }}
                icon={<SlidersHorizontalIcon size={16} aria-hidden="true" />}
              />
            )}
          </>
        }
        scope={
          scopedChannelId && onScopeChange
            ? {
                id: scopedChannelId,
                label:
                  names.get(scopedChannelId) ??
                  session.channels.get?.(scopedChannelId)?.name ??
                  "Conversation",
                onRemove: () => onScopeChange(),
              }
            : undefined
        }
        groups={groups}
        open={open}
        highlightEmpty={
          guideOpen || (!scopedChannelId && !query.trim() && unread.length > 0)
        }
        // Enter before any row, or on search actions alone, waits for a
        // channel or person row, or for the lookups to settle, rather than
        // opening a message that lands first. A cold joined list has not yet
        // started the open-channel lookup.
        pending={
          !asking &&
          !guideOpen &&
          (directoryPending ||
            operatorLookupPending ||
            search.loading ||
            (!scopedChannelId &&
              !!query.trim() &&
              list.status === "loading" &&
              !list.channels.length)) &&
          !groups.some(
            (group) =>
              group.rank !== Infinity &&
              group.destinations.some(({ key }) => !isSearchAction(key)),
          )
        }
        isAction={isSearchAction}
        // The guide's rows add filters; Tab doesn't complete into them.
        completing={
          !guideOpen &&
          (pickerPrompt ||
            showAmbiguousPicker ||
            showDateChoices ||
            showChannelPicker)
        }
        completionPending={
          !guideOpen &&
          showAuthorPicker &&
          !authorAnswer &&
          !authorChoices.length
        }
        conversationShortcut={
          currentChannelId && !scopedChannelId && !offline && onScopeChange
            ? conversationBinding
            : undefined
        }
        footer={offline}
        peek={{
          // A filter or a conversation's own search asks for messages
          // only, so they aren't ranked with other results, but each still
          // previews.
          ranked: !guideOpen && previewed && !scopedChannelId && !hasOperator,
          hints,
          busy:
            !guideOpen &&
            !!query.trim() &&
            (messagesPending || directoryPending),
          onMove: () => setMovedFor(searchKey),
          unsearched:
            !guideOpen && (search.tooShort || search.onlyExclusions)
              ? { Messages: messageEmpty }
              : undefined,
          preview: guideOpen
            ? guidePreview
            : previewed
              ? (row, tone, follow) => (
                  <SearchPreview
                    session={session}
                    cache={previews}
                    row={row}
                    tone={tone}
                    follow={follow}
                    terms={terms}
                    nameOf={nameOf}
                    whereOf={whereOf}
                  />
                )
              : undefined,
        }}
      >
        {dateOperator === "on" && !guideOpen && (
          <Calendar
            mode="single"
            aria-label="Choose a day"
            onSelect={(day) => {
              if (day) completeDate(`on:${localDate(day)}`);
              input.current?.focus();
            }}
          />
        )}
        <div
          className="space-y-2 px-3 text-body-sm text-subtle"
          aria-live="polite"
          // Lookup status belongs to the results the guide covers.
          hidden={guideOpen}
        >
          {list.status === "loading" &&
            query.trim() &&
            !list.channels.length && <p>Loading joined conversations…</p>}
          {list.status === "error" && (
            <div>
              <p>Couldn’t load all joined conversations.</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={retryFromInput(() =>
                  session.channels.refreshList
                    ? session.channels.refreshList()
                    : session.channels.ensureList(),
                )}
              >
                Retry conversations
              </Button>
            </div>
          )}
          {list.coverage === "partial" && (
            <p>Conversation names include only loaded joined conversations.</p>
          )}
          {query.trim() &&
            !scopedChannelId &&
            (publicChannels.partial || operatorPublicChannels.partial) && (
              <p>Only the newest open channels were searched.</p>
            )}
          {!scopedChannelId && publicChannels.error && (
            <div>
              <p>{publicChannels.error}</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={retryFromInput(publicChannels.retry)}
              >
                Retry channels
              </Button>
            </div>
          )}
          {operatorLookupError && (
            <div>
              <p>{operatorLookupError}</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={retryFromInput(operatorPublicChannels.retry)}
              >
                Retry channels
              </Button>
            </div>
          )}
          {personOpen && (
            <p role={personOpen.error ? "alert" : undefined}>
              {personOpen.error ??
                `Opening your conversation with ${personOpen.name}…`}
            </p>
          )}
          {peopleActive && personDirectory.error && (
            <div>
              <p>Couldn’t search community people.</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={retryFromInput(personDirectory.retry)}
              >
                Retry people
              </Button>
            </div>
          )}
          {search.moreError && <p>{search.moreError}</p>}
          {search.error && (
            <div>
              <p>{search.error}</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={retryFromInput(search.retry)}
              >
                Retry messages
              </Button>
            </div>
          )}
        </div>
        <p className="sr-only" role={searchAnnouncement ? "status" : undefined}>
          {searchAnnouncement}
        </p>
      </SearchChoices>
    </>
  );
}

/** Reports the agent New chat would tag, for `ask:`. */
function DefaultAgent({
  session,
  scope,
  onAgent,
}: {
  session: RelaySession;
  scope: string;
  onAgent: (agent: MentionRecipient | undefined) => void;
}) {
  const agent = useDefaultAgent(session, scope);
  const key = agent ? `${agent.pubkey}:${agent.name}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: The key names the agent.
  useEffect(() => onAgent(agent), [key, onAgent]);
  return null;
}
