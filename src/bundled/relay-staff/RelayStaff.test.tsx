// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import type {
  ProbeDto,
  RelayStaffBackend,
  StaffContext,
  StaffFailure,
  StaffOutcome,
  StaffRequest,
} from "../../features/relay-staff/contract";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { cards } from "./index";
import { ProfilesContext } from "./people";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { foldProfiles } from "../../features/relay/profiles";
import { StrictMode, useState, useSyncExternalStore } from "react";
import { createSession, SessionProvider, useRead, useWrite } from "./session";
import { createStaff, type Staff, type StaffTarget } from "./staff";
import { useRetry } from "./ui";
import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";

const signer = "a".repeat(64);
const member = "b".repeat(64);
const relay = "wss://team.example.com";
const origin = "https://admin.example.com";

type Handler = (
  request: StaffRequest,
) => StaffOutcome<unknown> | Promise<StaffOutcome<unknown>>;
let routes: Partial<Record<StaffRequest["route"], Handler>>;
let calls: StaffRequest[];
let contexts: StaffContext[];
let saved: string[];

const ok = (value: unknown): StaffOutcome<unknown> => ({ ok: true, value });
function fail(patch: Partial<StaffFailure>): StaffOutcome<unknown> {
  return {
    ok: false,
    failure: {
      category: "rejected",
      status: 400,
      bodyComplete: true,
      bodyEmpty: false,
      code: null,
      notSent: false,
      authLost: patch.status === 401 || patch.status === 403,
      message: "Rejected",
      ...patch,
    },
  };
}
const routeMissing = fail({
  category: "unsupported",
  status: 404,
  bodyEmpty: true,
  message: "",
});
const probe = (patch: Partial<ProbeDto> = {}) =>
  ok({
    status: "ok",
    authMode: "nip98",
    role: "moderator",
    source: "db",
    canAct: true,
    canStaff: false,
    ...patch,
  });

const backend: RelayStaffBackend = {
  available: true,
  discover: async () => origin,
  request: (async (context, request) => {
    calls.push(request);
    contexts.push(context);
    const handler = routes[request.route];
    return handler
      ? handler(request)
      : fail({ message: `no ${request.route}` });
  }) as RelayStaffBackend["request"],
  attachment: (async () => {
    return ok(new Uint8Array([1, 2, 3]));
  }) as RelayStaffBackend["attachment"],
  saveAttachment: async (_context, ref) => {
    saved.push(ref.sha256);
    return { state: "saved" };
  },
};

/** Settings, reduced to the plugin's visible entries and the open one. */
function Entries({ staff }: { staff: Staff }) {
  const [entries] = useState(() => cards(staff, (node) => node));
  useSyncExternalStore(staff.subscribe, () =>
    entries.map((entry) => entry.visibility?.snapshot()).join(),
  );
  const shown = entries.filter(
    (entry) => entry.visibility?.snapshot() === true,
  );
  const [open, setOpen] = useState("reports");
  const entry = shown.find((e) => e.id === open) ?? shown[0];
  return (
    <>
      <div role="tablist" aria-label="Settings">
        {shown.map((e) => (
          <button
            key={e.id}
            type="button"
            role="tab"
            aria-selected={e === entry}
            onClick={() => setOpen(e.id)}
          >
            {e.title}
          </button>
        ))}
      </div>
      {entry && <entry.component key={entry.id} active={() => true} />}
    </>
  );
}

function mount() {
  const staff = createStaff(backend, () => ({ relay, signer }));
  staff.ensure();
  const view = (
    <ToastProvider>
      <Entries staff={staff} />
    </ToastProvider>
  );
  return { staff, ...render(view), view };
}
const sent = (route: StaffRequest["route"]) =>
  calls.filter((c) => c.route === route);

beforeEach(() => {
  calls = [];
  contexts = [];
  saved = [];
  routes = {
    probe: () => probe(),
    listReports: () => ok([]),
    listFeedback: () => ok([]),
    listCommunities: () =>
      ok({
        items: [{ id: "c1", host: "team.example.com", icon: null }],
        nextCursor: null,
      }),
    searchMembers: () =>
      ok({
        items: [
          { pubkey: member, displayName: "Bob", nip05: null, avatarUrl: null },
        ],
      }),
    getMember: () =>
      ok({
        pubkey: member,
        profile: null,
        role: "member",
        banned: false,
        mutedUntil: null,
        isStaff: false,
      }),
  };
});
afterEach(cleanup);

async function openCommunityActions() {
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  fireEvent.change(screen.getByLabelText("Member"), {
    target: { value: "Bob" },
  });
  fireEvent.click(await screen.findByRole("option", { name: /Bob/ }));
  await screen.findByText("Role: member");
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
}

/** The check has answered "not staff", and Settings lists no entries. */
async function noEntries(staff: Staff) {
  await waitFor(() => expect(staff.visible()).toBe(false));
  expect(
    within(screen.getByRole("tablist", { name: "Settings" })).queryAllByRole(
      "tab",
    ),
  ).toHaveLength(0);
}

it("a key that isn't staff sees no entries and nothing else is requested", async () => {
  routes.probe = () => fail({ category: "forbidden", status: 403 });
  const { staff } = mount();
  await noEntries(staff);
  expect(calls.map((c) => c.route)).toEqual(["probe"]);
});

it("remembers the role for the same identity and admin host", async () => {
  const { staff } = mount();
  await screen.findByText(/Connected as moderator/);
  cleanup();
  render(
    <ToastProvider>
      <Entries staff={staff} />
    </ToastProvider>,
  );
  await screen.findByText(/Connected as moderator/);
  expect(sent("probe")).toHaveLength(1);
});

it("re-probes after an authorization loss", async () => {
  routes.listReports = () => fail({ category: "unauthorized", status: 401 });
  mount();
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
});

it("shows Operators only to operators and lists reports deployment-wide", async () => {
  mount();
  await screen.findByRole("tab", { name: "Reports" });
  expect(screen.queryByRole("tab", { name: "Staff" })).not.toBeInTheDocument();
  await waitFor(() =>
    expect(sent("listReports")[0]).toMatchObject({ query: { scope: "all" } }),
  );
  cleanup();
  routes.probe = () => probe({ role: "operator", canStaff: true });
  mount();
  expect(await screen.findByRole("tab", { name: "Staff" })).toBeInTheDocument();
});

it("auth-disabled relays are read-only", async () => {
  routes.probe = () => probe({ authMode: "disabled" });
  mount();
  expect(await screen.findByText(/console is read-only/)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
});

it("keeps the Communities tab and explains an unsupported directory", async () => {
  routes.listCommunities = () => routeMissing;
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  expect(
    await screen.findByText(
      "This relay doesn't support community browsing yet.",
    ),
  ).toBeInTheDocument();
  // The pinned lookup fails the same way; only one alert explains it.
  await waitFor(() => expect(sent("listCommunities")).toHaveLength(2));
  await act(async () => {});
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("never sends a pasted secret key as a search", async () => {
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  await screen.findByRole("button", { name: /team\.example\.com/ });
  const before = sent("listCommunities").length;
  fireEvent.change(screen.getByLabelText("Search communities"), {
    target: { value: `nsec1${"q".repeat(58)}` },
  });
  expect(
    await screen.findByText(/looks like a private key/),
  ).toBeInTheDocument();
  expect(sent("listCommunities")).toHaveLength(before);
});

it("an unresolved direct action keeps its request id after moving to another entry and back", async () => {
  let first = true;
  routes.directAction = () => {
    if (first) {
      first = false;
      return fail({ category: "ambiguous", status: 502, message: "" });
    }
    return ok({ state: "succeeded", actionId: "a1", replayed: true });
  };
  mount();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByRole("button", { name: "Retry" });
  // Move to the Reports entry and back: the held action survives.
  fireEvent.click(
    within(screen.getByRole("tablist", { name: "Settings" })).getByRole("tab", {
      name: "Reports",
    }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(sent("directAction")).toHaveLength(2));
  const [a, b] = sent("directAction") as Extract<
    StaffRequest,
    { route: "directAction" }
  >[];
  expect(a).toEqual(b);
  expect(a).toMatchObject({
    communityHost: "team.example.com",
    action: "ban",
    target: member,
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument(),
  );
});

it("a pending direct action keeps the same request for a retry", async () => {
  routes.directAction = () => ok({ state: "pending" });
  mount();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(await screen.findByText(/still applying it/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(sent("directAction")).toHaveLength(2));
  const [a, b] = sent("directAction");
  expect(a).toEqual(b);
});

it("a request id conflict is an error and is never resent under a new id", async () => {
  routes.directAction = () =>
    fail({ status: 409, code: "request_id_conflict" });
  mount();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByText(/request id was already used/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(sent("directAction")).toHaveLength(1);
});

it("explains an unsupported direct action on that action only", async () => {
  routes.directAction = () => routeMissing;
  mount();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByText("This relay doesn't support direct actions yet."),
  ).toBeInTheDocument();
  // The feature stays available for the next action.
  expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
});

it("refuses to review a staff target", async () => {
  routes.getMember = () =>
    ok({
      pubkey: member,
      profile: null,
      role: "member",
      banned: false,
      mutedUntil: null,
      isStaff: true,
    });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  fireEvent.change(screen.getByLabelText("Member"), {
    target: { value: "Bob" },
  });
  fireEvent.click(await screen.findByRole("option", { name: /Bob/ }));
  expect(
    await screen.findByText(/Relay staff can't be banned/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
});

const report = {
  id: "r1",
  communityId: "c1",
  communityHost: "team.example.com",
  reportEventId: "e".repeat(64),
  reporterPubkey: member,
  targetKind: "pubkey",
  target: member,
  channelId: null,
  reportType: "spam",
  status: "open",
  createdAt: "2026-10-08T00:00:00Z",
};
const failedAction = {
  id: "act1",
  requestId: "q1",
  actorPubkey: signer,
  actorRole: "moderator",
  action: "ban",
  status: "failed",
  reason: null,
  expiresAt: null,
  errorMessage: "relay timeout",
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
};

async function openReport() {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
}

it("an ambiguous resolve is retried with the same request id", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  let first = true;
  routes.resolveReport = () => {
    if (!first) return ok({ status: "resolved", activeAction: null });
    first = false;
    return fail({
      category: "ambiguous",
      status: null,
      bodyComplete: false,
      message: "",
    });
  };
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  expect(
    screen.getByText("Sent verbatim to the affected user."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Retry: Ban/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(2));
  const [a, b] = sent("resolveReport");
  expect(a).toEqual(b);
  expect(a).toMatchObject({ id: "r1", action: "ban" });
});

it("a definite rejection releases the frozen resolve", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  routes.resolveReport = () => fail({ status: 422, code: "invalid" });
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Dismiss" }));
  expect(
    screen.getByText("Sent verbatim to the reporter."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Dismiss/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Confirm: Dismiss/ }),
    ).toBeEnabled(),
  );
  expect(
    screen.queryByRole("button", { name: /Retry/ }),
  ).not.toBeInTheDocument();
});

it("offers only the actions a target kind allows", async () => {
  routes.listReports = () =>
    ok([{ ...report, targetKind: "blob", target: "x" }]);
  routes.getReport = () => ok({ ...report, targetKind: "blob", target: "x" });
  await openReport();
  await screen.findByRole("radio", { name: "Dismiss" });
  expect(screen.getByRole("radio", { name: "Escalate" })).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "Ban" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("radio", { name: "Delete" }),
  ).not.toBeInTheDocument();
});

it("cancels a failed enforcement by its action id", async () => {
  const failed = {
    ...report,
    status: "processing",
    actionId: "act1",
    activeAction: failedAction,
  };
  routes.listReports = () => ok([failed]);
  routes.getReport = () => ok(failed);
  routes.cancelReport = () => ok({ status: "open", activeAction: null });
  await openReport();
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel and reopen" }),
  );
  await waitFor(() =>
    expect(sent("cancelReport")).toEqual([
      { route: "cancelReport", id: "r1", actionId: "act1" },
    ]),
  );
  await waitFor(() => expect(sent("getReport").length).toBeGreaterThan(1));
});

// The resolve lands, its answer is lost, and enforcement then fails: the
// report waits in `processing` on the failed action carrying its request id.
function failEnforcement(sent: StaffRequest) {
  const requestId = (sent as ResolveSent).requestId;
  return {
    ...report,
    status: "processing",
    actionId: "act1",
    activeAction: { ...failedAction, requestId },
  };
}

// The relay's cancel answer names the action it undid.
function cancelled(requestId: string) {
  return ok({
    status: "open",
    activeAction: { ...failedAction, requestId, status: "cancelled" },
  });
}

it("a held resolve is released by a successful Cancel and reopen", async () => {
  let current: typeof report & Record<string, unknown> = report;
  routes.listReports = () => ok([current]);
  routes.getReport = () => ok(current);
  routes.resolveReport = (request) => {
    current = failEnforcement(request);
    return fail({ category: "ambiguous", status: 502 });
  };
  routes.cancelReport = () => {
    const undone = (current.activeAction as { requestId: string }).requestId;
    current = report;
    return cancelled(undone);
  };
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel and reopen" }),
  );
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(2));
  const [a, b] = sent("resolveReport") as ResolveSent[];
  expect(a?.requestId).not.toBe(b?.requestId);
});

it("a resolve Retry still sending when Cancel succeeds is released once it settles", async () => {
  let current: typeof report & Record<string, unknown> = report;
  routes.listReports = () => ok([current]);
  routes.getReport = () => ok(current);
  routes.resolveReport = () => fail({ category: "ambiguous", status: 502 });
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  // The Retry lands and its enforcement fails, but its answer is held.
  const retry = holdNext("resolveReport", () => ok(report));
  fireEvent.click(await screen.findByRole("button", { name: /Retry: Ban/ }));
  await retry.started();
  const [first] = sent("resolveReport") as ResolveSent[];
  current = failEnforcement(first as StaffRequest);
  routes.cancelReport = () => {
    current = report;
    return cancelled(first?.requestId ?? "");
  };
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel and reopen" }),
  );
  await waitFor(() => expect(sent("cancelReport")).toHaveLength(1));
  await retry.release(fail({ category: "ambiguous", status: 502 }));
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(3));
  const ids = (sent("resolveReport") as ResolveSent[]).map((r) => r.requestId);
  expect(ids[1]).toBe(ids[0]);
  expect(ids[2]).not.toBe(ids[0]);
});

