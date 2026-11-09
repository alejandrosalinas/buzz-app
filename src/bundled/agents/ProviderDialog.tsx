import { ProviderDialogFooter } from "../../features/agents/ProviderDialogActions";
import { useState, useSyncExternalStore, type RefObject } from "react";
import type { RegisteredAgentType } from "../../features/agents/service";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import { Dialog } from "../../shared/design-system/ui/Dialog";

export function ProviderDialog({
  type,
  finalFocus,
  visit = false,
  onClose,
}: {
  type: RegisteredAgentType | undefined;
  finalFocus: RefObject<HTMLElement | null>;
  /** Opened as its own navigation visit, so Back closes it; local opens are not. */
  visit?: boolean;
  onClose(): void;
}) {
  const provider = type?.provider;
  if (!type || !provider) return null;
  return (
    <ContributionBoundary
      key={contributionKey(type)}
      fallback={
        <Dialog
          open
          onOpenChange={(open) => !open && onClose()}
          title={type.title}
          dismissOnOutsideClick
          visit={visit}
          finalFocus={() => finalFocus.current}
        >
          <p role="alert" className="m-0 text-body-sm text-danger">
            Provider controls are unavailable.
          </p>
        </Dialog>
      }
    >
      <ManagedProviderDialog
        type={type}
        provider={provider}
        finalFocus={finalFocus}
        visit={visit}
        onClose={onClose}
      />
    </ContributionBoundary>
  );
}

function ManagedProviderDialog({
  type,
  provider,
  finalFocus,
  visit,
  onClose,
}: {
  type: RegisteredAgentType;
  provider: NonNullable<RegisteredAgentType["provider"]>;
  finalFocus: RefObject<HTMLElement | null>;
  visit: boolean;
  onClose(): void;
}) {
  const state = useSyncExternalStore(
    provider.subscribe,
    provider.snapshot,
    provider.snapshot,
  );
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const Icon = type.icon;
  const Body = provider.DialogBody;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={
        <span className="flex items-center gap-2">
          {Icon && <Icon size={22} aria-hidden="true" />}
          {type.title}
        </span>
      }
      actions={<div ref={setFooter} className="contents" />}
      height="stable"
      headerGap="compact"
      dismissOnOutsideClick
      visit={visit}
      preventClose={!!state.blocking}
      finalFocus={() => finalFocus.current}
    >
      <ProviderDialogFooter value={footer}>
        <Body onClose={onClose} />
      </ProviderDialogFooter>
    </Dialog>
  );
}
