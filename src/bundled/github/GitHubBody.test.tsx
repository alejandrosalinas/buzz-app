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
import { afterEach, expect, it, vi } from "vitest";
import {
  MAX_MARKDOWN_LENGTH,
  MAX_MARKDOWN_DEPTH,
} from "../../features/relay/message-content";
import { GitHubBody } from "./GitHubBody";
import { GitHubPanel } from "./index";

const url = "https://github.com/block/buzz-app/pull/327";
const before =
  "https://github.com/user-attachments/assets/81e77cff-0e61-4694-9a88-add0c1f997e4";
const after =
  "https://github.com/user-attachments/assets/dd1f7e4f-e2a4-4aec-b661-cb45032f29c5";
const image =
  "https://github.com/user-attachments/assets/cd0773ee-9861-46d9-8a0f-352ae951ec7f";
const audio = "https://github.com/user-attachments/files/123/recording.wav";
const signedBefore =
  "https://private-user-images.githubusercontent.com/1888043/659873452-81e77cff-0e61-4694-9a88-add0c1f997e4.mp4?jwt=expired";
const metadata = `<details><summary>before.mp4</summary><video src="${signedBefore}"></video></details><video><source src="${after}" /></video>`;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders GFM and Before/After players without duplicate loaded-media links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={metadata}
      body={`# Summary\n\n**Strong** and *emphasis* with [context](../328).\n\n- item\n- [x] done\n\n> quote\n\n| State | Result |\n| --- | --- |\n| Old | New |\n\n## Before\n\n${before}\n\n## After\n\n[Result recording](${after})`}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Summary", level: 1 }),
  ).toBeVisible();
  expect(container.querySelector("strong")).toHaveTextContent("Strong");
  expect(container.querySelector("em")).toHaveTextContent("emphasis");
  expect(screen.getByRole("link", { name: "context" })).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app/328",
  );
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.getByRole("table")).toHaveTextContent("StateResultOldNew");
  expect(container.querySelector("blockquote")).toHaveTextContent("quote");
  expect(
    [...container.querySelectorAll("h2, video")].map((node) =>
      node.tagName === "VIDEO" ? node.getAttribute("src") : node.textContent,
    ),
  ).toEqual(["Before", before, "After", after]);
  expect(
    screen.getByRole("link", { name: "Result recording" }),
  ).toHaveAttribute("href", after);
  for (const video of container.querySelectorAll("video")) {
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).not.toHaveAttribute("autoplay");
    expect(video.closest("p, a")).toBeNull();
    fireEvent.loadedData(video);
  }
  expect(screen.queryByRole("link", { name: before })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Result recording" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Result recording")).toBeVisible();
});

it("selects images, audio and named attachments while retaining descriptions and file links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={`<a href="${after}">capture.mov</a><audio src="${audio}"></audio>`}
      body={`![Screen description](${image})\n\n<img width="120" alt="HTML image" src="${image}" onerror="alert(1)">\n\n[Audio recording](${audio})\n\n[Movie](${after})\n\n[Archive](https://github.com/user-attachments/files/99/source.zip)`}
    />,
  );
  expect(screen.getByAltText("Screen description")).toHaveAttribute(
    "src",
    image,
  );
  expect(screen.getByAltText("HTML image")).not.toHaveAttribute("onerror");
  expect(container.querySelector("audio")).toHaveAttribute("src", audio);
  expect(container.querySelector("video")).toHaveAttribute("src", after);
  expect(screen.getByRole("link", { name: "Archive" })).toHaveAttribute(
    "href",
    "https://github.com/user-attachments/files/99/source.zip",
  );
  const audioElement = container.querySelector("audio");
  const videoElement = container.querySelector("video");
  if (!audioElement || !videoElement) throw new Error("Missing media");
  fireEvent.loadedData(audioElement);
  fireEvent.loadedData(videoElement);
  fireEvent.load(screen.getByAltText("Screen description"));
  for (const name of ["Screen description", "Audio recording", "Movie"])
    expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Archive" })).toBeVisible();
  fireEvent.error(audioElement);
  fireEvent.error(videoElement);
  fireEvent.error(screen.getByAltText("Screen description"));
  expect(screen.getByText("Audio unavailable")).toBeVisible();
  expect(screen.getByText("Video unavailable")).toBeVisible();
  expect(screen.getByText("Image unavailable")).toBeVisible();
  for (const [name, href] of [
    ["Screen description", image],
    ["Audio recording", audio],
    ["Movie", after],
  ] as const) {
    expect(screen.getByRole("link", { name })).toBeVisible();
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    expect(screen.getByRole("link", { name })).toHaveAttribute(
      "target",
      "_blank",
    );
  }
});

