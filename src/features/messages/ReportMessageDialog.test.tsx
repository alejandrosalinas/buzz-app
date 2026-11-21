// @vitest-environment jsdom
import "../../../tests/sonner-dom";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createRelaySession } from "../relay/session";
import { PublishRejected } from "../relay/outbox";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import {
  keypair,
  message,
  roster,
  completeHeads,
  flush,
  scriptedTransport,
  signed,
} from "../relay/testing";
import { MessageRow } from "./MessageRow";
import { ConversationPresentation } from "../conversation/ConversationPresentation";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const root = message(other, "c", "Report me", 1);
const owners: { dispose(): void }[] = [];

let focusedAtRelease: Element | null = null;
const release = vi.fn(() => {
  focusedAtRelease = document.activeElement;
});
const keepMounted = vi.fn((_id: string) => release);
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  for (const owner of owners.splice(0)) owner.dispose();
  await waitFor(() =>
    expect(release).toHaveBeenCalledTimes(keepMounted.mock.calls.length),
  );
  focusedAtRelease = null;
  release.mockClear();
  keepMounted.mockClear();
});

async function mount(publish: (event: RelayEvent) => Promise<void>) {
  let live: LiveCallbacks | undefined;
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live?.receive([roster(relay, "c", [viewer.pubkey], 1), root]);
  completeHeads(wire, relay, [root]);
  await flush();
  const row = owner.session.channels.window("c").rows[0];
  if (!row) throw new Error("Missing row");
  const tree = (active: boolean) => (
    <ConversationPresentation value={active}>
      <div hidden={!active} inert={!active}>
        <MessageRow
          row={row}
          session={owner.session}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
          keepMounted={keepMounted}
        />
      </div>
    </ConversationPresentation>
  );
  const view = render(tree(true), { wrapper: ToastProvider });
  return { present: (active: boolean) => view.rerender(tree(active)) };
}

