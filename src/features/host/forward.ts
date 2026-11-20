import { Channel, invoke } from "@tauri-apps/api/core";

/** Typed bindings for the native agent gateway forwarding transport
 * (`src-tauri/src/host_forward.rs`). Desktop only. */

export type ForwardOwner = Readonly<{ id: string; revision: string }>;
export type ForwardHarness = "goose";
export type ForwardClass = "discovery" | "inference";

export type ForwardEvent =
  | Readonly<{ type: "admitted"; request: number; class: ForwardClass }>
  | Readonly<{
      type: "finished";
      request: number;
      /** What the harness was answered, if anything yet. */
      status: number | null;
      aborted: boolean;
    }>
  | Readonly<{ type: "refused"; status: number; reason: string }>
  /** Always the last event: the generation is gone. */
  | Readonly<{ type: "closed" }>;

export type ForwardOpened =
  | Readonly<{ type: "opened"; id: number; url: string }>
  /** Not at the route's current revision, or it doesn't admit. */
  | Readonly<{ type: "refused"; current: number; admits: boolean }>;

export type ForwardPushed =
  | Readonly<{ type: "applied"; revoked: number }>
  | Readonly<{ type: "stale" }>;

export type ForwardOpen = Readonly<{
  route: string;
  routeRevision: number;
  harness: ForwardHarness;
  inference: Readonly<Record<string, string>>;
  discovery: Readonly<Record<string, string>>;
  onEvent: (event: ForwardEvent) => void;
}>;

/** Pushes `route`'s eligibility at `routeRevision`. */
export function pushForwardAdmission(
  owner: ForwardOwner,
  route: string,
  routeRevision: number,
  admits: boolean,
): Promise<ForwardPushed> {
  return invoke<ForwardPushed>("plugin_host_forward_admission", {
    id: owner.id,
    revision: owner.revision,
    route,
    routeRevision,
    admits,
  });
}

/** Opens a generation for one harness process; give the harness only `url`. */
export function openForward(
  owner: ForwardOwner,
  { onEvent, ...options }: ForwardOpen,
): Promise<ForwardOpened> {
  return invoke<ForwardOpened>("plugin_host_forward_open", {
    id: owner.id,
    revision: owner.revision,
    ...options,
    onEvent: new Channel<ForwardEvent>(onEvent),
  });
}

/** Names a goose generation's session, once, before its first prompt. */
export function associateForward(
  owner: ForwardOwner,
  generation: number,
  session: string,
): Promise<void> {
  return invoke<void>("plugin_host_forward_associate", {
    id: owner.id,
    generation,
    session,
  });
}

/** Ends the generation's admission for good; admitted streams finish. */
export function sealForward(
  owner: ForwardOwner,
  generation: number,
): Promise<void> {
  return invoke<void>("plugin_host_forward_seal", {
    id: owner.id,
    generation,
  });
}

/** Forgets the generation and aborts its streams; `closed` follows. */
export function closeForward(
  owner: ForwardOwner,
  generation: number,
): Promise<void> {
  return invoke<void>("plugin_host_forward_close", {
    id: owner.id,
    generation,
  });
}