it.each(["Markdown", "HTML"])(
  "%s images preserve alt text without loaded captions",
  (syntax) => {
    for (const alt of ["Image", "Settings showing notifications enabled", ""]) {
      const { container, unmount } = render(
        <GitHubBody
          url={url}
          body={
            syntax === "Markdown"
              ? `Before ![${alt}](${image}) after.`
              : `<div>Before <img src="${image}" alt="${alt}"> after.</div>`
          }
        />,
      );
      const preview = screen.getByAltText(alt);
      expect(preview).toHaveAttribute("alt", alt);
      expect(screen.getByRole("link")).toHaveAttribute("href", image);
      fireEvent.load(preview);
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(container).toHaveTextContent(/^Before after\.$/);
      fireEvent.error(preview);
      expect(screen.getByRole("status")).toHaveTextContent("Image unavailable");
      expect(screen.getByRole("link")).toHaveAttribute("href", image);
      unmount();
    }
  },
);

it.each([
  ["Result screenshot", "Result screenshot"],
  ["**Result *with `details`*** screenshot", "Result with details screenshot"],
  ["", "Attachment preview"],
])(
  "describes image previews and fullscreen from link label %s",
  (label, description) => {
    const source = "https://github.com/user-attachments/files/99/result.png";
    const { container } = render(
      <GitHubBody
        url={url}
        body={`See [${label}](${source}) for the result.`}
      />,
    );
    const preview = screen.getByAltText(description);
    expect(screen.getByRole("link")).toHaveAttribute("href", source);
    fireEvent.load(preview);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container).toHaveTextContent(
      `See ${label ? description : ""} for the result.`.replace(/ +/g, " "),
    );
    if (label.includes("**")) {
      expect(container.querySelector("strong")).toHaveTextContent(
        "Result with details",
      );
      expect(container.querySelector("em code")).toHaveTextContent("details");
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Open image fullscreen" }),
    );
    expect(
      within(screen.getByRole("dialog")).getByAltText(description),
    ).toHaveAttribute("src", source);
    fireEvent.click(
      screen.getByRole("button", { name: "Close fullscreen viewer" }),
    );
    fireEvent.error(preview);
    expect(screen.getByRole("link")).toHaveAttribute("href", source);
  },
);

it("keeps original links when media fails before loading", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={metadata}
      body={`${before}\n\n![Screenshot](${image})\n\n[Audio](${audio})`}
    />,
  );
  for (const media of container.querySelectorAll("video, img, audio"))
    fireEvent.error(media);
  // The video has a signed link in the rendered HTML; it fails too.
  const video = container.querySelector("video") as HTMLVideoElement;
  expect(video).toHaveAttribute("src", signedBefore);
  fireEvent.error(video);
  expect(screen.getAllByRole("status")).toHaveLength(3);
  for (const [name, href] of [
    [before, before],
    ["Screenshot", image],
    ["Audio", audio],
  ] as const) {
    expect(screen.getByRole("link", { name })).toBeVisible();
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
  }
});

const signedImage = (jwt: string) =>
  `https://private-user-images.githubusercontent.com/1888043/1-cd0773ee-9861-46d9-8a0f-352ae951ec7f.png?jwt=${jwt}`;
const signedVideo = (jwt: string) => signedBefore.replace("expired", jwt);
const signedHtml = (jwt: string) =>
  `<p><a href="${signedImage(jwt)}"><img src="${signedImage(jwt)}" alt="Screenshot"></a></p><video src="${signedVideo(jwt)}"></video>`;
const signedBody = `![Screenshot](${image})\n\n${before}`;

