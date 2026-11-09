import { test, expect } from "./fixture.mjs";
import { open, end, settle } from "./timeline.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 40, beta: 1 },
});

// Real browser geometry, virtualizer ownership, and native focus cannot be
// established by DOM-emulator tests.
for (const inThread of [false, true]) {
  test(`incoming activity follows the bottom and retains focus through append (${inThread ? "thread" : "channel"})`, async ({
    page,
    app,
  }) => {
    const key = generateSecretKey();
    const pubkey = getPublicKey(key);
    await page.route("**/agent-library", (route) =>
      route.fulfill({
        json: {
          definitions: [],
          identities: [{ pubkey, name: "Working agent" }],
        },
      }),
    );
    app.serveProfile(key, { name: "Working agent", is_agent: true });
    await open(page, app);
    const root = app.append("primary", "alpha", "Activity lifecycle request");
    let history = page.getByRole("region", { name: "Channel message history" });
    if (inThread) {
      const row = history.locator(`[data-message-id="${root.id}"]`);
      await hoverMessage(row);
      await row.getByRole("button", { name: "Reply", exact: true }).click();
      history = page.getByRole("region", { name: "Thread messages" });
      for (let i = 0; i < 25; i++)
        app.append(
          "primary",
          "alpha",
          `Earlier reply ${i}\n\nDetails for this reply.`,
          true,
          true,
          root.id,
        );
      await expect(
        history.getByText("Earlier reply 24", { exact: false }),
      ).toBeVisible();
      await history.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event("scroll"));
      });
    } else await end(page);
    await settle(page, history);
    const tags = [
      ["h", "alpha"],
      ...(inThread
        ? [
            ["e", root.id, "", "root"],
            ["e", root.id, "", "reply"],
          ]
        : []),
    ];
    let timestamp = Math.floor(Date.now() / 1000);
    const publish = (kind, content, extra = []) => {
      timestamp =
        kind === 20002
          ? Math.floor(Date.now() / 1000)
          : Math.max(timestamp + 1, Math.floor(Date.now() / 1000) + 2);
      return app.relay.publish(
        "primary",
        finalizeEvent(
          {
            kind,
            content,
            tags: [...tags, ...extra],
            created_at: timestamp,
          },
          key,
        ),
      );
    };
    publish(20002, "");
    const trigger = history.getByRole("button", {
      name: "Activity: Working agent working",
    });
    await expect(trigger).toBeVisible();
    await expect
      .poll(() =>
        history.evaluate((el) =>
          el.querySelector("[data-conversation-activity]")
            ? el.scrollHeight - el.clientHeight - el.scrollTop
            : Number.POSITIVE_INFINITY,
        ),
      )
      .toBeLessThan(2);
    if (!inThread) {
      const tailHeight = await history
        .locator("[data-conversation-activity]")
        .evaluate((el) => el.getBoundingClientRect().height);
      const editor = page.getByRole("textbox", {
        name: "Message #Alpha",
        exact: true,
      });
      await editor.fill("Sending while the agent is working");
      await editor.press("Enter");
      await expect(
        history.getByText("Sending while the agent is working", {
          exact: true,
        }),
      ).toBeVisible();
      await expect
        .poll(() =>
          history.evaluate((el) =>
            el.querySelector("[data-conversation-activity]")
              ? el.scrollHeight - el.clientHeight - el.scrollTop
              : Number.POSITIVE_INFINITY,
          ),
        )
        .toBeLessThan(2);
      expect(
        await history
          .locator("[data-conversation-activity]")
          .evaluate((el) => el.getBoundingClientRect().height),
      ).toBe(tailHeight);
    }
    await trigger.focus();
    const original = await trigger.elementHandle();
    app.append(
      "primary",
      "alpha",
      "Another person adds a message",
      true,
      true,
      inThread ? root.id : undefined,
    );
    await expect(
      history.getByText("Another person adds a message", { exact: true }),
    ).toBeVisible();
    await expect(trigger).toBeFocused();
    expect(await original.evaluate((el) => el.isConnected)).toBe(true);

    publish(9, "Checking the lifecycle", [["audience", "agents"]]);
    const disclosure = history.getByRole("button", {
      name: /Show activity history:.*Checking the lifecycle/,
    });
    await expect(disclosure).toBeVisible();
    await expect
      .poll(() =>
        history.evaluate(
          (el) =>
            el.contains(document.activeElement) &&
            document.activeElement !== document.body,
        ),
      )
      .toBe(true);
    await disclosure.click();
    const collapse = history.getByRole("button", {
      name: /Collapse activity history/,
    });
    await collapse.focus();
    publish(9, "Completed lifecycle work");
    await expect(
      history.getByText("Completed lifecycle work", { exact: true }),
    ).toBeVisible();
    // A public reply retires the live treatment, not the expanded history.
    await expect(collapse).toBeVisible();
    await expect(collapse).toBeFocused();
    await collapse.click();
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toBeFocused();
    await disclosure.click();
    await expect(collapse).toBeVisible();
  });
}
