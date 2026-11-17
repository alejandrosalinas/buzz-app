import { type FileFormat, fileFormat } from "./formats";

const PREFIX = "buzz-file:?";
/** The last second dates can show, 9999-12-31; a later `time` is dropped. */
const LAST_TIME = 253_402_300_799;

export type FileTarget = Readonly<{
  url: string;
  name: string;
  mime?: string;
  /** When the file was shared, in Unix seconds. */
  time?: number;
  format: FileFormat;
}>;

/** `buzz-file:?url=<url>&name=<name>&mime=<mime>&time=<seconds>`, the target
 * other plugins also use to open a shared file; all but `url` are optional. */
export function fileTarget(
  file: Readonly<{ url: string; name?: string; mime?: string; time?: number }>,
): string {
  const params = new URLSearchParams({ url: file.url });
  if (file.name) params.set("name", file.name);
  if (file.mime) params.set("mime", file.mime);
  if (file.time !== undefined) params.set("time", String(file.time));
  return PREFIX + params.toString();
}

function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    return decodeURIComponent(last) || "File";
  } catch {
    return "File";
  }
}

export function parseFileTarget(target: string): FileTarget | undefined {
  if (!target.startsWith(PREFIX)) return undefined;
  const params = new URLSearchParams(target.slice(PREFIX.length));
  const url = params.get("url");
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  const name = params.get("name")?.trim() || nameFromUrl(url);
  const mime = params.get("mime")?.trim() || undefined;
  const time = Number(params.get("time") ?? Number.NaN);
  const format = fileFormat(name, mime);
  if (!format) return undefined;
  return {
    url,
    name,
    format,
    ...(mime ? { mime } : {}),
    ...(Number.isInteger(time) && time > 0 && time <= LAST_TIME
      ? { time }
      : {}),
  };
}

/** Only files shared in the current community open; anything else could
 * make the viewer fetch an address the sender chose. */
export function isCommunityMedia(
  url: string,
  origin: string | undefined,
): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === new URL(origin).origin &&
      parsed.pathname.startsWith("/media/") &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}
