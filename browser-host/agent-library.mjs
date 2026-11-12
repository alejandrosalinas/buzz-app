import { relayOrigin } from "../src/features/communities/destination.ts";
import { avatarSource } from "../src/shared/avatar-source.ts";
// Read-only display projection of installed Buzz 1.0 agents. Explicit legacy
// input remains supported for compatibility tests/import readers; never discover
// Classic stores or call loaders that migrate keys or write configuration.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 2000;
const HEX = /^[0-9a-f]{64}$/;
const failure = () =>
  new Error(
    "Could not read the current Buzz agent library. Open Buzz and retry; its saved library is left unchanged.",
  );
function text(value, max = 256) {
  if (typeof value !== "string" || value.length > max) throw failure();
  return value;
}
export function projectAgentLibrary(raw) {
  if (!Array.isArray(raw)) {
    if (
      raw?.version !== 1 ||
      !Array.isArray(raw.agents) ||
      raw.agents.length > MAX_ROWS
    )
      throw failure();
    // Parked identities are import candidates, not saved Buzz 1.0 agents.
    // Retained unconfigured custody can share a key with its configured setup.
    // Prefer that setup; equal-status records keep document order.
    const selected = new Map();
    for (const row of raw.agents) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        !HEX.test(text(row.pubkey, 64))
      )
        throw failure();
      const projected = {
        pubkey: row.pubkey,
        name: text(row.name),
        avatar_url: row.picture,
      };
      const previous = selected.get(row.pubkey);
      if (
        !previous ||
        (previous.configured === false && row.configured !== false)
      )
        selected.set(row.pubkey, { ...projected, configured: row.configured });
    }
    raw = [...selected.values()];
  }
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) throw failure();
  const definitions = [],
    identities = [];
  const slugs = new Set(),
    keys = new Set();
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw failure();
    const pubkey = text(row.pubkey, 64);
    const name = text(row.name);
    const avatar = avatarSource(row.avatar_url);
    const artwork = avatar ? { avatar } : {};
    if (!pubkey) {
      // Old to_definition_view skips keyless records without a slug.
      if (row.slug == null) continue;
      const id = text(row.slug);
      if (!id || slugs.has(id)) throw failure();
      slugs.add(id);
      if (row.is_active !== undefined && typeof row.is_active !== "boolean")
        throw failure();
      if (row.is_active === false) continue;
      definitions.push({
        id,
        ...artwork,
        name: row.display_name == null ? name : text(row.display_name),
      });
    } else {
      if (!HEX.test(pubkey) || keys.has(pubkey)) throw failure();
      keys.add(pubkey);
      const definitionId =
        row.persona_id == null ? undefined : text(row.persona_id);
      identities.push({
        pubkey,
        ...artwork,
        name,
        ...(definitionId ? { definitionId } : {}),
      });
    }
  }
  return { definitions, identities };
}

/** The app's current custody store; only display metadata crosses the broker.
 * It is versioned once an agent is in several communities, one row in each. */
export function projectAgentIdentities(raw, scope) {
  if (!Array.isArray(raw)) {
    if (raw?.version !== 2 && raw?.version !== 3 && raw?.version !== 4)
      throw failure();
    raw = raw.agents;
  }
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) throw failure();
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw failure();
    for (const state of [row.deleted, row.joining])
      if (state !== undefined && typeof state !== "boolean") throw failure();
  }
  const community = scope ? relayOrigin(scope.community) : undefined;
  return projectAgentLibrary({
    version: 1,
    agents: raw
      // Filter membership before pubkey deduplication: artwork is per community.
      .filter((row) => {
        if (row.deleted || row.joining) return false;
        if (!scope) return true;
        if (row.owner !== scope.owner) return false;
        try {
          return relayOrigin(row.relay) === community;
        } catch {
          return false;
        }
      })
      .map((row) => ({
        ...row,
        name: row.name === undefined ? "" : row.name,
      })),
  });
}
/**
 * Installed Buzz desktop's app-data directory, resolved the way Tauri does it
 * (the `dirs` crate): `Library/Application Support` on macOS; on Linux
 * `XDG_DATA_HOME` only when it is an absolute path, otherwise `~/.local/share`.
 * Other platforms return nothing: the live broker refuses them before this
 * reader could run, so guessing a path here would only mislead.
 */
export function installedBuzzDataDir(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (platform === "darwin")
    return join(home, "Library/Application Support/xyz.block.buzz.desktop");
  if (platform === "linux") {
    const xdg = env.XDG_DATA_HOME;
    const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local/share");
    return join(base, "xyz.block.buzz.desktop");
  }
  return undefined;
}
const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );
export async function readAgentLibrary(path, scope) {
  const current = path === undefined;
  path ??= await (async () => {
    const dir = installedBuzzDataDir();
    if (!dir) return undefined;
    // Until the updated desktop moves its pre-1.0 folder, read that one.
    const legacy = join(dirname(dir), "dev.local.buzz.foundation");
    const base = !(await exists(dir)) && (await exists(legacy)) ? legacy : dir;
    return join(base, "agents/identities.json");
  })();
  if (!path) throw failure();
  let file;
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw failure();
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw failure();
    // No raw contents or parser errors escape this host-only function.
    const raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      ),
    );
    return current || scope
      ? projectAgentIdentities(raw, scope)
      : projectAgentLibrary(raw);
  } catch (error) {
    // No saved library yet (or none since the store moved) is an empty one.
    if (!file && error?.code === "ENOENT")
      return { definitions: [], identities: [] };
    throw failure();
  } finally {
    buffer.fill(0);
    await file?.close();
  }
}
