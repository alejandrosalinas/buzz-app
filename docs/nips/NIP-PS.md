# NIP-PS: Plugin Signing

> Buzz draft. This is not an upstream standardized NIP.

NIP-PS binds a built Buzz plugin artifact to a Nostr publisher key. It uses
ordinary [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
event IDs and Schnorr signatures; it defines no new cryptography.

## Release files

An API v1 release is a pair of local files:

- `plugin.artifact.json`: the exact JSON bytes containing the validated plugin
  manifest and self-contained built JavaScript module.
- `plugin.signature.json`: a signed NIP-PS event.

The `x` digest covers every byte of `plugin.artifact.json` as written. It does
not hash the source directory, Git commit, or reserialized recipient copy.

## Event

The event is a regular kind `1064` event with empty `content`. It has exactly
one of each required tag, each with exactly two elements:

| Tag | Value |
| --- | --- |
| `x` | Lowercase hex SHA-256 of the exact artifact file bytes |
| `t` | `buzz-plugin-release-v1` |

For example, with placeholder IDs and hashes:

```json
{
  "id": "<NIP-01 event ID>",
  "pubkey": "<publisher hex pubkey>",
  "created_at": 0,
  "kind": 1064,
  "tags": [
    ["x", "<64 lowercase hex characters>"],
    ["t", "buzz-plugin-release-v1"]
  ],
  "content": "",
  "sig": "<NIP-01 signature>"
}
```

Other tags convey no plugin authority. NIP-94 kind `1063` is not a NIP-PS
signature, and this draft defines no URL or MIME tag.

## Verification and trust

Unsigned external plugins are allowed by default. Launching the client or CLI
with `BUZZ_REQUIRE_PLUGIN_SIGNATURES=1` requires signed releases, including for
local development builds. Only the exact value `1` enables enforcement; an unset
variable or any other value leaves it off. Plugins compiled into Buzz are exempt.
With enforcement enabled, missing signatures fail verification; existing unsigned
installations remain manageable but cannot run. Supplied signatures are always
verified, and the publisher continuity rules below apply in either mode.

For signed releases, before import and each load, verify the NIP-01 event ID and
signature, kind, empty content, required tags, and `x` against the exact artifact
bytes. Parse and validate the artifact manifest and module as usual. The publisher
is only the verified event `pubkey`, never a URL, manifest claim, or unsigned field.

An installed signed plugin may update only under the same manifest ID and
publisher key; it cannot downgrade to unsigned or roll back to an unsigned
revision. An existing unsigned installation may be replaced with a signed
release. Users decide whether to trust a publisher; a valid signature from any
publisher key satisfies this verification policy. Signing does not sandbox
plugin code.

The file pair can be distributed through a folder or Git repository without a
relay. Any later relay publication requires relay support for kind `1064`.