it("takes a signed link only when media's own link fails, renewing it when that fails too", async () => {
  const read = deferred<void>();
  const refresh = vi.fn(() => read.promise);
  const { container, rerender } = render(
    <GitHubBody
      url={url}
      body={signedBody}
      bodyHtml={signedHtml("1")}
      refresh={refresh}
    />,
  );
  const video = container.querySelector("video") as HTMLVideoElement;
  // Media loads its own link first, as for a public repository.
  expect(screen.getByAltText("Screenshot")).toHaveAttribute("src", image);
  expect(video).toHaveAttribute("src", before);
  fireEvent.loadedData(video);
  fireEvent.error(screen.getByAltText("Screenshot"));
  expect(screen.getByAltText("Screenshot")).toHaveAttribute(
    "src",
    signedImage("1"),
  );
  expect(refresh).not.toHaveBeenCalled();
  // The signed link failing reads again; the original link remains meanwhile.
  fireEvent.error(screen.getByAltText("Screenshot"));
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByRole("link", { name: "Screenshot" })).toHaveAttribute(
    "href",
    image,
  );
  rerender(
    <GitHubBody
      url={url}
      body={signedBody}
      bodyHtml={signedHtml("2")}
      refresh={refresh}
    />,
  );
  expect(screen.getByAltText("Screenshot")).toHaveAttribute(
    "src",
    signedImage("2"),
  );
  // The loaded video keeps its element and link, so it does not restart.
  expect(container.querySelector("video")).toBe(video);
  expect(video).toHaveAttribute("src", before);
  await act(async () => read.resolve());
  // A renewed link that fails before loading does not read again at once.
  fireEvent.error(screen.getByAltText("Screenshot"));
  expect(refresh).toHaveBeenCalledOnce();
});

it("reads again after a failed renewal, one read at a time", async () => {
  const signedAfter =
    "https://private-user-images.githubusercontent.com/1888043/2-dd1f7e4f-e2a4-4aec-b661-cb45032f29c5.mp4?jwt=1";
  const first = deferred<void>();
  const refresh = vi
    .fn<() => Promise<void>>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(undefined);
  const { container } = render(
    <GitHubBody
      url={url}
      body={`${signedBody}\n\n${after}`}
      bodyHtml={`${signedHtml("1")}<video src="${signedAfter}"></video>`}
      refresh={refresh}
    />,
  );
  const videos = () => [...container.querySelectorAll("video")];
  // Each takes its signed link when its own fails, and loads it.
  for (const media of [screen.getByAltText("Screenshot"), ...videos()])
    fireEvent.error(media);
  const [video, later] = videos();
  if (!video || !later) throw new Error("Expected both videos");
  expect(later).toHaveAttribute("src", signedAfter);
  fireEvent.loadedData(video);
  fireEvent.loadedData(later);
  fireEvent.error(screen.getByAltText("Screenshot"));
  // Media failing while a read is in flight waits for that read.
  fireEvent.error(video);
  expect(refresh).toHaveBeenCalledOnce();
  await act(async () => first.reject(new Error("offline")));
  // The read failed and nothing changed; media that expires later still
  // reads again.
  fireEvent.error(later);
  expect(refresh).toHaveBeenCalledTimes(2);
});

const privateImage = (jwt: string) =>
  `<img src="${signedImage(jwt)}" alt="Screenshot">`;
const privateBody = `![Screenshot](${image})`;
const settle = () => act(async () => {});
const fail = (element: HTMLMediaElement, code: number) => {
  Object.defineProperty(element, "error", {
    configurable: true,
    value: { code },
  });
  fireEvent.error(element);
};
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
// Its own link fails, then its signed link: one read.
const failTwice = () => {
  fireEvent.error(screen.getByAltText("Screenshot"));
  fireEvent.error(screen.getByAltText("Screenshot"));
};

it("reads again 30 seconds after a failed renewal, three times at most", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(() => Promise.reject(new Error("Not Found")));
  render(
    <GitHubBody
      url={url}
      body={privateBody}
      bodyHtml={privateImage("1")}
      refresh={refresh}
    />,
  );
  failTwice();
  expect(refresh).toHaveBeenCalledOnce();
  await settle();
  await wait(29_999);
  expect(refresh).toHaveBeenCalledOnce();
  await wait(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  await wait(30_000);
  await wait(30_000);
  expect(refresh).toHaveBeenCalledTimes(4);
  // Then it stops, leaving the original link.
  await wait(5 * 60_000);
  expect(refresh).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.getByRole("link", { name: "Screenshot" })).toHaveAttribute(
    "href",
    image,
  );
});

