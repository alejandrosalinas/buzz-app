// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ClientSnapshot,
  Communities,
} from "../features/communities/service";
import * as api from "../features/communities/api";
import { ProfileSettings } from "./ProfileSettings";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { useSyncExternalStore } from "react";
import { stubAvatarBrowserApis } from "../features/agents/avatar-testing";

stubAvatarBrowserApis();

vi.mock("../features/communities/api", () => ({
  inspectProfile: vi.fn(),
  publishProfile: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const a = "https://a.example";
const b = "https://b.example";
const original = (name: string, about = "Keep this") => ({
  profile: { name, picture: "", about },
  existing: { name, picture: "", about },
  exists: true,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  selected: string | null = a,
  picture = "",
  inheritedPicture = "",
) {
  let state: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer: "a".repeat(64),
    sync: { known: [], outbox: [] },
    selected,
    memberships: [
      { id: a, name: "Alpha" },
      { id: b, name: "Beta" },
    ],
    profile: { name: "Local default", picture },
  };
  const listeners = new Set<() => void>();
  const saveProfile = vi.fn();
  const select = (selected: string | null) =>
    act(() => {
      state = { ...state, selected };
      for (const fn of listeners) fn();
    });
  const communities = {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    relay: { snapshot: () => ({ status: "unavailable" }) },
    saveProfile,
  } as unknown as Communities;
  const profiles = new Map<
    string,
    Awaited<ReturnType<typeof api.inspectProfile>>
  >([
    [
      a,
      {
        ...original("Alpha human"),
        profile: {
          ...original("Alpha human").profile,
          picture: inheritedPicture,
        },
        existing: {
          ...original("Alpha human").existing,
          picture: inheritedPicture,
        },
      },
    ],
    [b, original("Beta human")],
  ]);
  vi.mocked(api.inspectProfile).mockImplementation(async (id) => {
    const profile = profiles.get(id);
    if (!profile) throw new Error("Unknown fixture community");
    return profile;
  });
  vi.mocked(api.publishProfile).mockImplementation(
    async (id, profile, existing) => {
      profiles.set(id, {
        profile: { ...profile, name: profile.name.trim() },
        existing: { ...existing, ...profile },
        exists: true,
      });
    },
  );
  function CapturedProfile() {
    const client = useSyncExternalStore(
      communities.subscribe,
      communities.snapshot,
    );
    return (
      <ProfileSettings
        key={client.selected ?? "local"}
        communities={communities}
        community={client.memberships.find(
          (item) => item.id === client.selected,
        )}
      />
    );
  }
  const view = render(<CapturedProfile />, { wrapper: ToastProvider });
  return { select, saveProfile, view, communities, profiles };
}
async function editName(name = "Changed") {
  await screen.findByDisplayValue("Alpha human");
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: name },
  });
}
function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

it("edits the existing selected community without another destination control and updates the local seed after confirmation", async () => {
  const fixture = setup();
  await editName();
  expect(
    screen.queryByRole("combobox", { name: "Profile to edit" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "Update this community’s profile. Other community profiles stay unchanged.",
    ),
  ).toBeInTheDocument();
  vi.mocked(api.inspectProfile).mockResolvedValueOnce({
    ...original("Alpha human"),
    existing: {
      ...original("Alpha human").existing,
      website: "https://new.example",
    },
  });
  save();
  await screen.findByText("Profile updated");
  expect(api.publishProfile).toHaveBeenCalledExactlyOnceWith(
    a,
    { name: "Changed", picture: "", about: "Keep this" },
    { ...original("Alpha human").existing, website: "https://new.example" },
  );
  expect(api.inspectProfile).toHaveBeenCalledTimes(3);
  expect(fixture.saveProfile).toHaveBeenCalledWith({
    name: "Changed",
    picture: "",
    about: "Keep this",
  });
});

it("switching during the pre-save read retires that save rather than publishing into either community", async () => {
  const fixture = setup();
  await editName();
  const late = deferred<ReturnType<typeof original>>();
  vi.mocked(api.inspectProfile).mockReturnValueOnce(late.promise);
  save();
  expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  fixture.select(b);
  await screen.findByDisplayValue("Beta human");
  await act(async () => {
    late.resolve(original("Alpha human"));
    await late.promise;
  });
  expect(api.publishProfile).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Display name")).toHaveValue("Beta human");
});

it("a dispatched save remains bound to A and its late completion cannot clear B's draft", async () => {
  const fixture = setup();
  await editName();
  const late = deferred<void>();
  vi.mocked(api.publishProfile).mockImplementationOnce(async (id, profile) => {
    await late.promise;
    fixture.profiles.set(id, {
      profile,
      existing: { ...profile },
      exists: true,
    });
  });
  save();
  await act(async () => {});
  await waitFor(() => expect(api.publishProfile).toHaveBeenCalledTimes(1));
  fixture.select(b);
  await screen.findByDisplayValue("Beta human");
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Beta draft" },
  });
  await act(async () => {
    late.resolve();
    await late.promise;
  });
  expect(api.inspectProfile).toHaveBeenLastCalledWith(a);
  expect(fixture.saveProfile).toHaveBeenCalledWith({
    name: "Changed",
    picture: "",
    about: "Keep this",
  });
  expect(screen.getByLabelText("Display name")).toHaveValue("Beta draft");
  expect(screen.queryByText("Profile updated")).not.toBeInTheDocument();
  expect(api.publishProfile).toHaveBeenCalledExactlyOnceWith(
    a,
    { name: "Changed", picture: "", about: "Keep this" },
    original("Alpha human").existing,
  );
  save();
  await screen.findByText("Profile updated");
  expect(api.publishProfile).toHaveBeenLastCalledWith(
    b,
    { name: "Beta draft", picture: "", about: "Keep this" },
    original("Beta human").existing,
  );
});

