// Plugin-owned cards inside existing host Settings. No persistence.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import type { PageNavigation } from "../navigation/service";
import type { ChatCircleIcon } from "../../shared/design-system/icons";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
export type SettingsCard = {
  id: string;
  title: string;
  /** Optional design-system icon for this card's Settings destination. */
  icon?: typeof ChatCircleIcon;
  component: ComponentType<{
    active(): boolean;
    /** The current Settings visit; route data is presentation only. */
    navigation?: PageNavigation | undefined;
    community?: { id: string; name: string };
  }>;
  /** Account status/link inside Identity; the plugin retains its session owner. */
  identityRow?: ComponentType<{ active(): boolean }>;
  /** Show this card under a labelled account-level group instead of the selected community. */
  group?: string;
  /** Separate permission-gated controls from ordinary settings for the selected community. */
  section?: "administration";
  /** Also offer this community card in Personal space, where no community is selected. */
  personal?: boolean;
  /** Reactive verified authorization for permission-gated navigation. */
  visibility?: {
    snapshot(): boolean | "pending" | "error";
    subscribe(listener: () => void): () => void;
    ensure(): () => void;
  };
};
export type SettingsCards = {
  snapshot(): readonly Contribution<SettingsCard>[];
  subscribe(listener: () => void): () => void;
  register(card: SettingsCard): void;
  retainVisibility(): () => void;
  visibility(key: string): boolean | "pending" | "error";
  /** Active registration, independent of cached authorization visibility. */
  has(key: string): boolean;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    settingsCards: SettingsCards;
  }
}
export class SettingsCardsService extends Service implements SettingsCards {
  private readonly entries;
  private readonly listeners = new Set<() => void>();
  private visible: readonly Contribution<SettingsCard>[] = [];
  constructor(ctx: Context) {
    super(ctx, "settingsCards");
    this.entries = createContributions<SettingsCard>(ctx);
    ctx.effect(() => this.entries.subscribe(this.publish));
  }
  private publish = () => {
    const next = this.entries
      .snapshot()
      .filter(
        (entry) => !entry.visibility || entry.visibility.snapshot() === true,
      );
    if (
      next.length !== this.visible.length ||
      next.some((entry, index) => entry !== this.visible[index])
    )
      this.visible = Object.freeze(next);
    for (const listener of this.listeners) listener();
  };
  snapshot = () => this.visible;
  has = (key: string) =>
    this.entries.snapshot().some((entry) => entry.key === key);
  visibility = (key: string) => {
    const entry = this.entries.snapshot().find((entry) => entry.key === key);
    return entry ? (entry.visibility?.snapshot() ?? true) : false;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  retainVisibility() {
    const retained = new Map<Contribution<SettingsCard>, () => void>();
    const sync = () => {
      const active = new Set(this.entries.snapshot());
      for (const [entry, release] of retained)
        if (!active.has(entry)) {
          release();
          retained.delete(entry);
        }
      for (const entry of active)
        if (entry.visibility && !retained.has(entry))
          retained.set(entry, entry.visibility.ensure());
    };
    const stop = this.entries.subscribe(sync);
    sync();
    return () => {
      stop();
      for (const release of retained.values()) release();
      retained.clear();
    };
  }
  register(card: SettingsCard) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(card.id) ||
      !card.title?.trim() ||
      typeof card.component !== "function" ||
      (card.identityRow !== undefined &&
        typeof card.identityRow !== "function") ||
      (card.group !== undefined &&
        (typeof card.group !== "string" || !card.group.trim())) ||
      (card.section !== undefined && card.section !== "administration") ||
      (card.group !== undefined && card.section !== undefined) ||
      // Personal space extends an ungrouped, non-administration community card.
      (card.personal !== undefined &&
        (typeof card.personal !== "boolean" ||
          (card.personal &&
            (card.group !== undefined || card.section !== undefined)))) ||
      (card.visibility !== undefined &&
        (typeof card.visibility.snapshot !== "function" ||
          typeof card.visibility.subscribe !== "function" ||
          typeof card.visibility.ensure !== "function"))
    )
      throw new Error("Settings cards need an id, title and component");
    this.entries.register(this.ctx, card);
    if (card.visibility) {
      const visibility = card.visibility;
      this.ctx.effect(() => visibility.subscribe(this.publish));
    }
    this.publish();
  }
}