it("stops retrying once a renewed link loads, without refilling its retries", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const refresh = vi.fn(async () => {
    reads += 1;
    if (reads !== 2) throw new Error("Not Found");
    view.rerender(
      <GitHubBody
        url={url}
        body={privateBody}
        bodyHtml={privateImage("2")}
        refresh={refresh}
      />,
    );
  });
  const view = render(
    <GitHubBody
      url={url}
      body={privateBody}
      bodyHtml={privateImage("1")}
      refresh={refresh}
    />,
  );
  failTwice();
  await settle();
  await wait(30_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(screen.getByAltText("Screenshot")).toHaveAttribute(
    "src",
    signedImage("2"),
  );
  fireEvent.load(screen.getByAltText("Screenshot"));
  await wait(5 * 60_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  // When it expires later it already had its read at once; it waits and
  // uses only the two retries left.
  fireEvent.error(screen.getByAltText("Screenshot"));
  expect(refresh).toHaveBeenCalledTimes(2);
  await wait(30_000);
  expect(refresh).toHaveBeenCalledTimes(3);
  await wait(5 * 60_000);
  expect(refresh).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});

it("caps reads for media that loads and then fails on each link", async () => {
  vi.useFakeTimers();
  const privateVideo = (jwt: string) =>
    `<video src="${signedVideo(jwt)}"></video>`;
  let reads = 0;
  // Every read brings a new link, which also loads and then fails.
  const refresh = vi.fn(async () => {
    reads += 1;
    view.rerender(
      <GitHubBody
        url={url}
        body={before}
        bodyHtml={privateVideo(String(reads + 1))}
        refresh={refresh}
      />,
    );
  });
  const view = render(
    <GitHubBody
      url={url}
      body={before}
      bodyHtml={privateVideo("1")}
      refresh={refresh}
    />,
  );
  const video = () => view.container.querySelector("video");
  fireEvent.error(video() as HTMLVideoElement);
  expect(video()).toHaveAttribute("src", signedVideo("1"));
  // Each link loads, then fails, which leaves it unavailable until a newer
  // link replaces it.
  let cycles = 0;
  for (let shown = video(); cycles < 8 && shown; shown = video()) {
    fireEvent.loadedData(shown);
    fireEvent.error(shown);
    cycles += 1;
    await settle();
    await wait(30_000);
  }
  expect(cycles).toBe(5);
  // One read at once for the source, then three retries; then none.
  expect(refresh).toHaveBeenCalledTimes(4);
  await wait(10 * 60_000);
  expect(refresh).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not refill retries when other media loads", async () => {
  vi.useFakeTimers();
  const working = `https://private-user-images.githubusercontent.com/1888043/2-dd1f7e4f-e2a4-4aec-b661-cb45032f29c5.png?jwt=1`;
  const refresh = vi.fn(() => Promise.reject(new Error("Not Found")));
  render(
    <GitHubBody
      url={url}
      body={`${privateBody}\n\n![Working](${after})`}
      bodyHtml={`${privateImage("1")}<img src="${working}" alt="Working">`}
      refresh={refresh}
    />,
  );
  failTwice();
  await settle();
  await wait(30_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  // Another image loads its signed link, then loads again (as a fullscreen
  // viewer's copy would), between retries.
  fireEvent.error(screen.getByAltText("Working"));
  expect(screen.getByAltText("Working")).toHaveAttribute("src", working);
  for (let load = 0; load < 3; load++) {
    fireEvent.load(screen.getByAltText("Working"));
    await wait(30_000);
  }
  await wait(10 * 60_000);
  expect(refresh).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a pending retry on unmount, and schedules none after it", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(() => Promise.reject(new Error("Not Found")));
  const first = render(
    <GitHubBody
      url={url}
      body={privateBody}
      bodyHtml={privateImage("1")}
      refresh={refresh}
    />,
  );
  failTwice();
  await settle();
  expect(vi.getTimerCount()).toBe(1);
  first.unmount();
  expect(vi.getTimerCount()).toBe(0);
  await wait(60_000);
  expect(refresh).toHaveBeenCalledOnce();

  const read = deferred<void>();
  const pending = vi.fn(() => read.promise);
  const second = render(
    <GitHubBody
      url={url}
      body={privateBody}
      bodyHtml={privateImage("1")}
      refresh={pending}
    />,
  );
  failTwice();
  second.unmount();
  await act(async () => read.reject(new Error("Not Found")));
  expect(vi.getTimerCount()).toBe(0);
  await wait(60_000);
  expect(pending).toHaveBeenCalledOnce();
});

it("never schedules a retry for public media or media whose own link loads", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(() => Promise.reject(new Error("Not Found")));
  render(
    <GitHubBody
      url={url}
      body={`![Asset](${image})\n\n![Screenshot](${after})`}
      bodyHtml={`<img src="${image}" alt="Asset"><img src="https://private-user-images.githubusercontent.com/1888043/2-dd1f7e4f-e2a4-4aec-b661-cb45032f29c5.png?jwt=1" alt="Screenshot">`}
      refresh={refresh}
    />,
  );
  fireEvent.error(screen.getByAltText("Asset"));
  fireEvent.load(screen.getByAltText("Screenshot"));
  expect(screen.getByAltText("Screenshot")).toHaveAttribute("src", after);
  await settle();
  expect(vi.getTimerCount()).toBe(0);
  await wait(5 * 60_000);
  expect(refresh).not.toHaveBeenCalled();
});

it("leaves network failures on a signed video to the player's quiet reload", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {});
  const view = render(
    <GitHubBody
      url={url}
      body={`[Movie](${before})`}
      bodyHtml={`<video src="${signedVideo("1")}"></video>`}
      refresh={refresh}
    />,
  );
  const video = () => view.container.querySelector("video") as HTMLVideoElement;
  const movie = () => screen.queryByRole("link", { name: "Movie" });
  fail(video(), 4);
  const signed = video();
  expect(signed).toHaveAttribute("src", signedVideo("1"));
  fireEvent.loadedData(signed);
  expect(movie()).not.toBeInTheDocument();
  // A network blip neither reads again nor remounts the player, and shows
  // the original link until the video loads again.
  fail(signed, 2);
  await settle();
  expect(video()).toBe(signed);
  expect(movie()).toHaveAttribute("href", before);
  fireEvent.loadedMetadata(signed);
  expect(movie()).not.toBeInTheDocument();
  // When the player's own reloads give up, the original link stays and the
  // panel still reads nothing.
  fail(signed, 2);
  await wait(5 * 60_000);
  expect(screen.getByText("Video unavailable")).toBeVisible();
  expect(movie()).toHaveAttribute("href", before);
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("shows the original link when loaded audio fails on a network error", () => {
  const { container } = render(
    <GitHubBody url={url} body={`[Audio recording](${audio})`} />,
  );
  const element = container.querySelector("audio");
  if (!element) throw new Error("Missing audio");
  fireEvent.loadedData(element);
  expect(
    screen.queryByRole("link", { name: "Audio recording" }),
  ).not.toBeInTheDocument();
  fail(element, 2);
  expect(screen.getByText("Audio unavailable")).toBeVisible();
  expect(screen.getByRole("link", { name: "Audio recording" })).toHaveAttribute(
    "href",
    audio,
  );
});

it("tries a link a poll delivers before the retry instead of reading again", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(() => Promise.reject(new Error("Not Found")));
  const { rerender } = render(
    <GitHubBody
      url={url}
      body={privateBody}
      bodyHtml={privateImage("1")}
      refresh={refresh}
    />,
  );
  failTwice();
  await settle();
  await wait(10_000);
  // A PR poll brings a newer link; the failed image takes it.
  rerender(
    <GitHubBody
      url={url}
      body={privateBody}
      bodyHtml={privateImage("2")}
      refresh={refresh}
    />,
  );
  expect(screen.getByAltText("Screenshot")).toHaveAttribute(
    "src",
    signedImage("2"),
  );
  // Still loading when the retry is due: nothing is read.
  await wait(20_000);
  expect(refresh).toHaveBeenCalledOnce();
  fireEvent.load(screen.getByAltText("Screenshot"));
  await wait(5 * 60_000);
  expect(refresh).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps public and raw media on their own links without reading again", () => {
  const raw = "https://raw.githubusercontent.com/block/buzz-app/main/icon.png";
  const refresh = vi.fn();
  render(
    <GitHubBody
      url={url}
      body={`![Asset](${image})\n\n![Raw](${raw})`}
      bodyHtml={`<img src="${image}" alt="Asset"><img src="https://camo.githubusercontent.com/1/2" data-canonical-src="${raw}" alt="Raw">`}
      refresh={refresh}
    />,
  );
  for (const [name, source] of [
    ["Asset", image],
    ["Raw", raw],
  ] as const) {
    expect(screen.getByAltText(name)).toHaveAttribute("src", source);
    fireEvent.error(screen.getByAltText(name));
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", source);
  }
  expect(refresh).not.toHaveBeenCalled();
});

