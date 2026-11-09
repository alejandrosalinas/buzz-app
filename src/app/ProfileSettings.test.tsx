// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRelaySession } from "../features/relay/session";
import { keypair, profile as signedProfile } from "../features/relay/testing";
import { afterEach, expect, it, vi } from "vitest";
import type {
  PersonalProfile,
  Communities,
} from "../features/communities/service";
import * as communityApi from "../features/communities/api";
import * as avatarUpload from "../features/profiles/avatar-upload";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { ProfileSettings } from "./ProfileSettings";
import { stubAvatarBrowserApis } from "../features/agents/avatar-testing";

stubAvatarBrowserApis();

const viewer = "ab".repeat(32);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function communities(): Communities {
  const state = {
    status: "ready" as const,
    relayAvailable: true,
    viewer,
    profile: { name: "Buzz User", picture: "" },
    memberships: [],
    selected: null,
  };
  const snapshot = () => state;
  return {
    snapshot,
    subscribe: () => () => {},
    relay: { snapshot: () => ({ status: "unavailable" }) },
    saveProfile: vi.fn(),
  } as unknown as Communities;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loads and publishes the selected community profile before updating the local seed", async () => {
  const service = communities();
  const inspect = vi.spyOn(communityApi, "inspectProfile").mockResolvedValue({
    exists: true,
    existing: { website: "https://example.test", name: "legacy" },
    profile: {
      name: "Community name",
      picture: "",
      about: "Community bio",
    },
  });
  const publish = vi
    .spyOn(communityApi, "publishProfile")
    .mockImplementation(async (_id, profile, existing) => {
      inspect.mockResolvedValue({ exists: true, existing, profile });
    });
  const user = userEvent.setup();
  const view = render(
    <ProfileSettings
      communities={service}
      community={{ id: "community-id", name: "Acme" }}
    />,
    { wrapper: ToastProvider },
  );

  expect(screen.queryByText("Loading your profile in Acme…")).toBeNull();
  const name = await screen.findByLabelText("Display name");
  expect(name).toHaveValue("Community name");
  expect(screen.getByLabelText("Profile description (optional)")).toHaveValue(
    "Community bio",
  );
  await user.clear(name);
  await user.type(name, "Updated community name");
  view.rerender(
    <ProfileSettings
      communities={service}
      community={{
        id: "community-id",
        name: "Acme",
        publishedName: "New published label",
      }}
    />,
  );
  expect(name).toHaveValue("Updated community name");
  expect(inspect).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(publish).toHaveBeenCalledWith(
      "community-id",
      {
        name: "Updated community name",
        picture: "",
        about: "Community bio",
      },
      { website: "https://example.test", name: "legacy" },
    ),
  );
  expect(service.saveProfile).toHaveBeenCalledWith({
    name: "Updated community name",
    picture: "",
    about: "Community bio",
  });
  expect(await screen.findByText("Profile updated")).toBeVisible();
  expect(inspect).toHaveBeenCalledWith("community-id");
});

function verifiedProfileSettings(
  signedName: string,
  status: "checked" | "cached" | null,
) {
  const service = communities();
  service.snapshot().selected = "community-id";
  const profiles = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const verify = (next: "checked" | "cached") => {
    profiles.set(viewer, {
      name: "Verified Name",
      verified: {
        displayName: "verified",
        username: "verified",
        fullName: "Verified Name",
        issuerLabel: "Block",
        verifiedAt: 1,
        status: next,
        multipleIssuers: false,
      },
    });
    for (const listener of listeners) listener();
  };
  if (status) verify(status);
  const ensure = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(service.relay, "snapshot").mockReturnValue({
    status: "ready",
    viewer,
    scope: "community-id",
    generation: 1,
    session: {
      viewer,
      profiles: {
        snapshot: () => profiles,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        ensure,
      },
    },
  } as unknown as ReturnType<Communities["relay"]["snapshot"]>);
  vi.spyOn(communityApi, "inspectProfile").mockResolvedValue({
    exists: true,
    existing: {},
    profile: { name: signedName, picture: "", about: "" },
  });
  const publish = vi
    .spyOn(communityApi, "publishProfile")
    .mockRejectedValue(new Error("stop"));
  render(
    <ProfileSettings
      communities={service}
      community={{ id: "community-id", name: "Acme" }}
    />,
    { wrapper: ToastProvider },
  );
  return {
    ensure,
    publish,
    verify: (next: "checked" | "cached") => act(() => verify(next)),
  };
}

