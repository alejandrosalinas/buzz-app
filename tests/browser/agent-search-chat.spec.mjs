import { test, expect } from "./fixture.mjs";

const earlier = "33333333-3333-4333-8333-333333333333";
// A chat with the agent whose name does not match the search.
const launch = "44444444-4444-4444-8444-444444444444";
test.use({
  productionBroker: true,
  channelIds: [earlier, launch],
  channelNames: {
    [earlier]: "Earlier with Honey",
    [launch]: "Plan the launch",
  },
  soloChannels: [earlier, launch],
  ownSoloChannels: [earlier, launch],
  historyCounts: { [earlier]: 1, [launch]: 1 },
  soloAgentNames: ["Owned Honey"],
});

test("search opens a new Solo chat with one of the viewer's agents", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  // The same unproven ordering mitigation for the WebKit lost-fill failure as
  // the public search destination test in global-search.spec.mjs, which waits
  // for a rendered conversation. This page opens none, so wait for the
  // sidebar's Solo chats instead.
  await expect(
    page
      .getByRole("navigation", { name: "Subscribed channels" })
      .getByRole("button", { name: "Earlier with Honey", exact: true }),
  ).toBeVisible();
  // Navigation load can finish before React mounts the shell shortcut owner.
  const search = page.getByRole("button", { name: "Search Buzz", exact: true });
  await search.focus();
  await expect(search).toBeFocused();
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+k`);
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  await input.fill("honey");
  // fill() selects in the page, then inserts over the protocol; a rare WebKit
  // run has shown an empty palette afterwards. Fail here, not on the results.
  await expect(input).toHaveValue("honey");
  // Result groups are listboxes, or grids when rows carry controls.
  const result = (group, name) =>
    dialog
      .getByRole("group", { name: group })
      .getByRole("option", { name })
      .or(
        dialog
          .getByRole("rowgroup", { name: group })
          .getByRole("row", { name }),
      );
  const choice = result("Agents", /Owned Honey/);
  await expect(choice).toContainText("New chat");
  // The agent's chats follow, in Chats, whether or not their names match.
  await expect(result("Chats", /Earlier with Honey/)).toContainText("Chat");
  await expect(result("Chats", /Plan the launch/)).toContainText(
    "Chat with Owned Honey",
  );
  await expect(
    dialog.locator('[role="group"], [role="rowgroup"]').first(),
  ).toHaveAccessibleName("Agents");
  await page.screenshot({ path: testInfo.outputPath("search.png") });
  await choice.click();
  await expect(dialog).toHaveCount(0);
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(composer).toBeFocused();
  // The new chat starts addressed to the chosen agent, in the composer's pill.
  const [agent] = app.soloAgents;
  await expect(
    page.getByRole("button", {
      name: `Sending to ${agent.name}. Change agents`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(composer).toHaveText("");
  // This browser fixture cannot start Solo chats (it says so below the
  // composer). SoloDraft tests cover the first message.
  await page.screenshot({
    path: testInfo.outputPath("chat.png"),
    clip: { x: 0, y: 0, width: 1440, height: 905 },
  });
});
