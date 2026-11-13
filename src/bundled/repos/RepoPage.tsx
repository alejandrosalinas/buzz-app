import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PageProps } from "../../features/pages/service";
import type { PageNavigation } from "../../features/navigation/service";
import type {
  Navigation,
  OpenFailure,
} from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import { useRelayConnection, useChannelList } from "../../features/relay/react";
import { useReauthorizedRetry } from "../../features/relay/RecoveryNotice";
import {
  isSignInRefusal,
  reauthorizedOnce,
} from "../../features/relay/recovery";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  MAX_MARKDOWN_LENGTH,
  scanMarkdown,
} from "../../features/relay/message-content";
import {
  EntityFailure,
  entityFailure,
  value,
  type EntityDetail,
} from "../../features/repos/destinations";
import {
  entityHref,
  entityDtag,
  entityTarget,
  entityTabs,
  parseEntityRoute,
  type EntityRoute,
} from "../../features/repos/routes";
import type { GitSnapshot } from "../../features/repos/git";
import { formatPublicKey } from "../../shared/identity/public-key";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { CopyIcon, FileTextIcon } from "../../shared/design-system/icons";
import type {
  CodeBlockRenderer,
  ContributionReader,
} from "../../features/conversation/contracts";
import {
  MarkdownDocument,
  sharedComponents,
} from "../../features/markdown/MarkdownDocument";
import type { MarkdownProfile } from "../../features/markdown/profiles";
import "./repos.css";
import { writeClipboardText } from "../../shared/clipboard";

type Open = Navigation["open"];
const labels = {
  overview: "Overview",
  files: "Files",
  commits: "Commits",
  prs: "Pull requests",
  issues: "Issues",
  contributors: "Contributors",
  channels: "Channels",
};
const tabs = ["overview", ...entityTabs].map((value) => ({
  value,
  label: labels[value as keyof typeof labels],
}));
type Loaded = {
  detail?: EntityDetail;
  git?: GitSnapshot;
  gitChannel?: string;
  gitError?: OpenFailure;
};

export function RepoPage({
  relay,
  navigation,
  open,
  codeBlocks,
}: PageProps & {
  relay: RelayData;
  open: Open;
  /** Plugin code-block renderers for README and description bodies. */
  codeBlocks?: ContributionReader<CodeBlockRenderer> | undefined;
}) {
  const connection = useRelayConnection(relay);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  const target = request?.target;
  const scope = target?.kind === "page" ? target.scope : undefined;
  useEffect(() => {
    if (!request || request.signal.aborted) return;
    if (target?.kind === "page" && !target.route && !scope) {
      if (
        connection.status === "ready" &&
        connection.scope &&
        connection.viewer &&
        scope === undefined
      )
        request.resolve({
          ...target,
          scope: {
            viewer: connection.viewer,
            communityOrigin: connection.scope.slice(
              0,
              -(connection.viewer.length + 1),
            ),
          },
        });
      else if (connection.status === "disconnected")
        request.complete({ status: "opened" });
      else if (connection.status !== "connecting")
        request.complete({ status: "failed", reason: "unavailable" });
      return;
    }
    if (
      !scope ||
      connection.status === "error" ||
      connection.status === "disconnected"
    )
      request.complete({ status: "failed", reason: "unavailable" });
  }, [request, connection, scope, target]);
  return (
    <RepoCodeBlocks value={codeBlocks}>
      <FullPageSurface aria-label="Repository">
        <div className="repos-page text-body">
          {connection.status === "ready" && request && scope ? (
            <Destination
              key={`${connection.scope}:${connection.generation}`}
              session={connection.session}
              request={request}
              open={open}
              scope={scope}
            />
          ) : (
            <>
              <h1 className="text-title">Repository</h1>
              <p role="status">
                {connection.status === "connecting"
                  ? "Connecting to your community..."
                  : "Select a community to open a repository."}
              </p>
            </>
          )}
        </div>
      </FullPageSurface>
    </RepoCodeBlocks>
  );
}