it("failed publication retains edits for explicit retry; Cancel restores the loaded profile", async () => {
  setup();
  await editName();
  vi.mocked(api.publishProfile).mockRejectedValueOnce(
    new Error("Publication unconfirmed"),
  );
  save();
  await screen.findByText("Publication unconfirmed");
  expect(screen.getByLabelText("Display name")).toHaveValue("Changed");
  save();
  await screen.findByText("Profile updated");
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Discard me" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByLabelText("Display name")).toHaveValue("Changed");
  expect(api.publishProfile).toHaveBeenCalledTimes(2);
});

it("late initial reads cannot replace another community's profile", async () => {
  const fixture = setup();
  await screen.findByDisplayValue("Alpha human");
  const late = deferred<ReturnType<typeof original>>();
  vi.mocked(api.inspectProfile).mockReturnValueOnce(late.promise);
  fixture.select(b);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByLabelText("Display name")).toBeDisabled();
  fixture.select(a);
  await screen.findByDisplayValue("Alpha human");
  await act(async () => {
    late.resolve(original("Late Beta"));
    await late.promise;
  });
  expect(screen.getByLabelText("Display name")).toHaveValue("Alpha human");
});

it("Personal space retains the pre-existing local-only default behavior", async () => {
  const fixture = setup(null);
  expect(screen.getByLabelText("Display name")).toHaveValue("Local default");
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "New default" },
  });
  save();
  expect(fixture.saveProfile).toHaveBeenCalledExactlyOnceWith({
    name: "New default",
    picture: "",
    about: "",
  });
  expect(api.inspectProfile).not.toHaveBeenCalled();
  expect(api.publishProfile).not.toHaveBeenCalled();
});

it("failed initial reads expose Retry and never publish defaults over an unknown profile", async () => {
  const fixture = setup();
  await screen.findByDisplayValue("Alpha human");
  vi.mocked(api.inspectProfile).mockRejectedValueOnce(
    new Error("Read refused"),
  );
  fixture.select(b);
  await screen.findByText(/Read refused/);
  expect(screen.getByLabelText("Display name")).toBeDisabled();
  expect(screen.queryByRole("textbox", { name: "Display name" })).toBeNull();
  expect(api.publishProfile).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry loading profile" }),
  );
  await screen.findByDisplayValue("Beta human");
  expect(api.publishProfile).not.toHaveBeenCalled();
});

