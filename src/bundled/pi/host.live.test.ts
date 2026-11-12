// @vitest-environment node
// The real host.mjs on Pi durable, with Pi's faux provider for a model: run
// with PI_DEPS set to a folder pi.sh installed Pi's packages in, such as
// "~/Library/Application Support/Buzz/pi/deps/<sum>".
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import host from "./host.mjs?raw";
import { piHookOutput } from "../hook-output";

const DEPS = process.env.PI_DEPS;
const run = promisify(execFile);

/** Serves the plugin's side over in-process streams, as Buzz would. */
const DRIVER = `
import { spawn } from "node:child_process";
import { rm, utimes, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import lockfile from "proper-lockfile";
import { AuthFile, serve } from "./host.mjs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTool, GenerationTask, Harness, hook } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
const originalOpen = Harness.open;
let openedHarness;
Harness.open = async (...args) => {
  openedHarness = await originalOpen(...args);
  // While \`statusGate\` is set, reads of a request's status wait for it;
  // while \`failRead\` is, the next one fails.
  const submission = openedHarness.submission.bind(openedHarness);
  openedHarness.submission = async (...ids) => {
    const found = await submission(...ids);
    return found && new Proxy(found, { get: (target, key) => key === "status"
      ? async (...rest) => { if (failRead) { failRead = false; throw new Error("Storage failed"); } const gate = statusGate; if (gate) { gate.entered.release(); await gate.gate; } return target.status(...rest); }
      : typeof target[key] === "function" ? target[key].bind(target) : target[key] });
  };
  // While \`staleSnapshot\` is set, a watch gets a commit before the value
  // it follows, and that value still shows a run working.
  const observeConversation = openedHarness.observeConversation.bind(openedHarness);
  openedHarness.observeConversation = async (id, observer, ...rest) => {
    const observation = await observeConversation(id, observer, ...rest);
    if (!staleSnapshot) return observation;
    observer.advance({ kind: "value", value: observation.value, ops: [], retired: false });
    const docs = { ...observation.value.docs, "pi.live": { ...observation.value.docs["pi.live"], run: { taskId: 0, inputs: [], turns: 0 } } };
    return { value: { ...observation.value, docs }, detach: () => observation.detach() };
  };
  return openedHarness;
};
/** A tool that runs another through Pi, as Code Mode does. */
const nesting = defineExtension({
  name: "nesting",
  tools: [defineTool({
    name: "nest",
    description: "Run a command through bash",
    parameters: { type: "object", properties: {} },
    execute: async (_args, api, context) => {
      await api.executeTool("bash", { command: "printf nested" }, context);
      return { output: [{ type: "text", text: "nested" }] };
    },
  })],
});
const data = process.argv[2];
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const agent = "b".repeat(64);
const tools = [
  { name: "send", description: "Post", inputSchema: { type: "object", properties: { text: { type: "string" }, final: { type: "boolean" } } }, load: "always" },
  { name: "watch_add", description: "Watch for events", inputSchema: { type: "object" }, load: "search" },
];
const out = {};
let blockTools = false, rewriteTools = false, rewriteCommand = false, blockedMessages = [], statusGate, staleSnapshot = false, failRead = false;
const hookEvents = [];
function start(prompt = async () => undefined, extensions = [nesting]) {
  const input = new PassThrough(), output = new PassThrough();
  const events = [], tools = [], pending = new Map();
  let id = 0;
  createInterface({ input: output }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "event") events.push(message.params);
    else if (message.method === "hook") {
      const { event, input: call } = message.params;
      hookEvents.push(event);
      const result = blockTools && event === "beforeTool" ? ${JSON.stringify(piHookOutput({ block: "Fixture blocks the command" }, "fixture-policy"))}
        : rewriteTools && event === "beforeTool" ? { arguments: { ...call.arguments, text: "Rewritten arguments" } }
        : rewriteTools && event === "afterTool" ? ${JSON.stringify(piHookOutput({ output: [{ type: "text", text: "Replaced result" }] }, "fixture-policy"))}
        : rewriteCommand && event === "beforeTool" && call.name === "bash" && call.arguments.command === "printf original" ? { arguments: { command: "printf rewritten" } }
        : null;
      input.write(JSON.stringify({ id: message.id, result }) + "\\n");
    }
    else if (message.method === "prompt") {
      Promise.resolve(prompt(message.params)).then((result) =>
        input.write(JSON.stringify({ id: message.id, result: result ?? false }) + "\\n"));
    } else if (message.method === "tool") {
      tools.push(message.params);
      const final = message.params.arguments.final === true;
      input.write(JSON.stringify({ id: message.id, result: { content: [{ type: "text", text: "sent" }], ...(final ? { final } : {}) } }) + "\\n");
    } else if (message.id !== undefined) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error));
      else call.resolve(message.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    input.write(JSON.stringify({ id, method, params }) + "\\n");
  });
  const { stop } = serve({ data, models, packages: { extensions, errors: [] }, dir: data, input, output, exit: () => {} });
  return { rpc, events, tools, stop };
}
const turn = (request, text) => ({ agent, key: "chan/root", at: 100, context: { channel: "chan", root: "root" }, text, steer: "steer: " + text, request, provider: "faux", model: "faux-1", instructions: "Test.", cwd: data });
const held = () => { let release; const gate = new Promise((resolve) => (release = resolve)); return { gate, release }; };
const abortable = (gate, signal) => Promise.race([gate, new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
const started = (events, request) => new Promise((resolve) => { const check = () => events.some((event) => event.type === "placed" && event.request === request) ? resolve() : setTimeout(check, 5); check(); });

let pi = start();
await pi.rpc("open", { agent, tools });
// A provider only a Pi package adds is not one Buzz's Pi has.
out.unknown = await pi.rpc("test", { provider: "databricks", model: "m" }).catch((error) => error.message);
// A final send ends the run without another model call.
faux.setResponses([fauxAssistantMessage(fauxToolCall("buzz_send", { text: "hi", final: true }), { stopReason: "toolUse" })]);
const a = await pi.rpc("deliver", turn("A", "first"));
out.a = { ...(await pi.rpc("wait", { agent, submission: a.submission })), calls: faux.state.callCount, tools: pi.tools.splice(0), conversation: a.conversation };
// A plain answer, in the same conversation.
faux.setResponses([fauxAssistantMessage("Plain answer")]);
const b = await pi.rpc("deliver", turn("B", "second"));
out.b = { ...(await pi.rpc("wait", { agent, submission: b.submission })), conversation: b.conversation };
// A cleanup write must not replace an already-settled answer with an RPC error.
const commit = openedHarness.commit;
let waitCommits = 0;
openedHarness.commit = function (...args) {
  if (++waitCommits === 2) throw new Error("Reply cleanup storage failure");
  return commit.apply(this, args);
};
try { out.cleanupFailure = await pi.rpc("wait", { agent, submission: b.submission, request: "B" }); }
finally { openedHarness.commit = commit; }
// What a transcript and usage read: the places, and the entries without schemas.
out.places = (await pi.rpc("places", { agent })).places;
// Another membership of the same identity has its own durable storage.
const secondary = agent + "@secondary.example%3A7447";
await pi.rpc("open", { agent: secondary, tools });
out.secondaryPlaces = (await pi.rpc("places", { agent: secondary })).places;
await pi.rpc("close", { agent: secondary });
out.recorded = Object.keys((await pi.rpc("recorded", { agent, conversation: a.conversation })).models);
out.entries = (await pi.rpc("entries", { agent, conversation: a.conversation })).entries.map((entry) => [entry.kind, ...(entry.model ?? []).map((message) => message.role + (message.usage ? "+usage" : ""))]);
// A policy enabled after the process started blocks the same live tool path.
blockTools = true;
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("buzz_send", { text: "blocked", final: true }), { stopReason: "toolUse" }),
  (context) => { blockedMessages = context.messages; return fauxAssistantMessage("Blocked by policy"); },
]);
const blockedFrom = pi.events.length;
const blockedHooks = hookEvents.length;
const blocked = await pi.rpc("deliver", turn("HOOK", "blocked tool"));
out.blocked = { ...(await pi.rpc("wait", { agent, submission: blocked.submission })), messages: blockedMessages, tools: pi.tools.splice(0), conversation: blocked.conversation };
out.blocked.steps = pi.events.slice(blockedFrom).filter((event) => event.type === "step");
// Buzz's hooks see only calls that ran: a blocked one gets no afterTool.
out.blocked.hooks = hookEvents.slice(blockedHooks);
blockTools = false;
// A request while the run works steers it.
rewriteTools = true;
const c = held();
let saw = [], results = [];
faux.setResponses([
  async () => { await c.gate; return fauxAssistantMessage(fauxToolCall("buzz_send", { text: "working" }), { stopReason: "toolUse" }); },
  (context) => { saw = context.messages.filter((m) => m.role === "user").map((m) => m.content); results = context.messages.filter((m) => m.role === "toolResult").map((m) => m.content); return fauxAssistantMessage("Answer to both"); },
]);
const c1 = await pi.rpc("deliver", turn("C1", "third"));
await started(pi.events, "C1");
const c2 = await pi.rpc("deliver", turn("C2", "fourth"));
c.release();
const cWaits = await Promise.all([c1, c2].map((x) => pi.rpc("wait", { agent, submission: x.submission })));
out.c = { rewritten: pi.tools.slice(-1)[0]?.arguments, waits: cWaits, saw, results, placed: pi.events.filter((e) => e.type === "placed").map((e) => [e.request, e.entry]), steps: pi.events.filter((e) => e.type === "step").map((e) => e.tool) };
rewriteTools = false;
// A run the host stops in continues in the next host.
const d = held(), calling = held();
faux.setResponses([
  async (_context, options) => { calling.release(); await abortable(d.gate, options?.signal); return fauxAssistantMessage("first try"); },
  () => fauxAssistantMessage("Resumed answer"),
]);
const d1 = await pi.rpc("deliver", { ...turn("D", "fifth"), reply: { channel: "chan", root: "wake-root", topLevel: false } });
await calling.gate;
const stopped = pi.rpc("wait", { agent, submission: d1.submission });
await pi.stop();
out.stopped = await stopped;
pi = start();
await pi.rpc("open", { agent, tools });
out.unfinished = (await pi.rpc("unfinished", { agent })).submissions;
out.resumed = await pi.rpc("wait", { agent, submission: d1.submission });
// A run that fails leaves no request it was steered with waiting for the next.
const e = held();
faux.setResponses([async () => { await e.gate; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 Bad model" }); }]);
const e1 = await pi.rpc("deliver", turn("E1", "sixth"));
await started(pi.events, "E1");
const e2 = await pi.rpc("deliver", turn("E2", "seventh"));
e.release();
out.e = await Promise.all([e1, e2].map((x) => pi.rpc("wait", { agent, submission: x.submission })));
// The owner's Stop aborts the run.
const g = held(), asking = held();
faux.setResponses([async (_context, options) => { asking.release(); await abortable(g.gate, options?.signal); return fauxAssistantMessage("never"); }]);
const g1 = await pi.rpc("deliver", turn("G", "ninth"));
await asking.gate;
await pi.rpc("abort", { agent, conversation: g1.conversation });
out.aborted = await pi.rpc("wait", { agent, submission: g1.submission });
// Session controls act on a conversation key's Pi conversation.
const s = held(), running = held();
faux.setResponses([async (_context, options) => { running.release(); await abortable(s.gate, options?.signal); return fauxAssistantMessage("never"); }]);
const s1 = await pi.rpc("deliver", turn("S", "session"));
await running.gate;
await pi.rpc("session", { agent, key: "chan/root", action: "interrupt" });
out.interrupted = await pi.rpc("wait", { agent, submission: s1.submission });
// Interrupted in a tool call, the run leaves Pi's aborted result for it.
faux.setResponses([() => fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" })]);
const t1 = await pi.rpc("deliver", turn("T", "tool"));
await new Promise((resolve) => { const check = () => pi.events.some((event) => event.type === "step" && event.tool === "bash") ? resolve() : setTimeout(check, 5); check(); });
await pi.rpc("session", { agent, key: "chan/root", action: "interrupt" });
out.toolStop = { step: pi.events.find((event) => event.type === "step" && event.tool === "bash"), wait: await pi.rpc("wait", { agent, submission: t1.submission }), last: (await pi.rpc("entries", { agent, conversation: t1.conversation })).entries[0] };
// A step shows the command as it runs, after the hooks, and the calls a
// tool makes through Pi. The read for the request's placed event is held
// until the run answers, so every commit of its tools lands meanwhile.
rewriteCommand = true;
statusGate = { ...held(), entered: held() };
const answering = held();
faux.setResponses([() => fauxAssistantMessage([fauxToolCall("bash", { command: "printf original" }), fauxToolCall("nest", {})], { stopReason: "toolUse" }), () => { answering.release(); return fauxAssistantMessage("Ran them"); }]);
const ranFrom = pi.events.length;
const ran = await pi.rpc("deliver", turn("R", "run"));
try {
  await statusGate.entered.gate;
  await answering.gate;
} finally {
  statusGate.release();
  statusGate = undefined;
}
// A wait answers once its run's events went out, and they arrive first.
out.ran = { wait: await pi.rpc("wait", { agent, submission: ran.submission }) };
out.ran.events = pi.events.slice(ranFrom).filter((event) => event.type === "placed" || (event.type === "step" && ["bash", "nest"].includes(event.tool))).map(({ type, tool, target, request }) => ({ type, ...(tool ? { tool } : {}), ...(target ? { target } : {}), ...(request ? { request } : {}) }));
rewriteCommand = false;
// A later answer may reuse a call ID: each run of it is a step.
faux.setResponses([
  () => fauxAssistantMessage(fauxToolCall("bash", { command: "printf one" }, { id: "same" }), { stopReason: "toolUse" }),
  () => fauxAssistantMessage(fauxToolCall("bash", { command: "printf two" }, { id: "same" }), { stopReason: "toolUse" }),
  () => fauxAssistantMessage("Ran both"),
]);
const againFrom = pi.events.length;
const again = await pi.rpc("deliver", turn("SAME", "again"));
out.again = { wait: await pi.rpc("wait", { agent, submission: again.submission }), targets: pi.events.slice(againFrom).filter((event) => event.type === "step" && event.tool === "bash").map((event) => event.target) };
// A read for a placed event that fails while an earlier one waits is
// reported, and the host goes on: the read starts only in its turn.
statusGate = { ...held(), entered: held() };
faux.setResponses([() => fauxAssistantMessage("First"), () => fauxAssistantMessage("Second")]);
const failing = (request, text) => ({ ...turn(request, text), key: "chan/failing", context: { channel: "chan", root: "failing" } });
const f1 = await pi.rpc("deliver", failing("FR1", "first"));
await statusGate.entered.gate;
failRead = true;
const f2 = await pi.rpc("deliver", failing("FR2", "second"));
// Read past the proxy: settled, its run started long before. Then a turn
// of the event loop, where Node finds a rejection nothing handles.
await (await Object.getPrototypeOf(openedHarness).submission.call(openedHarness, f2.submission, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
await new Promise((resolve) => setImmediate(resolve));
statusGate.release();
statusGate = undefined;
out.failedRead = await Promise.all([f1, f2].map((x) => pi.rpc("wait", { agent, submission: x.submission })));
failRead = false;
// A watch whose first value is older than a commit it got takes the commit:
// the run it shows ended, so a request starts a turn rather than steering.
staleSnapshot = true;
let staleSaw = [];
faux.setResponses([(context) => { staleSaw = context.messages.filter((m) => m.role === "user").map((m) => m.content); return fauxAssistantMessage("Fresh"); }]);
const stale = await pi.rpc("deliver", { ...turn("ST", "stale"), key: "chan/stale", context: { channel: "chan", root: "stale" } });
staleSnapshot = false;
out.stale = { wait: await pi.rpc("wait", { agent, submission: stale.submission }), saw: staleSaw };
// Past what Pi keeps verbatim, so compacting summarizes the older turn.
faux.setResponses([() => fauxAssistantMessage("Read it"), () => fauxAssistantMessage("Read it too"), () => fauxAssistantMessage("Summary of the chat")]);
for (const request of ["S2", "S3"]) {
  const long = await pi.rpc("deliver", turn(request, "word ".repeat(25_000)));
  await pi.rpc("wait", { agent, submission: long.submission });
}
await pi.rpc("session", { agent, key: "chan/root", action: "compact" });
await pi.rpc("session", { agent, key: "chan/root", action: "new" });
out.renewed = { place: await pi.rpc("place", { agent, key: "chan/root" }), kinds: (await pi.rpc("entries", { agent, conversation: s1.conversation })).entries.map((entry) => entry.kind).slice(0, 2) };
out.unplaced = await pi.rpc("session", { agent, key: "chan/none", action: "compact" });
// Which turn starts a session, and the session it starts, come from Pi's own
// history: a reset's entry id, or 0 before any.
const own = (request, text) => ({ ...turn(request, text), key: "chan/sessions" });
const answer = async (request, text) => {
  faux.setResponses([fauxAssistantMessage("ok")]);
  const delivered = await pi.rpc("deliver", own(request, text));
  await pi.rpc("wait", { agent, submission: delivered.submission });
  return delivered;
};
const n0 = await answer("N0", "opens");
const n1 = await answer("N1", "continues");
await pi.rpc("session", { agent, key: "chan/sessions", action: "new" });
const reset = (await pi.rpc("entries", { agent, conversation: n0.conversation })).entries.find((entry) => entry.kind === "pi.reset")?.id;
const n2 = await answer("N2", "after new");
// A host that stops after the session's first turn, before the app saved its
// prompt, never offers a later turn as the first.
await pi.stop();
pi = start();
await pi.rpc("open", { agent, tools });
const n3 = await answer("N3", "after restart");
// Enough turns that the reset is older than the first page of entries.
for (let index = 0; index < 110; index++) await answer("M" + index, "more");
// Count the entries Pi's storage reads, to see that naming a session reads
// only its markers, not the history before them.
const probe = await openNodeSqliteStorage(data + "/probe.sqlite");
const storage = Object.getPrototypeOf(probe);
await probe.close();
const scan = storage.scanEntries;
let read = 0;
storage.scanEntries = async function (...args) {
  const page = await scan.apply(this, args);
  read += page.items.length;
  return page;
};
const page = await pi.rpc("entries", { agent, conversation: n0.conversation });
const pageRead = read;
read = 0;
const last = await answer("M110", "more");
const deliverRead = read;
storage.scanEntries = scan;
out.sessions = { n0: n0.session, n1: n1.session, n2: n2.session, n3: n3.session, last: last.session, reset, page: page.session, more: !!page.next, oldest: page.entries.at(-1)?.id, shown: page.entries.length, pageRead, deliverRead };
// A tool loaded on search is offered once tool_search finds it.
const offered = [];
/** The tools a request offers: its own, and those its system messages add. */
const toolsOf = (context) => {
  const names = new Set((context.tools ?? []).map((tool) => tool.name));
  for (const message of context.messages) {
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name ?? tool);
  }
  return [...names];
};
faux.setResponses([
  (context) => { offered.push(toolsOf(context)); return fauxAssistantMessage(fauxToolCall("tool_search", { query: "watch events" }), { stopReason: "toolUse" }); },
  (context) => { offered.push(toolsOf(context)); return fauxAssistantMessage(fauxToolCall("buzz_watch_add", {}), { stopReason: "toolUse" }); },
  () => fauxAssistantMessage("Watching"),
]);
const h = await pi.rpc("deliver", turn("H", "watch it"));
out.search = { wait: await pi.rpc("wait", { agent, submission: h.submission }), offered, called: pi.tools.splice(0).map((call) => call.name) };
out.place = await pi.rpc("place", { agent, key: "chan/root" });
// A turn Pi could not start leaves what the conversation was shown.
out.unstarted = await pi.rpc("deliver", { ...turn("F", "eighth"), at: 200, model: "nope" }).catch((error) => error.message);
out.unstartedPlace = await pi.rpc("place", { agent, key: "chan/root" });
// The core memory a conversation was shown stays until a compaction, so a
// memory edit, or one not read, changes nothing; only the note that it has
// none is replaced at once. A conversation that could not read it is
// shown none, even after another one read it, and is shown it at its next
// read. Conversations delivered at once are each shown their own read.
const none = "<core-memory>\\nNo core memory found.\\n</core-memory>";
const memory = (text) => ({ text: "<core-memory>\\n" + text + "\\n</core-memory>", placeholder: none });
const remembering = (request, text, core, root = "root") => ({ ...turn(request, text), key: "core/" + root, context: { channel: "core", root }, ...(core ? { core } : {}) });
const shown = [];
const seenApart = {};
const apart = (context) => { const request = ["P1", "P2", "P3", "P4"].find((label) => JSON.stringify(context.messages.filter((m) => m.role === "user")).includes(label)); seenApart[request] = context.messages.filter((m) => m.role === "system" && m.sections?.["core-memory"] !== undefined).map((m) => m.sections["core-memory"]); return fauxAssistantMessage("Noted"); };
const sees = (context) => { shown.push(context.messages.filter((m) => m.role === "system" && m.sections?.["core-memory"] !== undefined).map((m) => m.sections["core-memory"])); return fauxAssistantMessage("Noted"); };
faux.setResponses([sees, sees, sees, sees, sees, sees, () => fauxAssistantMessage("Read it"), () => fauxAssistantMessage("Read it too"), () => fauxAssistantMessage("Summary of the chat"), sees, sees, apart, apart, apart, apart]);
// N5 and N6 only give the compaction turns to cut.
for (const [request, text, core, root] of [["U1", "hi", undefined, "unread"], ["U2", "read it", memory("first"), "unread"], ["N1", "hi", { text: none, placeholder: none }], ["N2", "made it", memory("first")], ["N3", "edited it", memory("second")], ["N4", "unread", undefined], ["N5", "word ".repeat(25_000), memory("second")], ["N6", "word ".repeat(25_000), memory("second")]]) {
  const noted = await pi.rpc("deliver", remembering(request, text, core, root));
  await pi.rpc("wait", { agent, submission: noted.submission });
}
await pi.rpc("session", { agent, key: "core/root", action: "compact" });
const compacted = await pi.rpc("deliver", remembering("N7", "after", memory("third")));
await pi.rpc("wait", { agent, submission: compacted.submission });
const late = await pi.rpc("deliver", remembering("L1", "hi", undefined, "late"));
await pi.rpc("wait", { agent, submission: late.submission });
for (const pair of [[["P1", memory("first"), "read"], ["P2", undefined, "failed"]], [["P3", undefined, "failed2"], ["P4", memory("first"), "read2"]]]) {
  const delivered = await Promise.all(pair.map(([request, core, root]) => pi.rpc("deliver", remembering(request, request, core, root))));
  for (const { submission } of delivered) await pi.rpc("wait", { agent, submission });
}
out.core = shown;
out.apart = seenApart;
// A request that waits after the agent's storage failed is told to open it
// again, and finds its run there. Another connection holds the write lock
// while the run commits, so the storage fails while the host is blocked and the
// request is read only afterwards, as when the plugin's wait is already in the pipe.
const locked = held();
faux.setResponses([async () => { await locked.gate; return fauxAssistantMessage("Late answer"); }, () => fauxAssistantMessage("Late answer")]);
const l1 = await pi.rpc("deliver", { ...turn("L", "tenth"), reply: { channel: "chan", root: "wake-root", topLevel: false } });
const blocker = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", "const { DatabaseSync } = require('node:sqlite'); new DatabaseSync(process.argv[1]).exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(() => {}, 60000)", data + "/agents/" + agent + ".sqlite"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => blocker.stdout.once("data", resolve));
const failingWait = pi.rpc("wait", { agent, submission: l1.submission, request: "L" });
await new Promise((resolve) => setImmediate(resolve));
locked.release();
out.failed = await failingWait;
blocker.kill();
await new Promise((resolve) => blocker.once("exit", resolve));
await pi.rpc("open", { agent, tools });
out.failedResumed = await pi.rpc("wait", { agent, submission: l1.submission, request: "L" });
// Pi's settings as they are now, which the pi command changes.
await writeFile(data + "/settings.json", JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }));
out.defaults = await pi.rpc("defaults", {});
// One-off turns a stopped host left are listed with no place. Dropping them
// continues nothing, not even a mention left beside them, which runs only
// once it is waited for; and no later run continues them.
const w = held(), leaving = held();
let asked = 0;
const leave = async (_context, options) => { if (++asked === 3) leaving.release(); await abortable(w.gate, options?.signal); return fauxAssistantMessage("Late"); };
faux.setResponses([leave, leave, leave]);
const m1 = await pi.rpc("deliver", turn("M", "twelfth"));
const w1 = await pi.rpc("once", { ...turn("W1", "timer"), context: undefined });
const w2 = await pi.rpc("once", { ...turn("W2", "watch"), context: undefined });
await leaving.gate;
await pi.stop();
pi = start();
await pi.rpc("open", { agent, tools });
const order = [];
faux.setResponses([() => { order.push("model"); return fauxAssistantMessage("Mention answer"); }]);
const left = (await pi.rpc("unfinished", { agent })).submissions;
await pi.rpc("drop", { agent, submissions: [w1, w2].map(({ submission, conversation }) => ({ submission, conversation })) });
order.push("dropped");
const calls = faux.state.callCount;
out.timer = {
  left: left.map((item) => [item.request, !!item.context]),
  mention: await pi.rpc("wait", { agent, submission: m1.submission }),
  dropped: await Promise.all([w1, w2].map((x) => pi.rpc("wait", { agent, submission: x.submission }))),
  calls: faux.state.callCount - calls,
  order,
};
// A host whose storage another host took over stops running it, and leaves
// its run there: changing the lock's time is what taking it over does.
const k = held(), thinking = held();
faux.setResponses([async (_context, options) => { thinking.release(); await abortable(k.gate, options?.signal); return fauxAssistantMessage("Ran beside the new owner"); }]);
const k1 = await pi.rpc("deliver", turn("K", "eleventh"));
await thinking.gate;
const lock = data + "/agents/" + agent + ".sqlite.lock";
const taken = new Date(Date.now() + 60_000);
await utimes(lock, taken, taken);
// The lock's own timer, which finds it taken, doesn't keep a process up.
const up = setInterval(() => {}, 1_000);
out.lost = await pi.rpc("wait", { agent, submission: k1.submission });
clearInterval(up);
out.lostDeliver = await pi.rpc("deliver", turn("K2", "twelfth")).catch((error) => error.message);
await rm(lock, { recursive: true });
await pi.rpc("open", { agent, tools });
out.lostLeft = (await pi.rpc("unfinished", { agent })).submissions.map((item) => item.request);
await pi.stop();
// Attention prompts are refreshed after the host queue and configuration.
const promptAgent = "c".repeat(64);
const promptStarted = held(), promptQueue = held();
let instructions = "Old Interest instructions";
const promptCalls = [];
pi = start(async ({ request }) => {
  promptCalls.push(request);
  if (request === "R1") { promptStarted.release(); await promptQueue.gate; }
  return request === "R3" ? undefined : { text: instructions, steer: instructions };
});
await pi.rpc("open", { agent: promptAgent, tools });
faux.setResponses([fauxAssistantMessage("Refreshed"), fauxAssistantMessage("Refreshed")]);
const refreshing = (request, at = 200) => ({ ...turn(request, "Old Interest instructions"), agent: promptAgent, key: "refresh", refresh: true, at });
const r1 = pi.rpc("deliver", refreshing("R1"));
await promptStarted.gate;
const r2 = pi.rpc("deliver", refreshing("R2"));
await pi.rpc("place", { agent: promptAgent, key: "refresh" });
instructions = "Updated Interest instructions";
promptQueue.release();
const submitted = await Promise.all([r1, r2]);
await Promise.all(submitted.map(({ submission }) => pi.rpc("wait", { agent: promptAgent, submission })));
out.refresh = { calls: promptCalls, entries: JSON.stringify((await pi.rpc("entries", { agent: promptAgent, conversation: submitted[0].conversation })).entries) };
out.refresh.dropped = await pi.rpc("deliver", refreshing("R3", 999));
out.refresh.seen = (await pi.rpc("place", { agent: promptAgent, key: "refresh" })).seen;
await pi.stop();
// A run that answered keeps its run while its afterRun hooks work; a request
// meanwhile starts the next run with its own turn, rather than steering.
const finishing = held(), finished = held();
const afterRun = defineExtension({ name: "after-run", hooks: [hook(GenerationTask, { afterRun: async () => { finishing.release(); await finished.gate; return undefined; } })] });
const afterAgent = "d".repeat(64);
pi = start(undefined, [nesting, afterRun]);
await pi.rpc("open", { agent: afterAgent, tools });
let afterSaw = [];
faux.setResponses([fauxAssistantMessage("Answered"), (context) => { afterSaw = context.messages.filter((m) => m.role === "user").map((m) => m.content); return fauxAssistantMessage("Next"); }]);
const after = (request, text) => ({ ...turn(request, text), agent: afterAgent });
const ar1 = await pi.rpc("deliver", after("AR1", "answered"));
const ar1Wait = await pi.rpc("wait", { agent: afterAgent, submission: ar1.submission });
await finishing.gate;
const ar2 = await pi.rpc("deliver", after("AR2", "next"));
finished.release();
out.afterRun = { first: ar1Wait, second: await pi.rpc("wait", { agent: afterAgent, submission: ar2.submission }), saw: afterSaw };
await pi.stop();
// Pi's auth.json: a change that returns nothing, as pi-ai's refresh does when
// another process refreshed first, keeps the sign-in.
const auth = new AuthFile(data + "/auth.json");
const signIn = { type: "oauth", access: "a", refresh: "r", expires: 1 };
await auth.modify("p", async () => signIn);
out.auth = { result: await auth.modify("p", async () => undefined), stored: await auth.read("p") };
// A key \`pi\` gets by running a command, or from its environment, is not used here.
await auth.modify("c", async () => ({ type: "api_key", key: "!echo secret" }));
out.command = await auth.read("c").catch((error) => error.message);
process.env.BUZZ_PI_TEST_KEY = "secret";
await auth.modify("e", async () => ({ type: "api_key", key: "$BUZZ_PI_TEST_KEY" }));
out.environment = await auth.read("e").catch((error) => error.message);
// A read waits out a write \`pi\` makes in place under the same lock, rather
// than seeing it half done; the pause gives a read that didn't wait its chance.
const writing = await lockfile.lock(data + "/auth.json", { realpath: false });
await writeFile(data + "/auth.json", '{"p":');
const reading = auth.read("p").catch((error) => error.message);
await new Promise((resolve) => setTimeout(resolve, 100));
await writeFile(data + "/auth.json", JSON.stringify({ p: signIn }));
await writing();
out.whileWritten = await reading;
console.log(JSON.stringify(out));
`;