it("keeps coarse-pointer entry on the dialog until a reason is chosen", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: media === "(pointer: coarse)",
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
  const publish = vi.fn(async () => {});
  const user = userEvent.setup();
  await mount(publish);
  await user.click(
    screen.getByRole("button", { name: "More message actions" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Report" }));
  const dialog = await screen.findByRole("dialog", { name: "Report message" });
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  const reason = screen.getByRole("radio", { name: "Spam" });
  expect(reason.getAttribute("aria-checked")).toBe("false");
  await user.click(reason);
  expect(reason.getAttribute("aria-checked")).toBe("true");
  expect(publish).not.toHaveBeenCalled();
});

it("reports from the message menu, keeps input after failure and confirms success", async () => {
  const user = userEvent.setup();
  let settle!: (error?: Error) => void;
  const publish = vi.fn(
    (_event: RelayEvent) =>
      new Promise<void>((resolve, reject) => {
        settle = (error) => (error ? reject(error) : resolve());
      }),
  );
  await mount(publish);
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Report" }));
  const dialog = await screen.findByRole("dialog", { name: "Report message" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Spam" }),
    ),
  );
  // A virtualized list must not evict the row owning the draft and outcome.
  expect(keepMounted.mock.calls).toEqual([[root.id]]);
  const submit = screen.getByRole("button", { name: "Submit report" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  await user.click(screen.getByRole("radio", { name: "Spam" }));
  await user.type(
    screen.getByRole("textbox", { name: "Additional context (optional)" }),
    "repeated links",
  );
  await user.click(submit);
  await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  expect(submit.getAttribute("aria-busy")).toBe("true");
  expect(
    screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
  ).toBe(true);
  settle(new PublishRejected("blocked"));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Failed to submit report",
  );
  expect(dialog.isConnected).toBe(true);
  expect(
    (
      screen.getByRole("textbox", {
        name: "Additional context (optional)",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("repeated links");
  await user.click(submit);
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
  expect(publish.mock.calls[1]?.[0]).toMatchObject({
    kind: 1984,
    content: "repeated links",
    tags: [
      ["p", other.pubkey],
      ["e", root.id, "spam"],
    ],
  });
  settle();
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Report message" })).toBeNull(),
  );
  expect(
    await screen.findByText("Report submitted to community moderators"),
  ).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(release).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /dismiss/i }));
  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(keepMounted).toHaveBeenCalledOnce();
});

it("starts each report with an empty form", async () => {
  const user = userEvent.setup();
  await mount(async () => {});
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Report" }));
  await user.click(await screen.findByRole("radio", { name: "Other" }));
  expect(keepMounted.mock.calls).toEqual([[root.id]]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Report message" })).toBeNull(),
  );
  // Restored focus must reach the row before its pin is released.
  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(focusedAtRelease).toBe(trigger);
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Report" }));
  expect(
    (
      (await screen.findByRole("radio", { name: "Other" })) as HTMLElement
    ).getAttribute("aria-checked"),
  ).toBe("false");
});

it.each([
  "success",
  "success while hidden",
  "failure while hidden",
  "failure after recovery",
] as const)(
  "retains a suspended report operation without reopening or duplicating it: %s",
  async (outcome) => {
    const user = userEvent.setup();
    let settle!: (error?: Error) => void;
    const publish = vi.fn(
      (_event: RelayEvent) =>
        new Promise<void>((resolve, reject) => {
          settle = (error) => (error ? reject(error) : resolve());
        }),
    );
    const h = await mount(publish);
    const openMenu = async () => {
      await user.click(
        screen.getByRole("button", { name: "More message actions" }),
      );
      return screen.findByRole("menuitem", { name: "Report" });
    };
    await user.click(await openMenu());
    await user.click(await screen.findByRole("radio", { name: "Spam" }));
    await user.type(screen.getByRole("textbox"), "retained submitted note");
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    try {
      h.present(false);
      // Portal removal is synchronous, not the dialog's animated close.
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      expect(release).not.toHaveBeenCalled();
      if (outcome.endsWith("while hidden")) {
        await act(async () =>
          settle(
            outcome === "success while hidden"
              ? undefined
              : new PublishRejected("blocked"),
          ),
        );
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(
          screen.queryByText("Report submitted to community moderators"),
        ).toBeNull();
      }
      h.present(true);
      expect(
        screen.queryByRole("dialog", { name: "Report message", hidden: true }),
      ).toBeNull();
      if (outcome !== "success while hidden") {
        const reportItem = await openMenu();
        expect(reportItem.getAttribute("aria-disabled")).toBe("true");
        await user.click(reportItem);
        await user.keyboard("{Escape}");
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      }
      expect(publish).toHaveBeenCalledOnce();
      if (!outcome.endsWith("while hidden")) {
        expect(screen.getByRole("status").textContent).toContain(
          "Submitting report",
        );
        await act(async () =>
          settle(
            outcome === "success" ? undefined : new PublishRejected("blocked"),
          ),
        );
      }
      if (outcome.startsWith("failure")) {
        expect((await screen.findByRole("alert")).textContent).toContain(
          "Failed to submit report",
        );
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(release).not.toHaveBeenCalled();
        h.present(false);
        expect(screen.queryByRole("alert")).toBeNull();
        h.present(true);
        expect((await screen.findByRole("alert")).textContent).toContain(
          "Failed to submit report",
        );
        await user.click(screen.getByRole("button", { name: "Review report" }));
        await screen.findByRole("dialog", { name: "Report message" });
        expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
          "retained submitted note",
        );
        expect(
          screen
            .getByRole("radio", { name: "Spam" })
            .getAttribute("aria-checked"),
        ).toBe("true");
        await user.click(screen.getByRole("button", { name: "Submit report" }));
        await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
        expect(publish.mock.calls[1]?.[0]).toMatchObject({
          kind: 1984,
          content: "retained submitted note",
          tags: [
            ["p", other.pubkey],
            ["e", root.id, "spam"],
          ],
        });
        await act(async () => settle());
      }
      expect(
        await screen.findByText("Report submitted to community moderators"),
      ).toBeTruthy();
      expect(
        screen.getAllByText("Report submitted to community moderators"),
      ).toHaveLength(1);
      expect(keepMounted).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      await user.click(await openMenu());
      await screen.findByRole("dialog", { name: "Report message" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "",
      );
      await user.type(screen.getByRole("textbox"), "new unsubmitted note");
      await act(async () => {});
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "new unsubmitted note",
      );
      expect(publish).toHaveBeenCalledTimes(
        outcome.startsWith("success") ? 1 : 2,
      );
    } finally {
      await act(async () => settle());
    }
  },
);