function Destination({
  session,
  request,
  open,
  scope,
}: {
  session: RelaySession;
  request: PageNavigation;
  open: Open;
  scope: NavigationScope;
}) {
  const target = request.target;
  const route = useMemo(
    () =>
      target.kind === "page" && target.route
        ? parseEntityRoute(target.route.params)
        : null,
    [target],
  );
  const [selection, setSelection] = useState<{
    target: typeof target;
    path: string | undefined;
  }>();
  const path = selection?.target === target ? selection.path : undefined;
  const setPath = (path: string | undefined) => setSelection({ target, path });
  const [refresh, setRefresh] = useState(0);
  const owner = useMemo(
    () => ({ request, route, path, refresh }),
    [request, route, path, refresh],
  );
  const [state, setState] = useState<{
    owner: typeof owner;
    data?: Loaded;
    error?: OpenFailure;
    /** The credential generation of a read refused for missing sign-in. */
    refused?: number;
  }>();
  const heading = useRef<HTMLHeadingElement>(null);
  useChannelList(session.channels);
  const current = state?.owner === owner ? state : undefined;
  const stored = current?.data;
  const revoked =
    !!stored?.git &&
    !!stored.gitChannel &&
    !session.channels.get?.(stored.gitChannel);
  const data =
    revoked && stored
      ? { ...stored, git: undefined, gitError: "denied" as const }
      : stored;
  const gitRequired =
    route &&
    "tab" in route &&
    ["files", "commits", "contributors"].includes(route.tab ?? "");
  useEffect(() => {
    if (revoked)
      setState((previous) => {
        if (previous?.owner !== owner || !previous.data) return previous;
        const { git: _git, ...metadata } = previous.data;
        return { owner, data: { ...metadata, gitError: "denied" } };
      });
  }, [revoked, owner]);
  // A repository read refused while signed out reads again once sign-in lands.
  const reauthorized = useReauthorizedRetry(session.recovery, () =>
    setRefresh((n) => n + 1),
  );
  useEffect(() => {
    if (request.signal.aborted) return;
    const controller = new AbortController();
    const failed = reauthorized.begin();
    const sent = session.recovery?.snapshot().reauthorized ?? 0;
    const signal = AbortSignal.any([controller.signal, request.signal]);
    async function load(): Promise<Loaded> {
      if (target.kind !== "page" || (target.route && !route))
        throw new EntityFailure("invalid-target");
      if (!route) return {};
      const detail = await session.repositories.load(route, signal);
      const tab = "tab" in route ? route.tab : undefined;
      if (tab === "channels")
        await session.channels.resolve?.(detail.channels, { signal });
      if (
        "id" in route ||
        tab === "prs" ||
        tab === "issues" ||
        tab === "channels"
      )
        return { detail };
      const repository = detail.entity;
      try {
        if (!session.projectGit) throw new EntityFailure("unavailable");
        const gitChannel = value(repository.event, "buzz-channel");
        if (gitChannel) {
          await session.channels.resolve?.([gitChannel], { signal });
          if (!session.channels.get?.(gitChannel))
            throw new EntityFailure("denied");
        }
        const git = await session.projectGit.read(
          {
            owner: repository.owner,
            dtag: repository.dtag,
            ...(route.type === "repo" && route.commit
              ? { commit: route.commit }
              : {}),
            ...(path ? { path } : {}),
          },
          signal,
        );
        if (gitChannel && !session.channels.get?.(gitChannel))
          throw new EntityFailure("denied");
        return { detail, git, ...(gitChannel ? { gitChannel } : {}) };
      } catch (error) {
        signal.throwIfAborted();
        if (tab) throw error;
        failed(error);
        return { detail, gitError: entityFailure(error) };
      }
    }
    void load().then(
      (data) => {
        if (!signal.aborted) setState({ owner, data });
      },
      (error) => {
        if (signal.aborted) return;
        setState({
          owner,
          error: entityFailure(error),
          ...(isSignInRefusal(error) ? { refused: sent } : {}),
        });
        failed(error);
      },
    );
    return () => controller.abort();
  }, [owner, request, route, session, target, path, reauthorized]);
  const recovery = session.recovery;
  useEffect(() => {
    if (current?.error || (gitRequired && data?.gitError))
      request.complete({
        status: "failed",
        reason: current?.error ?? data?.gitError ?? "unavailable",
        // The page goes with the failure; navigation reopens it after sign-in.
        ...(recovery && current?.refused !== undefined
          ? {
              reauthorize: (reopen: () => void) =>
                reauthorizedOnce(recovery, current.refused ?? 0, reopen),
            }
          : {}),
      });
    else if (data) {
      heading.current?.focus({ preventScroll: true });
      request.complete({ status: "opened" });
    }
  }, [current, data, gitRequired, request, recovery]);
  const go = (next: EntityRoute) => {
    setPath(undefined);
    void open(entityTarget(next, scope));
  };
  const failure = current?.error ?? (gitRequired ? data?.gitError : undefined);
  if (failure)
    return (
      <div role="alert">
        <h1 className="text-title">This destination couldn’t open</h1>
        <p>
          {failure === "not-found"
            ? "The requested entity was not found in this community."
            : "Repository content is unavailable."}
        </p>
        <Button onClick={() => setRefresh((n) => n + 1)}>Retry</Button>
      </div>
    );
  if (!data) return <p role="status">Loading repository...</p>;
  const detail = data.detail;
  if (!detail)
    return (
      <>
        <h1 ref={heading} tabIndex={-1} className="text-title">
          Destination no longer available
        </h1>
        <p role="status">
          Project containers are no longer available. Open a repository, issue
          or pull request link instead.
        </p>
      </>
    );
  const active =
    route && "id" in route
      ? route.type === "pr"
        ? "prs"
        : "issues"
      : route && "tab" in route
        ? (route.tab ?? "overview")
        : "overview";
  const base = {
    type: detail.entity.type,
    owner: detail.entity.owner,
    dtag: detail.entity.dtag,
  };
  const commit = detail.commit;
  const channels = detail.channels.flatMap((id) => {
    const channel = session.channels.get?.(id);
    return channel ? [channel] : [];
  });
  return (
    <>
      <header className="repo-heading">
        <div>
          <p className="text-secondary">
            Repository · {formatPublicKey(detail.entity.owner)}
          </p>
          <h1 ref={heading} tabIndex={-1} className="text-title">
            {detail.item
              ? (value(detail.item, "subject") ??
                detail.item.content.split("\n")[0])
              : detail.entity.name}
          </h1>
        </div>
        {route && <CopyLink route={route} />}
      </header>
      {detail.item && (
        <Button variant="link" onClick={() => go(base)}>
          {detail.entity.name}
        </Button>
      )}
      <Tabs
        variant="panel"
        label="Repository sections"
        items={tabs}
        value={active}
        onValueChange={(tab) =>
          go({
            ...base,
            ...(tab === "overview"
              ? {}
              : { tab: tab as (typeof entityTabs)[number] }),
          })
        }
      />
      <section className="repo-content" aria-label={labels[active]}>
        {detail.item ? (
          <>
            <p>
              {detail.status} · {formatPublicKey(detail.item.pubkey)} ·{" "}
              <time>
                {new Date(detail.item.created_at * 1000).toLocaleString()}
              </time>
            </p>
            <Body text={detail.item.content} open={open} scope={scope} />
            {commit && (
              <p>
                Look up commit in the base repository:{" "}
                <Button
                  variant="link"
                  disabled={!session.projectGit}
                  onClick={() =>
                    go({ ...base, type: "repo", tab: "commits", commit })
                  }
                >
                  <code>{commit}</code>
                </Button>{" "}
                Exact PR diffs from external forks are unavailable. This lookup
                only works if the commit is readable from the base repository.
              </p>
            )}
            <h2 className="text-heading">Discussion</h2>
            {detail.activity.length ? (
              detail.activity.map((event) => (
                <article className="repo-comment" key={event.id}>
                  <p className="text-secondary">
                    {formatPublicKey(event.pubkey)} ·{" "}
                    {new Date(event.created_at * 1000).toLocaleString()}
                  </p>
                  <Body text={event.content} open={open} scope={scope} />
                </article>
              ))
            ) : (
              <p>No comments.</p>
            )}
          </>
        ) : active === "overview" ? (
          <>
            <Body text={detail.entity.description} open={open} scope={scope} />
            {data.gitError ? (
              <p role="status">
                {data.gitError === "denied"
                  ? "Repository files require access to the linked channel."
                  : "Repository files are unavailable."}{" "}
                <Button variant="link" onClick={() => setRefresh((n) => n + 1)}>
                  Retry files
                </Button>
              </p>
            ) : data.git?.readme ? (
              <Body text={data.git.readme} open={open} scope={scope} />
            ) : (
              <p>No README in this repository.</p>
            )}
          </>
        ) : active === "prs" || active === "issues" ? (
          <>
            <ul className="repo-list">
              {detail.items.map((item) => {
                const repo = detail.entity;
                return (
                  <li key={item.id}>
                    <Button
                      variant="link"
                      disabled={!entityDtag(repo.dtag)}
                      onClick={() =>
                        go({
                          type: active === "prs" ? "pr" : "issue",
                          owner: repo.owner,
                          dtag: repo.dtag,
                          id: item.id,
                        })
                      }
                    >
                      {value(item, "subject") ?? item.content.split("\n")[0]}
                    </Button>
                    <small>{repo.name}</small>
                  </li>
                );
              })}
            </ul>
            {!detail.items.length && (
              <p>No {labels[active].toLowerCase()} found.</p>
            )}
          </>
        ) : active === "channels" ? (
          <ul className="repo-list">
            {channels.map((channel) => (
              <li key={channel.id}>
                <Button
                  variant="link"
                  onClick={() =>
                    void open({
                      version: 1,
                      kind: "conversation",
                      scope,
                      channelId: channel.id,
                    })
                  }
                >
                  {channel.name}
                </Button>
              </li>
            ))}
            {!channels.length && <li>No accessible linked channels.</li>}
          </ul>
        ) : data.git ? (
          <GitContent
            git={data.git}
            active={active}
            selectFile={setPath}
            selectCommit={(commit) => {
              const repo = detail.entity;
              go({
                type: "repo",
                owner: repo.owner,
                dtag: repo.dtag,
                tab: "commits",
                commit,
              });
            }}
          />
        ) : (
          <p>No repository linked.</p>
        )}
      </section>
    </>
  );
}