it("shows the verified name read-only and keeps the signed name when saving", async () => {
  const { ensure, publish } = verifiedProfileSettings("Signed name", "checked");
  const user = userEvent.setup();

  const name = await screen.findByLabelText("Display name");
  await waitFor(() => expect(name).toHaveValue("Verified Name"));
  expect(name).toHaveAttribute("readonly");
  expect(screen.getByText("Name verified by Block · @verified")).toBeVisible();
  expect(ensure).toHaveBeenCalledWith([viewer]);
  await user.type(
    screen.getByLabelText("Profile description (optional)"),
    "Bio",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(publish).toHaveBeenCalledWith(
      "community-id",
      { name: "Signed name", picture: "", about: "Bio" },
      {},
    ),
  );
});

it("keeps the signed name when verification arrives after a name edit", async () => {
  const { publish, verify } = verifiedProfileSettings("Signed name", null);
  const user = userEvent.setup();

  const name = await screen.findByLabelText("Display name");
  await waitFor(() => expect(name).toHaveValue("Signed name"));
  await user.clear(name);
  await user.type(
    screen.getByLabelText("Profile description (optional)"),
    "Bio",
  );
  verify("cached");

  expect(name).toHaveValue("Verified Name");
  expect(name).toHaveAttribute("readonly");
  expect(
    screen.getByText("Cached verification from Block · @verified"),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(publish).toHaveBeenCalledWith(
      "community-id",
      { name: "Signed name", picture: "", about: "Bio" },
      {},
    ),
  );
});

it("keeps an empty signed name editable for repair when verified", async () => {
  const { publish } = verifiedProfileSettings("", "checked");
  const user = userEvent.setup();

  const name = await screen.findByLabelText("Display name");
  await waitFor(() => expect(name).toBeEnabled());
  expect(name).not.toHaveAttribute("readonly");
  expect(name).toHaveValue("");
  await user.type(name, "Repaired");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(publish).toHaveBeenCalledWith(
      "community-id",
      { name: "Repaired", picture: "", about: "" },
      {},
    ),
  );
});

it("keeps a newer profile seed when an older community publication finishes last", async () => {
  const service = communities();
  const olderPublication = deferred();
  const saved = new Map<
    string,
    Parameters<typeof communityApi.publishProfile>[1]
  >();
  vi.spyOn(communityApi, "inspectProfile").mockImplementation(async (id) => ({
    exists: true,
    existing: { name: id },
    profile: saved.get(id) ?? {
      name: id === "older" ? "Older" : "Newer",
      picture: "",
    },
  }));
  const publish = vi
    .spyOn(communityApi, "publishProfile")
    .mockImplementation(async (id, profile) => {
      if (id === "older") await olderPublication.promise;
      saved.set(id, profile);
    });
  const user = userEvent.setup();
  const older = render(
    <ProfileSettings
      communities={service}
      community={{ id: "older", name: "Older community" }}
    />,
    { wrapper: ToastProvider },
  );
  const olderName = await within(older.container).findByLabelText(
    "Display name",
  );
  await user.clear(olderName);
  await user.type(olderName, "Older save");
  await user.click(
    within(older.container).getByRole("button", { name: "Save" }),
  );
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

  const newer = render(
    <ProfileSettings
      communities={service}
      community={{ id: "newer", name: "Newer community" }}
    />,
    { wrapper: ToastProvider },
  );
  const newerName = await within(newer.container).findByLabelText(
    "Display name",
  );
  await user.clear(newerName);
  await user.type(newerName, "Newer save");
  await user.click(
    within(newer.container).getByRole("button", { name: "Save" }),
  );
  await waitFor(() =>
    expect(service.saveProfile).toHaveBeenCalledWith({
      name: "Newer save",
      picture: "",
      about: "",
    }),
  );

  olderPublication.resolve();
  await olderPublication.promise;
  await waitFor(() => expect(olderName).not.toBeDisabled());
  expect(publish).toHaveBeenCalledTimes(2);
  expect(service.saveProfile).toHaveBeenCalledTimes(1);
});

