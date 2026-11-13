import { createShortcutBindings } from "../../features/shortcuts/preferences";
import { matches } from "../../features/shortcuts/bindings";
import type { GifShortcut } from "./gif-shortcut";
import { useConversationPresentation } from "../../features/conversation/ConversationPresentation";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SmileyIcon,
  SmileyPlusIcon,
} from "../../shared/design-system/icons/index";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import type { ComposerSession } from "../../features/messages/composer-session";
import type { CustomEmoji } from "../../features/relay/emoji";
import {
  communityFromScope,
  gifMarkdown,
  relayGifRequests,
  type GifRequests,
} from "../../features/relay/gifs";
import styles from "./Emoji.module.css";
import { GifPicker } from "./GifPicker";
import type { EmojiSearchSelection } from "./emoji-mart";

const EMOJI_SIZE = 36;
const EMOJI_SLOT = 48;
const PICKER_COLUMN_CHROME = 44;
// Two balanced scrollbar lanes plus five gaps between six fixed-size slots.
const PICKER_CHROME = 72;
const NO_ENTRIES: readonly CustomEmoji[] = [];

/** Reusable composer picker; data/signing remain owned by the community session. */
export function EmojiPicker({
  session,
  scope,
  disabled,
  insert,
  reaction = false,
  gifRequests = relayGifRequests,
  externalTrigger,
  gifShortcut,
}: {
  session: ComposerSession;
  gifShortcut?: GifShortcut;
  scope: string;
  disabled: boolean;
  insert(value: string): void;
  reaction?: boolean;
  gifRequests?: GifRequests | undefined;
  externalTrigger?: {
    ref: RefObject<HTMLButtonElement | null>;
    id: string;
    close(): void;
    finalFocus(): HTMLButtonElement | false;
  };
}) {
  const active = useConversationPresentation();
  const [colorMode, setColorMode] = useState<"light" | "dark">();
  const [open, setOpen] = useState(!!externalTrigger);
  const [tab, setTab] = useState<"emoji" | "gifs">("emoji");
  const [gifAvailability, setGifAvailability] = useState<{
    community: string;
    supported: boolean | undefined;
    error?: string;
  }>();
  const [gifDiscoveryRequested, setGifDiscoveryRequested] = useState(false);
  const [{ perLine, availableWidth, scale }, setLayout] = useState({
    perLine: 0,
    availableWidth: 0,
    scale: 1,
  });
  const [error, setError] = useState<string>();
  const [attempt, retry] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLFieldSetElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const search = useRef("");
  const searchSelection = useRef<EmojiSearchSelection | undefined>(undefined);
  const onInsert = useRef(insert);
  onInsert.current = insert;
  const accepted = useRef(false);
  const escapeFocus = useRef<HTMLElement | false>(false);
  const community = reaction ? undefined : communityFromScope(scope);
  const gifs = community
    ? gifAvailability?.community === community
      ? gifAvailability.supported
      : undefined
    : false;
  const currentGifs = useRef(gifs);
  currentGifs.current = gifs;
  const showGifTab = gifs === true || tab === "gifs";
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  // Remount Emoji Mart for catalog contents, not for status-only publishes.
  const entries = catalog.status === "ready" ? catalog.entries : NO_ENTRIES;
  useLayoutEffect(() => {
    if (!open) return;
    const origin = externalTrigger?.ref.current ?? controls.current;
    const themedSurface = origin?.closest<HTMLElement>("[data-color-mode]");
    const mode =
      themedSurface === document.documentElement
        ? undefined
        : themedSurface?.dataset.colorMode;
    setColorMode(mode === "dark" || mode === "light" ? mode : undefined);
  }, [open, externalTrigger]);
  useLayoutEffect(() => {
    // The popover is positioned against the composer; intermediate tool groups
    // may be narrower and are not its available width.
    const container = reaction
      ? document.documentElement
      : (controls.current?.closest("form") ?? controls.current?.offsetParent);
    if (!open || disabled || !(container instanceof HTMLElement)) return;
    const root = document.documentElement;
    const resize = () => {
      const scale =
        (Number.parseFloat(getComputedStyle(root).fontSize) || 16) / 16;
      setLayout({
        scale,
        availableWidth: container.clientWidth,
        perLine: Math.max(
          1,
          Math.min(
            6,
            Math.floor(
              (container.clientWidth - PICKER_COLUMN_CHROME * scale) /
                (EMOJI_SLOT * scale),
            ),
          ),
        ),
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    // Reaction pickers can keep the same viewport width while the root scale changes.
    const appearance = new MutationObserver(resize);
    appearance.observe(root, { attributes: true, attributeFilter: ["style"] });
    return () => {
      observer.disconnect();
      appearance.disconnect();
    };
  }, [open, disabled, reaction]);
  useEffect(() => {
    const form = controls.current?.closest("form");
    if (!form || reaction || disabled || !community || !active) return;
    const open = () => {
      accepted.current = false;
      if (currentGifs.current !== true) setGifAvailability(undefined);
      setGifDiscoveryRequested(true);
      setTab("gifs");
      setOpen(true);
    };
    if (gifShortcut) return gifShortcut.register(form, open);
    const bindings = createShortcutBindings(window);
    const apple = /Mac|iPhone|iPad/.test(window.navigator.platform);
    const openGifs = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.getModifierState("AltGraph") ||
        event.keyCode === 229 ||
        !matches(
          bindings.resolve("buzz.emoji/gif-picker") ?? [
            { key: "g", mod: true },
          ],
          event,
          apple,
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      open();
    };
    form.addEventListener("keydown", openGifs, true);
    return () => {
      form.removeEventListener("keydown", openGifs, true);
      bindings.dispose();
    };
  }, [community, disabled, reaction, active, gifShortcut]);
  useEffect(() => {
    if (
      !community ||
      !gifDiscoveryRequested ||
      (gifAvailability?.community === community &&
        gifAvailability.supported !== undefined)
    )
      return;
    const controller = new AbortController();
    void gifRequests.supports(community, controller.signal).then(
      (supported) => {
        if (!controller.signal.aborted) {
          setGifAvailability({ community, supported });
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setGifAvailability({
            community,
            supported: undefined,
            error: "Could not check GIF availability.",
          });
          setGifDiscoveryRequested(false);
        }
      },
    );
    return () => controller.abort();
  }, [community, gifDiscoveryRequested, gifAvailability, gifRequests]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed lazy import.
  useLayoutEffect(() => {
    if (!open || disabled || tab !== "emoji" || !host || !perLine) return;
    const container = host;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setError(undefined);
    // Keep the Unicode dataset and search work out of startup/channel opening.
    void import("./emoji-mart")
      .then(({ mountEmojiMart }) => {
        if (cancelled) return;
        dispose = mountEmojiMart({
          host: container,
          colorMode,
          scope,
          perLine,
          emojiSize: EMOJI_SIZE * scale,
          emojiButtonSize: EMOJI_SLOT * scale,
          search: search.current,
          searchSelection,
          searchChange: (value) => {
            search.current = value;
          },
          entries,
          media: session.media,
          select: (value) => {
            onInsert.current(value);
            accepted.current = true;
            setOpen(false);
          },
          close: () => setOpen(false),
        });
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      search.current =
        container
          .querySelector("em-emoji-picker")
          ?.shadowRoot?.querySelector<HTMLInputElement>('input[type="search"]')
          ?.value ?? search.current;
      dispose?.();
    };
  }, [
    open,
    disabled,
    session,
    scope,
    entries,
    attempt,
    perLine,
    scale,
    tab,
    host,
    colorMode,
  ]);
  const emojiContent = (
    <div className={styles.emojiMart}>
      <div ref={setHost} tabIndex={-1} />
    </div>
  );
  const gifContent = community && (
    <GifPicker
      community={community}
      enabled={gifs === true}
      unavailable={
        gifs === false
          ? "GIFs are not available in this community."
          : gifAvailability?.community === community
            ? gifAvailability.error
            : undefined
      }
      retryDiscovery={
        gifAvailability?.community === community && gifAvailability.error
          ? () => {
              setGifAvailability(undefined);
              setGifDiscoveryRequested(true);
            }
          : undefined
      }
      search={gifRequests.search}
      initialQuery={search.current}
      onQueryChange={(value) => {
        search.current = value;
      }}
      select={(gif) => {
        onInsert.current(gifMarkdown(gif));
        accepted.current = true;
        setOpen(false);

        setTab("emoji");
      }}
    />
  );
  const picker = (
    <div className={styles.emojiContent} data-tabs={showGifTab || undefined}>
      <Tabs
        variant="panel"
        label="Media type"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "emoji", label: "Emoji" },
          ...(showGifTab ? [{ value: "gifs" as const, label: "GIF" }] : []),
        ]}
        renderPanel={(value) => (value === "emoji" ? emojiContent : gifContent)}
      />

      {tab === "emoji" && error && (
        <div role="alert" className={styles.emojiStatus}>
          Could not load emoji picker: {error}
          <Button type="button" onClick={() => retry(attempt + 1)}>
            Retry picker
          </Button>
        </div>
      )}
      {/* Session recovery retries a transient failure; Unicode stays usable. */}
      {tab === "emoji" &&
        (catalog.status === "loading" ||
          (catalog.status === "error" && catalog.transient)) && (
          <LoadingRegion pending label="Loading community emoji…">
            {null}
          </LoadingRegion>
        )}
      {tab === "emoji" && catalog.error && !catalog.transient && (
        <div className={styles.emojiStatus}>
          <p role="alert">{catalog.error}</p>
          <Button type="button" onClick={() => void session.emoji.refresh()}>
            Retry emoji
          </Button>
        </div>
      )}
    </div>
  );
  const button = (
    <IconButton
      hint="familiar"
      size="toolbar"
      shape={reaction ? "round" : "control"}
      ref={trigger}
      type="button"
      aria-label={reaction ? "Add reaction" : "Emoji and GIFS"}
      title={reaction ? "Add reaction" : "Emoji and GIFS"}
      aria-busy={(gifDiscoveryRequested && gifs === undefined) || undefined}
      disabled={disabled}
      onPointerEnter={() => setGifDiscoveryRequested(true)}
      onFocus={() => setGifDiscoveryRequested(true)}
      icon={
        reaction ? (
          <SmileyPlusIcon size={18} aria-hidden="true" />
        ) : (
          <SmileyIcon size={20} aria-hidden="true" />
        )
      }
    />
  );
  const controlsView = (
    <fieldset
      ref={controls}
      data-external-trigger={!!externalTrigger || undefined}
      disabled={disabled}
      aria-label="Emoji controls"
      className={styles.emojiPicker}
      onKeyDownCapture={(event) => {
        // Mart stops search key events before they bubble out of its shadow root.
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          const target = externalTrigger
            ? externalTrigger.finalFocus()
            : trigger.current;
          // An external toolbar stays hidden until the popup closes. Use the
          // shared return-focus path; ordinary composer focus stays immediate.
          if (externalTrigger) escapeFocus.current = target ?? false;
          else if (target) target.focus();
          // Keyboard dismissal is immediate; release the external trigger before
          // another Enter can arrive, rather than waiting for exit completion.
          externalTrigger?.close();
        }
      }}
    >
      {!externalTrigger && (
        <PopoverTrigger disabled={disabled} render={button} />
      )}
      <PopoverPopup
        colorMode={colorMode}
        side={reaction && !externalTrigger ? "bottom" : "top"}
        anchor={
          reaction
            ? externalTrigger?.ref
            : () => controls.current?.closest("form") ?? trigger.current
        }
        sideOffset={reaction ? 6 : 4}
        collisionPadding={16}
        // Each media panel focuses its search after its asynchronous content mounts.
        initialFocus={false}
        padding="none"
        id={externalTrigger?.id}
        aria-label="Emoji picker"
        style={{
          width: Math.min(
            availableWidth,
            (perLine * EMOJI_SLOT + PICKER_CHROME) * scale + 2,
          ),
          overflow: "hidden",
        }}
        finalFocus={
          externalTrigger
            ? () => escapeFocus.current || externalTrigger.finalFocus()
            : !accepted.current || !!reaction
        }
      >
        {picker}
      </PopoverPopup>
    </fieldset>
  );
  return (
    <PopoverRoot
      open={open && !disabled}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) externalTrigger?.close();
      }}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          accepted.current = false;
          escapeFocus.current = false;
          void session.emoji.ensure("foreground");
          if (gifs !== true && gifAvailability?.community === community)
            setGifAvailability(undefined);
          setGifDiscoveryRequested(true);
        }
      }}
    >
      {controlsView}
    </PopoverRoot>
  );
}
