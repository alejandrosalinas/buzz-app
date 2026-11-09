import { test, expect } from "./source-fixture.mjs";

// Real hit testing and grid geometry are required: jsdom cannot prove the live
// preview, pointer tracking, or that embedded controls stay outside the gesture.
test("holding an agent previews a move, cancels cleanly, and saves only on drop", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/tests/fixtures/agent-library.html?reorder");
  const grid = page.getByRole("grid", { name: "Agents", exact: true });
  const cards = grid.locator('[role="gridcell"]');
  const order = () =>
    cards.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label")),
    );
  await expect.poll(order).toEqual(["Ada", "Bo", "Cy"]);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const ada = grid.getByRole("gridcell", { name: "Ada", exact: true });
  const cy = grid.getByRole("gridcell", { name: "Cy", exact: true });
  const start = await ada.boundingBox();
  const end = await cy.boundingBox();
  if (!start || !end) throw new Error("Cards must have layout");
  const press = async () => {
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 3,
    );
    await page.mouse.down();
    await page.clock.runFor(249);
    await expect(page.locator("[data-dragging]")).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(page.locator("[data-dragging]")).toHaveCount(1);
  };
  await press();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 3, {
    steps: 8,
  });
  await expect.poll(order).toEqual(["Bo", "Cy", "Ada"]);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(order).toEqual(["Ada", "Bo", "Cy"]);
  await page.clock.runFor(300);
  // dnd-kit's Web Animation uses real time, not the installed test clock.
  await expect(
    page.locator('[aria-hidden="true"]').getByText("Ada", { exact: true }),
  ).toHaveCount(0);
  await press();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 3, {
    steps: 8,
  });
  await expect.poll(order).toEqual(["Bo", "Cy", "Ada"]);
  await page.mouse.up();
  await page.clock.runFor(300);
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await page.reload();
  await expect.poll(order).toEqual(["Bo", "Cy", "Ada"]);
  // Holding the model button must not pick the card up.
  const model = ada.getByRole("combobox", { name: "Model", exact: true });
  const button = await model.boundingBox();
  if (!button) throw new Error("Model button must have layout");
  await page.mouse.move(
    button.x + button.width / 2,
    button.y + button.height / 2,
  );
  await page.mouse.down();
  await page.clock.runFor(300);
  await expect(page.locator("[data-dragging]")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByRole("listbox")).toBeVisible();
  const option = page.getByRole("option", {
    name: "Example model",
    exact: true,
  });
  const optionBounds = await option.boundingBox();
  if (!optionBounds) throw new Error("Model option must have layout");
  await page.mouse.move(
    optionBounds.x + optionBounds.width / 2,
    optionBounds.y + optionBounds.height / 2,
  );
  await page.mouse.down();
  try {
    await page.clock.runFor(300);
    await expect(page.locator("[data-dragging]")).toHaveCount(0);
  } finally {
    await page.mouse.up();
  }
  await expect(model).toHaveAttribute("aria-expanded", "false");
  // The controlled clock must also let the Select's exit transition finish.
  await page.clock.runFor(300);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  // A drag has its own Escape contract, even while a selected card has a panel.
  await ada.click();
  const panel = page.getByRole("region", { name: "Agent profile" });
  await expect(panel).toBeVisible();
  await page.clock.runFor(300);
  const selected = await ada.boundingBox();
  if (!selected) throw new Error("Selected card must have layout");
  await ada.focus();
  await page.mouse.move(
    selected.x + selected.width / 2,
    selected.y + selected.height / 3,
  );
  await page.mouse.down();
  try {
    await page.clock.runFor(250);
    await expect(page.locator("[data-dragging]")).toHaveCount(1);
    await page.keyboard.press("ArrowLeft");
    await expect(ada).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-dragging]")).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(ada).toHaveAttribute("aria-selected", "true");
    // Expire the timer-based click guard, then await the real-time drop animation.
    await page.clock.runFor(300);
    await expect(
      page.locator('[aria-hidden="true"]').getByText("Ada", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await page.mouse.up();
  }
  await expect(panel).toBeVisible();
  await expect(ada).toHaveAttribute("aria-selected", "true");
});

test("Escape followed by a delayed release does not click the card", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/tests/fixtures/agent-library.html?reorder");
  const card = page.getByRole("gridcell", { name: "Ada", exact: true });
  await expect(card).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const bounds = await card.boundingBox();
  if (!bounds) throw new Error("Card must have layout");
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 3,
  );
  await page.mouse.down();
  try {
    await page.clock.runFor(250);
    await expect(page.locator("[data-dragging]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.clock.runFor(300);
    await expect(page.getByText("Ada", { exact: true })).toHaveCount(1);
  } finally {
    await page.mouse.up();
  }
  await expect(card).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("region", { name: "Agent profile" })).toHaveCount(
    0,
  );
  // A subsequent ordinary click is not swallowed.
  await card.click();
  await expect(
    page.getByRole("region", { name: "Agent profile" }),
  ).toBeVisible();
});
