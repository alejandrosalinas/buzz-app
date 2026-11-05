import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Input } from "../../shared/design-system/ui/Input";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  usePanelTabHost,
  usePanelTabTitle,
} from "../../features/panels/PanelWorkspace";
import { AgentSaveFooter } from "../../features/agents/AgentSaveButton";
import type { ChannelChoice } from "../../features/agents/attention";
import type { AgentMemories } from "../../features/agents/MemoryPanel";
import type {
  Agent,
  Agents,
  AgentConversation,
  AgentViewProps,
  RegisteredAgentType,
  TranscriptRequest,
} from "../../features/agents/service";
import {
  AgentArchiveRetry,
  AgentDelete,
  AgentRemoveHere,
  inSeveral,
} from "../../features/agents/AgentManage";
import {
  CopyIcon,
  DotsThreeIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import type { CommunityReader } from "../../features/communities/service";
import { communityPresentation } from "../../features/communities/community-icon";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  canonicalPublicKey,
  formatPublicKey,
} from "../../shared/identity/public-key";
import { AgentPortrait, useAgentPortraitSource } from "./AgentCard";
import { AgentIdentityDialog } from "./AgentIdentityDialog";
import { useNamePrompt, useShake } from "./useNamePrompt";
import { AgentTabs } from "./AgentTabs";
import type { HistoryPresentation } from "../../features/agents/history-presentation";
import { AgentConfigHistoryRow } from "../../features/agents/AgentConfigHistoryRow";
import { useAgentSettingsHost } from "./AgentSettingsHost";
import styles from "./AgentsPage.module.css";
import { PackedAgentAvatar } from "./PackedAgentAvatar";
import { ProfileBackdrop } from "../../features/profiles/ProfileBackdrop";
import hero from "../../features/profiles/ProfileHero.module.css";
import { writeClipboardText } from "../../shared/clipboard";
import { SettingsSectionLink } from "../../features/navigation/SettingsSectionLink";

