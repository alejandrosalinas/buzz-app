/** Browser-only media host. Files stay in this tab; never contact a live broker. */
export function avatarMediaFixture() {
  const files = new Map<string, Blob>();
  let rejected = false;
  return {
    reject(value: boolean) {
      rejected = value;
    },
    async request(
      url: string,
      init?: RequestInit,
    ): Promise<Response | undefined> {
      if (!url.includes("/api/relay/"))
        throw new Error("Unexpected fixture request");
      const route = url.split("/").at(-1)?.split("?")[0];
      if (route === "upload") {
        if (rejected) return Response.json({ code: "failed" }, { status: 503 });
        const file = init?.body;
        if (!(file instanceof Blob)) throw new Error("Expected avatar bytes");
        const bytes = await file.arrayBuffer();
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (value) => value.toString(16).padStart(2, "0"),
        ).join("");
        const origin = decodeURIComponent(url.split("/")[3] ?? "");
        const picture = `${origin}/media/${hash}`;
        files.set(picture, file);
        return Response.json({
          url: picture,
          sha256: hash,
          type: file.type,
          size: file.size,
        });
      }
      return undefined;
    },
    // img requests cannot be intercepted by window.fetch. Serve tab-local previews.
    display(url: string) {
      return files.get(url.replace(/\.thumb\.webp$/, ""));
    },
  };
}