/** Loads the Pi packages in a Pi folder's settings, then runs a turn on the
 * provider one adds, as the host does when Buzz starts it. A package that
 * hangs is in a Pi folder of its own, loaded with a short limit. */
const PACKAGES_DRIVER = `
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadPackages, serve } from "./host.mjs";
const [data, dir, slow] = process.argv.slice(2);
const out = { none: await loadPackages(data), slow: (await loadPackages(slow, 100)).errors };
const packages = await loadPackages(dir);
out.errors = packages.errors;
out.extensions = packages.extensions.map((extension) => extension.name);
out.providers = packages.providers.map((provider) => provider.id);
const models = createModels();
for (const provider of packages.providers) models.setProvider(provider);
const { faux } = await import(pathToFileURL(dir + "/../good/durable.ts").href);
const input = new PassThrough(), output = new PassThrough(), pending = new Map();
let id = 0;
createInterface({ input: output }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "hook") {
    input.write(JSON.stringify({ id: message.id, result: null }) + "\\n");
    return;
  }
  if (message.id === undefined || message.method) return;
  const call = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) call.reject(new Error(message.error));
  else call.resolve(message.result);
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  pending.set(++id, { resolve, reject });
  input.write(JSON.stringify({ id, method, params }) + "\\n");
});
const { stop } = serve({ data, models, packages, dir, input, output, exit: () => {} });
const agent = "c".repeat(64);
await rpc("open", { agent, tools: [] });
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ./nothing" }), fauxToolCall("shout", { text: "hi" })], { stopReason: "toolUse" }),
  (context) => {
    const system = context.messages.filter((m) => m.role === "system");
    out.sections = Object.assign({}, ...system.map((m) => m.sections));
    out.offered = system.flatMap((m) => (m.toolsAdded ?? []).map((tool) => tool.name));
    out.results = context.messages.filter((m) => m.role === "toolResult").map((m) => [m.toolName, m.isError, m.content]);
    return fauxAssistantMessage("Done");
  },
]);
const turn = await rpc("deliver", { agent, key: "chan/root", at: 1, context: { channel: "chan", root: "root" }, text: "go", request: "P", provider: "pkg", model: "faux-1", instructions: "Test.", cwd: data });
out.turn = await rpc("wait", { agent, submission: turn.submission });
out.unknown = await rpc("test", { provider: "nope", model: "m" }).catch((error) => error.message);
await stop();
console.log(JSON.stringify(out));
`;