it("a slow Cancel answer leaves a newer uncertain resolve held", async () => {
  let current: typeof report & Record<string, unknown> = report;
  routes.listReports = () => ok([current]);
  routes.getReport = () => ok(current);
  routes.resolveReport = (request) => {
    current = failEnforcement(request);
    return fail({ category: "ambiguous", status: 502 });
  };
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  // The cancel commits on the relay, but its answer is slow.
  const cancel = holdNext("cancelReport", () => ok(report));
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel and reopen" }),
  );
  await cancel.started();
  current = report;
  routes.resolveReport = () => fail({ category: "ambiguous", status: 502 });
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await screen.findByRole("button", { name: /Retry: Ban/ });
  const [a, b] = sent("resolveReport") as ResolveSent[];
  await cancel.release(cancelled(a?.requestId ?? ""));
  fireEvent.click(await screen.findByRole("button", { name: /Retry: Ban/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(3));
  const [, , again] = sent("resolveReport") as ResolveSent[];
  expect(b?.requestId).not.toBe(a?.requestId);
  expect(again?.requestId).toBe(b?.requestId);
});

it("changes feedback status and previews and saves attachments", async () => {
  const sha = "f".repeat(64);
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:x",
      revokeObjectURL: revoke,
    }),
  );
  routes.listFeedback = () =>
    ok([
      {
        id: "f1",
        communityId: "c1",
        communityHost: "team.example.com",
        submitterPubkey: member,
        bodySummary: "Broken",
        status: "new",
        receivedAt: "2026-10-08T00:00:00Z",
      },
    ]);
  routes.getFeedback = () =>
    ok({
      id: "f1",
      communityId: "c1",
      communityHost: "team.example.com",
      eventId: "e".repeat(64),
      submitterPubkey: member,
      body: "Broken",
      status: "new",
      tags: [["imeta", `x ${sha}`, "m image/png", "size 3"]],
      eventCreatedAt: "2026-10-08T00:00:00Z",
      receivedAt: "2026-10-08T00:00:00Z",
    });
  routes.setFeedbackStatus = (request) =>
    ok({ status: (request as { status: string }).status });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Feedback" }));
  fireEvent.click(await screen.findByRole("button", { name: /Broken/ }));
  expect(await screen.findByAltText("Feedback attachment")).toHaveAttribute(
    "src",
    "blob:x",
  );
  fireEvent.click(screen.getByRole("radio", { name: "reviewed" }));
  await waitFor(() =>
    expect(sent("setFeedbackStatus")).toEqual([
      { route: "setFeedbackStatus", id: "f1", status: "reviewed" },
    ]),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toEqual([sha]));
  cleanup();
  expect(revoke).toHaveBeenCalledWith("blob:x");
});

function feedbackWith(tags: string[][]) {
  routes.listFeedback = () =>
    ok([
      {
        id: "f1",
        communityId: "c1",
        communityHost: "team.example.com",
        submitterPubkey: member,
        bodySummary: "Broken",
        status: "new",
        receivedAt: "2026-10-08T00:00:00Z",
      },
    ]);
  routes.getFeedback = () =>
    ok({
      id: "f1",
      communityId: "c1",
      communityHost: "team.example.com",
      eventId: "e".repeat(64),
      submitterPubkey: member,
      body: "Broken",
      status: "new",
      tags,
      eventCreatedAt: "2026-10-08T00:00:00Z",
      receivedAt: "2026-10-08T00:00:00Z",
    });
}

it("only raster images preview, and an attachment over 10 MiB is not shown", async () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:x",
      revokeObjectURL() {},
    }),
  );
  feedbackWith([
    ["imeta", `x ${"1".repeat(64)}`, "m image/png", "size 3"],
    ["imeta", `x ${"2".repeat(64)}`, "m image/png", `size ${20 * 1024 * 1024}`],
    ["imeta", `x ${"3".repeat(64)}`, "m image/svg+xml", "size 3"],
  ]);
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Feedback" }));
  fireEvent.click(await screen.findByRole("button", { name: /Broken/ }));
  await screen.findByAltText("Feedback attachment");
  // The SVG is listed for saving, after the skipped 20 MiB file, with no preview.
  expect(screen.getByText(/image\/svg\+xml/)).toBeVisible();
  expect(screen.getAllByAltText("Feedback attachment")).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(2);
  expect(screen.getByText(/1 attachment not shown/)).toBeVisible();
});

it("a status change still sending after Back reaches the reopened feedback", async () => {
  feedbackWith([]);
  const late = holdNext("setFeedbackStatus", () => ok({ status: "archived" }));
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Feedback" }));
  fireEvent.click(await screen.findByRole("button", { name: /Broken/ }));
  fireEvent.click(await screen.findByRole("radio", { name: "reviewed" }));
  await late.started();
  fireEvent.click(screen.getByRole("button", { name: /Back to feedback/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Broken/ }));
  const reviewed = await screen.findByRole("radio", { name: "reviewed" });
  expect(reviewed).toBeChecked();
  for (const radio of screen.getAllByRole("radio"))
    expect(radio).toHaveAttribute("aria-disabled", "true");
  await late.release(ok({ status: "reviewed" }));
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: "new" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    ),
  );
  expect(screen.getByRole("radio", { name: "reviewed" })).toBeChecked();
  expect(sent("setFeedbackStatus")).toHaveLength(1);
});

