import { useContext } from "react";
import { LinkLabelContext } from "../../features/conversation/LinkLabelContext";
import { GitCommitIcon } from "../../shared/design-system/icons/index";
import inlineStyles from "../../shared/InlineReference.module.css";
import { LinkLabel } from "../links/InlineLink";
import { PullLink } from "./PullLink";
import type { PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";

/** A GitHub link in a message, named by what it links to: `owner/repo`, a
 * pull request or issue with its state, or `repo@abc1234`. An authored label
 * stays. */
export function GitHubLink({
  url,
  states,
}: {
  url: string;
  states: PullStates;
}) {
  const authored = useContext(LinkLabelContext) !== undefined;
  const reference = parseGitHubReference(url, { pullSubtargets: true });
  if (reference?.kind === "repository")
    return (
      <LinkLabel
        href={url}
        {...(!authored && { label: reference.repository })}
      />
    );
  if (reference?.kind === "commit") {
    const repo = reference.repository.slice(
      reference.repository.indexOf("/") + 1,
    );
    return (
      <LinkLabel
        href={url}
        {...(!authored && { label: `${repo}@${reference.label}` })}
        icon={
          <GitCommitIcon aria-hidden="true" className={inlineStyles.icon} />
        }
      />
    );
  }
  return <PullLink url={url} states={states} />;
}
