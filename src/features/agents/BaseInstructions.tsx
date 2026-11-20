// Settings → Agent setup → Base instructions: the owner's choice for each
// section of the base prompt they can configure, as a draft with an explicit
// Save, and every section's text to read. It applies to all the owner's
// agents on this device.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { SECTIONS, type Section } from "../agent-harness/sections";
import {
  SECTION_TEXT_BYTES,
  textProblem,
} from "../agent-harness/sections/choices";
import {
  committedOwnerSections,
  defaultHash,
  type OwnerSections,
  ownerSections,
  saveOwnerSections,
} from "./prompt-sections";
import type { AgentStore } from "./store";

type Mode = "default" | "off" | "custom";
/** One section's choice as it is being edited. `text` is kept while the
 * mode is not Custom, so switching back shows it again. */
type Draft = Readonly<{ mode: Mode; text: string; basedOn?: string }>;

const MODES = [
  { value: "default", label: "Default" },
  { value: "off", label: "Off" },
  { value: "custom", label: "Custom" },
] as const;
const CONFIGURABLE = SECTIONS.filter((section) => section.owner);
/** A section's default text; the one of a thread session in the agent's own
 * workspace where Buzz picks it. */
const defaultText = (section: Section) =>
  (typeof section.text === "string"
    ? section.text
    : section.text({ scope: "thread" })
  ).trim();
const bytes = (text: string) => new TextEncoder().encode(text.trim()).length;

const drafts = (saved: OwnerSections) =>
  Object.fromEntries(
    CONFIGURABLE.map(({ id }): [string, Draft] => {
      const choice = saved.choices[id];
      return [
        id,
        choice
          ? {
              mode: choice.mode,
              text: choice.mode === "custom" ? choice.text : "",
              basedOn: choice.basedOn,
            }
          : { mode: "default", text: "" },
      ];
    }),
  );
/** What Save would keep for a draft. Custom text that is the default text
 * is the default, unless it is the saved text: a later default can become
 * the owner's text, which stays theirs until they reset it. */
const kept = (
  section: Section,
  { mode, text, basedOn }: Draft,
  saved: OwnerSections["choices"],
) => {
  const own = saved[section.id];
  return mode === "default" ||
    (mode === "custom" &&
      text.trim() === defaultText(section) &&
      !(own?.mode === "custom" && own.text === text.trim()))
    ? undefined
    : {
        ...(mode === "custom" ? { mode, text: text.trim() } : { mode }),
        ...(basedOn ? { basedOn } : {}),
      };
};
/** What Save would keep for every section's draft. */
const keptChoices = (
  all: Record<string, Draft>,
  saved: OwnerSections["choices"],
) =>
  Object.fromEntries(
    CONFIGURABLE.flatMap((section) => {
      const choice = kept(section, all[section.id] as Draft, saved);
      return choice ? [[section.id, choice] as const] : [];
    }),
  );

const prose = "m-0 whitespace-pre-wrap break-words text-body-sm text-subtle";
const names = new Intl.ListFormat("en", { type: "conjunction" });
const canReplace = (plugins: readonly string[]) =>
  `${names.format(plugins)} can replace this in chats ${plugins.length > 1 ? "they manage" : "it manages"}.`;
/** The choice that takes focus when the control that has it leaves: its
 * section's, or the first one for the form's own actions. */
const choiceNear = (from: Element) =>
  (
    from.closest("[data-section]") ?? from.closest("form")
  )?.querySelector<HTMLElement>('[role="combobox"]') ?? null;