/** Pi packages in a folder with no Pi of their own above it, as a user's
 * would be: each a package.json and its files. */
const PACKAGES: Record<string, Record<string, string>> = {
  broken: {
    "package.json":
      '{ "type": "module", "pi": { "durable": ["./durable.js"] } }',
    "durable.js": 'export default () => { throw new Error("No token"); };',
  },
  hangs: {
    "package.json":
      '{ "type": "module", "pi": { "durable": ["./durable.js"] } }',
    "durable.js": "export default () => new Promise(() => {});",
  },
  clash: {
    "package.json":
      '{ "type": "module", "pi": { "durable": ["./durable.js"] } }',
    "durable.js":
      'export default () => ({ extensions: [{ name: "clash" }, { name: "coding-tools" }] });',
  },
  invalid: {
    "package.json":
      '{ "type": "module", "pi": { "durable": ["./durable.js"] } }',
    "durable.js":
      'export default () => ({ extensions: [{ name: "invalid", sections: [{ key: "Bad Key", render: () => "" }] }] });',
  },
  "half-provider": {
    "package.json":
      '{ "type": "module", "pi": { "durable": ["./durable.js"] } }',
    "durable.js":
      'export default () => ({ providers: [{ id: "half", name: "Half" }] });',
  },
  fetches: {
    "package.json":
      '{ "type": "module", "pi": { "durable": ["./durable.js"] } }',
    "durable.js": `
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
export default () => ({
  providers: [createProvider({
    id: "fetched",
    auth: { apiKey: envApiKeyAuth("Fetched key", ["FETCHED_KEY"]) },
    api: openAICompletionsApi(),
    models: [],
    fetchModels: async () => [],
  })],
});
`,
  },
  "not-a-list": {
    "package.json": '{ "type": "module", "pi": { "durable": "./durable.js" } }',
  },
  "pi-only": {
    "package.json":
      '{ "type": "module", "pi": { "extensions": ["./index.js"] } }',
  },
  good: {
    "package.json":
      '{ "type": "module", "pi": { "durable": ["./durable.ts"] } }',
    // TypeScript, which Node strips itself outside node_modules.
    "durable.ts": `
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { shout } from "shout";
export const faux = fauxProvider({ provider: "pkg" });
const tool = defineTool({
  name: "shout",
  description: "Shout a text",
  parameters: obj({ text: str() }),
  execute: async (args: { text: string }) => ({ output: [{ type: "text", text: shout(args.text) }] }),
});
export default async () => ({
  extensions: [defineExtension({
    name: "good",
    sections: [section("house-rules", () => "House rule: no recursive deletes.")],
    tools: [tool],
    hooks: [hook(ToolTask, { beforeTool: (call) => /rm -rf/.test(String(call.arguments?.command)) ? { block: "No recursive deletes" } : undefined })],
  })],
  providers: [faux.provider],
});
`,
    // TypeScript under node_modules, which the host strips.
    "node_modules/shout/package.json":
      '{ "name": "shout", "type": "module", "exports": "./index.ts" }',
    "node_modules/shout/index.ts":
      "export const shout = (text: string): string => text.toUpperCase();",
  },
};

