import { useId, useRef, useState, useSyncExternalStore } from "react";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import type { Agents } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { DEFAULT_MESH_AGENT_CONFIG, meshAgentConfig } from "./meshAgent";
import { MESH_AGENT_PRESETS, type MeshAgentPreset } from "./meshAgentPresets";

/** Presets use the same creation service as Agents; editing stays in Settings. */
export function MeshHelpers({ agents }: { agents: Agents }) {
  const state = useSyncExternalStore(agents.subscribe, agents.snapshot);
  const title = useId();
  const busy = useRef(false);
  const [pending, setPending] = useState<string>();
  const [created, setCreated] = useState("");
  const [error, setError] = useState("");
  const type = agents
    .types()
    .find(
      (item) => item.pluginId === "buzz.mesh-compute" && item.id === "mesh",
    );
  const existing = (preset: MeshAgentPreset | null) =>
    state.agents.find(
      (agent) =>
        agent.type === type?.key &&
        (preset
          ? meshAgentConfig(agent.config).preset === preset.id
          : !meshAgentConfig(agent.config).preset &&
            agent.name === "Custom agent"),
    );
  const create = async (preset: MeshAgentPreset | null) => {
    if (busy.current || !type || state.status !== "ready" || existing(preset))
      return;
    const name = preset?.name ?? "Custom agent";
    busy.current = true;
    setPending(name);
    setCreated("");
    setError("");
    try {
      const agent = await agents.create({
        type: type.key,
        name,
        picture: randomAgentAvatar().url,
        config: {
          ...DEFAULT_MESH_AGENT_CONFIG,
          ...(preset
            ? {
                preset: preset.id,
                prompt: preset.prompt,
                mode: preset.mode,
              }
            : {}),
        },
      });
      setCreated(agent.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  };
  return (
    <section aria-labelledby={title} className="grid gap-3">
      <InlineHeader
        id={title}
        title="Helpers"
        subtitle="Create a helper, then add it to a conversation. Members serving its model can read the prompts and conversation history sent to them. Find your helpers in Agents."
      />
      <SettingsGroup>
        {[...MESH_AGENT_PRESETS, null].map((preset) => {
          const name = preset?.name ?? "Custom agent";
          const made = existing(preset);
          const mode = preset?.mode ?? DEFAULT_MESH_AGENT_CONFIG.mode;
          return (
            <PreferenceRow
              key={preset?.id ?? "custom"}
              title={made ? `${name} — Created` : name}
              subtitle={`${preset?.summary ?? "Start with the default assistant instructions."} ${mode === "chat" ? "Chat: no tools." : "Agent: the serving member’s model directs shell and files on this machine, plus Buzz access; workspace ~/.buzz. Tool output and core memory may be sent to that member."}`}
              trailing={
                <Button
                  size="sm"
                  disabled={
                    !type ||
                    state.status !== "ready" ||
                    pending !== undefined ||
                    Boolean(made)
                  }
                  loading={pending === name}
                  aria-label={
                    made ? `${name} created as ${made.name}` : `Create ${name}`
                  }
                  onClick={() => void create(preset)}
                >
                  {made ? "Created" : "Create"}
                </Button>
              }
            />
          );
        })}
      </SettingsGroup>
      {state.status !== "ready" && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          {state.error ??
            "Waiting for agents to be available in this community."}
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      {created && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          {created} created. Find it in Agents and add it to a conversation.
        </p>
      )}
    </section>
  );
}