it("stops reporting a discardable draft once its save is dispatched", async () => {
  const publication = deferred();
  let saved = { name: "Saved", picture: "" };
  vi.spyOn(communityApi, "inspectProfile").mockImplementation(async () => ({
    exists: true,
    existing: { name: saved.name },
    profile: saved,
  }));
  vi.spyOn(communityApi, "publishProfile").mockImplementation(
    async (_id, profile) => {
      await publication.promise;
      saved = profile;
    },
  );
  const onUnsavedChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ProfileSettings
      communities={communities()}
      community={{ id: "primary", name: "Primary" }}
      onUnsavedChange={onUnsavedChange}
    />,
    { wrapper: ToastProvider },
  );
  const name = await screen.findByLabelText("Display name");
  await user.clear(name);
  await user.type(name, "Edited");
  expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Save" }));
  // The save continues even if Settings closes, so nothing is left to discard.
  await waitFor(() => expect(onUnsavedChange).toHaveBeenLastCalledWith(false));
  publication.resolve();
  await publication.promise;
  await waitFor(() => expect(name).not.toBeDisabled());
  expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
});

it("keeps a draft discardable while Save reads the latest profile", async () => {
  const read = deferred();
  let reads = 0;
  vi.spyOn(communityApi, "inspectProfile").mockImplementation(async () => {
    // The second read is Save's fresh inspection before publication.
    if (++reads === 2) await read.promise;
    return {
      exists: true,
      existing: { name: "Saved" },
      profile: { name: "Saved", picture: "" },
    };
  });
  const publish = vi
    .spyOn(communityApi, "publishProfile")
    .mockImplementation(() => new Promise(() => {}));
  const onUnsavedChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ProfileSettings
      communities={communities()}
      community={{ id: "primary", name: "Primary" }}
      onUnsavedChange={onUnsavedChange}
    />,
    { wrapper: ToastProvider },
  );
  const name = await screen.findByLabelText("Display name");
  await waitFor(() => expect(name).toHaveValue("Saved"));
  await user.clear(name);
  await user.type(name, "Edited");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(reads).toBe(2));
  // Closing now would unmount before publication and silently lose the edit.
  expect(publish).not.toHaveBeenCalled();
  expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  read.resolve();
  await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  await waitFor(() => expect(onUnsavedChange).toHaveBeenLastCalledWith(false));
});

it("keeps a community draft when publication fails and retries a failed read", async () => {
  const service = communities();
  const inspect = vi
    .spyOn(communityApi, "inspectProfile")
    .mockRejectedValueOnce(new Error("read unavailable"))
    .mockResolvedValue({
      exists: false,
      existing: {},
      profile: { name: "", picture: "", about: "" },
    });
  const publish = vi
    .spyOn(communityApi, "publishProfile")
    .mockRejectedValue(new Error("publish unavailable"));
  const user = userEvent.setup();
  render(
    <ProfileSettings
      communities={service}
      community={{ id: "community-id", name: "Acme" }}
    />,
    { wrapper: ToastProvider },
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "read unavailable",
  );
  await user.click(
    screen.getByRole("button", { name: "Retry loading profile" }),
  );
  const name = await screen.findByLabelText("Display name");
  expect(name).toHaveValue("Buzz User");
  await user.clear(name);
  await user.type(name, "Keep this draft");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "publish unavailable",
  );
  expect(name).toHaveValue("Keep this draft");
  expect(service.saveProfile).not.toHaveBeenCalled();
  // Failed initial load, explicit retry, then fresh preflight; no confirmation.
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("shows profile actions for description-only edits and hides them on cancellation", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });
  const description = screen.getByLabelText("Profile description (optional)");
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Cancel" }),
  ).not.toBeInTheDocument();
  await user.type(description, "Draft");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  await user.clear(description);
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await user.type(description, "Discard me");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(description).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(service.saveProfile).not.toHaveBeenCalled();
});

