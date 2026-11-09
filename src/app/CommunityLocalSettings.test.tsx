// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useSyncExternalStore } from "react";
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityLocalSettings } from "./CommunityLocalSettings";
import { createCommunities } from "../features/communities/service";
import { localCommunityNameKey } from "../features/communities/names";
import { flush } from "../features/relay/testing";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { readDefaultLifetime } from "../features/solo/default-lifetime";

const viewer = "a".repeat(64);
const origin = "https://community.example";
const roots: Context[] = [];
async function setup() {
  const community = { id: origin, name: "Published" };
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "You", picture: "" },
      memberships: [community],
      selected: origin,
    }),
  );
  const root = new Context();
  roots.push(root);
  const communities = createCommunities(
    root,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
  );
  await flush();
  function Page() {
    const snapshot = useSyncExternalStore(
      communities.subscribe,
      communities.snapshot,
    );
    return (
      <CommunityLocalSettings
        communities={communities}
        community={snapshot.memberships[0] ?? community}
        viewer={snapshot.viewer}
      />
    );
  }
  const view = render(<Page />, { wrapper: ToastProvider });
  return { communities, view, user: userEvent.setup() };
}
afterEach(async () => {
  cleanup();
  for (const root of roots.splice(0)) await root.fiber.dispose();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("saves an explicit device name and resets to the default without changing the community address", async () => {
  const { user, communities } = await setup();
  expect(screen.getByLabelText("Community address")).toHaveValue(origin);
  expect(screen.getByLabelText("Community address")).toHaveAttribute(
    "readonly",
  );
  const input = screen.getByLabelText("Display name");
  expect(input).toHaveValue("");
  expect(input).toHaveAttribute("placeholder", "Published");
  await user.type(input, "Work");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("status")).toHaveTextContent("saved on this device");
  expect(communities.snapshot().memberships[0]?.localName).toBe("Work");
  await user.click(screen.getByRole("button", { name: "Reset name" }));
  expect(input).toHaveValue("");
  expect(
    localStorage.getItem(localCommunityNameKey(origin, viewer)),
  ).toBeNull();
  expect(communities.snapshot().selected).toBe(origin);
});

it("retains the draft when storage is denied and lets the same Save retry", async () => {
  const { user, communities } = await setup();
  const input = screen.getByLabelText("Display name");
  await user.type(input, "Work");
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("denied");
    });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t save");
  expect(screen.queryByRole("status")).toBeNull();
  expect(input).toHaveValue("Work");
  expect(communities.snapshot().memberships[0]?.localName).toBeUndefined();
  write.mockRestore();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(communities.snapshot().memberships[0]?.localName).toBe("Work");
});

it("does not replace a dirty draft when another window changes the saved name", async () => {
  const { user } = await setup();
  const input = screen.getByLabelText("Display name");
  await user.type(input, "My draft");
  const key = localCommunityNameKey(origin, viewer);
  act(() => {
    localStorage.setItem(key, "Other window");
    window.dispatchEvent(
      new StorageEvent("storage", { key, storageArea: localStorage }),
    );
  });
  expect(input).toHaveValue("My draft");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(input).toHaveValue("Other window");
});

it("copies the exact community URL, keeps it selectable on clipboard failure, and allows retry", async () => {
  const { user, communities } = await setup();
  const write = vi.fn().mockRejectedValueOnce(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: write },
  });
  await user.click(screen.getByRole("button", { name: "Copy URL" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Select it and copy manually.",
  );
  expect(screen.getByLabelText("Community address")).toHaveValue(origin);
  expect(screen.getByLabelText("Community address")).toHaveAttribute(
    "readonly",
  );
  expect(screen.queryByText("Community URL copied.")).toBeNull();
  let finish!: () => void;
  write.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await user.click(screen.getByRole("button", { name: "Copy URL" }));
  try {
    expect(screen.getByRole("button", { name: "Copy URL" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Copy URL" }));
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(origin);
  } finally {
    await act(async () => {
      finish();
    });
  }
  expect(await screen.findByText("Community URL copied.")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(communities.snapshot().selected).toBe(origin);
});

it("saves the lifetime new Solo chats start with for this community and account only", async () => {
  const { user } = await setup();
  const scope = `${origin}:${viewer}`;
  const lifetime = () =>
    screen.getByRole("combobox", { name: "New Solo chats" });
  const choose = async (name: RegExp) => {
    await user.click(lifetime());
    await user.click(await screen.findByRole("option", { name }));
  };
  expect(lifetime()).toHaveTextContent("Ongoing");
  await choose(/^Temporary, 7 days/);
  expect(readDefaultLifetime(scope)).toBe(604800);
  expect(lifetime()).toHaveTextContent("Temporary, 7 days");
  expect(readDefaultLifetime(`${origin}:${"b".repeat(64)}`)).toBeUndefined();
  await choose(/^Temporary, 2 weeks/);
  expect(readDefaultLifetime(scope)).toBe(1209600);
  await choose(/^Ongoing/);
  expect(readDefaultLifetime(scope)).toBeUndefined();
});

it("says so when this device can't save the lifetime, and keeps the saved one", async () => {
  const { user } = await setup();
  const scope = `${origin}:${viewer}`;
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("quota");
    });
  await user.click(screen.getByRole("combobox", { name: "New Solo chats" }));
  await user.click(
    await screen.findByRole("option", { name: /^Temporary, 1 day/ }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn’t save this on this device. Try again.",
  );
  expect(readDefaultLifetime(scope)).toBeUndefined();
  expect(
    screen.getByRole("combobox", { name: "New Solo chats" }),
  ).toHaveTextContent("Ongoing");
  setItem.mockRestore();
  await user.click(screen.getByRole("combobox", { name: "New Solo chats" }));
  await user.click(
    await screen.findByRole("option", { name: /^Temporary, 1 day/ }),
  );
  expect(readDefaultLifetime(scope)).toBe(86400);
  expect(screen.queryByRole("alert")).toBeNull();
});