export function BaseInstructions({
  store,
  replacedBy,
}: {
  store: AgentStore;
  /** The names of the plugins that can replace a section's text in the
   * chats they manage. */
  replacedBy?: ((section: string) => readonly string[]) | undefined;
}) {
  // A save from a form closed since can still be in flight: this one
  // starts from what is saved and holds until that save ends.
  const [start] = useState(() => committedOwnerSections(store));
  const [saved, setSaved] = useState(start.sections);
  const [draft, setDraft] = useState(() => drafts(saved));
  const [saving, setSaving] = useState(Boolean(start.writing));
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    start.writing
      ?.then(
        () => "",
        (reason: unknown) =>
          reason instanceof Error ? reason.message : String(reason),
      )
      .then((failed) => {
        if (!live) return;
        const next = ownerSections(store);
        setSaved(next);
        setDraft(drafts(next));
        setError(failed);
        setSaving(false);
      });
    return () => {
      live = false;
    };
  }, [start, store]);
  const noticeId = useId();
  const pendingFocus = useRef<HTMLElement | null>(null);
  const actionsRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // Capture focus before the conditional actions leave the DOM.
    return () => {
      if (node.contains(document.activeElement))
        pendingFocus.current = choiceNear(node);
    };
  }, []);
  useLayoutEffect(() => {
    // After the commit, when the control that had the focus has left.
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target?.isConnected) target.focus();
  });
  const change = (id: string, next: Partial<Draft>) => {
    setError("");
    setDraft((current) => ({
      ...current,
      [id]: { ...(current[id] as Draft), ...next },
    }));
  };
  const choices = keptChoices(draft, saved.choices);
  const dirty =
    JSON.stringify(choices) !==
    JSON.stringify(keptChoices(drafts(saved), saved.choices));
  const invalid = CONFIGURABLE.some(({ id }) => {
    const { mode, text } = draft[id] as Draft;
    return mode === "custom" && textProblem(text);
  });
  const save = async () => {
    if (saving || !dirty || invalid) return;
    setSaving(true);
    setError("");
    try {
      await saveOwnerSections(store, choices);
      const next = ownerSections(store);
      setSaved(next);
      setDraft(drafts(next));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  /** The names of the plugins that can replace `section`. */
  const plugins = (section: Section) =>
    section.plugin ? (replacedBy?.(section.id) ?? []) : [];
  /** What a section that the owner cannot configure is, in a few words. */
  const fixed = (section: Section) => {
    const able = plugins(section);
    if (able.length) return canReplace(able);
    return typeof section.text === "string" ? "Always on" : "Set by Buzz";
  };
  const unused = Object.entries(saved.unused);

  return (
    <>
      <div className="mt-section-gap">
        <InlineHeader
          title="Base instructions"
          subtitle="What Buzz tells every agent on this device before its own instructions. You can turn some sections off or replace them with your own text."
        />
        {saved.unreadable && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            Your saved choices could not be read, so every section uses its
            default text. Saving replaces them.
          </p>
        )}
        <SettingsGroup layout="form">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {CONFIGURABLE.map((section) => {
              const title = section.title ?? section.id;
              const { mode, text, basedOn } = draft[section.id] as Draft;
              const current = defaultHash(section);
              // The default text is another one than when the owner chose.
              const changed =
                mode !== "default" && !!basedOn && basedOn !== current;
              const problem = mode === "custom" ? textProblem(text) : undefined;
              const count = `${bytes(text).toLocaleString("en")} of ${SECTION_TEXT_BYTES.toLocaleString("en")} bytes`;
              const notice = `${noticeId}-${section.id}`;
              const able = plugins(section);
              const pluginNote = !able.length
                ? undefined
                : mode === "default"
                  ? canReplace(able)
                  : // The owner's choice wins over a plugin's text.
                    `Your choice also applies in chats that ${names.format(able)} ${able.length > 1 ? "manage" : "manages"}.`;
              const pluginNoteId = `${notice}-plugins`;
              return (
                <div key={section.id} data-section="" className="grid gap-2">
                  <Select
                    variant="preference"
                    label={title}
                    description={
                      changed || pluginNote ? (
                        <>
                          {changed && "Default changed"}
                          {changed && pluginNote && ". "}
                          {pluginNote && (
                            <span id={pluginNoteId}>{pluginNote}</span>
                          )}
                        </>
                      ) : undefined
                    }
                    describedBy={
                      [pluginNote && pluginNoteId, changed && notice]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    value={mode}
                    // Read-only, not disabled: a choice takes the focus when
                    // Save leaves, and a disabled control cannot.
                    readOnly={saving}
                    groups={[{ label: "", options: MODES }]}
                    onValueChange={(next) =>
                      change(section.id, {
                        mode: next as Mode,
                        // A new choice is made on the default as it is now.
                        basedOn: current,
                        // Custom starts from the default text.
                        ...(next === "custom" && !text.trim()
                          ? { text: defaultText(section) }
                          : {}),
                      })
                    }
                  />
                  {mode !== "off" && (
                    <Field
                      label={`${mode === "default" ? "Default text" : "Your text"} for ${title}`}
                      labelVisibility={
                        mode === "default" ? "hidden" : "visible"
                      }
                      description={
                        mode === "default" ? "Choose Custom to edit." : count
                      }
                      error={
                        problem && bytes(text) > SECTION_TEXT_BYTES
                          ? `${problem} ${count}.`
                          : problem
                      }
                    >
                      <Textarea
                        appearance="outlined"
                        rows={6}
                        value={mode === "default" ? defaultText(section) : text}
                        readOnly={mode === "default"}
                        disabled={mode === "custom" && saving}
                        onChange={(event) =>
                          change(section.id, { text: event.target.value })
                        }
                      />
                    </Field>
                  )}
                  {changed && (
                    <div className="grid gap-2">
                      <p
                        id={notice}
                        className="m-0 text-body-sm text-secondary"
                      >
                        The default text changed after you made this choice. The
                        default is now:
                      </p>
                      <p className={prose}>{defaultText(section)}</p>
                    </div>
                  )}
                  {mode !== "default" && (
                    <div
                      ref={actionsRef}
                      className="flex flex-wrap items-center gap-2"
                    >
                      {changed && (
                        <Button
                          type="button"
                          size="sm"
                          disabled={saving}
                          onClick={(event) => {
                            pendingFocus.current = choiceNear(
                              event.currentTarget,
                            );
                            change(section.id, { basedOn: current });
                          }}
                        >
                          Keep mine
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        disabled={saving}
                        onClick={() =>
                          change(section.id, { mode: "default", text: "" })
                        }
                      >
                        Reset to default
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
            <p className="m-0 text-caption text-secondary">
              Applies to each agent from its next turn. A session that is
              running a turn changes when the turn ends. Agents in the
              standalone agent host get a change when it next starts. Mesh
              agents do not get the base instructions.
            </p>
            {error && (
              <p role="alert" className="m-0 text-body-sm text-danger">
                {error}
              </p>
            )}
            {dirty &&
              !Object.keys(saved.choices).length &&
              Object.keys(choices).length > 0 && (
                <p className="m-0 text-body-sm text-secondary">
                  Older Codex conversations on this device start over once.
                  Older ones on another computer keep their instructions until
                  you start a new session.
                </p>
              )}
            {dirty && (
              <div
                ref={actionsRef}
                className="flex flex-wrap items-center justify-end gap-3"
              >
                <Button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setDraft(drafts(saved));
                    setError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={saving}
                  disabled={invalid}
                >
                  Save
                </Button>
              </div>
            )}
          </form>
        </SettingsGroup>
      </div>
      <div className="mt-section-gap">
        <InlineHeader
          title="All sections"
          subtitle="The default text of every section, in the order agents get them."
        />
        <SettingsGroup>
          {SECTIONS.map((section) => {
            const title = section.title ?? "Opening lines";
            const status = section.owner
              ? "You can change this"
              : fixed(section);
            return (
              <Accordion
                key={section.id}
                variant="settings"
                items={[
                  {
                    // The row's accessible name: its title and what it is.
                    value: `${title}, ${status}`,
                    title: (
                      <span className="flex items-center justify-between gap-3 text-left text-body-sm">
                        <span>{title}</span>
                        <span className="text-secondary">{status}</span>
                      </span>
                    ),
                    content: <p className={prose}>{defaultText(section)}</p>,
                  },
                ]}
              />
            );
          })}
          {unused.map(([id, choice]) => (
            <Accordion
              key={`unused/${id}`}
              variant="settings"
              items={[
                {
                  value: `${id}, no longer used`,
                  title: (
                    <span className="flex items-center justify-between gap-3 text-left text-body-sm">
                      <span>{id}</span>
                      <span className="text-secondary">No longer used</span>
                    </span>
                  ),
                  content: (
                    <p className={prose}>
                      {choice.mode === "custom"
                        ? choice.text
                        : "You turned this section off. Buzz no longer has it."}
                    </p>
                  ),
                },
              ]}
            />
          ))}
        </SettingsGroup>
      </div>
    </>
  );
}