it("preserves HTML-only summaries, prose and file links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={
        '<details><summary>Supporting evidence</summary><p>Read the logs &amp; notes.</p><a href="../files/report.zip">Download report</a></details>'
      }
    />,
  );
  expect(container).toHaveTextContent(
    "Supporting evidence Read the logs & notes. Download report",
  );
  expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app/files/report.zip",
  );
  expect(container.querySelector("details, summary")).toBeNull();
});

it("keeps mixed HTML text, images and attachment links in order after loading and failure", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={`<div><p>Before the screenshot.</p><img src="${image}" alt="HTML screenshot" onerror="alert(1)"><p>After the screenshot.</p><a href="https://github.com/user-attachments/files/99/source.zip">Source archive</a></div>`}
    />,
  );
  const screenshot = screen.getByAltText("HTML screenshot");
  expect(screenshot).toHaveAttribute("src", image);
  expect(screenshot).not.toHaveAttribute("onerror");
  expect(container).toHaveTextContent(
    "Before the screenshot. HTML screenshot After the screenshot. Source archive",
  );
  fireEvent.load(screenshot);
  expect(screen.queryByRole("link", { name: "HTML screenshot" })).toBeNull();
  fireEvent.error(screenshot);
  expect(screen.getByRole("link", { name: "HTML screenshot" })).toHaveAttribute(
    "href",
    image,
  );
  expect(container).toHaveTextContent("Before the screenshot.");
  expect(container).toHaveTextContent("After the screenshot.");
  expect(screen.getByRole("link", { name: "Source archive" })).toHaveAttribute(
    "href",
    "https://github.com/user-attachments/files/99/source.zip",
  );
});

