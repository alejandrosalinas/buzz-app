import {
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import {
  LinkDescriptionContext,
  LinkInteractiveContext,
  LinkLabelContext,
} from "../../features/conversation/LinkLabelContext";
import { LinkLabel } from "../links/InlineLink";
import inlineStyles from "../../shared/InlineReference.module.css";
import {
  describeIssue,
  describePull,
  issueIcons,
  issueState,
  pullLinkIcon,
} from "./pull-state-view";
import type { PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";
import styles from "./GitHub.module.css";

/** A pull request or issue link in a message: the Links label with its state
 * as its icon, in place of the GitHub logo, and a pasted link named by its
 * repository, number and title. */
export function PullLink({ url, states }: { url: string; states: PullStates }) {
  const identity =
    parseGitHubReference(url, { pullSubtargets: true })?.url ?? url;
  // A composer decoration or preview shows what is already known and reads
  // nothing: typing a link mounts one for every prefix of its number.
  const live = useContext(LinkInteractiveContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      live ? states.watch(identity, listener) : () => {},
    [live, states, identity],
  );
  const read = useSyncExternalStore(subscribe, () => states.get(identity));
  const state = typeof read === "object" ? read : undefined;
  const reference = parseGitHubReference(url);
  const issue = reference?.kind === "issue";
  // The plain pull request or issue glyph until read, and when it can't be,
  // so the icon doesn't swap when the state arrives. An issue's shows why it
  // was closed.
  const shown = state && (issue ? issueState(state) : state.state);
  const Icon = issue
    ? issueIcons[state ? issueState(state) : "open"]
    : pullLinkIcon(state);
  const words = (issue ? describeIssue : describePull)({
    state,
    failed: read === "failed",
  });
  // The state describes the link rather than joining its name, which stays
  // the authored label as the state changes.
  const describe = useContext(LinkDescriptionContext);
  useEffect(() => {
    describe?.(words);
    return () => describe?.(undefined);
  }, [describe, words]);
  // A pasted link is named `repo#7`, then with its title, which is read with
  // the state. Its owner stays in the URL the link's tooltip shows.
  const authored = useContext(LinkLabelContext) !== undefined;
  const name =
    reference &&
    `${reference.repository.slice(reference.repository.indexOf("/") + 1)}${reference.label}`;
  const label = name && state?.title ? `${name} · ${state.title}` : name;
  return (
    <LinkLabel
      href={url}
      {...(!authored && label && { label })}
      icon={
        <span
          className={styles.pullState}
          data-pr-state={shown ?? "unknown"}
          aria-hidden="true"
          title={words}
        >
          <Icon aria-hidden="true" className={inlineStyles.icon} />
        </span>
      }
    />
  );
}