it("a failed feedback list recovers with Retry in the same view", async () => {
  feedbackWith([]);
  const working = routes.listFeedback ?? (() => ok([]));
  routes.listFeedback = () => fail({ category: "rejected", status: 500 });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Feedback" }));
  const retry = await screen.findByRole("button", { name: "Retry" });
  routes.listFeedback = working;
  fireEvent.click(retry);
  expect(await screen.findByRole("button", { name: /Broken/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("a failed community directory recovers with Retry in the same view", async () => {
  const working = routes.listCommunities ?? (() => ok({ items: [] }));
  // The directory fails; the pinned lookup for the connected host still works.
  routes.listCommunities = (request) =>
    (request as { q?: string }).q
      ? working(request)
      : fail({ category: "rejected", status: 500 });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  const retry = await screen.findByRole("button", { name: "Retry" });
  routes.listCommunities = working;
  fireEvent.click(retry);
  expect(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("feedback with only oversized attachments still shows the hidden count", async () => {
  feedbackWith([
    ["imeta", `x ${"2".repeat(64)}`, "m image/png", `size ${20 * 1024 * 1024}`],
  ]);
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Feedback" }));
  fireEvent.click(await screen.findByRole("button", { name: /Broken/ }));
  expect(await screen.findByText(/1 attachment not shown/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

it("a failed attachment preview recovers with Retry in place", async () => {
  const original = backend.attachment;
  let release!: (outcome: StaffOutcome<Uint8Array>) => void;
  let attempts = 0;
  backend.attachment = (() => {
    attempts += 1;
    if (attempts === 1)
      return Promise.resolve(fail({ category: "rejected", status: 500 }));
    return new Promise((resolve) => {
      release = resolve;
    });
  }) as RelayStaffBackend["attachment"];
  try {
    await openFeedback("m image/png");
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
    expect(retry).toHaveFocus();
    await act(async () =>
      release(ok(new Uint8Array([1, 2, 3])) as StaffOutcome<Uint8Array>),
    );
    expect(screen.getByAltText("Feedback attachment")).toHaveAttribute(
      "src",
      "blob:x",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(attempts).toBe(2);
  } finally {
    await act(async () =>
      release?.(fail({ message: "released" }) as StaffOutcome<Uint8Array>),
    );
    backend.attachment = original;
  }
});

it("a failed pinned community lookup recovers with Retry", async () => {
  let pinnedFails = true;
  routes.listCommunities = (request) => {
    if ((request as { q?: string }).q === "team.example.com" && pinnedFails)
      return fail({ category: "rejected", status: 500 });
    return ok({
      items: [{ id: "c1", host: "team.example.com", icon: null }],
      nextCursor: null,
    });
  };
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  const retry = await screen.findByRole("button", { name: "Retry" });
  pinnedFails = false;
  fireEvent.click(retry);
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

/** Directory pages: `first` then a later page answered by `later`. */
function directoryPages(later: Handler) {
  routes.listCommunities = (request) => {
    const { q, cursor } = request as { q?: string; cursor?: string };
    if (q) return ok({ items: [], nextCursor: null });
    if (cursor === "p2") return later(request);
    return ok({
      items: [{ id: "a", host: "a.example.com", icon: null }],
      nextCursor: "p2",
    });
  };
}

it("an unsupported later directory page keeps the rows already loaded", async () => {
  directoryPages(() => routeMissing);
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  expect(
    await screen.findByText(
      "This relay doesn't support community browsing yet.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "a.example.com" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
});

it("Retry on a failed later directory page resends that cursor in place", async () => {
  let release!: (outcome: StaffOutcome<unknown>) => void;
  let laterCalls = 0;
  directoryPages(() => {
    laterCalls += 1;
    if (laterCalls === 1) return fail({ category: "rejected", status: 500 });
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  const retry = await screen.findByRole("button", { name: "Retry" });
  retry.focus();
  fireEvent.click(retry);
  const page = ok({
    items: [{ id: "b", host: "b.example.com", icon: null }],
    nextCursor: null,
  });
  try {
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
    expect(retry).toHaveFocus();
  } finally {
    await act(async () => release?.(page));
  }
  const cursors = sent("listCommunities")
    .map((r) => r as { q?: string; cursor?: string })
    .filter((r) => !r.q)
    .map((r) => r.cursor ?? null);
  expect(cursors).toEqual([null, "p2", "p2"]);
  expect(
    screen.getAllByRole("button", { name: /^[ab]\.example\.com$/ }),
  ).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("community sections are tabs with arrow keys and linked panels", async () => {
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  const sections = screen.getByRole("tablist", { name: "Community sections" });
  const reports = within(sections).getByRole("tab", { name: "Reports" });
  expect(reports).toHaveAttribute("aria-selected", "true");
  const panel = screen.getByRole("tabpanel");
  expect(panel).toHaveAttribute("aria-labelledby", reports.id);
  reports.focus();
  fireEvent.keyDown(reports, { key: "ArrowRight" });
  const restrictions = within(sections).getByRole("tab", {
    name: "Restrictions",
  });
  await waitFor(() => expect(restrictions).toHaveFocus());
});

it("directory search waits for typing to pause before sending", async () => {
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  await screen.findByRole("button", { name: /team\.example\.com/ });
  const search = screen.getByLabelText("Search communities");
  vi.useFakeTimers();
  try {
    const before = sent("listCommunities").length;
    for (const value of ["t", "te", "tea"])
      fireEvent.change(search, { target: { value } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1));
    expect(sent("listCommunities")).toHaveLength(before);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(sent("listCommunities").slice(before)).toEqual([
      { route: "listCommunities", q: "tea" },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("directory search sends nothing for one character and lists every community", async () => {
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  await screen.findByRole("button", { name: /team\.example\.com/ });
  const search = screen.getByLabelText("Search communities");
  vi.useFakeTimers();
  try {
    const before = sent("listCommunities").length;
    fireEvent.change(search, { target: { value: "t" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(sent("listCommunities")).toHaveLength(before);
    fireEvent.change(search, { target: { value: "te" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(sent("listCommunities").slice(before)).toEqual([
      { route: "listCommunities", q: "te" },
    ]);
    fireEvent.change(search, { target: { value: "t" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(sent("listCommunities").at(-1)).toEqual({
      route: "listCommunities",
    });
  } finally {
    vi.useRealTimers();
  }
});

it("config-backed staff can't be removed, and removing yourself re-probes", async () => {
  const fixedKey = "c".repeat(64);
  routes.probe = () => probe({ role: "operator", canStaff: true });
  routes.listOperators = () =>
    ok([
      { pubkey: fixedKey, effectiveRole: "operator", sources: ["config"] },
      { pubkey: signer, effectiveRole: "operator", sources: ["db"] },
    ]);
  routes.deleteOperator = () => ok({ deleted: signer });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2),
  );
  const [fixed, self] = screen.getAllByRole("button", {
    name: "Remove",
  }) as HTMLElement[];
  expect(fixed).toBeDisabled();
  fireEvent.click(self as HTMLElement);
  expect(
    await screen.findByText(/removing your own staff access/),
  ).toBeInTheDocument();
  const confirm = screen
    .getAllByRole("button", { name: "Remove" })
    .at(-1) as HTMLElement;
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(sent("deleteOperator")).toEqual([
      { route: "deleteOperator", pubkey: signer },
    ]),
  );
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
});

/** Mounts the card for a selection that the test can change. */
function mountSwitchable(local: RelayStaffBackend = backend) {
  const selection = { relay, signer };
  const staff = createStaff(local, () => ({ ...selection }));
  staff.ensure();
  const card = () => (
    <ToastProvider>
      <Entries staff={staff} />
    </ToastProvider>
  );
  const view = render(card());
  const select = async (patch: Partial<typeof selection>) => {
    await act(async () => {
      Object.assign(selection, patch);
      staff.refresh();
    });
  };
  const reopen = () => {
    cleanup();
    render(card());
  };
  return { staff, view, select, reopen };
}

/** Holds the next answer on `route` until `release`; other calls use `then`. */
function holdNext(route: StaffRequest["route"], then: Handler) {
  let release: ((outcome: StaffOutcome<unknown>) => void) | null = null;
  let armed = true;
  routes[route] = (request) => {
    if (!armed) return then(request);
    armed = false;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  return {
    started: () => waitFor(() => expect(release).toBeTypeOf("function")),
    release: (outcome: StaffOutcome<unknown>) =>
      act(async () => release?.(outcome)),
  };
}

async function freezeDirectBan() {
  routes.directAction = () => fail({ category: "ambiguous", status: 502 });
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByRole("button", { name: "Retry" });
}
async function reopenActions() {
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
}
/** The retried request is the first one, byte for byte, in the same context. */
async function expectIdenticalRetry(route: StaffRequest["route"]) {
  await waitFor(() => expect(sent(route)).toHaveLength(2));
  const [first, second] = sent(route);
  expect(second).toEqual(first);
  const at = contexts.filter((_, i) => calls[i]?.route === route);
  expect(at[1]).toEqual(at[0]);
}

it("a report Retry after leaving the report resends the frozen request", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  routes.resolveReport = () => fail({ category: "ambiguous", status: 502 });
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await screen.findByRole("button", { name: /Retry: Ban/ });
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Retry: Ban/ }));
  await expectIdenticalRetry("resolveReport");
});

it("an unresolved direct action survives closing and reopening the card", async () => {
  const { reopen } = mountSwitchable();
  await freezeDirectBan();
  reopen();
  await reopenActions();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await expectIdenticalRetry("directAction");
});

it("an unresolved direct action survives losing and regaining access", async () => {
  const { staff } = mountSwitchable();
  await freezeDirectBan();
  routes.probe = () => fail({ category: "forbidden", status: 403 });
  const reprobe = () =>
    act(async () => {
      const context = staff.context();
      if (context) await staff.probe(context, true);
    });
  await reprobe();
  await noEntries(staff);
  routes.probe = () => probe();
  await reprobe();
  await reopenActions();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await expectIdenticalRetry("directAction");
});

it("a held action is never offered under another identity", async () => {
  const { select } = mountSwitchable();
  await freezeDirectBan();
  await select({ signer: member });
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
  await reopenActions();
  expect(await screen.findByRole("button", { name: "Review" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await select({ signer });
  await reopenActions();
  expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
});

it("switching identity on the same relay probes as the new identity", async () => {
  const { select, staff } = mountSwitchable();
  await screen.findByText(/Connected as moderator/);
  routes.probe = () => fail({ category: "forbidden", status: 403 });
  await select({ signer: member });
  await noEntries(staff);
  expect(sent("probe")).toHaveLength(2);
  expect(contexts.at(-1)?.signer).toBe(member);
});

it("clicking a feedback image opens the media viewer and closing returns", async () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:x",
      revokeObjectURL: vi.fn(),
    }),
  );
  await openFeedback("m image/png");
  fireEvent.click(await screen.findByRole("button", { name: "Open image" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Image attachment",
  });
  expect(
    within(dialog).getByAltText("Feedback attachment, full size"),
  ).toHaveAttribute("src", "blob:x");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Close fullscreen viewer" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByAltText("Feedback attachment")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
});

it("an attachment preview 401 re-checks the role", async () => {
  const original = backend.attachment;
  backend.attachment = (async () =>
    fail({
      category: "unauthorized",
      status: 401,
    })) as RelayStaffBackend["attachment"];
  try {
    await openFeedback("m image/png");
    await screen.findByText("The relay did not accept your signature.");
    await waitFor(() => expect(sent("probe")).toHaveLength(2));
  } finally {
    backend.attachment = original;
  }
});

it("an attachment Save 401 re-checks the role", async () => {
  const original = backend.saveAttachment;
  backend.saveAttachment = async () => ({
    state: "failed",
    failure: (
      fail({ category: "unauthorized", status: 401 }) as {
        failure: StaffFailure;
      }
    ).failure,
  });
  try {
    await openFeedback("m application/pdf");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("probe")).toHaveLength(2));
  } finally {
    backend.saveAttachment = original;
  }
});

async function openFeedback(mime: string) {
  const item = {
    id: "f1",
    communityId: "c1",
    communityHost: "team.example.com",
    submitterPubkey: member,
    status: "new",
    receivedAt: "2026-10-08T00:00:00Z",
  };
  routes.listFeedback = () => ok([{ ...item, bodySummary: "Attachment" }]);
  routes.getFeedback = () =>
    ok({
      ...item,
      body: "Attachment",
      tags: [["imeta", `x ${"f".repeat(64)}`, mime, "size 3"]],
    });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Feedback" }));
  fireEvent.click(await screen.findByRole("button", { name: /Attachment/ }));
}

it("operators on a read-only relay can't add, change or remove staff", async () => {
  routes.probe = () => probe({ role: "operator", authMode: "disabled" });
  routes.listOperators = () =>
    ok([
      {
        pubkey: member,
        effectiveRole: "moderator",
        sources: ["db"],
      },
    ]);
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  await screen.findByText("moderator");
  expect(screen.queryByText("Add staff")).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  expect(screen.queryByLabelText(/Role for/)).toBeNull();
});

it("a late directory page for an earlier search is dropped", async () => {
  let release!: (outcome: StaffOutcome<unknown>) => void;
  routes.listCommunities = (request) => {
    const q = (request as { q?: string }).q;
    if (q === "old")
      return new Promise((resolve) => {
        release = resolve;
      });
    if (q === "new")
      return ok({
        items: [{ id: "new", host: "new.example.com", icon: null }],
        nextCursor: null,
      });
    return ok({ items: [], nextCursor: null });
  };
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  const search = screen.getByLabelText("Search communities");
  fireEvent.change(search, { target: { value: "old" } });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.change(search, { target: { value: "new" } });
  await screen.findByRole("button", { name: "new.example.com" });
  await act(async () =>
    release(
      ok({
        items: [{ id: "old", host: "old.example.com", icon: null }],
        nextCursor: null,
      }),
    ),
  );
  expect(screen.queryByRole("button", { name: "old.example.com" })).toBeNull();
  expect(screen.getByRole("button", { name: "new.example.com" })).toBeVisible();
});

it("a late member search for an earlier query is dropped", async () => {
  let release!: (outcome: StaffOutcome<unknown>) => void;
  const result = (displayName: string, pubkey: string) =>
    ok({ items: [{ pubkey, displayName, nip05: null, avatarUrl: null }] });
  routes.searchMembers = (request) => {
    const q = (request as { q: string }).q;
    if (q === "Old")
      return new Promise((resolve) => {
        release = resolve;
      });
    return result("Newbie", member);
  };
  mount();
  await reopenActions();
  const input = await screen.findByLabelText("Member");
  fireEvent.change(input, { target: { value: "Old" } });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.change(input, { target: { value: "New" } });
  await screen.findByRole("option", { name: /Newbie/ });
  await act(async () => release(result("Oldie", "c".repeat(64))));
  expect(screen.queryByRole("option", { name: /Oldie/ })).toBeNull();
});

it("a pasted nostr: npub offers that member without a name search", async () => {
  mount();
  await reopenActions();
  const input = await screen.findByLabelText("Member");
  const before = sent("searchMembers").length;
  vi.useFakeTimers();
  try {
    fireEvent.change(input, {
      target: { value: `nostr:${npubEncode(member)}` },
    });
    // The typing pause has passed, so a name search would have been sent.
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(sent("searchMembers")).toHaveLength(before);
    expect(screen.getAllByRole("option")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
  fireEvent.click(screen.getByRole("option"));
  expect(await screen.findByText("Role: member")).toBeVisible();
  expect(sent("getMember").at(-1)).toMatchObject({ pubkey: member });
});

/**
 * Both selections are visited first, so their roles are remembered and the
 * switch back and forth needs no probe: the console stays authorized, and
 * only the stale-read guards keep the earlier answer off the screen.
 */
async function lateReadAfterSwitch(
  away: Partial<StaffTarget>,
  local?: RelayStaffBackend,
) {
  const { select } = mountSwitchable(local);
  await screen.findByText(/Connected as moderator/);
  await select(away);
  await screen.findByText(/Connected as moderator/);
  const late = holdNext("listReports", () => ok([]));
  await select({ relay, signer });
  await late.started();
  await select(away);
  await waitFor(() => expect(sent("listReports").length).toBeGreaterThan(3));
  await late.release(ok([report]));
  await screen.findByText(/No reports/);
  expect(screen.queryByRole("button", { name: /spam/ })).toBeNull();
}

it("a late read for an earlier identity is dropped", async () => {
  await lateReadAfterSwitch({ signer: member });
});

it("a late read for an earlier admin host is dropped", async () => {
  const other = "wss://other.example.com";
  await lateReadAfterSwitch(
    { relay: other },
    {
      ...backend,
      discover: async (url) =>
        url === other ? "https://admin.other.example.com" : origin,
    },
  );
  expect(contexts.at(-1)?.origin).toBe("https://admin.other.example.com");
});

it("a late read for an earlier community is dropped", async () => {
  const late = holdNext("listRestrictions", () =>
    ok({ items: [], nextCursor: null }),
  );
  routes.listCommunities = () =>
    ok({
      items: [
        { id: "c1", host: "team.example.com", icon: null },
        { id: "c2", host: "two.example.com", icon: null },
      ],
      nextCursor: null,
    });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Restrictions" }));
  await late.started();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /two\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Restrictions" }));
  await waitFor(() => expect(sent("listRestrictions")).toHaveLength(2));
  await late.release(
    ok({
      items: [{ pubkey: member, banned: true, mutedUntil: null }],
      nextCursor: null,
    }),
  );
  expect(screen.queryByText(/bbbb/)).toBeNull();
});

it("an in-flight direct action that succeeds updates a reopened card", async () => {
  const { reopen } = mountSwitchable();
  const late = holdNext("directAction", () =>
    ok({ state: "succeeded", actionId: "done", replayed: true }),
  );
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await late.started();
  reopen();
  await reopenActions();
  await late.release(
    ok({ state: "succeeded", actionId: "done", replayed: false }),
  );
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  expect(screen.getByRole("button", { name: "Review" })).toBeVisible();
});

it("an in-flight resolve rejected after reopening the report releases the form", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  const late = holdNext("resolveReport", () =>
    fail({ code: "invalid_action" }),
  );
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await late.started();
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("button", { name: /Retry: Ban/ });
  await late.release(fail({ code: "invalid_action" }));
  expect(screen.queryByRole("button", { name: /Retry: Ban/ })).toBeNull();
  expect(screen.getByRole("radio", { name: "Ban" })).toBeEnabled();
});

it("an in-flight direct action can't be discarded or replaced after reopening", async () => {
  const { reopen } = mountSwitchable();
  const late = holdNext("directAction", () =>
    fail({ category: "ambiguous", status: 502 }),
  );
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await late.started();
  reopen();
  await reopenActions();
  expect(await screen.findByRole("button", { name: "Discard" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await late.release(fail({ category: "ambiguous", status: 502 }));
  reopen();
  await reopenActions();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await expectIdenticalRetry("directAction");
});

const dnsDown = fail({
  category: "notSent",
  status: null,
  notSent: true,
  bodyComplete: false,
  message: "DNS unavailable",
});
const refused = fail({ category: "forbidden", status: 403, message: "" });

it.each([
  ["ambiguous", fail({ category: "ambiguous", status: 502 }), dnsDown],
  ["ambiguous", fail({ category: "ambiguous", status: 502 }), refused],
  [
    "pending",
    ok({ state: "pending", actionId: "a1", replayed: false }),
    dnsDown,
  ],
  [
    "pending",
    ok({ state: "pending", actionId: "a1", replayed: false }),
    refused,
  ],
])(
  "a direct action that was %s stays held when a retry fails without an answer",
  async (_, first, retry) => {
    routes.directAction = () => first;
    mountSwitchable();
    await openCommunityActions();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await screen.findByRole("button", { name: "Retry" });
    routes.directAction = () => retry;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sent("directAction")).toHaveLength(2));
    routes.directAction = () => fail({ category: "ambiguous", status: 502 });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sent("directAction")).toHaveLength(3));
    const [a, , c] = sent("directAction");
    expect(c).toEqual(a);
  },
);

it.each([
  ["refused before sending", dnsDown],
  ["refused for authorization", refused],
])("an uncertain resolve stays held when a retry is %s", async (_, retry) => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  routes.resolveReport = () => fail({ category: "ambiguous", status: 502 });
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await screen.findByRole("button", { name: /Retry: Ban/ });
  routes.resolveReport = () => retry;
  fireEvent.click(screen.getByRole("button", { name: /Retry: Ban/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(2));
  routes.resolveReport = () => fail({ category: "ambiguous", status: 502 });
  fireEvent.click(await screen.findByRole("button", { name: /Retry: Ban/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(3));
  const [a, , c] = sent("resolveReport");
  expect(c).toEqual(a);
});

it("a first attempt refused before sending releases the write", async () => {
  routes.directAction = () => dnsDown;
  mountSwitchable();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByText(/DNS unavailable/);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("a gateway 401 after a sent write re-checks access and keeps the write", async () => {
  routes.directAction = () =>
    fail({ category: "ambiguous", status: 401, authLost: true });
  mountSwitchable();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await expectIdenticalRetry("directAction");
});

it("a gateway 401 on a write re-probes once, even when the probe is refused too", async () => {
  routes.directAction = () =>
    fail({ category: "ambiguous", status: 401, authLost: true });
  const { staff } = mountSwitchable();
  await openCommunityActions();
  routes.probe = () =>
    fail({ category: "ambiguous", status: 401, authLost: true });
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await noEntries(staff);
  const context = staff.context();
  // The re-probe has answered once access is denied; any further re-probe
  // would already have been sent by the write's 401.
  await waitFor(() =>
    expect(context && staff.access(context)?.state).toBe("denied"),
  );
  // Flush the renders and effects the denial causes before counting.
  await act(async () => {});
  expect(sent("probe")).toHaveLength(2);
  expect(
    context && staff.writes(context).get("direct action")?.request,
  ).toEqual(sent("directAction")[0]);
});

it("an identity switch publishes a context change", async () => {
  let viewer = signer;
  const staff = createStaff(backend, () => ({ relay, signer: viewer }));
  staff.ensure();
  render(
    <ToastProvider>
      <Entries staff={staff} />
    </ToastProvider>,
  );
  await screen.findByText(/Connected as moderator/);
  await act(async () => {
    viewer = member;
    staff.refresh();
    await Promise.resolve();
  });
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
});

it("the same admin origin does not keep the old discovery relay", async () => {
  let selectedRelay = relay;
  const contexts: string[] = [];
  const localBackend = {
    ...backend,
    request: (async (context, request) => {
      if (request.route === "listCommunities") contexts.push(context.relay);
      return backend.request(context, request);
    }) as RelayStaffBackend["request"],
  };
  const staff = createStaff(localBackend, () => ({
    relay: selectedRelay,
    signer,
  }));
  staff.ensure();
  const view = (
    <ToastProvider>
      <Entries staff={staff} />
    </ToastProvider>
  );
  const { rerender } = render(view);
  await screen.findByText(/Connected as moderator/);
  await act(async () => {
    selectedRelay = "wss://other.example.com";
    staff.refresh();
    await Promise.resolve();
  });
  // Give the component an explicit parent rerender too, as Settings may do.
  rerender(
    <ToastProvider>
      <Entries staff={staff} />
    </ToastProvider>,
  );
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  await screen.findByRole("button", { name: /team\.example\.com/ });
  expect(contexts.length).toBeGreaterThan(0);
  expect(contexts.every((value) => value === selectedRelay)).toBe(true);
});

it("a retry refused before sending does not resolve an older sent write", async () => {
  mountSwitchable();
  await freezeDirectBan();
  routes.directAction = () =>
    fail({
      category: "notSent",
      status: null,
      notSent: true,
      bodyComplete: false,
      message: "DNS unavailable",
    });
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByText(/DNS unavailable/);
  expect(sent("directAction")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
});

it("a cancel completed after reopening refreshes the active report", async () => {
  let cancelled = false;
  const failed = {
    ...report,
    status: "processing",
    activeAction: {
      id: "a1",
      requestId: "q",
      actorPubkey: signer,
      actorRole: "moderator",
      action: "ban",
      status: "failed",
      reason: null,
      expiresAt: null,
      errorMessage: "nope",
      createdAt: "t",
      updatedAt: "t",
    },
  };
  routes.listReports = () => ok([failed]);
  routes.getReport = () =>
    ok(cancelled ? { ...report, activeAction: null } : failed);
  let release!: (value: StaffOutcome<unknown>) => void;
  routes.cancelReport = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await openReport();
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel and reopen" }),
  );
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("button", { name: "Cancel and reopen" });
  await act(async () => {
    cancelled = true;
    release(
      ok({
        status: "open",
        activeAction: { ...failed.activeAction, status: "cancelled" },
      }),
    );
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Cancel and reopen" }),
    ).toBeNull(),
  );
  expect(screen.getByRole("radio", { name: "Ban" })).toBeEnabled();
});

it("an operator rejection after reopening reaches the active view", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  routes.listOperators = () => ok([]);
  let release!: (value: StaffOutcome<unknown>) => void;
  routes.putOperator = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const { reopen } = mountSwitchable();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  fireEvent.change(await screen.findByLabelText("Public key"), {
    target: { value: member },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  reopen();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  await screen.findByText("No staff configured.");
  await act(async () => release(fail({ message: "Operator change refused" })));
  await screen.findByText("Operator change refused");
});

it("a lift refused after reopening shows on the active Restrictions view, once", async () => {
  routes.listRestrictions = () =>
    ok({
      items: [
        { pubkey: member, banned: true, banExpiresAt: null, mutedUntil: null },
      ],
      nextCursor: null,
    });
  const late = holdNext("liftRestriction", () => fail({}));
  const { reopen } = mountSwitchable();
  const openRestrictions = async () => {
    fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /team\.example\.com/ }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Restrictions" }));
  };
  await openRestrictions();
  fireEvent.click(await screen.findByRole("button", { name: "Lift ban" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Lift ban",
    }),
  );
  await late.started();
  reopen();
  await openRestrictions();
  await screen.findByRole("button", { name: "Lift ban" });
  await late.release(fail({ message: "Lift refused" }));
  expect(await screen.findByText("Lift refused")).toBeVisible();
  reopen();
  await openRestrictions();
  await screen.findByRole("button", { name: "Lift ban" });
  expect(screen.queryByText("Lift refused")).toBeNull();
});

it("adds staff by a pasted nostr: npub as its hex key", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  routes.listOperators = () => ok([]);
  routes.putOperator = () => ok(null);
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  fireEvent.change(await screen.findByLabelText("Public key"), {
    target: { value: `nostr:${npubEncode(member)}` },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(sent("putOperator")).toHaveLength(1));
  expect(sent("putOperator")[0]).toMatchObject({ pubkey: member });
});

it("operator changes without a request id start fresh each time", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  routes.listOperators = () => ok([]);
  routes.putOperator = () => fail({ message: "Operator change refused" });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  fireEvent.change(await screen.findByLabelText("Public key"), {
    target: { value: member },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await screen.findByText("Operator change refused");
  fireEvent.change(screen.getByLabelText("Public key"), {
    target: { value: signer },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(sent("putOperator")).toHaveLength(2));
  expect(
    sent("putOperator").map((r) => (r as { pubkey: string }).pubkey),
  ).toEqual([member, signer]);
});

it("a reason refused before sending shows and can be edited", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  routes.resolveReport = () =>
    fail({
      category: "notSent",
      status: null,
      notSent: true,
      bodyComplete: false,
      message: "Reason is too long",
    });
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.change(screen.getByLabelText("Reason (optional)"), {
    target: { value: "x".repeat(20) },
  });
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  expect(await screen.findByText("Reason is too long")).toBeVisible();
  const reason = screen.getByLabelText("Reason (optional)");
  expect(reason).toBeEnabled();
  fireEvent.change(reason, { target: { value: "short" } });
  expect(reason).toHaveValue("short");
  expect(screen.getByRole("button", { name: /Confirm: Ban/ })).toBeEnabled();
});

it("an operator result finished while closed is delivered once on next mount", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  routes.listOperators = () => ok([]);
  const late = holdNext("putOperator", () => fail({}));
  const { reopen } = mountSwitchable();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  fireEvent.change(await screen.findByLabelText("Public key"), {
    target: { value: member },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await late.started();
  cleanup();
  await late.release(fail({ message: "Finished while closed" }));
  reopen();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  expect(await screen.findByText("Finished while closed")).toBeVisible();
  reopen();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  await screen.findByText("No staff configured.");
  expect(screen.queryByText("Finished while closed")).toBeNull();
});

it("only the original context claims a finished operator attempt", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  routes.listOperators = () => ok([]);
  const late = holdNext("putOperator", () => fail({}));
  const { select } = mountSwitchable();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  fireEvent.change(await screen.findByLabelText("Public key"), {
    target: { value: member },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await late.started();
  await select({ signer: member });
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  await screen.findByText("No staff configured.");
  await late.release(fail({ message: "Original context only" }));
  expect(screen.queryByText("Original context only")).toBeNull();
  await select({ signer });
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  expect(await screen.findByText("Original context only")).toBeVisible();
});

it("strict-mode and concurrent consumers claim each attempt once", async () => {
  const { staff } = mount();
  await screen.findByText(/Connected as moderator/);
  const context = staff.context();
  if (!context) throw new Error("no context");
  const session = createSession(staff, context, {
    status: "ok",
    authMode: "nip98",
    role: "moderator",
    source: "db",
    canAct: true,
    canStaff: false,
  });
  cleanup();
  routes.putOperator = () => fail({ message: "claimed" });
  const handled: StaffRequest[] = [];
  function Consumer({ name }: { name: string }) {
    const write = useWrite("operators", (_outcome, sent) => handled.push(sent));
    return (
      <button
        type="button"
        onClick={() =>
          write.run({ route: "putOperator", pubkey: member, role: "moderator" })
        }
      >
        {name}
      </button>
    );
  }
  render(
    <StrictMode>
      <SessionProvider value={session}>
        <Consumer name="first" />
        <Consumer name="second" />
      </SessionProvider>
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole("button", { name: "first" }));
  await waitFor(() => expect(handled).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "second" }));
  await waitFor(() => expect(handled).toHaveLength(2));
  expect(sent("putOperator")).toHaveLength(2);
});

it("resolve finished off-screen is delivered on reopening, not a later lifecycle", async () => {
  let resolved = false;
  routes.listReports = () =>
    ok([{ ...report, status: resolved ? "resolved" : "open" }]);
  routes.getReport = () =>
    ok({ ...report, status: resolved ? "resolved" : "open" });
  const late = holdNext("resolveReport", () =>
    ok({ status: "resolved", activeAction: null }),
  );
  const { staff, reopen } = mountSwitchable();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await late.started();
  cleanup();
  resolved = true;
  await late.release(ok({ status: "resolved", activeAction: null }));
  reopen();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("button", { name: "Reopen report" });
  // Fresh detail already has the final status, so Resolve is never mounted;
  // the detail claims the result anyway.
  expect(
    await screen.findByText("Report resolved: resolved"),
  ).toBeInTheDocument();
  const context = staff.context();
  expect(
    context && staff.writes(context).get(`resolve ${report.id}`)?.unseen,
  ).toBe(false);
  // A later report reopen mounts Resolve and must not announce it again.
  resolved = false;
  reopen();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("radio", { name: "Ban" });
  expect(screen.queryByText("Report resolved: resolved")).toBeNull();
});

it("enforcement error finished while closed reaches reopened detail", async () => {
  let failed = false;
  const enforcement = {
    id: "a1",
    requestId: "q",
    actorPubkey: signer,
    actorRole: "moderator",
    action: "ban",
    status: "failed",
    reason: null,
    expiresAt: null,
    errorMessage: "Native enforcement detail",
    createdAt: "t",
    updatedAt: "t",
  };
  routes.listReports = () => ok([report]);
  routes.getReport = () =>
    ok(
      failed
        ? { ...report, status: "processing", activeAction: enforcement }
        : report,
    );
  const late = holdNext("resolveReport", () =>
    fail({ code: "enforcement_failed" }),
  );
  const { reopen } = mountSwitchable();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await late.started();
  cleanup();
  failed = true;
  await late.release(
    fail({
      code: "enforcement_failed",
      message: "Distinct completion failure",
    }),
  );
  reopen();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("button", { name: "Cancel and reopen" });
  expect(screen.queryByText("Native enforcement detail")).toBeVisible();
  // Sonner keeps a new toast transparent until its mount effect flips data-mounted.
  await waitFor(() =>
    expect(screen.getByText("Distinct completion failure")).toBeVisible(),
  );
});

it("a reopen finished while closed is announced on the reopened detail, once", async () => {
  let reopened = false;
  const resolvedReport = { ...report, status: "resolved" };
  routes.listReports = () => ok([reopened ? report : resolvedReport]);
  routes.getReport = () => ok(reopened ? report : resolvedReport);
  const late = holdNext("reopenReport", () => ok({ status: "open" }));
  const { reopen } = mountSwitchable();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Reopen report" }));
  await late.started();
  cleanup();
  reopened = true;
  await late.release(ok({ ...report, status: "open" }));
  reopen();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("radio", { name: "Ban" });
  expect(await screen.findByText("Report reopened")).toBeInTheDocument();
  reopen();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("radio", { name: "Ban" });
  expect(screen.queryByText("Report reopened")).toBeNull();
});

it("a cancel finished while closed is announced on the reopened detail, once", async () => {
  let cancelled = false;
  const failed = {
    ...report,
    status: "processing",
    activeAction: {
      id: "a1",
      requestId: "q",
      actorPubkey: signer,
      actorRole: "moderator",
      action: "ban",
      status: "failed",
      reason: null,
      expiresAt: null,
      errorMessage: "nope",
      createdAt: "t",
      updatedAt: "t",
    },
  };
  routes.listReports = () => ok([cancelled ? report : failed]);
  routes.getReport = () => ok(cancelled ? report : failed);
  const late = holdNext("cancelReport", () => ok({ status: "open" }));
  const { reopen } = mountSwitchable();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel and reopen" }),
  );
  await late.started();
  cleanup();
  cancelled = true;
  await late.release(
    ok({
      status: "open",
      activeAction: { ...failed.activeAction, status: "cancelled" },
    }),
  );
  reopen();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("radio", { name: "Ban" });
  expect(
    await screen.findByText("Enforcement cancelled. The report is open again."),
  ).toBeInTheDocument();
  reopen();
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("radio", { name: "Ban" });
  expect(
    screen.queryByText("Enforcement cancelled. The report is open again."),
  ).toBeNull();
});

it("people show their profile name with the short key, never the raw key", async () => {
  const author = "c".repeat(64);
  const ensured: string[] = [];
  const known = new Map([[member, { name: "Bob" }]]);
  const profiles: ProfileQueries = {
    snapshot: () => known,
    subscribe: () => () => {},
    ensure: async (ids) => {
      ensured.push(...ids);
    },
  };
  const detail = {
    ...report,
    message: {
      authorPubkey: author,
      content: "hi",
      createdAt: report.createdAt,
      deletedAt: null,
    },
  };
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(detail);
  const staff = createStaff(backend, () => ({ relay, signer }));
  staff.ensure();
  render(
    <ToastProvider>
      <ProfilesContext.Provider value={profiles}>
        <Entries staff={staff} />
      </ProfilesContext.Provider>
    </ToastProvider>,
  );
  const card = await screen.findByRole("button", { name: /spam/ });
  expect(card).toHaveTextContent(`reporter: Bob (${formatPublicKey(member)})`);
  fireEvent.click(card);
  // Reporter and target: the name, with the full npub behind a preview.
  expect(
    await screen.findAllByRole("button", { name: "Preview Bob identity" }),
  ).toHaveLength(2);
  // No name for the message author: the short key stands in.
  expect(
    screen.getByRole("button", {
      name: `Preview ${formatPublicKey(author)} identity`,
    }),
  ).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(member);
  expect(document.body.textContent).not.toContain(author);
  await waitFor(() => expect(ensured).toContain(author));
});

it("each community's count is a lower bound when the relay's limit is hit", async () => {
  const other = {
    ...report,
    communityId: "c2",
    communityHost: "other.example.com",
  };
  const rows = Array.from({ length: 200 }, (_, i) => ({
    ...(i < 3 ? other : report),
    id: `r${i}`,
  }));
  routes.listReports = () => ok(rows);
  mount();
  const heading = (host: string) =>
    screen.getByRole("button", { name: host }).closest("h4");
  await screen.findByRole("button", { name: "other.example.com" });
  expect(heading("other.example.com")).toHaveTextContent("3+");
  expect(heading("team.example.com")).toHaveTextContent("197+");
  expect(sent("listReports")[0]).toMatchObject({ query: { limit: 200 } });

  cleanup();
  routes.listReports = () => ok(rows.slice(0, 5));
  routes.listFeedback = () =>
    ok([
      {
        id: "f1",
        communityId: "c1",
        communityHost: "team.example.com",
        submitterPubkey: member,
        status: "new",
        receivedAt: report.createdAt,
        bodySummary: "Hello",
      },
    ]);
  mount();
  expect(
    (await screen.findByRole("button", { name: "other.example.com" })).closest(
      "h4",
    ),
  ).toHaveTextContent(/^other\.example\.com3$/);
  fireEvent.click(screen.getByRole("tab", { name: "Feedback" }));
  await screen.findByRole("button", { name: /Hello/ });
  expect(heading("team.example.com")).toHaveTextContent(
    /^team\.example\.com1$/,
  );
});

it("report cards show when the report was made", async () => {
  vi.setSystemTime(new Date("2026-10-08T00:05:00Z"));
  try {
    routes.listReports = () => ok([report]);
    mount();
    expect(
      await screen.findByRole("button", { name: /spam/ }),
    ).toHaveTextContent(/5 minutes ago \(.*2026/);
  } finally {
    vi.useRealTimers();
  }
});

/** Two people named Bob whose keys share the same three-character suffix. */
const bobA = `${"e".repeat(56)}000008c5`;
const bobB = `${"e".repeat(56)}00004000`;
const twinLabels = publicKeyLabels([bobA, bobB]);
const short = formatPublicKey(bobA) as string;
const longA = twinLabels.get(bobA) as string;
const longB = twinLabels.get(bobB) as string;

function mountWithProfiles(
  known: ReadonlyMap<string, { name: string }>,
  ensured: string[][] = [],
) {
  const profiles: ProfileQueries = {
    snapshot: () => known,
    subscribe: () => () => {},
    ensure: async (ids) => {
      ensured.push([...ids]);
    },
  };
  const staff = createStaff(backend, () => ({ relay, signer }));
  staff.ensure();
  return render(
    <ToastProvider>
      <ProfilesContext.Provider value={profiles}>
        <Entries staff={staff} />
      </ProfilesContext.Provider>
    </ToastProvider>,
  );
}
const twins = new Map([
  [bobA, { name: "Bob" }],
  [bobB, { name: "Bob" }],
]);

it("two people with the same name and short key stay distinct everywhere", async () => {
  expect(formatPublicKey(bobB)).toBe(short);
  expect(longA).not.toBe(longB);
  const byA = { ...report, reporterPubkey: bobA, target: bobA };
  const byB = { ...report, id: "r2", reporterPubkey: bobB, target: bobB };
  routes.listReports = () => ok([byA, byB]);
  routes.getReport = () =>
    ok({
      ...byA,
      message: {
        authorPubkey: bobB,
        content: "hi",
        createdAt: report.createdAt,
        deletedAt: null,
      },
    });
  routes.searchMembers = () =>
    ok({
      items: [bobA, bobB].map((pubkey) => ({
        pubkey,
        displayName: "Bob",
        nip05: null,
        avatarUrl: null,
      })),
    });
  routes.getMember = () =>
    ok({
      pubkey: bobB,
      profile: null,
      role: "member",
      banned: false,
      mutedUntil: null,
      isStaff: false,
    });
  mountWithProfiles(twins);

  // Reports list and detail.
  const cards = await screen.findAllByRole("button", { name: /spam/ });
  expect(cards[0]).toHaveTextContent(`reporter: Bob (${longA})`);
  expect(cards[1]).toHaveTextContent(`reporter: Bob (${longB})`);
  fireEvent.click(cards[0] as HTMLElement);
  await screen.findAllByRole("button", { name: "Preview Bob identity" });
  expect(screen.getAllByText(longA).length).toBeGreaterThan(0);
  expect(screen.getAllByText(longB).length).toBeGreaterThan(0);
  expect(screen.queryByText(short)).toBeNull();

  // Member search, the picked member and the confirm step keep the label.
  cleanup();
  mountWithProfiles(twins);
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  fireEvent.change(screen.getByLabelText("Member"), {
    target: { value: "Bob" },
  });
  const results = within(await screen.findByRole("listbox"));
  expect(results.getByRole("option", { name: `Bob (${longA})` })).toBeVisible();
  fireEvent.click(results.getByRole("option", { name: `Bob (${longB})` }));
  await screen.findByText("Role: member");
  expect(screen.getByText(`(${longB})`)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(
    await screen.findByRole("button", { name: "Confirm" }),
  ).toBeInTheDocument();
  // The picked member and the confirm step both carry the longer label.
  expect(screen.getAllByText(`(${longB})`)).toHaveLength(2);
  expect(screen.queryByText(`(${short})`)).toBeNull();
});

it("operator and restriction dialogs repeat the row's distinct label", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  routes.listOperators = () =>
    ok(
      [bobA, bobB].map((pubkey) => ({
        pubkey,
        effectiveRole: "moderator",
        sources: ["db"],
      })),
    );
  mountWithProfiles(twins);
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  expect(
    await screen.findByLabelText(`Role for Bob (${longA})`),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Remove" })[1] as HTMLElement,
  );
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    `Bob (${longB}) (moderator) loses relay staff access.`,
  );

  cleanup();
  routes.listRestrictions = () =>
    ok({
      items: [bobA, bobB].map((pubkey) => ({
        pubkey,
        banned: true,
        banExpiresAt: null,
        mutedUntil: null,
      })),
      nextCursor: null,
    });
  mountWithProfiles(twins);
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Restrictions" }));
  const lifts = await screen.findAllByRole("button", { name: "Lift ban" });
  fireEvent.click(lifts[0] as HTMLElement);
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    `Bob (${longA}) will be able to post`,
  );
});

it("a profile without a usable name shows only the short key", async () => {
  const malformed = "c".repeat(64);
  const kind0 = (pubkey: string, content: string) => ({
    id: pubkey,
    pubkey,
    created_at: 1,
    kind: 0,
    content,
    tags: [],
  });
  const known = foldProfiles([
    kind0(member, JSON.stringify({ about: "hello" })),
    kind0(malformed, "{not json"),
  ]);
  routes.listReports = () =>
    ok([{ ...report, target: malformed, targetKind: "pubkey" }]);
  routes.getReport = () =>
    ok({ ...report, target: malformed, targetKind: "pubkey" });
  mountWithProfiles(known);
  const card = await screen.findByRole("button", { name: /spam/ });
  expect(card).toHaveTextContent(
    `reporter: ${formatPublicKey(member)} · target: ${formatPublicKey(malformed)}`,
  );
  fireEvent.click(card);
  expect(
    await screen.findByRole("button", {
      name: `Preview ${formatPublicKey(member)} identity`,
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: `Preview ${formatPublicKey(malformed)} identity`,
    }),
  ).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(member.slice(0, 10));
  expect(document.body.textContent).not.toContain(malformed.slice(0, 10));
});

it("names say which community's profiles they come from", async () => {
  routes.listReports = () => ok([report]);
  mount();
  expect(
    await screen.findByText("Names come from profiles in team.example.com."),
  ).toBeInTheDocument();
});

it("a list fetches every unknown profile in one batch", async () => {
  const keys = Array.from({ length: 150 }, (_, i) =>
    i.toString(16).padStart(64, "f"),
  );
  routes.listReports = () =>
    ok(
      keys.map((key, i) => ({
        ...report,
        id: `r${i}`,
        reporterPubkey: key,
        target: key,
      })),
    );
  const ensured: string[][] = [];
  mountWithProfiles(new Map(), ensured);
  await screen.findAllByRole("button", { name: /spam/ });
  await waitFor(() => expect(ensured.length).toBeGreaterThan(0));
  expect(ensured).toHaveLength(1);
  expect(new Set(ensured[0])).toEqual(new Set(keys));
});

it("member search fetches every unknown result profile in one batch", async () => {
  const keys = ["a", "b", "c"].map((c) => c.repeat(64));
  routes.searchMembers = () =>
    ok({
      items: keys.map((pubkey) => ({
        pubkey,
        displayName: null,
        nip05: null,
        avatarUrl: null,
      })),
    });
  const ensured: string[][] = [];
  mountWithProfiles(new Map(), ensured);
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  fireEvent.change(screen.getByLabelText("Member"), {
    target: { value: "xy" },
  });
  await screen.findByRole("listbox");
  await waitFor(() =>
    expect(ensured.some((ids) => ids.includes(keys[0] as string))).toBe(true),
  );
  const search = ensured.filter((ids) => keys.some((k) => ids.includes(k)));
  expect(search).toHaveLength(1);
  expect(new Set(search[0])).toEqual(new Set(keys));
});

const feedbackFrom = (submitterPubkey: string, id = submitterPubkey) => ({
  id,
  communityId: "c1",
  communityHost: "team.example.com",
  submitterPubkey,
  status: "new",
  receivedAt: report.createdAt,
  bodySummary: "Hello",
});

async function openFeedbackList() {
  fireEvent.click(await screen.findByRole("tab", { name: "Feedback" }));
  return screen.findAllByRole("button", { name: /Hello/ });
}

it("feedback cards show the submitter by name and short key", async () => {
  routes.listFeedback = () => ok([feedbackFrom(member)]);
  mountWithProfiles(new Map([[member, { name: "Alice" }]]));
  const [card] = await openFeedbackList();
  expect(card).toHaveTextContent(
    `submitter: Alice (${formatPublicKey(member)})`,
  );
  expect(
    screen.getByText("Names come from profiles in team.example.com."),
  ).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(member.slice(0, 10));
});

it("same-name feedback submitters get distinct labels", async () => {
  routes.listFeedback = () => ok([feedbackFrom(bobA), feedbackFrom(bobB)]);
  mountWithProfiles(twins);
  const cards = await openFeedbackList();
  expect(cards[0]).toHaveTextContent(`submitter: Bob (${longA})`);
  expect(cards[1]).toHaveTextContent(`submitter: Bob (${longB})`);
});

it("feedback list fetches every unknown submitter in one batch", async () => {
  const keys = ["c", "d", "e"].map((c) => c.repeat(64));
  routes.listFeedback = () => ok(keys.map((key) => feedbackFrom(key)));
  const ensured: string[][] = [];
  mountWithProfiles(new Map(), ensured);
  await openFeedbackList();
  await waitFor(() =>
    expect(ensured.some((ids) => ids.includes(keys[0] as string))).toBe(true),
  );
  const batch = ensured.filter((ids) => keys.some((k) => ids.includes(k)));
  expect(batch).toHaveLength(1);
  expect(new Set(batch[0])).toEqual(new Set(keys));
});

/** The titles Settings would list, before any entry has opened. */
async function settingsTitles(staff: Staff) {
  await waitFor(() => expect(staff.visible()).not.toBe("pending"));
  return cards(staff, (node) => node)
    .filter((card) => card.visibility?.snapshot() === true)
    .map((card) => card.title);
}

it("opening Settings sends one probe and shows each role its entries before any entry opens", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  const operator = createStaff(backend, () => ({ relay, signer }));
  operator.ensure();
  expect(await settingsTitles(operator)).toEqual([
    "Reports",
    "Feedback",
    "Communities",
    "Staff",
  ]);
  expect(sent("probe")).toHaveLength(1);
  for (const card of cards(operator, (node) => node))
    expect(card.group).toBe("Moderation");

  routes.probe = () => probe();
  const moderator = createStaff(backend, () => ({ relay, signer }));
  moderator.ensure();
  expect(await settingsTitles(moderator)).toEqual([
    "Reports",
    "Feedback",
    "Communities",
  ]);

  routes.probe = () => fail({ category: "forbidden", status: 403 });
  const outsider = createStaff(backend, () => ({ relay, signer }));
  outsider.ensure();
  expect(await settingsTitles(outsider)).toEqual([]);
  expect(sent("probe")).toHaveLength(3);
});

it("every entry retaining visibility still sends a single probe", async () => {
  const staff = createStaff(backend, () => ({ relay, signer }));
  for (const card of cards(staff, (node) => node)) card.visibility?.ensure();
  await settingsTitles(staff);
  expect(sent("probe")).toHaveLength(1);
  // A relay update with the same identity and host is not a new check.
  staff.refresh();
  await settingsTitles(staff);
  expect(sent("probe")).toHaveLength(1);
});

it("a read-only relay shows the read-only entries but not Staff", async () => {
  routes.probe = () => probe({ authMode: "disabled", role: null });
  const staff = createStaff(backend, () => ({ relay, signer }));
  staff.ensure();
  expect(await settingsTitles(staff)).toEqual([
    "Reports",
    "Feedback",
    "Communities",
  ]);
});

it("a probe that fails reports an error, not hidden or shown", async () => {
  routes.probe = () =>
    fail({ category: "notSent", status: null, notSent: true });
  const staff = createStaff(backend, () => ({ relay, signer }));
  staff.ensure();
  await waitFor(() => expect(staff.visible()).toBe("error"));
  expect(staff.operatorVisible()).toBe("error");
});

it("no advertised admin host sends no probe and shows no entries", async () => {
  const none = createStaff({ ...backend, discover: async () => null }, () => ({
    relay,
    signer,
  }));
  none.ensure();
  await waitFor(() => expect(none.visible()).toBe(false));
  expect(await settingsTitles(none)).toEqual([]);
  expect(sent("probe")).toHaveLength(0);
});

it("opening Settings again re-probes, and a demotion removes the entries", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  const selection = { relay, signer };
  const staff = createStaff(backend, () => ({ ...selection }));
  const release = staff.ensure();
  expect(await settingsTitles(staff)).toContain("Staff");
  release();
  // Closed Settings sends nothing, even for another identity. A check would
  // start synchronously inside refresh(), so no wait is needed.
  selection.signer = member;
  staff.refresh();
  expect(sent("probe")).toHaveLength(1);
  selection.signer = signer;

  routes.probe = () => probe();
  const releaseAgain = staff.ensure();
  await waitFor(() => expect(staff.operatorVisible()).toBe(false));
  expect(sent("probe")).toHaveLength(2);
  expect(await settingsTitles(staff)).toEqual([
    "Reports",
    "Feedback",
    "Communities",
  ]);
  releaseAgain();

  routes.probe = () => fail({ category: "forbidden", status: 403 });
  staff.ensure();
  await waitFor(() => expect(staff.visible()).toBe(false));
  expect(sent("probe")).toHaveLength(3);
});

it("opening an entry after the Settings check sends no second probe", async () => {
  mount();
  await screen.findByText(/Connected as moderator/);
  fireEvent.click(await screen.findByRole("tab", { name: "Feedback" }));
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  await screen.findByRole("button", { name: /team\.example\.com/ });
  expect(sent("probe")).toHaveLength(1);
});

it("a report's community badge opens that community in the same entry, and Back returns", async () => {
  routes.listReports = () => ok([report]);
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  expect(
    await screen.findByRole("tab", { name: "Restrictions" }),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("tablist", { name: "Settings" })).getByRole("tab", {
      name: "Reports",
    }),
  ).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("button", { name: /spam/ })).toBeVisible();
  expect(
    screen.queryByRole("tab", { name: "Restrictions" }),
  ).not.toBeInTheDocument();
});

/** Probe responses released by the test, in the order it chooses. */
function heldProbes() {
  const pending: ((outcome: StaffOutcome<unknown>) => void)[] = [];
  routes.probe = () =>
    new Promise((resolve) => {
      pending.push(resolve);
    });
  return async (index: number, outcome: StaffOutcome<unknown>) => {
    await act(async () => pending[index]?.(outcome));
  };
}
const operatorProbe = () => probe({ role: "operator", canStaff: true });
const denied = () => fail({ category: "forbidden", status: 403 });

it("a newer role check wins over an older one that finishes later", async () => {
  const answer = heldProbes();
  const staff = createStaff(backend, () => ({ relay, signer }));
  const release = staff.ensure();
  await waitFor(() => expect(sent("probe")).toHaveLength(1));
  release();
  // Reopening re-reads the admin host first, then checks.
  staff.ensure();
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
  await answer(1, denied());
  expect(staff.visible()).toBe(false);
  await answer(0, operatorProbe());
  expect(staff.visible()).toBe(false);
  expect(staff.operatorVisible()).toBe(false);
});

it("a newer authorization is not hidden by an older denial", async () => {
  const answer = heldProbes();
  const staff = createStaff(backend, () => ({ relay, signer }));
  const release = staff.ensure();
  await waitFor(() => expect(sent("probe")).toHaveLength(1));
  release();
  staff.ensure();
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
  await answer(1, operatorProbe());
  expect(staff.operatorVisible()).toBe(true);
  await answer(0, denied());
  expect(staff.visible()).toBe(true);
  expect(staff.operatorVisible()).toBe(true);
});

it("relays sharing one admin host keep the newest role check", async () => {
  const answer = heldProbes();
  const selection = { relay, signer };
  const staff = createStaff(backend, () => ({ ...selection }));
  staff.ensure();
  await waitFor(() => expect(sent("probe")).toHaveLength(1));
  selection.relay = "wss://other.example.com";
  staff.refresh();
  await waitFor(() => expect(sent("probe")).toHaveLength(2));
  expect(contexts.map((c) => c.origin)).toEqual([origin, origin]);
  await answer(1, denied());
  await answer(0, operatorProbe());
  expect(staff.visible()).toBe(false);
});

/** An authorized session for the selected context, as an open entry has. */
async function authorizedSession(staff: Staff) {
  await waitFor(() => expect(staff.visible()).toBe(true));
  const context = staff.context();
  if (!context) throw new Error("no context");
  const access = staff.access(context);
  if (access?.state !== "authorized") throw new Error("not authorized");
  return createSession(staff, context, access.probe);
}
const reportsRead = { route: "listReports", query: { scope: "all" } } as const;
/** Reports reads whose response the test releases. */
function heldRead() {
  let answer: (outcome: StaffOutcome<unknown>) => void = () => {};
  routes.listReports = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  return (outcome: StaffOutcome<unknown>) => answer(outcome);
}

it("a 401 or 403 that arrives after Settings closes starts no role check", async () => {
  const answer = heldRead();
  const staff = createStaff(backend, () => ({ relay, signer }));
  const release = staff.ensure();
  const session = await authorizedSession(staff);
  const read = session.request(reportsRead);
  expect(sent("listReports")).toHaveLength(1);
  release();
  answer(denied());
  await read;
  expect(calls.map((c) => c.route)).toEqual(["probe", "listReports"]);
});

it("a 401 or 403 for a context that is no longer selected starts no role check for it", async () => {
  const answer = heldRead();
  const selection = { relay, signer };
  const staff = createStaff(backend, () => ({ ...selection }));
  staff.ensure();
  const session = await authorizedSession(staff);
  const read = session.request(reportsRead);
  expect(sent("listReports")).toHaveLength(1);
  selection.signer = member;
  staff.refresh();
  answer(denied());
  await read;
  expect(
    contexts.filter((_, i) => calls[i]?.route === "probe").map((c) => c.signer),
  ).toEqual([signer, member]);
});

const other = "d".repeat(64);
const restricted = (pubkey: string) => ({
  pubkey,
  banned: true,
  banExpiresAt: null,
  mutedUntil: null,
});
async function openRestrictions() {
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /team\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Restrictions" }));
}

it("while one lift is sending, every row's lift waits for it", async () => {
  routes.listRestrictions = () =>
    ok({ items: [restricted(member), restricted(other)], nextCursor: null });
  const lift = holdNext("liftRestriction", () => ok(null));
  mount();
  await openRestrictions();
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Lift ban" })).toHaveLength(2),
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "Lift ban" })[0] as HTMLElement,
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Lift ban",
    }),
  );
  try {
    await lift.started();
    for (const button of screen.getAllByRole("button", { name: "Lift ban" }))
      expect(button).toBeDisabled();
  } finally {
    await lift.release(ok(null));
  }
  await waitFor(() => {
    for (const button of screen.getAllByRole("button", { name: "Lift ban" }))
      expect(button).toBeEnabled();
  });
});

it("while one operator change is sending, every staff control waits for it", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  routes.listOperators = () =>
    ok(
      [member, other].map((pubkey) => ({
        pubkey,
        effectiveRole: "moderator",
        sources: ["db"],
      })),
    );
  const put = holdNext("putOperator", () => ok(null));
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  fireEvent.change(await screen.findByLabelText("Public key"), {
    target: { value: signer },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const controls = () => [
    ...screen.getAllByRole("button", { name: "Remove" }),
    ...screen.getAllByRole("combobox", { name: /Role/ }),
    screen.getByLabelText("Public key"),
  ];
  try {
    await put.started();
    for (const control of controls()) expect(control).toBeDisabled();
  } finally {
    await put.release(ok(null));
  }
  await waitFor(() => {
    for (const control of controls()) expect(control).toBeEnabled();
  });
});

it("a held resolve is released once the report has moved on, and a reopened report offers a fresh choice", async () => {
  let current: typeof report & { status: string } = report;
  routes.listReports = () => ok([current]);
  routes.getReport = () => ok(current);
  routes.resolveReport = () => fail({ category: "ambiguous", status: 502 });
  const { staff } = await (async () => {
    const mounted = mount();
    fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
    return mounted;
  })();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await screen.findByRole("button", { name: /Retry: Ban/ });
  const first = sent("resolveReport")[0] as { requestId: string };
  const held = () => {
    const context = staff.context();
    return context && staff.writes(context).get("resolve r1");
  };
  // The ban landed after all: the reloaded report reads resolved.
  current = { ...report, status: "resolved" };
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  await screen.findByRole("button", { name: "Reopen report" });
  await waitFor(() => expect(held()).toBeNull());
  // Someone reopens it: the form starts over under a new request id.
  current = report;
  routes.resolveReport = () => ok({ status: "resolved", activeAction: null });
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  const ban = await screen.findByRole("radio", { name: "Ban" });
  expect(ban).not.toBeChecked();
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  fireEvent.click(ban);
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(2));
  const second = sent("resolveReport")[1] as { requestId: string };
  expect(second.requestId).not.toBe(first.requestId);
});

it("an uncertain resolve can be discarded for a fresh choice", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  routes.resolveReport = () => fail({ category: "ambiguous", status: 502 });
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  expect(screen.getByRole("radio", { name: "Dismiss" })).toBeEnabled();
});

it("member search waits for typing to pause before sending one request", async () => {
  mount();
  await reopenActions();
  const input = await screen.findByLabelText("Member");
  vi.useFakeTimers();
  try {
    for (const value of ["B", "Bo", "Bob"])
      fireEvent.change(input, { target: { value } });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(sent("searchMembers")).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
  } finally {
    vi.useRealTimers();
  }
  await screen.findByRole("option", { name: /Bob/ });
  expect(sent("searchMembers")).toEqual([
    { route: "searchMembers", communityHost: "team.example.com", q: "Bob" },
  ]);
});

it("member search sends nothing for one character", async () => {
  mount();
  await reopenActions();
  const input = await screen.findByLabelText("Member");
  vi.useFakeTimers();
  try {
    fireEvent.change(input, { target: { value: "B" } });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(sent("searchMembers")).toHaveLength(0);
    fireEvent.change(input, { target: { value: "Bo" } });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
  } finally {
    vi.useRealTimers();
  }
  await screen.findByRole("option", { name: /Bob/ });
  expect(sent("searchMembers")).toEqual([
    { route: "searchMembers", communityHost: "team.example.com", q: "Bo" },
  ]);
});

it("Load more appends the next restrictions page, and a late page after a restart is dropped", async () => {
  let late: ((outcome: StaffOutcome<unknown>) => void) | null = null;
  routes.listRestrictions = (request) =>
    (request as { cursor?: string }).cursor
      ? new Promise((resolve) => {
          late = resolve;
        })
      : ok({ items: [restricted(member)], nextCursor: "p2" });
  routes.liftRestriction = () => ok(null);
  mount();
  await openRestrictions();
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await waitFor(() => expect(late).toBeTypeOf("function"));
  await act(async () =>
    late?.(ok({ items: [restricted(other)], nextCursor: null })),
  );
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Lift ban" })).toHaveLength(2),
  );
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

  // Lifting restarts the list; the page asked for before it must not land.
  cleanup();
  calls = [];
  late = null;
  mount();
  await openRestrictions();
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await waitFor(() => expect(late).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Lift ban" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Lift ban",
    }),
  );
  await waitFor(() =>
    expect(
      sent("listRestrictions").filter((r) => !("cursor" in r)),
    ).toHaveLength(2),
  );
  await screen.findByRole("button", { name: "Load more" });
  await act(async () =>
    late?.(ok({ items: [restricted(other)], nextCursor: null })),
  );
  expect(screen.getAllByRole("button", { name: "Lift ban" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Load more" })).toBeVisible();
});

it("Load more appends the next directory page, and a late page after a new search is dropped", async () => {
  const community = (host: string) => ({ id: host, host, icon: null });
  let late: ((outcome: StaffOutcome<unknown>) => void) | null = null;
  routes.listCommunities = (request) => {
    const { q, cursor } = request as { q?: string; cursor?: string };
    if (cursor)
      return new Promise((resolve) => {
        late = resolve;
      });
    if (q === "xe")
      return ok({ items: [community("x.example.com")], nextCursor: null });
    return ok({ items: [community("one.example.com")], nextCursor: "p2" });
  };
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await waitFor(() => expect(late).toBeTypeOf("function"));
  await act(async () =>
    late?.(ok({ items: [community("two.example.com")], nextCursor: null })),
  );
  expect(
    await screen.findByRole("button", { name: "two.example.com" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "one.example.com" })).toBeVisible();

  late = null;
  fireEvent.change(screen.getByLabelText("Search communities"), {
    target: { value: "" },
  });
  cleanup();
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await waitFor(() => expect(late).toBeTypeOf("function"));
  fireEvent.change(screen.getByLabelText("Search communities"), {
    target: { value: "xe" },
  });
  await screen.findByRole("button", { name: "x.example.com" });
  await act(async () =>
    late?.(ok({ items: [community("two.example.com")], nextCursor: null })),
  );
  expect(screen.queryByRole("button", { name: "two.example.com" })).toBeNull();
});

it("a failed read offers Retry beside the error, keeps focus on it, and recovers in place", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  routes.listOperators = () => fail({ message: "Staff list failed" });
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  await screen.findByText("Staff list failed");
  const again = holdNext("listOperators", () => ok([]));
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.focus();
  fireEvent.click(retry);
  try {
    await again.started();
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
    expect(retry).toHaveFocus();
  } finally {
    await again.release(fail({ message: "Still failing" }));
  }
  await screen.findByText("Still failing");
  expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No staff configured.")).toBeVisible();
});

it("a failed restrictions load can be retried in place", async () => {
  let failing = true;
  routes.listRestrictions = () =>
    failing
      ? fail({ message: "Restrictions failed" })
      : ok({ items: [restricted(member)], nextCursor: null });
  mount();
  await openRestrictions();
  await screen.findByText("Restrictions failed");
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Lift ban" })).toBeVisible();
  expect(screen.queryByText("Restrictions failed")).toBeNull();
});

it("Retry stops being busy when the same failure object comes back", async () => {
  routes.probe = () => probe({ role: "operator", canStaff: true });
  const same = fail({ message: "Staff list failed" });
  routes.listOperators = () => same;
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(sent("listOperators")).toHaveLength(2));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry" })).not.toHaveAttribute(
      "aria-busy",
      "true",
    ),
  );
  expect(screen.getByText("Staff list failed")).toBeVisible();
});

async function pickBob() {
  fireEvent.change(await screen.findByLabelText("Member"), {
    target: { value: "Bob" },
  });
  fireEvent.click(await screen.findByRole("option", { name: /Bob/ }));
}

it("a failed member lookup recovers with Retry in place", async () => {
  const found = routes.getMember as Handler;
  let failing = true;
  routes.getMember = (request) =>
    failing ? fail({ message: "Lookup failed" }) : found(request);
  mount();
  await reopenActions();
  await pickBob();
  await screen.findByText("Lookup failed");
  expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Role: member")).toBeVisible();
  expect(screen.queryByText("Lookup failed")).toBeNull();
  expect(screen.getByRole("button", { name: "Review" })).toBeEnabled();
});

it("a failed event lookup recovers with Retry in place", async () => {
  let failing = true;
  routes.getEvent = () =>
    failing
      ? fail({ message: "Lookup failed" })
      : ok({
          id: "e".repeat(64),
          authorPubkey: member,
          kind: 9,
          content: "the message",
          createdAt: "2026-01-01T00:00:00Z",
          deletedAt: null,
          channelId: null,
        });
  mount();
  await reopenActions();
  fireEvent.click(await screen.findByRole("radio", { name: "Delete message" }));
  fireEvent.change(screen.getByLabelText("Event id"), {
    target: { value: "e".repeat(64) },
  });
  await screen.findByText("Lookup failed");
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("the message")).toBeVisible();
  expect(screen.queryByText("Lookup failed")).toBeNull();
});

it("a failed member search recovers with Retry in place", async () => {
  const results = routes.searchMembers as Handler;
  let failing = true;
  routes.searchMembers = (request) =>
    failing ? fail({ message: "Search failed" }) : results(request);
  mount();
  await reopenActions();
  fireEvent.change(await screen.findByLabelText("Member"), {
    target: { value: "Bob" },
  });
  await screen.findByText("Search failed");
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry search" }));
  expect(await screen.findByRole("option", { name: /Bob/ })).toBeVisible();
  expect(screen.queryByText("Search failed")).toBeNull();
});

it("direct action validation errors sit on their fields and clear when corrected", async () => {
  mount();
  await reopenActions();
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  const memberField = await screen.findByLabelText("Member");
  await waitFor(() =>
    expect(memberField).toHaveAttribute("aria-invalid", "true"),
  );
  expect(memberField).toHaveAccessibleDescription(/Choose a member/);
  await pickBob();
  await screen.findByText("Role: member");

  fireEvent.click(screen.getByRole("radio", { name: "Time out member" }));
  const secs = screen.getByLabelText("Duration (seconds)");
  fireEvent.change(secs, { target: { value: "0" } });
  await waitFor(() => expect(secs).toHaveAttribute("aria-invalid", "true"));
  expect(secs).toHaveAccessibleDescription(/whole number of seconds/);
  fireEvent.change(secs, { target: { value: "60" } });
  await waitFor(() => expect(secs).not.toHaveAttribute("aria-invalid"));

  const reason = screen.getByLabelText("Reason (optional)");
  fireEvent.change(reason, { target: { value: `nsec1${"q".repeat(58)}` } });
  await waitFor(() => expect(reason).toHaveAttribute("aria-invalid", "true"));
  expect(reason).toHaveAccessibleDescription(/looks like a private key/);
  expect(reason).not.toHaveAccessibleDescription(/Sent verbatim/);
  fireEvent.change(reason, { target: { value: "spam" } });
  await waitFor(() => expect(reason).not.toHaveAttribute("aria-invalid"));

  fireEvent.click(screen.getByRole("radio", { name: "Delete message" }));
  const target = screen.getByLabelText("Event id");
  fireEvent.change(target, { target: { value: "nope" } });
  await waitFor(() => expect(target).toHaveAttribute("aria-invalid", "true"));
  expect(target).toHaveAccessibleDescription(/64-hex event id/);
  expect(sent("directAction")).toHaveLength(0);
});

/** First lookup on `route` fails; the held Retry fails again, then recovers. */
async function heldLookupRetry(
  route: StaffRequest["route"],
  open: () => Promise<void>,
  recovered: string,
) {
  const answer = routes[route] as Handler;
  routes[route] = () => fail({ message: "Lookup failed" });
  mount();
  await reopenActions();
  await open();
  await screen.findByText("Lookup failed");
  const again = holdNext(route, answer);
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.focus();
  fireEvent.click(retry);
  try {
    await again.started();
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
    expect(retry).toHaveFocus();
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
  } finally {
    await again.release(fail({ message: "Still failing" }));
  }
  await screen.findByText("Still failing");
  expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
  expect(retry).toHaveFocus();
  fireEvent.click(retry);
  expect(await screen.findByText(recovered)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
}

const eventFound = () =>
  ok({
    id: "e".repeat(64),
    authorPubkey: member,
    kind: 9,
    content: "the message",
    createdAt: "2026-01-01T00:00:00Z",
    deletedAt: null,
    channelId: null,
  });
async function typeEventId() {
  fireEvent.click(await screen.findByRole("radio", { name: "Delete message" }));
  fireEvent.change(screen.getByLabelText("Event id"), {
    target: { value: "e".repeat(64) },
  });
}

it("a held member lookup Retry keeps the same focused button through another failure", async () => {
  await heldLookupRetry("getMember", pickBob, "Role: member");
});

it("a held event lookup Retry keeps the same focused button through another failure", async () => {
  routes.getEvent = eventFound;
  await heldLookupRetry("getEvent", typeEventId, "the message");
});

it.each([
  ["member lookup", "getMember", pickBob, "Role: member", "Retry"],
  ["event lookup", "getEvent", typeEventId, "the message", "Retry"],
  [
    "member search",
    "searchMembers",
    async () => {
      fireEvent.change(await screen.findByLabelText("Member"), {
        target: { value: "Bob" },
      });
    },
    "Bob",
    "Retry search",
  ],
] as const)(
  "an unsupported %s offers Retry and recovers with the same input",
  async (_, route, open, recovered, button) => {
    if (route === "getEvent") routes.getEvent = eventFound;
    const answer = routes[route] as Handler;
    let missing = true;
    routes[route] = (request) => (missing ? routeMissing : answer(request));
    mount();
    await reopenActions();
    await open();
    const retry = await screen.findByRole("button", { name: button });
    expect(screen.getAllByText(/doesn't support/).length).toBeGreaterThan(0);
    // A search has no member yet, so only lookups block Review.
    if (route !== "searchMembers")
      expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
    missing = false;
    fireEvent.click(retry);
    expect(
      await screen.findByText(recovered, { exact: route !== "searchMembers" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: button })).toBeNull();
    expect(sent(route)).toHaveLength(2);
    expect(sent(route)[1]).toEqual(sent(route)[0]);
  },
);

it("Retry ends busy when its attempt settles the same failure before any loading render", async () => {
  const same = (fail({ message: "Same failure" }) as { failure: StaffFailure })
    .failure;
  function Harness() {
    const [settled, setSettled] = useState(1);
    // The rerun settles at once with the identical failure: no loading state.
    const retry = useRetry(same, settled, () => setSettled((n) => n + 1));
    return (
      <button type="button" aria-busy={retry.retrying} onClick={retry.retry}>
        Retry
      </button>
    );
  }
  render(<Harness />);
  const retry = screen.getByRole("button", { name: "Retry" });
  fireEvent.click(retry);
  expect(retry).toHaveAttribute("aria-busy", "false");
});

it("a fresh form after a successful action shows no field errors until Review", async () => {
  routes.directAction = () =>
    ok({ state: "succeeded", actionId: "done", replayed: false });
  mount();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  const memberField = await screen.findByLabelText("Member");
  await waitFor(() => expect(sent("directAction")).toHaveLength(1));
  expect(memberField).not.toHaveAttribute("aria-invalid");
  expect(memberField).not.toHaveAccessibleDescription(/Choose a member/);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() =>
    expect(memberField).toHaveAttribute("aria-invalid", "true"),
  );
});

/** Fails `route` once, then holds the Retry until `release`; later calls use `then`. */
function failThenHold(route: StaffRequest["route"], then: Handler) {
  let calls = 0;
  let release: ((outcome: StaffOutcome<unknown>) => void) | null = null;
  routes[route] = (request) => {
    calls += 1;
    if (calls === 1) return fail({ message: "Old failure" });
    if (calls === 2)
      return new Promise((resolve) => {
        release = resolve;
      });
    return then(request);
  };
  return {
    started: () => waitFor(() => expect(release).toBeTypeOf("function")),
    release: (outcome: StaffOutcome<unknown>) =>
      act(async () => release?.(outcome)),
  };
}

it("a held member search Retry ends when the query changes", async () => {
  const results = routes.searchMembers as Handler;
  let next: StaffOutcome<unknown> | null = null;
  const held = failThenHold(
    "searchMembers",
    (request) => next ?? results(request),
  );
  mount();
  await reopenActions();
  const field = await screen.findByLabelText("Member");
  fireEvent.change(field, { target: { value: "Ann" } });
  fireEvent.click(await screen.findByRole("button", { name: "Retry search" }));
  let b: ReturnType<typeof holdNext> | null = null;
  try {
    await held.started();
    next = fail({ message: "B failed" });
    b = holdNext("searchMembers", () => next as StaffOutcome<unknown>);
    fireEvent.change(field, { target: { value: "Bob" } });
    await b.started();
    expect(screen.queryByText("Old failure")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry search" })).toBeNull();
    await held.release(fail({ message: "Old failure" }));
    expect(screen.queryByText("Old failure")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry search" })).toBeNull();
    await b.release(fail({ message: "B failed" }));
    expect(await screen.findByText("B failed")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Retry search" }),
    ).not.toHaveAttribute("aria-busy", "true");
  } finally {
    await held.release(fail({ message: "released" }));
    await b?.release(fail({ message: "released" }));
  }
});

it("a held directory Retry ends when a secret key disables the search", async () => {
  const held = failThenHold("listCommunities", () =>
    ok({ items: [], nextCursor: null }),
  );
  const directory = routes.listCommunities as Handler;
  routes.listCommunities = (request) =>
    (request as { q?: string }).q
      ? ok({ items: [], nextCursor: null })
      : directory(request);
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Communities" }));
  // The pinned lookup and the directory share the route; fail only the directory.
  const retries = await screen.findAllByRole("button", { name: "Retry" });
  fireEvent.click(retries[retries.length - 1] as HTMLElement);
  try {
    await held.started();
    fireEvent.change(screen.getByLabelText("Search communities"), {
      target: { value: `nsec1${"q".repeat(58)}` },
    });
    expect(
      await screen.findByText(
        "That looks like a private key. Never paste it here.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Old failure")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await held.release(fail({ message: "Old failure" }));
    expect(screen.queryByText("Old failure")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  } finally {
    await held.release(fail({ message: "released" }));
  }
});

it("a held Reports Retry ends when the status filter changes", async () => {
  const held = failThenHold("listReports", () => ok([]));
  let filtered: ((outcome: StaffOutcome<unknown>) => void) | null = null;
  mount();
  await screen.findByText("Old failure");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  try {
    await held.started();
    routes.listReports = () =>
      new Promise((resolve) => {
        filtered = resolve;
      });
    fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
    // The Select commits a choice on pointer release, not on a bare click.
    const option = await screen.findByRole("option", { name: "resolved" });
    fireEvent.pointerDown(option);
    fireEvent.mouseDown(option);
    fireEvent.pointerUp(option);
    fireEvent.mouseUp(option);
    fireEvent.click(option);
    await waitFor(() => expect(filtered).toBeTypeOf("function"));
    expect(screen.queryByText("Old failure")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await held.release(fail({ message: "Old failure" }));
    expect(screen.queryByText("Old failure")).toBeNull();
    await act(async () => filtered?.(ok([report])));
    expect(await screen.findByRole("button", { name: /spam/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  } finally {
    await held.release(fail({ message: "released" }));
    await act(async () => filtered?.(ok([])));
  }
});

/**
 * A read for `id` whose Retry and a scope change land in one React batch.
 * The first read fails; every later read is held until the test releases it.
 */
async function batchedRetry(next: string | null) {
  const staff = createStaff(backend, () => ({ relay, signer }));
  staff.ensure();
  const session = await authorizedSession(staff);
  const held: ((outcome: StaffOutcome<unknown>) => void)[] = [];
  routes.getReport = () =>
    held.length === 0 && sent("getReport").length === 1
      ? fail({ message: "Old failure" })
      : new Promise((resolve) => {
          held.push(resolve);
        });
  function Harness() {
    const [id, setId] = useState<string | null>("a");
    const [read, reload] = useRead(id ? { route: "getReport", id } : null, [
      id,
    ]);
    const retry = useRetry(
      read.state === "failed" ? read.failure : null,
      read.settled,
      reload,
    );
    return (
      <>
        {retry.failure && <p>{retry.failure.message}</p>}
        <output aria-label="Read state">{read.state}</output>
        <button
          type="button"
          aria-busy={retry.retrying}
          onClick={() => {
            retry.retry();
            setId(next);
          }}
        >
          Retry and switch
        </button>
      </>
    );
  }
  render(
    <SessionProvider value={session}>
      <Harness />
    </SessionProvider>,
  );
  await screen.findByText("Old failure");
  fireEvent.click(screen.getByRole("button", { name: "Retry and switch" }));
  return {
    held,
    release: () =>
      act(async () => {
        for (const resolve of held) resolve(fail({ message: "Old failure" }));
      }),
  };
}

it("a Retry batched with a query change ends with the old scope", async () => {
  const { held, release } = await batchedRetry("b");
  try {
    // B's request is the replacement in flight; A's Retry never started.
    await waitFor(() => expect(held).toHaveLength(1));
    expect(sent("getReport").at(-1)).toMatchObject({ id: "b" });
    expect(screen.queryByText("Old failure")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Retry and switch" }),
    ).toHaveAttribute("aria-busy", "false");
  } finally {
    await release();
  }
});

it("a Retry batched with disabling the read ends with the old scope", async () => {
  const { release } = await batchedRetry(null);
  try {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Retry and switch" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(screen.queryByText("Old failure")).toBeNull();
    // A disabled read no longer carries the old failure for ungated callers.
    expect(screen.getByLabelText("Read state")).not.toHaveTextContent("failed");
    expect(sent("getReport")).toHaveLength(1);
  } finally {
    await release();
  }
});

it("a held delete or timeout keeps its own fields after the card remounts", async () => {
  routes.getEvent = () =>
    ok({
      id: "e".repeat(64),
      authorPubkey: member,
      kind: 9,
      content: "the message",
      createdAt: "2026-01-01T00:00:00Z",
      deletedAt: null,
      channelId: null,
    });
  const { reopen } = mountSwitchable();
  const del = holdNext("directAction", () => ok({ state: "pending" }));
  await reopenActions();
  fireEvent.click(await screen.findByRole("radio", { name: "Delete message" }));
  fireEvent.change(screen.getByLabelText("Event id"), {
    target: { value: "e".repeat(64) },
  });
  await screen.findByText("the message");
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await del.started();
  reopen();
  await reopenActions();
  try {
    expect(
      await screen.findByRole("radio", { name: "Delete message" }),
    ).toBeChecked();
    expect(screen.getByLabelText("Event id")).toHaveValue("e".repeat(64));
    expect(screen.queryByLabelText("Member")).toBeNull();
  } finally {
    await del.release(
      ok({ state: "succeeded", actionId: "d", replayed: false }),
    );
  }

  const timeout = holdNext("directAction", () => ok({ state: "pending" }));
  await screen.findByRole("button", { name: "Review" });
  fireEvent.click(screen.getByRole("radio", { name: "Time out member" }));
  fireEvent.change(screen.getByLabelText("Member"), {
    target: { value: "Bob" },
  });
  fireEvent.click(await screen.findByRole("option", { name: /Bob/ }));
  await screen.findByText("Role: member");
  fireEvent.change(screen.getByLabelText("Duration (seconds)"), {
    target: { value: "600" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await timeout.started();
  reopen();
  await reopenActions();
  try {
    expect(
      await screen.findByRole("radio", { name: "Time out member" }),
    ).toBeChecked();
    expect(screen.getByLabelText("Duration (seconds)")).toHaveValue(600);
    expect(screen.queryByLabelText("Event id")).toBeNull();
  } finally {
    await timeout.release(
      ok({ state: "succeeded", actionId: "t", replayed: false }),
    );
  }
});

type ResolveSent = Extract<StaffRequest, { route: "resolveReport" }>;
const ambiguous = fail({
  category: "ambiguous",
  status: null,
  bodyComplete: false,
  message: "",
});

it("a failed resolve shows its error beside Retry", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  routes.resolveReport = () => ambiguous;
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  await screen.findByRole("button", { name: /Retry: Ban/ });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The relay did not confirm the result.",
  );
});

it("an uncertain resolve that landed reloads the report and is released", async () => {
  let landed = false;
  routes.listReports = () => ok([report]);
  routes.getReport = () =>
    ok(landed ? { ...report, status: "resolved" } : report);
  routes.resolveReport = () => {
    landed = true;
    return ambiguous;
  };
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Ban" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Ban/ }));
  expect(
    await screen.findByRole("button", { name: "Reopen report" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  // Reopened elsewhere: a fresh choice, not the old request id.
  landed = false;
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  fireEvent.click(await screen.findByRole("radio", { name: "Dismiss" }));
  expect(
    screen.getByRole("button", { name: /Confirm: Dismiss/ }),
  ).toBeEnabled();
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
});

it("a held reopen offers Discard and shows its error", async () => {
  const resolved = { ...report, status: "resolved" };
  routes.listReports = () => ok([resolved]);
  routes.getReport = () => ok(resolved);
  routes.reopenReport = () => ambiguous;
  await openReport();
  fireEvent.click(await screen.findByRole("button", { name: "Reopen report" }));
  await screen.findByRole("button", { name: "Retry reopen" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The relay did not confirm the result.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(
    await screen.findByRole("button", { name: "Reopen report" }),
  ).toBeVisible();
});

it("a held reopen is released once the report is open again", async () => {
  let status = "resolved";
  routes.listReports = () => ok([{ ...report, status }]);
  routes.getReport = () => ok({ ...report, status });
  routes.reopenReport = () => {
    status = "open";
    return ambiguous;
  };
  await openReport();
  fireEvent.click(await screen.findByRole("button", { name: "Reopen report" }));
  // The failure reloads the report, which shows it landed.
  await screen.findByRole("radio", { name: "Ban" });
  // Resolved again elsewhere: Reopen starts fresh instead of replaying.
  status = "resolved";
  fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
  fireEvent.click(await screen.findByRole("button", { name: /spam/ }));
  expect(
    await screen.findByRole("button", { name: "Reopen report" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry reopen" })).toBeNull();
});

it("a retried reopen that landed before a re-resolve does not claim the report is open", async () => {
  const resolved = { ...report, status: "resolved" };
  routes.listReports = () => ok([resolved]);
  routes.getReport = () => ok(resolved);
  let first = true;
  routes.reopenReport = () => {
    if (!first) return ok({ status: "open" });
    first = false;
    // The reopen lands, its answer is lost, and another moderator resolves
    // the report before our reload sees it open.
    return ambiguous;
  };
  await openReport();
  fireEvent.click(await screen.findByRole("button", { name: "Reopen report" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry reopen" }));
  expect(
    await screen.findByText(
      "Your reopen went through, but the report has since been resolved.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("Report reopened")).toBeNull();
  expect(
    await screen.findByRole("button", { name: "Reopen report" }),
  ).toBeVisible();
});

it("a reopen confirmation survives a failed reload", async () => {
  let status = "resolved";
  let failReads = 0;
  routes.listReports = () => ok([{ ...report, status }]);
  routes.getReport = () =>
    failReads-- > 0
      ? fail({ category: "rejected", status: 500 })
      : ok({ ...report, status });
  routes.reopenReport = () => {
    status = "open";
    failReads = 1;
    return ok({ status: "open" });
  };
  await openReport();
  fireEvent.click(await screen.findByRole("button", { name: "Reopen report" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Report reopened")).toBeInTheDocument();
  await screen.findByRole("radio", { name: "Ban" });
  expect(screen.getAllByText("Report reopened")).toHaveLength(1);
});

it("an uncertain Dismiss asks for a fresh decision instead of a held Retry", async () => {
  routes.listReports = () => ok([report]);
  routes.getReport = () => ok(report);
  routes.resolveReport = () => ambiguous;
  await openReport();
  fireEvent.click(await screen.findByRole("radio", { name: "Dismiss" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Dismiss/ }));
  expect(
    await screen.findByText(
      "The relay did not confirm the result. Check the report and decide again.",
    ),
  ).toBeInTheDocument();
  await waitFor(() => expect(sent("getReport").length).toBeGreaterThan(1));
  // The reloaded report shows a fresh form: nothing is resent until the
  // user decides again.
  fireEvent.click(await screen.findByRole("radio", { name: "Dismiss" }));
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  expect(sent("resolveReport")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /Confirm: Dismiss/ }));
  await waitFor(() => expect(sent("resolveReport")).toHaveLength(2));
  const [a, b] = sent("resolveReport") as ResolveSent[];
  expect(a?.requestId).not.toBe(b?.requestId);
});

it("a direct-action error shows only on the community it was sent to", async () => {
  routes.listCommunities = () =>
    ok({
      items: [
        { id: "c1", host: "team.example.com", icon: null },
        { id: "c2", host: "other.example.com", icon: null },
      ],
      nextCursor: null,
    });
  routes.directAction = () =>
    fail({ status: 409, code: "target_is_staff", message: "" });
  mount();
  await openCommunityActions();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByText(/Relay staff can't be banned/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /other\.example\.com/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
  await screen.findByLabelText("Member");
  expect(screen.queryByText(/Relay staff can't be banned/)).toBeNull();
});

it("opening Settings again re-reads the advertised admin host", async () => {
  let advertised = origin;
  const local = { ...backend, discover: async () => advertised };
  const staff = createStaff(local, () => ({ relay, signer }));
  const release = staff.ensure();
  await waitFor(() => expect(staff.visible()).toBe(true));
  release();
  advertised = "https://admin2.example.com";
  staff.ensure();
  await waitFor(() =>
    expect(staff.context()?.origin).toBe("https://admin2.example.com"),
  );
  await waitFor(() => expect(contexts.at(-1)?.origin).toBe(advertised));
  expect(sent("probe")).toHaveLength(2);
});

it("reopening Settings checks only after the fresh admin-host lookup", async () => {
  const moved = "https://admin2.example.com";
  let answer = (_origin: string) => {};
  let advertised: Promise<string> = Promise.resolve(origin);
  const local = { ...backend, discover: () => advertised };
  const staff = createStaff(local, () => ({ relay, signer }));
  const open = () =>
    cards(staff, (node) => node).map((card) => card.visibility?.ensure());
  const close = (releases: ReturnType<typeof open>) => {
    for (const release of releases) release?.();
  };
  const first = open();
  await waitFor(() => expect(staff.visible()).toBe(true));
  close(first);
  calls = [];
  contexts = [];
  advertised = new Promise((resolve) => {
    answer = resolve;
  });
  open();
  staff.refresh();
  await act(async () => {});
  expect(sent("probe")).toHaveLength(0);
  await act(async () => answer(moved));
  await waitFor(() => expect(sent("probe")).toHaveLength(1));
  expect(contexts.map((c) => c.origin)).toEqual([moved]);
});

it("a gateway sign-in page on the role check is unreachable, not denied", async () => {
  routes.probe = () =>
    fail({ category: "intercepted", status: 401, message: "" });
  const staff = createStaff(backend, () => ({ relay, signer }));
  staff.ensure();
  await waitFor(() => expect(staff.visible()).toBe("error"));
  const context = staff.context();
  expect(context && staff.access(context)?.state).toBe("unreachable");
});
