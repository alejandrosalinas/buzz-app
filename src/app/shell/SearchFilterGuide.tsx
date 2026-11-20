import {
  CalendarIcon,
  ChatCircleIcon,
  HashIcon,
  RobotIcon,
  UserIcon,
} from "../../shared/design-system/icons/index";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { ValueChip } from "../../shared/design-system/ui/ValueChip";

/** A filter the guide teaches, with what Enter on its row types. */
export type GuideFilter = {
  key: "from" | "in" | "during" | "before" | "after" | "on" | "ask" | "phrase";
  label: string;
  /** What the row's Enter types, which opens that filter's own picker. */
  syntax: string;
  about: string;
  /** Complete filters to try, each with what it finds. */
  examples: readonly (readonly [example: string, meaning: string])[];
  icon: typeof UserIcon;
};

/**
 * The filters search reads, in plain words. `channel` names a real channel
 * for the `in:` example; `agent` is who `ask:` asks, by name once known.
 * Searching one conversation already has its `in:`.
 */
export function guideFilters({
  channel,
  ask,
  agent,
  scoped,
}: {
  channel?: string | undefined;
  /** Whether `ask:` can start a chat here. */
  ask: boolean;
  agent?: string | undefined;
  scoped: boolean;
}): GuideFilter[] {
  const filters: (GuideFilter | false)[] = [
    {
      key: "from",
      label: "Who sent it",
      syntax: "from:",
      about:
        "Messages one person sent. Type a name after it to pick someone, or me for your own.",
      examples: [["from:me", "Your messages"]],
      icon: UserIcon,
    },
    !scoped && {
      key: "in",
      label: "Where it was sent",
      syntax: "in:",
      about:
        "Messages in one channel, or in:@name for your direct messages with someone.",
      examples: channel ? [[`in:#${channel}`, `In #${channel}`]] : [],
      icon: HashIcon,
    },
    ask && {
      key: "ask",
      label: `Ask ${agent ?? "your agent"}`,
      syntax: "ask:",
      about: `${agent ?? "Your agent"} searches Buzz for you and answers in a new chat. Filters you’ve added stay in the question.`,
      examples: [["ask: what did we ship?", "Ask a question"]],
      icon: RobotIcon,
    },

    {
      key: "during",
      label: "When it was sent",
      syntax: "during:",
      about:
        "Messages from a day, a month (march or 2026-03) or a year, or from the past few days, weeks, months or years (7d, 2w, 3m, 1y).",
      examples: [
        ["during:today", "Today"],
        ["during:7d", "Past 7 days"],
        ["during:march", "In March"],
        [`during:${new Date().getFullYear()}`, "This year"],
      ],
      icon: CalendarIcon,
    },
    {
      key: "before",
      label: "Before a day",
      syntax: "before:",
      about:
        "Messages sent before a day, not on it. Name the day as YYYY-MM-DD, today or yesterday.",
      examples: [["before:today", "Before today"]],
      icon: CalendarIcon,
    },
    {
      key: "after",
      label: "After a day",
      syntax: "after:",
      about:
        "Messages sent on or after a day. Name the day as YYYY-MM-DD, today or yesterday.",
      examples: [["after:yesterday", "Since yesterday"]],
      icon: CalendarIcon,
    },
    {
      key: "on",
      label: "On one day",
      syntax: "on:",
      about:
        "Messages sent on a single day. Name the day as YYYY-MM-DD, today or yesterday.",
      examples: [["on:yesterday", "Yesterday"]],
      icon: CalendarIcon,
    },
    {
      key: "phrase",
      label: "Exact words",
      syntax: '"',
      about:
        "Words in quotes match together, in that order. Put - before a word to leave it out.",
      examples: [
        ['"release notes"', "That phrase"],
        ["-draft", "Without “draft”"],
      ],
      icon: ChatCircleIcon,
    },
  ];
  return filters.filter((filter) => !!filter);
}

/** What a filter's row types, as the guide shows it. */
export const syntaxOf = (filter: GuideFilter) =>
  filter.key === "phrase" ? "“…”" : filter.syntax;

/** A filter as it's typed, led by a dot in the hue of its operator. */
export function FilterSyntax({
  text,
  operator = text.slice(0, text.indexOf(":")),
}: {
  text: string;
  operator?: string;
}) {
  return (
    <ValueChip
      icon={
        <svg
          viewBox="0 0 12 12"
          className="search-guide-dot"
          data-operator={operator}
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="3" />
        </svg>
      }
    >
      <code>{text}</code>
    </ValueChip>
  );
}

/** What a filter finds, with examples to try. */
export function FilterGuidePreview({
  filter,
  onTry,
}: {
  filter: GuideFilter;
  onTry: (example: string) => void;
}) {
  return (
    <div className="search-peek-card">
      <div className="search-peek-summary">
        <div className="search-peek-head">
          <FilterSyntax operator={filter.key} text={syntaxOf(filter)} />
          <span className="search-peek-title text-label">{filter.label}</span>
        </div>
        <p className="search-peek-about text-body-sm">{filter.about}</p>
      </div>
      {filter.examples.length > 0 && (
        <div className="search-guide-examples">
          <span className="text-label-sm text-subtle">Try</span>
          <div className="search-guide-tries">
            {filter.examples.map(([example, meaning]) => (
              <NavigationItem
                key={example}
                variant="option"
                multiline
                // The field keeps focus, so typing carries on after the example.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onTry(example)}
                label={
                  <>
                    <FilterSyntax operator={filter.key} text={example} />{" "}
                    <span className="text-body-sm text-subtle">{meaning}</span>
                  </>
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
