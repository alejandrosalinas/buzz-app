// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mediaUrl } from "../../features/relay/transport";
import { ConversationIcon } from "./ChannelsPage";

afterEach(cleanup);
// The real sizing rewrite behind a pass-through proxy, as the session applies it.
const media = (url: string, size?: "small") =>
  mediaUrl(url, (proxied) => proxied, "https://relay.test", size);

it("asks for the relay thumbnail of a DM participant, as message rows do", () => {
  const sha = "a".repeat(64);
  const { container } = render(
    <ConversationIcon
      item={{ name: "Alice", channelType: "dm" }}
      picture={`https://relay.test/media/${sha}.png`}
      media={media}
    />,
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    `https://relay.test/media/${sha}.thumb.webp`,
  );
});