it("previews draft profile content and the shared avatar crop before saving", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });

  const preview = screen.getByRole("region", { name: "Profile preview" });
  expect(preview).toHaveTextContent("Buzz User");
  expect(preview.querySelector('[data-avatar-shape="circle"]')).toBeVisible();

  await user.clear(screen.getByLabelText("Display name"));
  await user.type(screen.getByLabelText("Display name"), "Clay");
  await user.type(
    screen.getByLabelText("Profile description (optional)"),
    "Building with Buzz",
  );
  await user.click(screen.getByRole("button", { name: "Edit avatar" }));
  await user.type(
    await screen.findByLabelText("Picture URL (optional)"),
    "https://example.test/profile.png",
  );
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(preview).toHaveTextContent("Clay");
  expect(preview).toHaveTextContent("Building with Buzz");
  expect(preview.querySelector("img")).toHaveAttribute(
    "src",
    "https://example.test/profile.png",
  );
});

it("edits and trims the profile description with a visible limit", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });

  const description = screen.getByLabelText("Profile description (optional)");
  expect(screen.getByText("0 of 500 characters")).toBeVisible();
  await user.type(description, "  Building with Buzz  ");
  expect(screen.getByText("22 of 500 characters")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(service.saveProfile).toHaveBeenCalledWith({
    name: "Buzz User",
    picture: "",
    about: "Building with Buzz",
  });
  expect(await screen.findByText("Profile updated")).toBeVisible();
});

it("preserves an over-limit remote description and blocks unrelated saves", async () => {
  const service = communities();
  const about = "a".repeat(800);
  vi.spyOn(communityApi, "inspectProfile").mockResolvedValue({
    exists: true,
    existing: { name: "Remote", about },
    profile: { name: "Remote", picture: "", about },
  });
  const publish = vi.spyOn(communityApi, "publishProfile").mockResolvedValue();
  const user = userEvent.setup();
  render(
    <ProfileSettings
      communities={service}
      community={{ id: "community-id", name: "Acme" }}
    />,
    { wrapper: ToastProvider },
  );

  const description = await screen.findByLabelText(
    "Profile description (optional)",
  );
  expect(description).toHaveValue(about);
  expect(
    screen.getByText(
      "Shorten the description to 500 characters before saving.",
    ),
  ).toBeVisible();
  const name = screen.getByLabelText("Display name");
  await user.clear(name);
  await user.type(name, "Renamed");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(publish).not.toHaveBeenCalled();
});

it("rejects profile image URLs with embedded credentials", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });

  await user.click(screen.getByRole("button", { name: "Edit avatar" }));
  await user.type(
    await screen.findByLabelText("Picture URL (optional)"),
    "https://user:secret@example.test/profile.png",
  );
  // Done reveals the error instead of applying the URL.
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(
    screen.getByLabelText("Picture URL (optional)"),
  ).toHaveAccessibleDescription(/Use an HTTPS image URL without credentials/);
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(service.saveProfile).not.toHaveBeenCalled();
});

function setup() {
  let state = { status: "ready", profile: { name: "Arjun", picture: "" } };
  const listeners = new Set<() => void>();
  const saveProfile = vi.fn((profile: PersonalProfile) => {
    state = { ...state, profile };
    for (const listener of listeners) listener();
  });
  const communities = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    saveProfile,
    relay: { snapshot: () => ({ status: "unavailable" }) },
  } as unknown as Communities;
  render(<ProfileSettings communities={communities} />, {
    wrapper: ToastProvider,
  });
  return {
    saveProfile,
    name: screen.getByRole("textbox", { name: "Display name" }),
  };
}

