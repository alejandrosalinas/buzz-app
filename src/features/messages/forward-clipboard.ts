import { writeClipboardRichText } from "../../shared/clipboard";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { forwardBody, snapshotMessage } from "../relay/forwarded-message";
import { splitPartition } from "../relay/partition";

export type ForwardReference = {
  version: 1;
  origin: string;
  channelId: string;
  id: string;
};
export function forwardReference(value: unknown): ForwardReference | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    typeof v.origin !== "string" ||
    !v.origin ||
    v.origin.length > 2048 ||
    typeof v.channelId !== "string" ||
    !v.channelId ||
    v.channelId.length > 256 ||
    typeof v.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(v.id)
  )
    return;
  return { version: 1, origin: v.origin, channelId: v.channelId, id: v.id };
}
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
export function forwardClipboard(
  reference: ForwardReference,
  text: string,
  note = "",
) {
  const url = `buzz://forward?${new URLSearchParams({ version: "1", origin: reference.origin, channel: reference.channelId, id: reference.id, ...(note ? { note } : {}) })}`;
  return {
    text,
    html: `<a href="${escapeHtml(url)}">Forwarded message</a><pre>${escapeHtml(text)}</pre>`,
  };
}
/** HTML is only a locator. Never render or trust clipboard attribution/content. */
export function pastedForward(
  data: Pick<DataTransfer, "getData">,
): (ForwardReference & { note?: string }) | undefined {
  if (typeof data?.getData !== "function") return;
  const html = data.getData("text/html");
  if (!html || html.length > 262144) return;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const links = [...doc.querySelectorAll("a[href]")].filter((a) =>
    a.getAttribute("href")?.startsWith("buzz://forward?"),
  );
  if (links.length !== 1) return;
  try {
    const url = new URL(links[0]?.getAttribute("href") ?? "");
    const reference = forwardReference({
      version: Number(url.searchParams.get("version")),
      origin: url.searchParams.get("origin"),
      channelId: url.searchParams.get("channel"),
      id: url.searchParams.get("id"),
    });
    const note = url.searchParams.get("note") ?? "";
    if (!reference || note.length > 4096) return;
    return { ...reference, ...(note ? { note } : {}) };
  } catch {
    return;
  }
}
export async function copyAsForward(
  session: RelaySession,
  row: ChannelMessage,
  authorName: string,
  note = "",
) {
  const problem = session.messages.forwardProblem(
    row.channelId,
    row,
    authorName,
    note,
  );
  if (problem) throw new Error(problem);
  const origin = splitPartition(session.scope)?.communityOrigin;
  if (!origin) throw new Error("This community is unavailable.");
  const snapshot = snapshotMessage(
    row,
    authorName,
    session.profiles.snapshot(),
    session.agentChoices.snapshot().identities,
  );
  const payload = forwardClipboard(
    { version: 1, origin, channelId: row.channelId, id: row.id },
    forwardBody(snapshot, note),
    note,
  );
  await writeClipboardRichText(payload.text, payload.html);
}