it.each([
  `<video src="${before}">Recording fallback</video>`,
  `<video><source src="${before}">Recording fallback</video>`,
  `<audio src="${before}">Recording fallback</audio>`,
])(
  "retains raw media destinations without requiring API metadata: %s",
  (body) => {
    const { container } = render(<GitHubBody url={url} body={body} />);
    expect(screen.getByRole("link", { name: before })).toHaveAttribute(
      "href",
      before,
    );
    expect(container).toHaveTextContent("Recording fallback");
  },
);

it("preserves HTML link labels while rejecting unsafe destinations and attributes", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={
        '<div onclick="alert(1)"><a href="javascript:alert(1)">Unsafe action</a><a href="data:text/html,bad">Unsafe data</a><a href="https://user:password@example.com/file">Credential URL</a><a href="https://example.com/report.zip" onclick="alert(1)">Safe file</a></div>'
      }
    />,
  );
  for (const label of ["Unsafe action", "Unsafe data", "Credential URL"])
    expect(container).toHaveTextContent(label);
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Safe file" })).toHaveAttribute(
    "href",
    "https://example.com/report.zip",
  );
  expect(container.querySelector("[onclick]")).toBeNull();
});

it("keeps inline HTML anchor labels linked within surrounding prose", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={'See <a href="https://example.com/docs">the docs</a> now.'}
    />,
  );
  expect(container).toHaveTextContent("See the docs now.");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute(
    "href",
    "https://example.com/docs",
  );
});

it("separates adjacent HTML table header and data cells", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={
        "<table><tr><th>Before</th><th>After</th></tr><tr><td>old</td><td>new</td></tr></table>"
      }
    />,
  );
  expect(container).toHaveTextContent("Before After");
  expect(container).toHaveTextContent("old new");
});