function GitContent({
  git,
  active,
  selectFile,
  selectCommit,
}: {
  git: GitSnapshot;
  active: string;
  selectFile(path: string | undefined): void;
  selectCommit(hash: string): void;
}) {
  if (active === "files")
    return git.file ? (
      <>
        <Button variant="link" onClick={() => selectFile(undefined)}>
          All files
        </Button>
        <h2 className="text-heading">{git.file.path}</h2>
        {git.file.content !== null ? (
          <pre className="repo-code text-code">{git.file.content}</pre>
        ) : (
          <p>Binary file or text larger than 1 MiB ({git.file.size} bytes).</p>
        )}
      </>
    ) : (
      <ul className="repo-list">
        {git.files.map((file) => (
          <li key={file.path}>
            <FileTextIcon size={18} />
            <Button variant="link" onClick={() => selectFile(file.path)}>
              {file.path}
            </Button>
            <small>{file.size} bytes</small>
          </li>
        ))}
        {!git.files.length && <li>No files.</li>}
      </ul>
    );
  if (active === "commits")
    return git.diff !== null ? (
      <>
        <h2 className="text-heading">Commit {git.head}</h2>
        <section aria-label="Commit changes">
          <pre className="repo-code text-code">{git.diff}</pre>
        </section>
      </>
    ) : (
      <>
        <p className="text-secondary">Latest {git.commits.length} commits</p>
        <ul className="repo-list">
          {git.commits.map((commit) => (
            <li key={commit.hash}>
              <Button variant="link" onClick={() => selectCommit(commit.hash)}>
                {commit.subject}
              </Button>
              <small>
                {commit.author} · {commit.hash.slice(0, 10)}
              </small>
            </li>
          ))}
        </ul>
      </>
    );
  const counts = new Map<string, number>();
  for (const commit of git.commits)
    counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1);
  return (
    <>
      <p className="text-secondary">
        Contributors in the latest {git.commits.length} commits
      </p>
      <ul className="repo-list">
        {[...counts]
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => (
            <li key={name}>
              <span>{name}</span>
              <small>{count} commits</small>
            </li>
          ))}
      </ul>
    </>
  );
}
function CopyLink({ route }: { route: EntityRoute }) {
  const [status, setStatus] = useState("");
  return (
    <div>
      <IconButton
        hint="familiar"
        aria-label="Copy link"
        title="Copy link"
        icon={<CopyIcon size={18} />}
        onClick={() =>
          void writeClipboardText(entityHref(route)).then(
            () => setStatus("Link copied"),
            () => setStatus("Could not copy link"),
          )
        }
      />
      <span role="status">{status}</span>
    </div>
  );
}
const PROFILE: MarkdownProfile = {
  syntax: [remarkGfm],
  transforms: [],
  html: "literal",
};
const RepoCodeBlocks = createContext<
  ContributionReader<CodeBlockRenderer> | undefined