describe.skipIf(!DEPS)("the Pi host on Pi durable", () => {
  const folders: string[] = [];
  afterAll(async () => {
    await Promise.all(
      folders.map((folder) => rm(folder, { recursive: true, force: true })),
    );
  });

  it("runs, steers, ends and resumes turns", async () => {
    const folder = await mkdtemp(join(tmpdir(), "buzz-pi-live-"));
    folders.push(folder);
    await symlink(
      join(DEPS ?? "", "node_modules"),
      join(folder, "node_modules"),
    );
    await writeFile(join(folder, "host.mjs"), host);
    await writeFile(join(folder, "driver.mjs"), DRIVER);
    // Storage an earlier build left readable by others.
    const agents = join(folder, "agents");
    const database = join(agents, `${"b".repeat(64)}.sqlite`);
    await mkdir(agents, { mode: 0o755 });
    await chmod(agents, 0o755);
    await writeFile(database, "", { mode: 0o644 });
    await chmod(database, 0o644);
    const { stdout } = await run(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(folder, "driver.mjs"),
        folder,
      ],
      { cwd: folder, timeout: 60_000 },
    );
    const out = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    if (process.platform !== "win32") {
      const mode = async (path: string) => (await stat(path)).mode & 0o777;
      expect(await mode(agents)).toBe(0o700);
      expect(await mode(database)).toBe(0o600);
    }
    expect(out.unknown).toBe(
      "databricks isn't one of Pi's built-in providers, and no Pi package Buzz loaded adds it. Buzz loads the packages in Pi's settings when it starts. Choose another provider in the agent's Identity tab.",
    );
    expect(out.a).toMatchObject({ status: "done", calls: 1 });
    expect(out.a.tools).toEqual([
      {
        agent: "b".repeat(64),
        conversation: out.a.conversation,
        context: { channel: "chan", root: "root" },
        name: "send",
        arguments: { text: "hi", final: true },
      },
    ]);
    expect(out.blocked.steps).toEqual([]);
    expect(out.blocked.hooks).toEqual(["beforeTool"]);
    expect(out.blocked).toMatchObject({
      status: "done",
      tools: [],
      conversation: out.a.conversation,
    });
    expect(JSON.stringify(out.blocked.messages)).toContain(
      "[Buzz plugin: fixture-policy] Fixture blocks the command",
    );
    expect(out.cleanupFailure).toMatchObject({
      status: "done",
      text: "Plain answer",
    });
    expect(out.recorded).toEqual(["faux/faux-1"]);
    expect(out.secondaryPlaces).toEqual([]);
    expect(
      (
        await stat(
          join(agents, `${"b".repeat(64)}@secondary.example%3A7447.sqlite`),
        )
      ).isFile(),
    ).toBe(true);
    expect(out.places).toEqual([
      { key: "chan/root", conversation: out.a.conversation, seen: 100 },
    ]);
    // Newest first; a system entry's tool schemas are left out, an answer's
    // usage kept.
    expect(out.entries).toEqual([
      ["pi.assistant", "assistant+usage"],
      ["pi.user", "user"],
      ["pi.tool-result", "toolResult"],
      ["pi.assistant", "assistant+usage"],
      ["pi.system"],
      ["pi.user", "user"],
    ]);
    expect(out.b).toMatchObject({
      status: "done",
      text: "Plain answer",
      conversation: out.a.conversation,
    });
    const [first, second] = out.c.waits;
    expect(first).toMatchObject({ status: "done", text: "Answer to both" });
    expect(second).toEqual(first);
    expect(out.c.saw.slice(-2)).toEqual(["third", "steer: fourth"]);
    expect(out.c.placed.map(([request]: [string]) => request)).toEqual([
      "A",
      "B",
      "HOOK",
      "C1",
      "C2",
    ]);
    // Each placed at an entry before the run's answer, which the runtime
    // compares to find the latest request a run took.
    const [, c1] = out.c.placed[3];
    const [, c2] = out.c.placed[4];
    expect(c1).toBeLessThan(c2);
    expect(c2).toBeLessThan(first.answer);
    expect(out.c.steps).toContain("send");
    // What a Buzz tool answered is what the model reads.
    expect(out.c.rewritten).toMatchObject({ text: "Rewritten arguments" });
    expect(out.c.results.at(-1)).toEqual([
      { type: "text", text: "[Buzz plugin: fixture-policy]" },
      { type: "text", text: "Replaced result" },
    ]);
    expect(out.stopped).toEqual({ status: "closed" });
    expect(out.unfinished).toEqual([
      {
        submission: expect.any(Number),
        conversation: out.a.conversation,
        request: "D",
        reply: { channel: "chan", root: "wake-root", topLevel: false },
        context: { channel: "chan", root: "root" },
      },
    ]);
    expect(out.resumed).toMatchObject({
      status: "done",
      text: "Resumed answer",
    });
    const [failed, withdrawn] = out.e;
    expect(failed).toMatchObject({
      status: "unanswered",
      detail: expect.stringContaining("400 Bad model"),
    });
    expect(withdrawn).toEqual(failed);
    expect(out.aborted).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    });
    expect(out.interrupted).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    });
    expect(out.toolStop.step).toMatchObject({ target: "sleep 30" });
    expect(out.ran.wait).toMatchObject({ status: "done", text: "Ran them" });
    expect(out.ran.events).toEqual([
      { type: "placed", request: "R" },
      { type: "step", tool: "bash", target: "printf rewritten" },
      { type: "step", tool: "nest" },
      { type: "step", tool: "bash", target: "printf nested" },
    ]);
    expect(out.again.wait).toMatchObject({ status: "done", text: "Ran both" });
    expect(out.again.targets).toEqual(["printf one", "printf two"]);
    expect(out.stale.wait).toMatchObject({ status: "done", text: "Fresh" });
    expect(out.stale.saw).toEqual(["stale"]);
    expect(out.failedRead).toMatchObject([
      { status: "done", text: "First" },
      { status: "done", text: "Second" },
    ]);
    expect(out.afterRun.first).toMatchObject({
      status: "done",
      text: "Answered",
    });
    expect(out.afterRun.second).toMatchObject({ status: "done", text: "Next" });
    expect(out.afterRun.saw).toEqual(["answered", "next"]);
    expect(out.toolStop.wait).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    });
    expect(out.toolStop.last).toMatchObject({
      kind: "pi.tool-result",
      aborted: true,
    });
    // A new session is shown the whole conversation at its next turn.
    // The first turn of a conversation and of each reset names its session.
    expect(out.sessions).toMatchObject({
      n0: 0,
      n2: out.sessions.reset,
      more: true,
    });
    expect(out.sessions.n1).toBeUndefined();
    expect(out.sessions.n3).toBeUndefined();
    expect(out.sessions.oldest).toBeGreaterThan(out.sessions.reset);
    expect(out.sessions.page).toBe(out.sessions.reset);
    expect(out.sessions.last).toBeUndefined();
    // Naming the page's session reads no entry beyond the page itself.
    expect(out.sessions.pageRead).toBe(out.sessions.shown);
    // A later turn's first-turn check stops at the session's first prompt,
    // well short of the hundreds of entries since the reset.
    expect(out.sessions.deliverRead).toBeLessThan(50);
    expect(out.renewed).toEqual({
      place: { seen: 0 },
      kinds: ["pi.reset", "pi.compaction"],
    });
    expect(out.unplaced).toEqual({});
    const [before, after] = out.search.offered;
    expect(before).toEqual(
      expect.arrayContaining(["buzz_send", "tool_search"]),
    );
    expect(before).not.toContain("buzz_watch_add");
    expect(after).toContain("buzz_watch_add");
    expect(out.search.called).toContain("watch_add");
    expect(out.search.wait).toMatchObject({ status: "done", text: "Watching" });
    expect(out.place).toEqual({ seen: 100 });
    expect(out.unstarted).toMatch(/Pi has no model nope/);
    expect(out.unstartedPlace).toEqual({ seen: 100 });
    const none = "<core-memory>\nNo core memory found.\n</core-memory>";
    const memory = (text: string) => `<core-memory>\n${text}\n</core-memory>`;
    expect(out.core).toEqual([
      [""],
      ["", memory("first")],
      [none],
      [none, memory("first")],
      [none, memory("first")],
      [none, memory("first")],
      [memory("third")],
      [""],
    ]);
    expect(out.apart).toEqual({
      P1: [memory("first")],
      P2: [""],
      P3: [""],
      P4: [memory("first")],
    });
    expect(out.failed).toEqual({ status: "reopen" });
    expect(out.failedResumed).toMatchObject({
      status: "done",
      text: "Late answer",
    });
    expect(out.defaults).toEqual({ provider: "faux", model: "faux-1" });
    expect(out.timer).toEqual({
      left: [
        ["M", true],
        ["W1", false],
        ["W2", false],
      ],
      mention: expect.objectContaining({
        status: "done",
        text: "Mention answer",
      }),
      dropped: [
        { status: "unanswered", reason: "aborted" },
        { status: "unanswered", reason: "aborted" },
      ],
      // Only the mention's: the dropped runs asked the model nothing more.
      calls: 1,
      order: ["dropped", "model"],
    });
    expect(out.lost).toEqual({ status: "closed" });
    expect(out.lostDeliver).toBe("The agent is not open");
    expect(out.lostLeft).toEqual(["K"]);
    expect(out.refresh.calls).toEqual(["R1", "R2", "R3"]);
    expect(out.refresh.entries).toContain("Updated Interest instructions");
    expect(out.refresh.entries).not.toContain("Old Interest instructions");
    expect(out.refresh.seen).toBe(200);
    expect(out.refresh.dropped).toBe(false);
    const signIn = { type: "oauth", access: "a", refresh: "r", expires: 1 };
    expect(out.auth).toEqual({ result: signIn, stored: signIn });
    expect(out.command).toMatch(
      /^Buzz doesn't use `!command` or `\$NAME` keys/,
    );
    expect(out.environment).toBe(out.command);
    expect(out.whileWritten).toEqual(signIn);
  }, 90_000);

  it("loads the Pi packages in Pi's settings, leaving out each that fails", async () => {
    const folder = await mkdtemp(join(tmpdir(), "buzz-pi-live-"));
    // Outside the host's folder, so Pi's own packages come from the host.
    const packages = await mkdtemp(join(tmpdir(), "buzz-pi-packages-"));
    folders.push(folder, packages);
    await symlink(
      join(DEPS ?? "", "node_modules"),
      join(folder, "node_modules"),
    );
    await writeFile(join(folder, "host.mjs"), host);
    await writeFile(join(folder, "driver.mjs"), PACKAGES_DRIVER);
    for (const [name, files] of Object.entries(PACKAGES))
      for (const [file, text] of Object.entries(files)) {
        await mkdir(dirname(join(packages, name, file)), { recursive: true });
        await writeFile(join(packages, name, file), text);
      }
    const dir = join(packages, "pi");
    await mkdir(dir);
    // With a BOM, as an editor may save it, which Pi accepts.
    await writeFile(
      join(dir, "settings.json"),
      `\uFEFF${JSON.stringify({
        packages: [
          "npm:pi-example",
          "../broken",
          "../clash",
          "../invalid",
          "../half-provider",
          "../fetches",
          "../not-a-list",
          "../pi-only",
          { source: "~/good" },
        ],
      })}`,
    );
    const slow = join(packages, "slow");
    await mkdir(slow);
    await writeFile(
      join(slow, "settings.json"),
      JSON.stringify({ packages: ["../hangs"] }),
    );
    const { stdout } = await run(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(folder, "driver.mjs"),
        folder,
        dir,
        slow,
      ],
      {
        cwd: folder,
        // Where `~/good` is.
        env: { ...process.env, HOME: packages, USERPROFILE: packages },
        timeout: 60_000,
      },
    );
    const out = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    expect(out.none).toEqual({ extensions: [], providers: [], errors: [] });
    expect(out.slow).toEqual([
      { source: "../hangs", error: "It took over 0.1 seconds" },
    ]);
    expect(out.errors).toEqual([
      {
        source: "npm:pi-example",
        error: "Buzz loads only Pi packages in a local folder",
      },
      { source: "../broken", error: "No token" },
      { source: "../clash", error: "Another extension is named coding-tools" },
      {
        source: "../invalid",
        error: 'Section key "Bad Key" must match /^[a-z][a-z0-9_-]*$/',
      },
      {
        source: "../half-provider",
        error: "A provider it returns needs an id, name, auth and getModels",
      },
      {
        source: "../fetches",
        error:
          "Provider fetched lists no models, and Buzz doesn't fetch a provider's models",
      },
      {
        source: "../not-a-list",
        error: '"pi.durable" in its package.json must list files',
      },
    ]);
    // Nothing from a package that failed, such as clash's first extension.
    expect(out.extensions).toEqual(["good"]);
    expect(out.providers).toEqual(["pkg"]);
    expect(out.turn).toMatchObject({ status: "done", text: "Done" });
    expect(out.sections["house-rules"]).toContain(
      "House rule: no recursive deletes.",
    );
    expect(out.offered).toContain("shout");
    expect(out.results).toEqual([
      [
        "bash",
        true,
        [
          expect.objectContaining({
            text: expect.stringContaining(
              "Tool call blocked: No recursive deletes",
            ),
          }),
        ],
      ],
      ["shout", false, [{ type: "text", text: "HI" }]],
    ]);
    expect(out.unknown).toContain(
      "nope isn't one of Pi's built-in providers, and no Pi package Buzz loaded adds it. Pi could not load the package npm:pi-example: Buzz loads only Pi packages in a local folder. Pi could not load the package ../broken: No token.",
    );
  }, 90_000);
});