it("preserves single line breaks alongside paragraphs, lists and code blocks", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={
        "First requirement.\nSecond requirement.\nThird requirement.\n\nSeparate paragraph.\n\n- one\n- two\n\n```\nline one\nline two\n```"
      }
    />,
  );
  const code = container.querySelector("pre code");
  expect(code).toHaveTextContent(/line one\s+line two/);
  expect(code?.querySelector("br")).toBeNull();
  expect(container.querySelectorAll("br")).toHaveLength(2);
  expect(screen.getByText(/First requirement\./).innerHTML).toMatch(
    /First requirement\.<br>.*Second requirement\.<br>.*Third requirement\./s,
  );
  expect(screen.getByText("Separate paragraph.")).toBeVisible();
  expect(
    [...container.querySelectorAll("li")].map((item) => item.textContent),
  ).toEqual(["one", "two"]);
});

it("preserves surrounding prose and formatted labels after an inline video loads", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={metadata}
      body={`See [**the corrected behavior**](${before}) for the result.`}
    />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video");
  fireEvent.loadedData(video);
  expect(container).toHaveTextContent("See");
  expect(container.querySelector("strong")).toHaveTextContent(
    "the corrected behavior",
  );
  expect(container).toHaveTextContent("for the result.");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("never interprets literal code or executes HTML and unsafe links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      bodyHtml={metadata}
      body={`\`${before}\`\n\n\`\`\`html\n<img src="${image}">\n${after}\n\`\`\`\n\n<script>alert(1)</script>\n\n<iframe src="https://evil.test"></iframe>\n\n[Bad](javascript:alert%281%29) ![Unsafe](data:image/svg+xml,bad)\n\n<img src="https://github.com.evil.test/image.png" alt="External">`}
    />,
  );
  expect(container.querySelectorAll("code")).toHaveLength(2);
  expect(container.querySelector("pre")).toHaveTextContent(after);
  expect(
    container.querySelector("script, iframe, video, img, audio"),
  ).toBeNull();
  expect(
    container.querySelector('a[href^="javascript:"], a[href^="data:"]'),
  ).toBeNull();
  expect(screen.getByRole("link", { name: "External" })).toHaveAttribute(
    "href",
    "https://github.com.evil.test/image.png",
  );
});

it("does not guess UUID media types or match asset IDs embedded in unrelated paths", () => {
  const { container, rerender } = render(
    <GitHubBody url={url} body={before} />,
  );
  expect(container.querySelector("video")).toBeNull();
  expect(screen.getByRole("link")).toHaveAttribute("href", before);
  rerender(
    <GitHubBody
      url={url}
      body={before}
      bodyHtml='<video src="https://private-user-images.githubusercontent.com/1888043/prefix-81e77cff-0e61-4694-9a88-add0c1f997e4.mp4"></video>'
    />,
  );
  expect(container.querySelector("video")).toBeNull();
});

it.each([`![Linked image](${image})`, `**![Linked image](${image})**`])(
  "keeps linked Markdown images out of anchors and preserves both destinations: %s",
  (content) => {
    const { container } = render(
      <GitHubBody
        url={url}
        body={`[${content}](https://example.com/review)`}
      />,
    );
    expect(screen.getByAltText("Linked image").closest("a, p")).toBeNull();
    expect(screen.getByRole("link", { name: "Linked image" })).toHaveAttribute(
      "href",
      image,
    );
    expect(
      screen.getByRole("link", { name: "https://example.com/review" }),
    ).toBeVisible();
    fireEvent.load(screen.getByAltText("Linked image"));
    expect(
      screen.queryByRole("link", { name: "Linked image" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "https://example.com/review" }),
    ).toBeVisible();
    expect(container.querySelector("a a")).toBeNull();
  },
);

it("preserves linked HTML images and media fallback destinations without nested links", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={`<div><a href="https://example.com/review"><img src="${image}" alt="Linked HTML image"></a><a href="https://example.com/recording"><video src="${before}">Recording</video></a></div>`}
    />,
  );
  expect(screen.getByAltText("Linked HTML image")).toHaveAttribute(
    "src",
    image,
  );
  for (const destination of [
    "https://example.com/review",
    "https://example.com/recording",
    before,
  ])
    expect(screen.getByRole("link", { name: destination })).toHaveAttribute(
      "href",
      destination,
    );
  expect(container.querySelector("a a, a img")).toBeNull();
});

