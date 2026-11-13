import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import { watchPageErrors } from "./page-errors.mjs";
import { relayBrokerPlugin } from "../../browser-host/relay-broker.mjs";
import { fixtureAliases, fixtureRelayUrl } from "../relay-config.ts";

// 1x1 PNGs; distinct bytes give distinct Blossom hashes.
const png = (red) =>
  Buffer.from(
    red
      ? "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
      : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==",
    "base64",
  );

function matches(event, filter) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since && event.created_at < filter.since) return false;
  if (filter.until && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter))
    if (
      key.startsWith("#") &&
      !event.tags.some(
        ([name, value]) => `#${name}` === key && values.includes(value),
      )
    )
      return false;
  return true;
}

/** Local upstream relay: NIP-01 socket, HTTP query, Blossom upload and media. No network. */
function localRelay(relayKey, viewer) {
  const memberKey = generateSecretKey();
  const stores = new Map();
  const blobs = new Map();
  const sockets = new Set();
  const report = { publications: [], rejections: [], uploads: [] };
  let rejectPublications = 0;
  let rejectUploads = 0;
  const events = (community) => {
    if (!stores.has(community)) {
      const relayEvent = (template) =>
        finalizeEvent(
          { created_at: 1700000000, content: "", ...template },
          relayKey,
        );
      stores.set(community, [
        finalizeEvent(
          {
            kind: 30030,
            created_at: 1700000000,
            content: "",
            tags: [
              ["d", "buzz:custom-emoji"],
              ...["community_bee", "community_party"].map((name) => [
                "emoji",
                name,
                `${community}/media/member.png`,
              ]),
            ],
          },
          memberKey,
        ),
        relayEvent({
          kind: 39002,
          tags: [
            ["d", "c"],
            ["p", viewer],
          ],
        }),
        relayEvent({
          kind: 39000,
          content: JSON.stringify({ name: "general" }),
          tags: [
            ["d", "c"],
            ["name", "general"],
          ],
        }),
      ]);
      blobs.set(`${community}/media/member.png`, png(true));
    }
    return stores.get(community);
  };
  const query = (community, filters) =>
    filters.flatMap((filter) =>
      events(community)
        .filter((event) => matches(event, filter))
        .toSorted((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit ?? Infinity),
    );
  function store(community, event) {
    const list = events(community);
    if (event.kind >= 30000 && event.kind < 40000) {
      const d = event.tags.find(([name]) => name === "d")?.[1];
      const index = list.findIndex(
        (item) =>
          item.kind === event.kind &&
          item.pubkey === event.pubkey &&
          item.tags.find(([name]) => name === "d")?.[1] === d,
      );
      if (index >= 0) list.splice(index, 1);
    }
    list.push(event);
    for (const socket of sockets)
      if (socket.community === community)
        for (const [id, filters] of socket.subscriptions)
          if (filters.some((filter) => matches(event, filter)))
            socket.emit(["EVENT", id, event]);
  }
  return {
    report,
    stored: (community) => events(community),
    rejectNextPublication: () => rejectPublications++,
    rejectNextUpload: () => rejectUploads++,
    async fetch(url, init) {
      const { origin, pathname } = new URL(String(url));
      if (pathname === "/upload") {
        const bytes = Buffer.concat(await Array.fromAsync(init.body));
        if (rejectUploads) {
          rejectUploads--;
          return new Response("rejected", { status: 400 });
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const media = `${origin}/media/${sha256}.png`;
        blobs.set(media, bytes);
        report.uploads.push({
          community: origin,
          url: media,
          size: bytes.length,
        });
        return Response.json({
          url: media,
          sha256,
          size: bytes.length,
          type: "image/png",
          uploaded: 1700000000,
        });
      }
      if (pathname.startsWith("/media/")) {
        // Blossom serves a thumbnail beside each blob; model it with the original bytes.
        const bytes = blobs.get(
          `${origin}${pathname.replace(/\.thumb\.jpg$/, ".png")}`,
        );
        return bytes
          ? new Response(bytes, { headers: { "Content-Type": "image/png" } })
          : new Response("missing", { status: 404 });
      }
      if (pathname === "/query")
        return Response.json(query(origin, JSON.parse(init.body)));
      return Response.json({});
    },
    socket(url) {
      const community = String(url)
        .replace(/^wss:/, "https:")
        .replace(/\/$/, "");
      const socket = {
        community,
        readyState: 1,
        subscriptions: new Map(),
        emit(frame) {
          if (socket.readyState === 1)
            queueMicrotask(() =>
              socket.onmessage?.({ data: JSON.stringify(frame) }),
            );
        },
        send(text) {
          const [kind, value, ...rest] = JSON.parse(text);
          if (kind === "AUTH") socket.emit(["OK", value.id, true, ""]);
          if (kind === "REQ") {
            socket.subscriptions.set(value, rest);
            for (const event of query(community, rest))
              socket.emit(["EVENT", value, event]);
            socket.emit(["EOSE", value]);
          }
          if (kind === "CLOSE") socket.subscriptions.delete(value);
          if (kind === "EVENT") {
            if (!verifyEvent(value) || value.pubkey !== viewer) {
              socket.emit(["OK", value.id, false, "invalid: fixture"]);
              return;
            }
            if (rejectPublications) {
              rejectPublications--;
              report.rejections.push({ community, event: value });
              socket.emit(["OK", value.id, false, "blocked: fixture"]);
              return;
            }
            report.publications.push({ community, event: value });
            socket.emit(["OK", value.id, true, ""]);
            store(community, value);
          }
        },
        close() {
          socket.readyState = 3;
          sockets.delete(socket);
          socket.onclose?.();
        },
      };
      sockets.add(socket);
      socket.emit(["AUTH", "fixture"]);
      return socket;
    },
  };
}

test("adds custom emoji through the production broker, then uses, replaces, retries and scopes them", async ({
  page,
}, testInfo) => {
  const userKey = generateSecretKey();
  const relayKey = generateSecretKey();
  const viewer = getPublicKey(userKey);
  const relay = localRelay(relayKey, viewer);
  let server;
  try {
    server = await createServer({
      root: fileURLToPath(new URL("../../", import.meta.url)),
      configFile: false,
      envFile: false,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [
        react(),
        {
          name: "custom-emoji-broker",
          async configureServer(vite) {
            await relayBrokerPlugin({
              archiveFile: ":memory:",
              relayUrl: fixtureRelayUrl,
              communityAliases: fixtureAliases,
              identity: () => userKey.slice(),
              agentLibrary: () => ({ definitions: [], identities: [] }),
              authority: async () => ({ relayAuthor: getPublicKey(relayKey) }),
              upstreamFetch: relay.fetch,
              socketFactory: relay.socket,
            }).configureServer(vite);
          },
        },
      ],
    });
    await server.listen();
    const errors = watchPageErrors(page);
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await page.goto(`${origin}/tests/fixtures/custom-emoji.html`);
    const primary = "https://primary.example";
    const secondary = "https://secondary.example";
    const upload = page.getByLabel("Upload image");
    const name = page.getByPlaceholder("party-parrot");
    const save = page.getByRole("button", { name: "Save emoji" });
    const draft = page.getByRole("textbox", { name: "Message #general" });
    // The emoji typeahead lists custom matches while its Unicode search is
    // pending ("Searching emoji…"), then republishes; a click on the interim
    // list is not accepted, so choose only from the settled list.
    const searching = page.getByText("Searching emoji…");
    const ownSet = (community) =>
      relay
        .stored(community)
        .find((event) => event.kind === 30030 && event.pubkey === viewer);

    await expect(
      page.getByRole("heading", { name: "Community primary.example" }),
    ).toBeVisible();
    await expect(name).toHaveCount(0);
    await expect(save).toHaveCount(0);
    const mineTab = page.getByRole("tab", { name: "My emojis", exact: true });
    await mineTab.click();
    await expect(page.getByText("No emojis yet")).toBeVisible();
    await mineTab.press("ArrowLeft");
    const addTab = page.getByRole("tab", { name: "Add emoji", exact: true });
    await expect(addTab).toBeFocused();
    await addTab.press("Enter");
    await expect(addTab).toHaveAttribute("aria-selected", "true");
    await page.screenshot({
      path: testInfo.outputPath("add-emoji-empty.png"),
      fullPage: true,
    });

    // Upload failure, then retry.
    relay.rejectNextUpload();
    await upload.setInputFiles({
      name: "Party Parrot.png",
      mimeType: "image/png",
      buffer: png(true),
    });
    await expect(page.getByRole("alert")).toHaveText(
      "The server could not accept this file. Its format or metadata may not be supported.",
    );
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("form", { name: "Add emoji" })
      .locator("button")
      .filter({ hasText: "Upload image" })
      .click();
    await (await chooser).setFiles({
      name: "Party Parrot.png",
      mimeType: "image/png",
      buffer: png(true),
    });
    await expect(
      page.getByRole("img", { name: "Selected custom emoji preview" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Choose different image" }),
    ).toBeFocused();
    await expect(name).toHaveValue("party_parrot");
    const first = relay.report.uploads.at(-1).url;

    // Publish failure keeps the draft; retry publishes the own set.
    relay.rejectNextPublication();
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("Failed to add emoji.");
    await expect(save).toBeEnabled();
    expect(relay.report.rejections).toHaveLength(1);
    expect(ownSet(primary)).toBeUndefined();
    await save.click();
    await expect(page.getByText("Added :party_parrot:")).toBeVisible();
    await expect(
      page
        .getByRole("form", { name: "Add emoji" })
        .locator("button")
        .filter({ hasText: "Upload image" }),
    ).toBeFocused();
    await expect(name).toHaveCount(0);
    await expect(page.getByText("My emojis (1)")).toBeVisible();
    const added = ownSet(primary);
    expect(added.tags).toEqual([
      ["d", "buzz:custom-emoji"],
      ["emoji", "party_parrot", first],
    ]);
    expect(verifyEvent(added)).toBe(true);

    // Reload: a new page and session read the stored set through the broker.
    await page.reload();
    await page.getByRole("tab", { name: "My emojis (1)" }).click();
    await expect(
      page.getByRole("tabpanel", { name: "My emojis (1)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: ":party_parrot:" }).first(),
    ).toBeVisible();

    // Typeahead, then send a message that renders the new image.
    await draft.fill(":party_par");
    const suggestion = page.getByRole("option", {
      name: ":party_parrot:",
      exact: true,
    });
    await expect(suggestion).toBeVisible();
    await expect(searching).toHaveCount(0);
    await suggestion.click();
    await expect(draft).toHaveJSProperty("value", ":party_parrot: ");
    await draft.press("Enter");
    const row = page.locator("[data-message-id]").first();
    await expect(row.locator('img[alt=":party_parrot:"]')).toBeVisible();
    await expect
      .poll(
        () =>
          relay.report.publications.filter(({ event }) => event.kind === 9)
            .length,
      )
      .toBe(1);
    expect(
      relay.report.publications.find(({ event }) => event.kind === 9).event
        .tags,
    ).toContainEqual(["emoji", "party_parrot", first]);

    // Picker inserts it.
    await page
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    await page
      .getByRole("searchbox", { name: "Search emoji" })
      .fill("party_parrot");
    await page
      .getByRole("button", { name: ":party_parrot:", exact: true })
      .click();
    await expect(draft).toHaveJSProperty("value", ":party_parrot: ");
    await draft.fill("");

    // Reaction with it.
    await hoverMessage(row);
    await row
      .getByRole("group", { name: "Message actions", includeHidden: true })
      .getByRole("button", { name: "Add reaction", exact: true })
      .click();
    await page
      .locator('em-emoji-picker input[type="search"]')
      .fill("party_parrot");
    await page
      .getByRole("button", { name: ":party_parrot:", exact: true })
      .click();
    await expect
      .poll(
        () =>
          relay.report.publications.find(({ event }) => event.kind === 7)
            ?.event,
      )
      .toMatchObject({ content: ":party_parrot:" });
    expect(
      relay.report.publications.find(({ event }) => event.kind === 7).event
        .tags,
    ).toContainEqual(["emoji", "party_parrot", first]);
    await expect(
      row
        .getByRole("button", { name: ":party_parrot:: You", exact: true })
        .locator("img"),
    ).toHaveJSProperty("complete", true);
    await expect(
      row
        .getByRole("button", { name: ":party_parrot:: You", exact: true })
        .locator("img"),
    ).not.toHaveJSProperty("naturalWidth", 0);

    // Replace the image under the same name.
    await page.getByRole("tab", { name: "Add emoji", exact: true }).click();
    await upload.setInputFiles({
      name: "other.png",
      mimeType: "image/png",
      buffer: png(false),
    });
    await expect(
      page.getByRole("img", { name: "Selected custom emoji preview" }),
    ).toBeVisible();
    await name.fill("party_parrot");
    await expect(
      page.getByText(
        "You already have :party_parrot: — saving will replace its image.",
      ),
    ).toBeVisible();
    await save.click();
    await expect(page.getByText("Added :party_parrot:")).toBeVisible();
    const second = relay.report.uploads.at(-1).url;
    expect(second).not.toBe(first);
    const replaced = ownSet(primary);
    expect(replaced.created_at).toBeGreaterThan(added.created_at);
    expect(replaced.tags).toEqual([
      ["d", "buzz:custom-emoji"],
      ["emoji", "party_parrot", second],
    ]);
    await expect(page.getByText("My emojis (1)")).toBeVisible();
    // Sent messages and reactions keep their original image; the palette offers the replacement.
    const media = (url) => new RegExp(url.match(/[0-9a-f]{64}/)[0]);
    await expect(
      row.locator('p[data-single-emoji] img[alt=":party_parrot:"]'),
    ).toHaveAttribute("src", media(first));
    await expect(
      row
        .getByRole("button", { name: ":party_parrot:: You", exact: true })
        .locator("img"),
    ).toHaveAttribute("src", media(first));
    await hoverMessage(row);
    await row
      .getByRole("group", { name: "Message actions", includeHidden: true })
      .getByRole("button", { name: "Add reaction", exact: true })
      .click();
    const reactionPicker = page.locator("em-emoji-picker");
    await reactionPicker.locator('input[type="search"]').fill("party_parrot");
    await expect(
      reactionPicker
        .getByRole("button", { name: ":party_parrot:", exact: true })
        .locator("img"),
    ).toHaveAttribute("src", media(second));
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: testInfo.outputPath("primary-after-replace.png"),
      fullPage: true,
    });

    // Another community has its own empty set and palette.
    await page.getByRole("button", { name: "Switch community" }).click();
    await expect(
      page.getByRole("heading", { name: "Community secondary.example" }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "My emojis", exact: true }).click();
    await expect(page.getByText("No emojis yet")).toBeVisible();
    await page.getByRole("tab", { name: "Add emoji", exact: true }).click();
    // With no custom matches, only the settled Unicode search lists options.
    await draft.fill(":party");
    await expect(page.getByRole("option").first()).toBeVisible();
    await expect(searching).toHaveCount(0);
    await expect(
      page.getByRole("option", { name: ":party_parrot:" }),
    ).toHaveCount(0);
    await draft.fill("");
    await upload.setInputFiles({
      name: "wave.png",
      mimeType: "image/png",
      buffer: png(true),
    });
    await expect(name).toHaveValue("wave");
    await save.click();
    await expect(page.getByText("Added :wave:")).toBeVisible();
    expect(ownSet(secondary).tags).toEqual([
      ["d", "buzz:custom-emoji"],
      ["emoji", "wave", relay.report.uploads.at(-1).url],
    ]);
    expect(relay.report.uploads.at(-1).url.startsWith(secondary)).toBe(true);
    expect(ownSet(primary).tags).toEqual(replaced.tags);
    await page.getByRole("button", { name: "Switch community" }).click();
    await expect(page.getByText("My emojis (1)")).toBeVisible();
    await expect(page.getByText(":wave:")).toHaveCount(0);

    // The settings collection is searchable and read-only for other owners.
    await page.getByRole("tab", { name: "Community emoji (2)" }).click();
    const community = page.getByRole("group", {
      name: "Community emoji",
      exact: true,
    });
    await expect(community.getByRole("listitem")).toHaveCount(2);
    await expect(community.getByRole("button", { name: /Remove/ })).toHaveCount(
      0,
    );
    const search = community.getByRole("searchbox", { name: "Search" });
    await search.fill(" :BEE: ");
    await expect(community.getByRole("listitem")).toHaveCount(1);
    await expect(
      community.getByText(":community_bee:", { exact: true }),
    ).toBeVisible();
    await search.fill("missing_emoji");
    await expect(
      community.getByRole("heading", { name: "No results" }),
    ).toBeVisible();
    await community.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    await expect(community.getByRole("listitem")).toHaveCount(2);

    // A rejected removal retains the emoji. Retry publishes an empty own set.
    await page.getByRole("tab", { name: "My emojis (1)" }).click();
    const otherSet = relay
      .stored(primary)
      .find((event) => event.kind === 30030 && event.pubkey !== viewer);
    const remove = page.getByRole("button", { name: "Remove :party_parrot:" });
    // Populated rows and their trailing actions must fit at enlarged text sizes.
    for (const mode of ["light", "dark"]) {
      for (const width of [800, 390]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate((mode) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.style.fontSize = "32px";
        }, mode);
        await expect(remove).toBeInViewport();
        await expect
          .poll(() =>
            page
              .getByRole("group", { name: "My emojis", exact: true })
              .evaluate((root) => {
                const bounds = root.getBoundingClientRect();
                return (
                  root.scrollWidth <= root.clientWidth &&
                  bounds.left >= 0 &&
                  bounds.right <= innerWidth
                );
              }),
          )
          .toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`emoji-mine-${mode}-${width}-200.png`),
          fullPage: true,
        });
      }
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    relay.rejectNextPublication();
    await remove.click();
    await expect(page.getByRole("alert")).toHaveText("Failed to remove emoji.");
    expect(ownSet(primary).tags).toEqual(replaced.tags);
    await expect(remove).toBeEnabled();
    await remove.focus();
    await remove.press("Enter");
    await expect(page.getByText("Removed :party_parrot:")).toBeVisible();
    await expect(
      page.getByRole("group", { name: "My emojis", exact: true }),
    ).toBeFocused();
    expect(ownSet(primary).tags).toEqual([["d", "buzz:custom-emoji"]]);
    expect(verifyEvent(ownSet(primary))).toBe(true);
    expect(relay.stored(primary)).toContainEqual(otherSet);
    // Historical messages retain their event-local mapping and uploaded media.
    await expect(
      row.locator('p[data-single-emoji] img[alt=":party_parrot:"]'),
    ).toHaveAttribute("src", media(first));
    await page.reload();
    await page.getByRole("tab", { name: "My emojis", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "No emojis yet" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Remove :/ })).toHaveCount(0);
    await page.getByRole("tab", { name: "Community emoji (2)" }).click();
    await expect(
      page
        .getByRole("group", { name: "Community emoji", exact: true })
        .getByRole("listitem"),
    ).toHaveCount(2);

    await testInfo.attach("relay-report.json", {
      body: JSON.stringify(
        {
          publications: relay.report.publications,
          rejections: relay.report.rejections,
          uploads: relay.report.uploads,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server?.close();
  }
});
