import { describe, expect, it, vi } from "vitest";
import { createLoader } from "./loader";
import { previewable } from "./safety";

describe("previewable", () => {
  it("allows public HTTPS names only", () => {
    expect(previewable("https://example.com/a")?.href).toBe(
      "https://example.com/a",
    );
    for (const url of [
      "http://example.com/",
      "https://user:pw@example.com/",
      "https://example.com:8443/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://0x7f.1/",
      "https://localhost/",
      "https://printer.local/",
      "https://box.tailnet.ts.net/",
      "https://site.example/",
      `https://example.com/${"a".repeat(2048)}`,
    ])
      expect(previewable(url), url).toBeNull();
  });
});

describe("createLoader", () => {
  it("follows checked redirects and keeps the page for the session", async () => {
    const readPage = vi.fn(async (url: string) =>
      url === "https://short.example.com/x"
        ? { status: 301, location: "/final" }
        : {
            status: 200,
            preview: {
              title: "Final",
              image: "https://img.example.com/a.png",
              siteName: "Example",
            },
          },
    );
    const loader = createLoader({ readPage });
    const page = await loader.page("https://short.example.com/x");
    expect(page).toEqual({
      url: "https://short.example.com/final",
      title: "Final",
      siteName: "Example",
      image: "https://img.example.com/a.png",
    });
    await loader.page("https://short.example.com/x");
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it("refuses a redirect to a local name before asking for it", async () => {
    const readPage = vi.fn(async () => ({
      status: 302,
      location: "https://intranet.corp/secret",
    }));
    const loader = createLoader({ readPage });
    expect(await loader.page("https://example.com/")).toBeNull();
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("shows nothing for a page without a title and forgets failures", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, preview: {} })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: 200, preview: { title: "Back" } });
    const loader = createLoader({ readPage });
    expect(await loader.page("https://a.example.com/")).toBeNull();
    expect(await loader.page("https://a.example.com/")).toBeNull();
    expect((await loader.page("https://a.example.com/"))?.title).toBe("Back");
  });

  it("revokes an evicted image only after every card using it lets go", async () => {
    let made = 0;
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => `blob:test/${made++}`);
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    try {
      const requestBytes = vi.fn(async () => ({
        status: 200,
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array([1]),
      }));
      const loader = createLoader({ readPage: vi.fn(), requestBytes });
      const shown = loader.image("https://img.example.com/0.png");
      const others = Array.from({ length: 61 }, (_, i) =>
        loader.image(`https://img.example.com/${i + 1}.png`),
      );
      for (const lease of others) lease.release();
      const src = await shown.src;
      await Promise.all(others.map((lease) => lease.src));
      await Promise.resolve();
      expect(src).toBe("blob:test/0");
      expect(revoke).not.toHaveBeenCalledWith(src);
      expect(revoke).toHaveBeenCalledWith("blob:test/1");
      expect(revoke).not.toHaveBeenCalledWith("blob:test/61");
      shown.release();
      await Promise.resolve();
      expect(revoke).toHaveBeenCalledWith(src);
      loader.stop();
      await Promise.resolve();
      expect(revoke).toHaveBeenCalledWith("blob:test/61");
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  it("is unavailable without a page reader", async () => {
    const loader = createLoader(undefined);
    expect(loader.available).toBe(false);
    expect(await loader.page("https://example.com/")).toBeNull();
  });
});
