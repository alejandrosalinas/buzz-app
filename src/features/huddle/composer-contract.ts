import type {
  ComposerDraftSend,
  ComposerDraftSendResult,
  ComposerSession,
} from "../messages/composer-session";
import type { ConversationExtensions } from "../conversation/contracts";
import type { RelaySession } from "../relay/session";
import type { UploadedAttachment } from "../relay/attachments";

export type ComposerSnapshot = {
  modelRevision: number;
  viewer: string | undefined;
  scope: string;
  room: string;
  writable: boolean;
  uploads: boolean;
  canAdd: boolean;
  channels: ReturnType<ComposerSession["channels"]["list"]>;
  profiles: ReturnType<ComposerSession["profiles"]["snapshot"]>;
  /** The owner's profile purge generation; views reread shown names when it moves. */
  profileGeneration: number;
  emoji: ReturnType<ComposerSession["emoji"]["snapshot"]>;
  agents: ReturnType<ComposerSession["agentChoices"]["snapshot"]>;
  library: ReturnType<ComposerSession["agentLibrary"]["snapshot"]>;
  archives: ReturnType<ComposerSession["archives"]["snapshot"]>;
  typing: ReturnType<ComposerSession["typing"]["snapshot"]>;
  media: ReadonlyMap<string, string | undefined>;
  tools: readonly string[];
  completions: readonly string[];
};
export type ComposerOperations = {
  forwardSource: {
    args: import("../messages/forward-clipboard").ForwardReference;
    result: import("../messages/resolve-forward").ResolvedForward;
  };
  models: {
    args: readonly string[];
    result: readonly import("../agents/react").MentionModelChoice[];
  };
  gifSupport: { args: undefined; result: boolean };
  gifSearch: { args: string; result: import("../relay/gifs").KlipyGif[] };
  send: {
    args: ComposerDraftSend;
    result: ComposerDraftSendResult;
  };
  release: { args: UploadedAttachment; result: undefined };
  agents: {
    args: { refresh: boolean; legacy: boolean | "templates" };
    result: undefined;
  };
  upload: { args: File; result: UploadedAttachment };
  profiles: { args: readonly string[]; result: undefined };
  emoji: { args: boolean; result: undefined };
  archives: { args: boolean; result: undefined };
  channels: { args: boolean; result: undefined };
  people: {
    args: { query: string; page: number };
    result: Awaited<ReturnType<RelaySession["directMessages"]["people"]>>;
  };
  add: {
    args: string;
    result: Awaited<ReturnType<RelaySession["memberAdditions"]["add"]>>;
  };
  repositoriesHome: {
    args: undefined;
    result: Awaited<ReturnType<RelaySession["repositories"]["home"]>>;
  };
  repositoriesLoad: {
    args: Parameters<RelaySession["repositories"]["load"]>[0];
    result: Awaited<ReturnType<RelaySession["repositories"]["load"]>>;
  };
};
export type ComposerOperation = keyof ComposerOperations;
export type ComposerRequest = {
  [K in ComposerOperation]: {
    kind: "request";
    client: string;
    id: number;
    op: K;
    args: ComposerOperations[K]["args"];
  };
}[ComposerOperation];
export type ComposerCommand =
  | ComposerRequest
  | { kind: "hello" | "bye"; client: string }
  | { kind: "cancel"; client: string; id: number };
export type ComposerResponse =
  | { kind: "snapshot"; client: string; value: ComposerSnapshot }
  | {
      kind: "result";
      client: string;
      id: number;
      value?: unknown;
      error?: string;
    }
  | { kind: "closed"; client: string };
export type ComposerReader = Pick<
  ConversationExtensions,
  "tools" | "completions"
>;
