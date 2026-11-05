import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { loadPolicy, open, parse, savePolicy, type Rule } from "./authors";

/** Whose pull request comments and reviews wake agents watching it. */
export function AuthorSettings({ active }: { active(): boolean }) {
  const [saved, setSaved] = useState(loadPolicy);
  const [draft, setDraft] = useState(saved.text);
  const [fallback, setFallback] = useState(saved.fallback);
  /** Why the rules could not be saved, apart from why they are not rules. */
  const [error, setError] = useState("");
  // After a Save, each edit checks the rules again.
  const [checked, setChecked] = useState(saved.error !== undefined);
  const parsed = parse(draft);
  const dirty =
    typeof parsed === "string" ||
    parsed.text !== saved.text ||
    fallback !== saved.fallback;
  return (
    <section aria-label="GitHub comment authors settings">
      <InlineHeader
        title="Comment authors"
        subtitle="Agents watching a pull request are woken by CI, and by the comments and reviews these rules allow."
      />
      <form
        aria-label="GitHub comment author rules"
        onSubmit={(event) => {
          event.preventDefault();
          if (!active() || !dirty) return;
          setChecked(true);
          if (typeof parsed === "string") return;
          try {
            const policy = savePolicy(draft, fallback);
            setSaved(policy);
            setDraft(policy.text);
            setChecked(false);
            setError("");
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        }}
      >
        <SettingsGroup layout="form">
          {saved.error !== undefined && (
            <p role="status" className="m-0 text-body-sm text-subtle">
              Your saved rules no longer parse, so no comment or review wakes
              your agents until you fix them.
            </p>
          )}
          {open(saved) && (
            <p role="status" className="m-0 text-body-sm text-subtle">
              Comments from anyone no rule denies can wake your agents. To limit
              them, allow only org:name or author:login, and don’t wake them
              when no rule matches.
            </p>
          )}
          <Field
            label="Rules"
            error={checked && typeof parsed === "string" ? parsed : undefined}
            description="One per line: allow or deny, then any of author:login, author:/pattern/, org:organization, body:/pattern/ and prefix:text, which runs to the end of the line. Patterns are JavaScript regular expressions without backreferences, lookaround or escapes JavaScript reads as plain letters, such as \q. body: sees a comment's first 1,000 characters, the most a wake quotes. A bare allow or deny matches everyone. author:@me is your GitHub account, a bot's login ends in [bot], and logins match case aside. The first rule that matches decides. Membership your GitHub account cannot see, or of a misspelled organization, counts as none."
          >
            <Textarea
              rows={6}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
          </Field>
          <Field label="When no rule matches" nativeLabel={false}>
            <RadioGroup<Rule["effect"]>
              aria-label="When no rule matches"
              value={fallback}
              onValueChange={setFallback}
            >
              <Radio value="allow" label="Wake the agent" />
              <Radio value="deny" label="Don’t wake it" />
            </RadioGroup>
          </Field>
          {error && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="submit" variant="primary" disabled={!dirty}>
              Save
            </Button>
          </div>
        </SettingsGroup>
      </form>
    </section>
  );
}
