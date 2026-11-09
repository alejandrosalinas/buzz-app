import { useState } from "react";
import type { AgentViewProps } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  DEFAULT_WORKSPACE,
  type MeshAgentConfig,
  type MeshMode,
  meshAgentConfig,
  validWorkspace,
} from "./meshAgent";
import { MESH_AGENT_PRESETS } from "./meshAgentPresets";

const options = (choices: readonly (readonly [string, string])[]) => [
  { label: "", options: choices.map(([value, label]) => ({ value, label })) },
];
const MODES = options([
  ["chat", "Chat"],
  ["agent", "Agent"],
]);
const MODE_DESCRIPTIONS: Record<MeshMode, string> = {
  chat: "Answers from the conversation alone, with no tools. Suits small models.",
  agent: "Works with shell, project skills and Buzz tools.",
};
const SCOPES = options([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);
const CUSTOM = "custom";
const PRESETS = options([
  [CUSTOM, "Custom"],
  ...MESH_AGENT_PRESETS.map((preset) => [preset.id, preset.name] as const),
]);

/** The Mesh type's settings: a starting preset, prompt, mode, sessions and
 * working directory. */
export function MeshAgentTab({ agent, save }: AgentViewProps<MeshAgentConfig>) {
  const saved = meshAgentConfig(agent.config);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const workspaceValid = validWorkspace(draft.workspace);
  const changed =
    draft.prompt !== saved.prompt ||
    draft.workspace.trim() !== saved.workspace ||
    draft.mode !== saved.mode ||
    draft.scope !== saved.scope ||
    draft.preset !== saved.preset;
  const preset = MESH_AGENT_PRESETS.find((item) => item.id === draft.preset);
  const submit = async () => {
    if (!changed || saving || !workspaceValid) return;
    setSaving(true);
    setError(undefined);
    try {
      await save({ ...draft, workspace: draft.workspace.trim() });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Select
        label="Start from"
        variant="field"
        value={draft.preset ?? CUSTOM}
        groups={PRESETS}
        description={
          preset?.summary ??
          "Pick an example to fill the prompt and mode, then edit as you like."
        }
        onValueChange={(value) => {
          const picked = MESH_AGENT_PRESETS.find((item) => item.id === value);
          if (!picked) {
            const { preset: _, ...rest } = draft;
            setDraft(rest);
            return;
          }
          setDraft({
            ...draft,
            preset: picked.id,
            prompt: picked.prompt,
            mode: picked.mode,
          });
        }}
      />
      <Field
        label="Prompt"
        description="The system prompt for every reply. Replies come from this community's shared compute."
      >
        <Textarea
          rows={8}
          value={draft.prompt}
          onChange={(event) =>
            setDraft({ ...draft, prompt: event.target.value })
          }
        />
      </Field>
      <Select
        label="Mode"
        variant="field"
        value={draft.mode}
        groups={MODES}
        description={MODE_DESCRIPTIONS[draft.mode]}
        onValueChange={(value) =>
          setDraft({
            ...draft,
            mode: value === "chat" ? "chat" : "agent",
          })
        }
      />
      <Select
        label="Sessions"
        variant="field"
        value={draft.scope}
        groups={SCOPES}
        onValueChange={(value) =>
          setDraft({
            ...draft,
            scope: value === "channel" ? "channel" : "thread",
          })
        }
      />
      {draft.mode !== "chat" && (
        <Field
          label="Workspace"
          description={`Where its shell runs, and where it finds project skills. An absolute path, or ${DEFAULT_WORKSPACE}.`}
          error={workspaceValid ? undefined : "Use an absolute path."}
        >
          <Input
            value={draft.workspace}
            onChange={(event) =>
              setDraft({ ...draft, workspace: event.target.value })
            }
          />
        </Field>
      )}
      {error && (
        <p role="alert" className="buzz-field-error">
          {error}
        </p>
      )}
      <div>
        <Button
          type="submit"
          variant="prominent"
          loading={saving}
          disabled={!changed || !workspaceValid}
          focusableWhenDisabled
        >
          Save
        </Button>
      </div>
    </form>
  );
}