it("accepted but superseded publication retains the avatar draft for explicit retry", async () => {
  setup();
  await screen.findByDisplayValue("Alpha human");
  fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
  fireEvent.change(await screen.findByLabelText("Picture URL (optional)"), {
    target: { value: "https://images.example/new.png" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  vi.mocked(api.publishProfile).mockResolvedValueOnce(undefined);
  save();
  await screen.findByText(
    "Your profile change is not current. Your edits are retained; save again to retry.",
  );
  expect(screen.queryByText("Profile updated")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  save();
  await screen.findByText("Profile updated");
  expect(api.publishProfile).toHaveBeenLastCalledWith(
    a,
    {
      name: "Alpha human",
      picture: "https://images.example/new.png",
      about: "Keep this",
    },
    original("Alpha human").existing,
  );
});

it("failed confirmation keeps edits and does not automatically republish", async () => {
  setup();
  await editName();
  vi.mocked(api.inspectProfile)
    .mockResolvedValueOnce(original("Alpha human"))
    .mockRejectedValueOnce(new Error("Confirmation unavailable"));
  save();
  await screen.findByText("Confirmation unavailable");
  expect(screen.getByLabelText("Display name")).toHaveValue("Changed");
  expect(api.publishProfile).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Profile updated")).not.toBeInTheDocument();
});

it("late confirmation after switching cannot replace the next community draft", async () => {
  const fixture = setup();
  await editName();
  const late = deferred<ReturnType<typeof original>>();
  const started = deferred<void>();
  vi.mocked(api.inspectProfile)
    .mockResolvedValueOnce(original("Alpha human"))
    .mockImplementationOnce(() => {
      started.resolve();
      return late.promise;
    });
  save();
  await act(async () => {
    await started.promise;
  });
  fixture.select(b);
  await screen.findByDisplayValue("Beta human");
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Beta draft" },
  });
  await act(async () => {
    late.resolve(original("Changed"));
    await late.promise;
  });
  expect(screen.getByLabelText("Display name")).toHaveValue("Beta draft");
  expect(screen.queryByText("Profile updated")).not.toBeInTheDocument();
  expect(api.publishProfile).toHaveBeenCalledTimes(1);
});

it("confirms a dispatched save through its captured session after leaving Settings", async () => {
  const { createRelaySession } = await import("../features/relay/session");
  const owner = createRelaySession(null);
  const fixture = setup();
  vi.spyOn(fixture.communities.relay, "snapshot").mockReturnValue({
    status: "ready",
    viewer: "a".repeat(64),
    generation: 1,
    scope: a,
    session: owner.session,
  });
  await editName();
  const late = deferred<void>();
  vi.mocked(api.publishProfile).mockImplementationOnce(async (id, profile) => {
    await late.promise;
    fixture.profiles.set(id, {
      profile,
      existing: { ...profile },
      exists: true,
    });
  });
  try {
    save();
    await waitFor(() => expect(api.publishProfile).toHaveBeenCalledTimes(1));
    fixture.view.unmount();
    await act(async () => {
      late.resolve();
      await late.promise;
    });
    expect(api.inspectProfile).toHaveBeenLastCalledWith(a, owner.session);
    expect(fixture.saveProfile).toHaveBeenCalledExactlyOnceWith({
      name: "Changed",
      picture: "",
      about: "Keep this",
    });
  } finally {
    late.resolve();
    owner.dispose();
  }
});

it.each([
  ["https://a.example/media/upload.png", "https://public.example/previous.png"],
  [
    "https://A.example:443/media/upload.png",
    "https://public.example/previous.png",
  ],
  ["https://public.example/new.png", "https://public.example/new.png"],
  ["", ""],
])(
  "publishes %s only to its community and seeds the portable default correctly",
  async (picture, expected) => {
    const fixture = setup(a, "https://public.example/previous.png");
    await editName();
    if (picture) {
      fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
      fireEvent.change(await screen.findByLabelText("Picture URL (optional)"), {
        target: { value: picture },
      });
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    }
    save();
    await screen.findByText("Profile updated");
    expect(api.publishProfile).toHaveBeenCalledExactlyOnceWith(
      a,
      { name: "Changed", picture, about: "Keep this" },
      original("Alpha human").existing,
    );
    expect(fixture.saveProfile).toHaveBeenCalledExactlyOnceWith({
      name: "Changed",
      picture: expected,
      about: "Keep this",
    });
  },
);

it("shows and keeps an emoji avatar saved by Buzz mobile", async () => {
  // Buzz mobile's emojiAvatarDataUrl("🛹", 0xFFFFB84D).
  const picture = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="256" fill="#FFB84D"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">🛹</text></svg>',
  )}`;
  setup(a, "", picture);
  await editName();
  expect(
    screen
      .getByRole("region", { name: "Profile preview" })
      .querySelector("img"),
  ).toHaveAttribute("src", picture);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  save();
  await screen.findByText("Profile updated");
  expect(api.publishProfile).toHaveBeenCalledExactlyOnceWith(
    a,
    { name: "Changed", picture, about: "Keep this" },
    expect.objectContaining({ picture }),
  );
});

it.each(["http://images.example/avatar.png", "data:image/png;base64,AA=="])(
  "explains inherited invalid picture %s and recovers after removal",
  async (picture) => {
    setup(a, "", picture);
    await editName();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Use an HTTPS image URL without credentials",
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
    const input = await screen.findByLabelText("Picture URL (optional)");
    expect(input).toHaveValue(picture);
    expect(input).toHaveAccessibleDescription(/Use an HTTPS image URL/);
    fireEvent.click(screen.getByRole("button", { name: "Remove avatar" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    save();
    await screen.findByText("Profile updated");
    expect(api.publishProfile).toHaveBeenCalledWith(
      a,
      { name: "Changed", picture: "", about: "Keep this" },
      expect.objectContaining({ picture }),
    );
  },
);
