import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import { CircleNotchIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { ProviderDialog } from "./ProviderDialog";
import type { PageNavigation } from "../../features/navigation/service";

export function AgentDefaults({
  agents,
  navigation,
  onProvider,
}: {
  agents: Agents;
  navigation?: PageNavigation | undefined;
  onProvider?: ((provider?: string) => void) | undefined;
}) {
  const types = useSyncExternalStore(
    agents.subscribe,
    agents.types,
    agents.types,
  );
  useEffect(() => {
    for (const { provider } of types) {
      if (!provider) continue;
      try {
        void Promise.resolve(provider.check()).catch(() => {});
      } catch {
        // A failed contribution must not block the other providers.
      }
    }
  }, [types]);
  return (
    <div className="mt-section-gap">
      <InlineHeader title="Harness defaults" />
      <SettingsGroup>
        {types.map((type) => {
          if (!type.provider) return null;
          const fallback = (
            <PreferenceRow
              title={type.title}
              trailing={
                <Button
                  size="sm"
                  disabled
                  aria-label={`${type.title}, unavailable`}
                >
                  Unavailable
                </Button>
              }
            />
          );
          return (
            <ContributionBoundary
              key={contributionKey(type)}
              fallback={fallback}
            >
              <ProviderDefaults
                type={type}
                provider={type.provider}
                navigation={navigation}
                onProvider={onProvider}
              />
            </ContributionBoundary>
          );
        })}
      </SettingsGroup>
    </div>
  );
}

function ProviderDefaults({
  type,
  provider,
  navigation,
  onProvider,
}: {
  type: RegisteredAgentType;
  provider: NonNullable<RegisteredAgentType["provider"]>;
  navigation?: PageNavigation | undefined;
  onProvider?: ((provider?: string) => void) | undefined;
}) {
  const state = useSyncExternalStore(
    provider.subscribe,
    provider.snapshot,
    provider.snapshot,
  );
  const [localOpen, setLocalOpen] = useState(false);
  const routed = navigation?.target.kind === "settings" && !!onProvider;
  const open = routed
    ? navigation.target.kind === "settings" &&
      navigation.target.provider === type.key
    : localOpen;
  const setOpen = (open: boolean) => {
    if (!routed) setLocalOpen(open);
    else if (!navigation.signal.aborted)
      onProvider(open ? type.key : undefined);
  };
  const focusTarget = useRef<HTMLElement>(null);
  const checking = state.readiness === "checking";
  const statusOnly =
    state.readiness === "attention" && state.attentionLabel === null;
  // A recheck must not unmount the focused inline defaults control.
  const [settledReadiness, setSettledReadiness] = useState(state.readiness);
  if (!checking && settledReadiness !== state.readiness) {
    setSettledReadiness(state.readiness);
  }
  const label =
    state.readiness === "attention"
      ? (state.attentionLabel ?? `Set up ${type.title}`)
      : type.title;
  const Icon = type.icon;
  const DefaultControl = provider.DefaultControl;
  const select = () => {
    if (state.readiness === "attention" && provider.attentionAction) {
      try {
        provider.attentionAction();
        return;
      } catch {
        // Fall back to the provider's recovery guidance.
      }
    }
    setOpen(true);
  };
  return (
    <>
      <PreferenceRow
        title={type.title}
        icon={Icon && <Icon size={20} />}
        subtitle={
          statusOnly ? (
            <span
              ref={(node) => {
                focusTarget.current = node;
              }}
              tabIndex={-1}
            >
              {state.attentionDescription}
            </span>
          ) : state.readiness === "attention" ? (
            state.attentionDescription
          ) : undefined
        }
        trailing={(description) => {
          if (statusOnly) return null;
          return (checking ? settledReadiness : state.readiness) === "ready" &&
            DefaultControl ? (
            <div
              ref={(node) => {
                if (node) focusTarget.current = node.querySelector("button");
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="text-body-sm text-subtle">Default model</span>
              <DefaultControl
                onConfigure={() => {
                  setOpen(true);
                }}
              />
            </div>
          ) : (
            <Button
              ref={(node) => {
                focusTarget.current = node;
              }}
              size="sm"
              aria-label={`${label}, ${state.readiness}`}
              aria-describedby={description["aria-describedby"]}
              aria-busy={checking || undefined}
              disabled={checking}
              onClick={select}
            >
              {checking && (
                <CircleNotchIcon
                  size={17}
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                />
              )}
              {checking
                ? "Checking…"
                : state.readiness === "attention"
                  ? label
                  : "Edit configuration"}
            </Button>
          );
        }}
      />
      {open && (
        <ProviderDialog
          type={type}
          finalFocus={focusTarget}
          visit={routed}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