>(undefined);
const RepoLinks = createContext<{ open: Open; scope: NavigationScope } | null>(
  null,
);
const COMPONENTS: Components = {
  ...sharedComponents,
  a: function RepoLink({ href, children }) {
    const links = useContext(RepoLinks);
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (links && href && isBuzzLink(href)) {
            event.preventDefault();
            const target = buzzLinkTarget(href, links.scope);
            if (target) void links.open(target);
          }
        }}
      >
        {children}
      </a>
    );
  },
  // A README's own images load, as on the repository's host.
  img: ({ node: _node, alt, ...props }) => <img alt={alt ?? ""} {...props} />,
};
export function Body({
  text,
  open,
  scope,
}: {
  text: string;
  open: Open;
  scope: NavigationScope;
}) {
  const codeBlocks = useContext(RepoCodeBlocks);
  const plain = useMemo(
    () => text.length > MAX_MARKDOWN_LENGTH || scanMarkdown(text).tooDeep,
    [text],
  );
  const links = useMemo(() => ({ open, scope }), [open, scope]);
  if (plain) return <div className="repo-markdown repo-plain">{text}</div>;
  return (
    <RepoLinks value={links}>
      <MarkdownDocument
        content={text}
        profile={PROFILE}
        // Buzz links are admitted only in the current scope.
        urlTransform={(url) => {
          if (isBuzzLink(url)) return buzzLinkTarget(url, scope) ? url : "";
          return /^(https?:|mailto:)/i.test(url) ? url : "";
        }}
        components={COMPONENTS}
        capabilities={{ codeBlocks, copy: true }}
        scale="document"
        className="repo-markdown"
      />
    </RepoLinks>
  );
}
