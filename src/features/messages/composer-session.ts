import type { RelaySession } from "../relay/session";

type AsyncResult<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => R | Promise<R>
  : never;
/** The editor consumes presentation and explicit chat operations, never a relay transport. */
export type ComposerSession = Pick<
  RelaySession,
  "viewer" | "media" | "scope"
> & {
  names?: import("../identity-names/service").IdentityNameView | undefined;
  recovery?: RelaySession["recovery"];
  repositories: Pick<
    RelaySession["repositories"],
    "home" | "load" | "peekHome"
  >;
  channels: Pick<
    RelaySession["channels"],
    | "list"
    | "subscribeList"
    | "get"
    | "ensureList"
    | "refreshList"
    | "searchPublic"
    | "matchPublic"
    | "openDirectory"
  > &
    Partial<Pick<RelaySession["channels"], "subscribeWindow" | "window">>;
  profiles: RelaySession["profiles"];
  emoji: Pick<
    RelaySession["emoji"],
    "snapshot" | "subscribe" | "ensure" | "refresh"
  >;
  agentChoices: Pick<
    RelaySession["agentChoices"],
    "snapshot" | "subscribe" | "ensure" | "retain" | "refresh"
  >;
  agentLibrary: RelaySession["agentLibrary"];
  archives: Pick<
    RelaySession["archives"],
    "snapshot" | "subscribe" | "ensure" | "state" | "refresh"
  >;
  typing: Pick<RelaySession["typing"], "snapshot" | "subscribe"> &
    Partial<Pick<RelaySession["typing"], "send">>;
  presence?: Pick<NonNullable<RelaySession["presence"]>, "status"> | undefined;
  /** `verified` names searched people; a bridge without it shows shared names only. */
  directMessages: Pick<RelaySession["directMessages"], "people"> &
    Partial<Pick<RelaySession["directMessages"], "verified">>;
  memberAdditions: Pick<RelaySession["memberAdditions"], "add">;
  channelWrites: Pick<
    RelaySession["channelWrites"],
    "refreshMembership" | "addAgents"
  >;
  outbox:
    | Pick<
        NonNullable<RelaySession["outbox"]>,
        "supports" | "snapshot" | "subscribe" | "retry"
      >
    | undefined;
  attachments:
    | (NonNullable<RelaySession["attachments"]> & {
        /** A detached editor delegates native file preparation to its owning window. */
        prepare?(file: File, signal: AbortSignal): Promise<File>;
        release?(file: import("../relay/attachments").UploadedAttachment): void;
      })
    | undefined;
  forwarding?: {
    resolve(
      reference: import("./forward-clipboard").ForwardReference,
      signal: AbortSignal,
    ): Promise<import("./resolve-forward").ResolvedForward>;
    send(
      reference: import("./forward-clipboard").ForwardReference,
      note: string,
      mentions: readonly string[],
      attachments: readonly import("../relay/attachments").UploadedAttachment[],
      references: readonly string[],
      picks: import("../relay/messages").MentionPicks,
    ): Promise<string>;
  };
  messages: {
    send: AsyncResult<RelaySession["messages"]["send"]>;
    reply: AsyncResult<RelaySession["messages"]["reply"]>;
    edit: RelaySession["messages"]["edit"];
  };
};

export function fullSession(
  session: RelaySession | ComposerSession | undefined,
): RelaySession | undefined {
  return session && "unread" in session ? session : undefined;
}
