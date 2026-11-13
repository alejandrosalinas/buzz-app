import type { BuzzClient, Context } from "../../buzz-mcp/client";
import type { AddedTool } from "../../buzz-mcp/session-tools";

declare const operationBrand: unique symbol;
declare const proofBrand: unique symbol;

/** A provider's operation. Pass this descriptor to a consumer tool. */
export type AgentToolOperation = Readonly<{ [operationBrand]: true }>;
/** Proof for one checked operation and its exact arguments. */
export type AgentToolProof = Readonly<{ [proofBrand]: true }>;
export type AgentToolAuthority = Readonly<{
  client: BuzzClient;
  context: Context;
  signal: AbortSignal;
  viewer: string;
  community: string;
  /** Call after awaited reads and in the synchronous admission callback. */
  check(): void;
}>;
export type AgentToolProvider = Readonly<{
  operation: AgentToolOperation;
  /** Claims a proof once. The returned check can be called more than once. */
  resolve(
    proof: AgentToolProof,
    args: Readonly<Record<string, unknown>>,
  ): AgentToolAuthority;
}>;

type NativeCall = Readonly<{ signal: AbortSignal; check(): void }>;
type Binding = Readonly<{
  viewer: string;
  community: string;
  check(): void;
  release(): void;
}>;
const clients = new WeakMap<BuzzClient, NativeCall>();
const operations = new WeakMap<
  AgentToolOperation,
  Readonly<{
    name: string;
    bind(client: BuzzClient, context: Context, tool: AddedTool): Binding;
  }>
>();
const proofs = new WeakMap<
  AgentToolProof,
  {
    operation: AgentToolOperation;
    args: string;
    authority: AgentToolAuthority;
    claimed: boolean;
  }
>();

/** Only native runtime call sites register clients here. */
export function nativeToolClient(client: BuzzClient, call: NativeCall) {
  clients.set(client, call);
}

export function createToolOperation(
  name: string,
  bind: (client: BuzzClient, context: Context, tool: AddedTool) => Binding,
): AgentToolProvider {
  const operation = Object.freeze({}) as AgentToolOperation;
  operations.set(operation, { name, bind });
  return Object.freeze({
    operation,
    resolve(proof: AgentToolProof, args: Readonly<Record<string, unknown>>) {
      const found = proofs.get(proof);
      if (
        !found ||
        found.operation !== operation ||
        found.claimed ||
        found.args !== exactArgs(args)
      )
        throw new Error("No matching agent operation proof");
      found.authority.check();
      found.claimed = true;
      return Object.freeze({
        ...found.authority,
        check: () => {
          found.authority.check();
          if (found.args !== exactArgs(args))
            throw new Error("Agent operation arguments changed");
        },
      });
    },
  });
}

/** JSON object order carries no meaning. Array order does. */
function exactArgs(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (
      item &&
      typeof item === "object" &&
      Object.getPrototypeOf(item) === Object.prototype
    )
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => [key, normalize(value)]),
      );
    throw new Error("Agent operation arguments must be JSON values");
  };
  return JSON.stringify(normalize(value));
}

export async function callToolOperation(
  client: BuzzClient,
  context: Context,
  args: Record<string, unknown>,
  tool: AddedTool,
) {
  const operation = tool.operation;
  const registered = operation && operations.get(operation);
  const native = clients.get(client);
  if (!operation || !registered || !native)
    throw new Error("This operation requires an active native agent call");
  const input = exactArgs(args);
  context = Object.freeze(structuredClone(context));
  args = JSON.parse(input) as Record<string, unknown>;
  const current = registered.bind(client, context, tool);
  let active = true;
  const check = () => {
    if (!active) throw new Error("The agent operation call has ended");
    native.signal.throwIfAborted();
    native.check();
    current.check();
  };
  try {
    check();
    if (!client.nativeToolGate)
      await client.protect?.({
        kind: "tool",
        session: JSON.stringify(context),
        content: { title: tool.name, arguments: JSON.parse(input) },
      });
    check();
    // A consumer tool's review does not approve the provider operation.
    await client.protect?.({
      kind: "tool",
      session: JSON.stringify(context),
      content: { title: registered.name, arguments: JSON.parse(input) },
    });
    check();
    const { settings: _, ...plugin } = client;
    const authority = Object.freeze({
      client: Object.freeze(plugin),
      context,
      signal: native.signal,
      viewer: current.viewer,
      community: current.community,
      check,
    });
    const proof = Object.freeze({}) as AgentToolProof;
    proofs.set(proof, { operation, args: input, authority, claimed: false });
    return await tool.call(plugin, context, args, proof);
  } finally {
    active = false;
    current.release();
  }
}