it("preserves deeply nested HTML as literal text beyond the parsing budget", () => {
  const { container } = render(
    <GitHubBody
      url={url}
      body={`${"<div>".repeat(MAX_MARKDOWN_DEPTH + 2)}Deep evidence<img src="${image}">${"</div>".repeat(MAX_MARKDOWN_DEPTH + 2)}`}
    />,
  );
  expect(container).toHaveTextContent(`Deep evidence<img src="${image}">`);
  expect(container.querySelector("img")).toBeNull();
});

it.each([
  "x".repeat(MAX_MARKDOWN_LENGTH + 1),
  `${"> ".repeat(MAX_MARKDOWN_DEPTH + 1)}deep`,
])("uses a literal fallback for over-budget Markdown", (body) => {
  const { container } = render(
    <GitHubBody url={url} body={body} bodyHtml={metadata} />,
  );
  expect(container.textContent).toBe(body);
  expect(container.querySelector("blockquote, video")).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("ignores retired PR loads, retries errors, and clears media when navigating", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const retry = deferred<Response>();
  const fetch = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(retry.promise);
  vi.stubGlobal("fetch", fetch);
  const { container, rerender } = render(
    <GitHubPanel target={url} close={() => {}} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  rerender(<GitHubPanel target={`${url}0`} close={() => {}} />);
  // The store reads one batch at a time: the next PR is read once the
  // retired one's read is in.
  await act(async () => {
    first.resolve(
      new Response(
        JSON.stringify({
          title: "Retired PR",
          body: before,
          body_html: metadata,
        }),
      ),
    );
    await first.promise;
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByRole("heading", { name: "Retired PR #327" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await act(async () => {
    second.resolve(new Response(null, { status: 400 }));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("400");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await act(async () => {
    retry.resolve(
      new Response(
        JSON.stringify({
          title: "Current PR",
          body: before,
          body_html: metadata,
        }),
      ),
    );
  });
  expect(
    screen.getByRole("heading", { name: "Current PR #3270" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Description" }),
  ).not.toBeInTheDocument();
  expect(container.querySelector("video")).toHaveAttribute("src", before);
  const next = deferred<Response>();
  fetch.mockReturnValueOnce(next.promise);
  rerender(<GitHubPanel target={`${url}1`} close={() => {}} />);
  expect(container.querySelector("video")).toBeNull();
  await act(async () => {
    next.resolve(
      new Response(JSON.stringify({ title: "No metadata", body: before })),
    );
  });
  expect(
    screen.getByRole("heading", { name: "No metadata #3271" }),
  ).toBeVisible();
  expect(container.querySelector("video")).toBeNull();
  expect(screen.getByRole("link", { name: before })).toBeVisible();
});

it("reads the pull request again when its signed image fails", async () => {
  const signed = (read: number) =>
    `https://private-user-images.githubusercontent.com/1/2-cd0773ee-9861-46d9-8a0f-352ae951ec7f.png?jwt=${read}`;
  let reads = 0;
  const fetch = vi.fn(async () => {
    reads += 1;
    return new Response(
      JSON.stringify({
        title: "Private PR",
        body: `![Screenshot](${image})`,
        body_html: `<img src="${signed(reads)}" alt="Screenshot">`,
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  render(<GitHubPanel target={url} close={() => {}} />);
  fireEvent.error(await screen.findByAltText("Screenshot"));
  expect(screen.getByAltText("Screenshot")).toHaveAttribute("src", signed(1));
  fireEvent.error(screen.getByAltText("Screenshot"));
  await waitFor(() =>
    expect(screen.getByAltText("Screenshot")).toHaveAttribute("src", signed(2)),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps a shown issue when reading it again for its signed image fails", async () => {
  const issue = "https://github.com/block/buzz-app/issues/5";
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "Private issue",
          body: `![Screenshot](${image})`,
          body_html: `<img src="${signedImage("1")}" alt="Screenshot">`,
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  render(<GitHubPanel target={issue} close={() => {}} />);
  fireEvent.error(await screen.findByAltText("Screenshot"));
  fireEvent.error(screen.getByAltText("Screenshot"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Private issue" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Screenshot" })).toHaveAttribute(
    "href",
    image,
  );
});