it("shows Cancel then Save only for edits, including picture edits, and restores on cancel", () => {
  const { name, saveProfile } = setup();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  fireEvent.change(name, { target: { value: "Updated" } });
  const form = name.closest("form");
  if (!form) throw new Error("Profile form missing");
  expect(
    within(form)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Cancel", "Save"]);
  fireEvent.change(name, { target: { value: "Arjun" } });
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
  const picture = screen.getByRole("textbox", {
    name: "Picture URL (optional)",
  });
  fireEvent.change(picture, {
    target: { value: "https://example.com/avatar.png" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
  expect(
    screen.getByRole("textbox", { name: "Picture URL (optional)" }),
  ).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(saveProfile).not.toHaveBeenCalled();
});

it("retains edits on failure and hides actions after a successful retry", async () => {
  const { name, saveProfile } = setup();
  fireEvent.change(name, { target: { value: "Updated" } });
  saveProfile.mockImplementationOnce(() => {
    throw new Error("Could not save");
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
  expect(name).toHaveValue("Updated");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(await screen.findByText("Profile updated")).toBeVisible();
});

it("keeps cancel available for invalid edits and refuses unchanged form submission", () => {
  const { name, saveProfile } = setup();
  const form = name.closest("form");
  if (!form) throw new Error("Profile form missing");
  fireEvent.submit(form);
  expect(saveProfile).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
});

it.each(["Cancel", "Save"])(
  "returns focused %s to Display name when actions retire",
  async (action) => {
    const user = userEvent.setup();
    const { name } = setup();
    await user.type(name, " updated");
    screen.getByRole("button", { name: action }).focus();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("button", { name: action }),
    ).not.toBeInTheDocument();
    expect(name).toHaveFocus();
  },
);

it("keeps the focused Save on failure and hands focus off after retry", async () => {
  const user = userEvent.setup();
  const { name, saveProfile } = setup();
  await user.type(name, " updated");
  const save = screen.getByRole("button", { name: "Save" });
  save.focus();
  saveProfile.mockImplementationOnce(() => {
    throw new Error("Could not save");
  });
  await user.keyboard("{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
  expect(save).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(name).toHaveFocus();
});

it("preserves input focus on implicit submit and external profile updates", async () => {
  const user = userEvent.setup();
  const { name, saveProfile } = setup();
  await user.type(name, " updated");
  await user.keyboard("{Enter}");
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(name).toHaveFocus();
  await user.type(name, " again");
  const description = screen.getByRole("textbox", {
    name: "Profile description (optional)",
  });
  description.focus();
  act(() => saveProfile({ name: "Arjun updated again", picture: "" }));
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(description).toHaveFocus();
});

it("does not request a community profile when transport is absent", () => {
  const service = communities();
  service.snapshot().relayAvailable = false;
  const inspect = vi.spyOn(communityApi, "inspectProfile");
  render(
    <ProfileSettings
      communities={service}
      community={{ id: "https://saved.example", name: "Saved" }}
    />,
  );
  expect(
    screen.getByText("Community profiles are not available in this build yet."),
  ).toBeVisible();
  expect(inspect).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy public key" })).toBeNull();
});

it("reuses the verified same-community profile while refreshing and preserves edits without overwriting untouched fields", async () => {
  const service = communities();
  const key = keypair();
  const event = signedProfile(key, {
    name: "Cached name",
    about: "Cached about",
  });
  const owner = createRelaySession({
    viewer: key.pubkey,
    relayAuthor: key.pubkey,
    media: (url) => url,
    query: async () => [event],
  });
  const refresh =
    deferred<Awaited<ReturnType<typeof communityApi.inspectProfile>>>();
  const inspect = vi
    .spyOn(communityApi, "inspectProfile")
    .mockReturnValue(refresh.promise);
  service.snapshot().viewer = key.pubkey;
  service.snapshot().selected = "primary";
  vi.spyOn(service.relay, "snapshot").mockReturnValue({
    status: "ready",
    viewer: key.pubkey,
    scope: "primary",
    generation: 1,
    session: owner.session,
  });
  try {
    await owner.session.profiles.ensure([key.pubkey]);
    const view = render(
      <ProfileSettings
        communities={service}
        community={{ id: "primary", name: "Primary" }}
      />,
      { wrapper: ToastProvider },
    );
    const name = screen.getByRole("textbox", { name: "Display name" });
    expect(name).toHaveValue("Cached name");
    expect(screen.getByRole("button", { name: "Edit avatar" })).toBeEnabled();
    expect(screen.queryByText(/Loading your profile/)).toBeNull();
    fireEvent.change(name, { target: { value: "My edit" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await act(async () =>
      refresh.resolve({
        exists: true,
        existing: {},
        profile: { name: "Fresh name", picture: "", about: "Fresh about" },
      }),
    );
    expect(name).toHaveValue("My edit");
    expect(screen.getByLabelText("Profile description (optional)")).toHaveValue(
      "Fresh about",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(inspect).toHaveBeenCalledWith("primary", owner.session);
    view.unmount();
  } finally {
    refresh.resolve({
      exists: true,
      existing: {},
      profile: { name: "Final", picture: "" },
    });
    owner.dispose();
  }
});

it("a failed cached-profile refresh leaves the form and edits in place for retry", async () => {
  const service = communities();
  const key = keypair();
  const event = signedProfile(key, {
    name: "Cached name",
    about: "Cached about",
  });
  const owner = createRelaySession({
    viewer: key.pubkey,
    relayAuthor: key.pubkey,
    media: (url) => url,
    query: async () => [event],
  });
  const refresh =
    deferred<Awaited<ReturnType<typeof communityApi.inspectProfile>>>();
  const inspect = vi
    .spyOn(communityApi, "inspectProfile")
    .mockRejectedValueOnce(new Error("Offline refresh"))
    .mockReturnValue(refresh.promise);
  service.snapshot().viewer = key.pubkey;
  service.snapshot().selected = "primary";
  vi.spyOn(service.relay, "snapshot").mockReturnValue({
    status: "ready",
    viewer: key.pubkey,
    scope: "primary",
    generation: 1,
    session: owner.session,
  });
  try {
    await owner.session.profiles.ensure([key.pubkey]);
    render(
      <ProfileSettings
        communities={service}
        community={{ id: "primary", name: "Primary" }}
      />,
      { wrapper: ToastProvider },
    );
    const name = screen.getByRole("textbox", { name: "Display name" });
    await screen.findByText(/Offline refresh/);
    fireEvent.change(name, { target: { value: "Keep my edit" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry loading profile" }),
    );
    await act(async () =>
      refresh.resolve({
        exists: true,
        existing: {},
        profile: { name: "New name", picture: "", about: "New bio" },
      }),
    );
    expect(name).toHaveValue("Keep my edit");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(inspect).toHaveBeenCalledTimes(2);
  } finally {
    refresh.resolve({
      exists: true,
      existing: {},
      profile: { name: "Final", picture: "" },
    });
    owner.dispose();
  }
});

it.each(["refresh-first", "upload-first"])(
  "keeps avatar editing available during refresh without restoring stale name or bio (%s)",
  async (order) => {
    const service = communities();
    const key = keypair();
    const event = signedProfile(key, {
      name: "Cached name",
      about: "Cached bio",
    });
    const owner = createRelaySession({
      viewer: key.pubkey,
      relayAuthor: key.pubkey,
      media: (url) => url,
      query: async () => [event],
    });
    const refresh =
      deferred<Awaited<ReturnType<typeof communityApi.inspectProfile>>>();
    const upload = deferred<string>();
    const uploaded = "https://images.example/new-avatar.png";
    vi.spyOn(communityApi, "inspectProfile").mockReturnValue(refresh.promise);
    const publish = vi
      .spyOn(communityApi, "publishProfile")
      .mockResolvedValue();
    vi.spyOn(avatarUpload, "paintEmojiAvatar").mockImplementation(() => {});
    vi.spyOn(avatarUpload, "emojiAvatar").mockResolvedValue(
      new File(["image"], "emoji.png", { type: "image/png" }),
    );
    const uploadAvatar = vi
      .spyOn(avatarUpload, "uploadAvatar")
      .mockReturnValue(upload.promise);
    service.snapshot().viewer = key.pubkey;
    service.snapshot().selected = "primary";
    vi.spyOn(service.relay, "snapshot").mockReturnValue({
      status: "ready",
      viewer: key.pubkey,
      scope: "primary",
      generation: 1,
      session: owner.session,
    });
    try {
      await owner.session.profiles.ensure([key.pubkey]);
      render(
        <ProfileSettings
          communities={service}
          community={{ id: "primary", name: "Primary" }}
        />,
        { wrapper: ToastProvider },
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
      fireEvent.click(await screen.findByRole("tab", { name: "Background" }));
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => expect(uploadAvatar).toHaveBeenCalledTimes(1));
      expect(publish).not.toHaveBeenCalled();
      const fresh = {
        exists: true,
        existing: {},
        profile: { name: "Fresh name", picture: "", about: "Fresh bio" },
      };
      await act(async () => {
        if (order === "refresh-first") {
          refresh.resolve(fresh);
          upload.resolve(uploaded);
        } else {
          upload.resolve(uploaded);
          refresh.resolve(fresh);
        }
      });
      expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
        "Fresh name",
      );
      expect(
        screen.getByLabelText("Profile description (optional)"),
      ).toHaveValue("Fresh bio");
      expect(
        screen
          .getByRole("region", { name: "Profile preview" })
          .querySelector("img"),
      ).toHaveAttribute("src", uploaded);
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      refresh.resolve({
        exists: true,
        existing: {},
        profile: { name: "Final", picture: "" },
      });
      upload.resolve(uploaded);
      owner.dispose();
    }
  },
);

it("mounts the already-cached community thumbnail immediately while the profile refresh is pending", async () => {
  const service = communities();
  const key = keypair();
  const picture = `https://primary.example/media/${"c".repeat(64)}.png`;
  const cached = `/api/relay/primary/media?url=${encodeURIComponent(picture.replace(".png", ".thumb.jpg"))}`;
  const event = signedProfile(key, { name: "Cached person", picture });
  const owner = createRelaySession({
    viewer: key.pubkey,
    relayAuthor: key.pubkey,
    media: () => cached,
    query: async () => [event],
  });
  const refresh =
    deferred<Awaited<ReturnType<typeof communityApi.inspectProfile>>>();
  vi.spyOn(communityApi, "inspectProfile").mockReturnValue(refresh.promise);
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    80,
  );
  service.snapshot().viewer = key.pubkey;
  service.snapshot().selected = "primary";
  vi.spyOn(service.relay, "snapshot").mockReturnValue({
    status: "ready",
    viewer: key.pubkey,
    scope: "primary",
    generation: 1,
    session: owner.session,
  });
  try {
    await owner.session.profiles.ensure([key.pubkey]);
    render(
      <ProfileSettings
        communities={service}
        community={{ id: "primary", name: "Primary" }}
      />,
      { wrapper: ToastProvider },
    );
    const image = screen
      .getByRole("region", { name: "Profile preview" })
      .querySelector("img");
    expect(image).toHaveAttribute("src", cached);
    expect(image).toHaveAttribute("data-loaded", "true");
  } finally {
    await act(async () =>
      refresh.resolve({
        exists: true,
        existing: {},
        profile: { name: "Cached person", picture },
      }),
    );
    owner.dispose();
  }
});