export function AgentDetails({
  agents,
  agent,
  type,
  types,
  channels,
  memories,
  onRemoved,
  messageAction,
  conversation,
  initialActivity,
  initialTranscript,
  close,
  openConversation,
  communities,
  openSettings,
  historyPresentation,
}: {
  historyPresentation?: HistoryPresentation | undefined;
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  types: readonly RegisteredAgentType[];
  channels: readonly ChannelChoice[];
  memories: AgentMemories | undefined;
  onRemoved(): void;
  messageAction: (variant: "glass" | "subtle") => ReactNode;
  conversation?: AgentConversation | undefined;
  initialActivity?: boolean;
  initialTranscript?: TranscriptRequest | undefined;
  /** Closes the panel showing the agent. */
  close?: () => void;
  /** Opens a turn's conversation from its activity; see AgentViewProps. */
  openConversation?: AgentViewProps["openConversation"];
  communities?: CommunityReader | undefined;
  openSettings?: ((section: string) => void) | undefined;
}) {
  const ProfileActions = type?.ProfileActions ?? Fragment;
  const { pack, src: backdrop } = useAgentPortraitSource(agent, agent.relay);
  const tabbed = !!usePanelTabHost();
  const reducedMotion = useReducedMotion();
  const identityTransition = {
    duration:
      reducedMotion ||
      document.documentElement.hasAttribute("data-keyboard-navigation")
        ? 0
        : 0.22,
    ease: [0.23, 1, 0.32, 1] as const,
  };
  const tabAvatar = useMemo(
    () => (
      <span aria-hidden="true" className="block h-full w-full">
        <AgentPortrait agent={agent} community={agent.relay} />
      </span>
    ),
    [agent],
  );
  usePanelTabTitle(agent.name, tabAvatar);
  const [saveFooter, setSaveFooter] = useState<HTMLDivElement | null>(null);
  const [signInVisible, setSignInVisible] = useState(false);
  const [footerVisible, setFooterVisible] = useState(false);
  const [panelNotice, setPanelNotice] = useState<ReactNode>(null);
  const content = useRef<HTMLDivElement>(null);
  const [panelFooter, setPanelFooter] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const footer = panelFooter;
    const scroll = content.current;
    if (!footer || !scroll) {
      setSignInVisible(false);
      setFooterVisible(false);
      return;
    }
    const measure = () => {
      setFooterVisible(footer.childElementCount > 0);
      setSignInVisible(
        [...footer.children].some(
          (sheet) =>
            sheet.getAttribute("data-agent-access-required") !== "false",
        ),
      );
      // Share the fields' usable width, excluding either side's scrollbar gutter.
      footer.style.width = `${scroll.clientWidth}px`;
      footer.style.left = `${scroll.offsetLeft + scroll.clientLeft}px`;
      scroll.style.setProperty(
        "--agent-footer-height",
        `${footer.getBoundingClientRect().height}px`,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      // Updating the scroll inset also resizes its content box; settle outside delivery.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(footer);
    observer.observe(scroll);
    // Presence can replace equally tall sheets with different access semantics.
    const changes = new MutationObserver((records) => {
      measure();
      // An exiting sheet becomes inert before its replacement mounts.
      if (
        document.activeElement === document.body &&
        records.some((record) => record.addedNodes.length > 0)
      )
        footer
          .querySelector<HTMLElement>(
            ':scope > :not([inert]) :is(button:not(:disabled), [role="button"]:not([aria-disabled="true"]))',
          )
          ?.focus({ preventScroll: true });
    });
    changes.observe(footer, { childList: true });
    return () => {
      observer.disconnect();
      changes.disconnect();
      cancelAnimationFrame(frame);
      scroll.style.removeProperty("--agent-footer-height");
    };
  }, [panelFooter]);
  useEffect(() => {
    // Setup or sign-in removes its focused button; continue in the selected tab.
    if (!footerVisible && document.activeElement === document.body)
      content.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
  }, [footerVisible]);
  const [copied, setCopied] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const identityMenu = useRef<HTMLButtonElement>(null);
  const [editingName, setEditingName] = useState(false);
  const closeIdentityEditors = useCallback(() => {
    setEditingName(false);
    setEditingIdentity(false);
  }, []);
  useLayoutEffect(() => {
    if (signInVisible) closeIdentityEditors();
  }, [signInVisible, closeIdentityEditors]);
  const [name, setName] = useState(agent.name);
  const [namePending, setNamePending] = useState(false);
  const [nameError, setNameError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const nameEditor = useRef<HTMLDivElement>(null);
  const namePrompt = useNamePrompt(nameInput);
  useShake(nameEditor, namePrompt.attempts);
  const nameMessage =
    nameError || (namePrompt.attempts ? "Add a name to save your agent" : "");
  const nameMessageId = useId();
  useEffect(() => {
    if (!editingName) return;
    // Wait for the closing menu's focus handoff before placing the caret.
    const frame = requestAnimationFrame(() => {
      const input = nameInput.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [editingName]);
  const finishName = () => {
    setEditingName(false);
    requestAnimationFrame(() => identityMenu.current?.focus());
  };
  const saveName = async () => {
    if (namePending) return;
    if (!name.trim()) {
      setNameError("");
      namePrompt.prompt();
      return;
    }
    setNamePending(true);
    setNameError("");
    try {
      await agents.save(agent.key, { name: name.trim() });
      finishName();
    } catch (reason) {
      setNameError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setNamePending(false);
    }
  };
  const openIdentity = (target: "name" | "avatar") => {
    if (target === "avatar") setEditingIdentity(true);
    else {
      setName(agent.name);
      setNameError("");
      namePrompt.named(agent.name);
      setEditingName(true);
    }
  };
  const [copyError, setCopyError] = useState("");
  const npub = canonicalPublicKey(agent.pubkey);
  const settings = useAgentSettingsHost({ agents, agent, type, types });
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <AgentSaveFooter
      value={{
        target: saveFooter,
        setPanelNotice,
        notice: (
          <SharedSettingsNotice
            agents={agents}
            agent={agent}
            communities={communities}
          />
        ),
      }}
    >
      <div className={styles.build}>
        <div ref={content} className={styles.detailsScroll}>
          {!tabbed && (
            <IconButton
              aria-label="Close"
              size="sm"
              icon={<XIcon size={16} />}
              onClick={onRemoved}
            />
          )}
          <motion.aside
            className={`${hero.hero} ${hero.panelHero} ${styles.identityCard}`}
            aria-label={`${agent.name} identity`}
            initial={false}
            animate={{
              "--agent-artwork-grayscale": signInVisible ? 1 : 0,
              "--agent-artwork-scale":
                signInVisible && !reducedMotion ? 0.85 : 1,
              "--agent-artwork-opacity":
                signInVisible && !reducedMotion ? 0.5 : 1,
              "--agent-artwork-blur":
                signInVisible && !reducedMotion ? "2px" : "0px",
            }}
            transition={
              reducedMotion
                ? { duration: 0 }
                : signInVisible
                  ? { duration: 10, ease: "linear" }
                  : {
                      duration: 0.8,
                      ease: [0.23, 1, 0.32, 1],
                      "--agent-artwork-scale": {
                        type: "spring",
                        duration: 1.1,
                        bounce: 0.65,
                      },
                    }
            }
          >
            <ProfileBackdrop src={backdrop}>
              {pack && <PackedAgentAvatar avatar={pack} fit="cover" />}
            </ProfileBackdrop>
            <motion.div
              className={styles.identityPortrait}
              initial={false}
              animate={{
                scale: editingName ? 0.55 : 1,
                y: editingName ? "-1.8rem" : "0rem",
              }}
              transition={identityTransition}
            >
              <AgentPortrait agent={agent} community={agent.relay} />
            </motion.div>
            <motion.div
              className={styles.identityName}
              initial={false}
              animate={{
                scale: editingName ? 1.3 : 1,
                y: editingName ? "-1.8rem" : "0rem",
              }}
              transition={identityTransition}
            >
              <h2
                className="m-0 text-body-lg text-center break-words"
                style={{ visibility: editingName ? "hidden" : undefined }}
              >
                {agent.name}
              </h2>
              {editingName && (
                <div ref={nameEditor} className={styles.nameEditor}>
                  <Input
                    appearance="heading"
                    ref={nameInput}
                    aria-label="Agent name"
                    placeholder="Name your agent"
                    aria-invalid={namePrompt.attempts > 0 || undefined}
                    aria-describedby={nameMessage ? nameMessageId : undefined}
                    value={name}
                    disabled={namePending}
                    onChange={(event) => {
                      setName(event.target.value);
                      namePrompt.named(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveName();
                      }
                      if (event.key === "Escape" && !namePending) {
                        event.preventDefault();
                        event.stopPropagation();
                        finishName();
                      }
                    }}
                  />
                </div>
              )}
            </motion.div>
            <div className={hero.actions}>
              {!editingName && messageAction(backdrop ? "glass" : "subtle")}
              <ProfileActions
                {...(type?.ProfileActions
                  ? { onUnavailable: closeIdentityEditors }
                  : {})}
              >
                {editingName ? (
                  <motion.div
                    className={styles.nameActions}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                      duration:
                        reducedMotion ||
                        document.documentElement.hasAttribute(
                          "data-keyboard-navigation",
                        )
                          ? 0
                          : 0.15,
                    }}
                  >
                    <Button
                      size="sm"
                      shape="control"
                      disabled={namePending}
                      onClick={finishName}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      shape="control"
                      variant="prominent"
                      loading={namePending}
                      onClick={() => void saveName()}
                    >
                      Save
                    </Button>
                  </motion.div>
                ) : (
                  <MenuRoot>
                    <MenuTrigger
                      render={
                        <IconButton
                          ref={identityMenu}
                          aria-label="Agent profile actions"
                          variant={backdrop ? "glass" : "subtle"}
                          size="sm"
                          icon={<DotsThreeIcon aria-hidden="true" />}
                        />
                      }
                    />
                    <MenuPopup
                      align="end"
                      finalFocus={() =>
                        nameInput.current ?? identityMenu.current ?? false
                      }
                    >
                      <MenuItem onClick={() => openIdentity("avatar")}>
                        Change avatar
                      </MenuItem>
                      <MenuItem onClick={() => openIdentity("name")}>
                        Change name
                      </MenuItem>
                    </MenuPopup>
                  </MenuRoot>
                )}
              </ProfileActions>
            </div>
            {editingName && nameMessage && (
              <p
                id={nameMessageId}
                role="alert"
                className="m-0 text-body-sm text-danger"
              >
                {nameMessage}
              </p>
            )}
            {editingIdentity && (
              <AgentIdentityDialog
                agent={agent}
                agents={agents}
                communities={communities}
                finalFocus={identityMenu}
                onClose={() => setEditingIdentity(false)}
              />
            )}
          </motion.aside>
          <section
            className={styles.work}
            aria-label={`${agent.name} settings`}
          >
            {!type && (
              <p className="m-0 mb-4 text-body-sm text-secondary">
                Enable the plugin that provides this agent's type in{" "}
                <SettingsSectionLink section="plugins" open={openSettings}>
                  Manage plugins
                </SettingsSectionLink>{" "}
                to change its settings.
              </p>
            )}
            <AgentTabs
              showSettings={historyPresentation?.active}
              agents={agents}
              agent={settings.agent}
              type={settings.type}
              channels={channels}
              conversation={conversation}
              initialActivity={initialActivity}
              initialTranscript={initialTranscript}
              close={close}
              openConversation={openConversation}
              settingsHost={settings.settingsHost}
              onDiscard={settings.discard}
              memories={memories}
              communities={communities}
              settingsContent={
                <div>
                  <InlineHeader title="Agent details" level={4} />
                  <SettingsGroup>
                    <PreferenceRow
                      title="Public key"
                      subtitle={
                        <code title={npub}>
                          {formatPublicKey(agent.pubkey, 8)}
                        </code>
                      }
                      trailing={
                        <IconButton
                          aria-label={copied ? "Copied" : "Copy public key"}
                          size="sm"
                          icon={<CopyIcon size={16} aria-hidden="true" />}
                          disabled={!npub}
                          onClick={() => {
                            if (!npub) return;
                            setCopyError("");
                            void Promise.resolve()
                              .then(() => writeClipboardText(npub))
                              .then(() => setCopied(true))
                              .catch(() =>
                                setCopyError(
                                  "Could not copy the public key. Try again.",
                                ),
                              );
                          }}
                        />
                      }
                    />
                    {agent.place === "here" && (
                      <AgentConfigHistoryRow
                        agents={agents}
                        pubkey={agent.pubkey}
                        presentation={historyPresentation}
                      />
                    )}
                    <AgentArchiveRetry agents={agents} agent={agent} />
                    {inSeveral(agents, agent) && (
                      <PreferenceRow
                        title="Remove from this community"
                        subtitle={
                          agent.deleting
                            ? "Its Remove didn't finish, so it stays stopped here. Remove it again to finish."
                            : `Also in ${agents
                                .memberships(agent.pubkey)
                                .filter(
                                  (membership) =>
                                    membership.key !== agent.key &&
                                    !membership.deleting,
                                )
                                .map(({ origin }) =>
                                  origin.replace(/^https:\/\//, ""),
                                )
                                .join(", ")}, where it stays.`
                        }
                        trailing={
                          <AgentRemoveHere
                            agents={agents}
                            agent={agent}
                            onRemoved={onRemoved}
                            trigger={(open) => (
                              <Button
                                size="compact"
                                variant="outline"
                                aria-label="Remove from this community"
                                onClick={open}
                              >
                                Remove
                              </Button>
                            )}
                          />
                        }
                      />
                    )}
                    <PreferenceRow
                      title="Delete agent"
                      subtitle={
                        agent.deleting &&
                        !inSeveral(agents, agent) &&
                        "Its Delete didn't finish, so it stays stopped. Delete it again to finish."
                      }
                      trailing={
                        <AgentDelete
                          agents={agents}
                          agent={agent}
                          onRemoved={onRemoved}
                          trigger={(open) => (
                            <Button
                              size="compact"
                              variant="destructive"
                              aria-label="Delete agent"
                              onClick={open}
                            >
                              Delete
                            </Button>
                          )}
                        />
                      }
                    />
                  </SettingsGroup>
                  {copyError && (
                    <p role="alert" className="mt-2 text-body-sm text-danger">
                      {copyError}
                    </p>
                  )}
                </div>
              }
            />
          </section>
          <div ref={setSaveFooter} className={styles.saveFooter} />
        </div>
        {(type?.PanelFooter || panelNotice) && (
          <div ref={setPanelFooter} className={styles.panelFooter}>
            <AnimatePresence mode="wait">
              {panelNotice ??
                (type?.PanelFooter && <type.PanelFooter key="notice" />)}
            </AnimatePresence>
          </div>
        )}
      </div>
    </AgentSaveFooter>
  );
}

const noSubscribe = () => () => {};

/** Shared configuration edits affect every remaining membership, including offline ones. */
function SharedSettingsNotice({
  agents,
  agent,
  communities,
}: {
  agents: Agents;
  agent: Agent;
  communities: CommunityReader | undefined;
}) {
  const known = useSyncExternalStore(
    communities?.subscribe ?? noSubscribe,
    () => communities?.snapshot(),
  );
  const memberships = agents
    .memberships(agent.pubkey)
    .filter((membership) => !membership.deleting)
    .sort((a, b) => Number(b.key === agent.key) - Number(a.key === agent.key));
  if (memberships.length < 2) return null;
  const items = memberships.map(({ origin }) => ({
    ...communityPresentation(origin, known?.memberships),
    shape: "squircle" as const,
  }));
  const names = items.map((item) => item.name).join(", ");
  return (
    <div className={styles.sharedSettingsNotice}>
      <PopoverRoot>
        <PopoverTrigger
          openOnHover="preview"
          render={
            <Button variant="plain" size="inline" style={{ maxWidth: "100%" }}>
              <span className="flex min-w-0 flex-wrap items-center justify-center gap-1 whitespace-normal text-subtle">
                Shared across
                <AvatarStack items={items} size="mini" />
                <span className="sr-only">{names}</span>
              </span>
            </Button>
          }
        />
        <PopoverPopup
          side="top"
          align="center"
          aria-label={`${agent.name}’s shared settings`}
        >
          <p className="m-0 text-body-sm text-subtle">
            {agent.name}’s name, instructions, and settings are shared across
            these communities:
          </p>
          <ul
            aria-label="Communities"
            className="m-0 mt-2 grid list-none gap-2 p-0"
          >
            {items.map((item) => (
              <li
                key={item.id}
                className="flex min-w-0 items-center gap-2 text-body-sm"
              >
                <Avatar
                  src={item.src}
                  alt=""
                  fallback={item.name}
                  shape={item.shape}
                  size="small"
                />
                <span className="min-w-0 break-words">{item.name}</span>
              </li>
            ))}
          </ul>
        </PopoverPopup>
      </PopoverRoot>
    </div>
  );
}
