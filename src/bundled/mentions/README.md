# Mentions

Find and mention people, agents, and teams while you write.

## Getting started

1. Type @ in the composer and pick someone from the suggestions.
2. Or choose **Mention a member** to search everyone in your community.
3. Pick a team to mention all of its members at once.

---

# Mention rules

`version 3` · `client contract` · `uses existing tags`

## Abstract

This contract says who a user can mention in a channel message, how a client
orders the choices, when Space or closing punctuation completes a mention, and
what a client sends when the user mentions someone outside the channel. Clients
that follow it give the same search the same list and send the same tags.

The built-in Mentions feature implements the chooser: the choice set, matching,
order, and selection by Space or closing punctuation. The composer decides which
keys a draft may address and asks before sending to people outside the channel.
The relay message writer and message fold implement the tags. This directory
owns the spec and the [portable fixtures](mention-rules.fixtures.json).

This is an extraction of the behavior in
[buzz-app #257](https://github.com/block/buzz-app/pull/257) and
[buzz-app #258](https://github.com/block/buzz-app/pull/258), with the archive
rule from [#256](https://github.com/block/buzz-app/pull/256) and the prose rule
from [#303](https://github.com/block/buzz-app/pull/303). It adds no event
kind. It uses `p` tags and the two-field `mention` tag that other Buzz clients
already write. Labels come from the
[contextual identity names](../identity-naming/README.md) contract.

MUST, MUST NOT, SHOULD, and MAY have their RFC 2119 meanings.

## Terms

- **Key**: a Nostr public key, as 64 lowercase hex characters.
- **Exact public key**: a query that, ignoring surrounding whitespace, is 64
  hex characters in either case, or a complete all-lowercase or all-uppercase
  npub, with or without a `nostr:` prefix in any case, that decodes to a
  32-byte key. A partly typed npub, or one with mixed case, a bad checksum or a
  payload of another length, is a name search.
- **Choice**: one key the user can mention. It has a **name** (the identity's own
  name), a **label** (the name shown in the chooser, possibly qualified, for
  example `Wes’s Honey` or `Honey · 4prr`), and **aliases** (the real names known
  for that key). A choice with no known name has no aliases. Its label is only a
  key fallback.
- **Member**: a key in the channel's current member list.
- **Outside**: a choice that is not a member.
- **Recipient**: a key that the message addresses and notifies.
- **Reference**: a key that the message names without notifying.

## Scope and authority

Choosing a person does not give them access. A mention does not promise that an
agent will accept or answer. The existing channel membership, add-member
permission, and Solo chat invitation rules stay the authority. Labels are
presentation only. Clients MUST send and store exact keys, not labels.

This contract does not define profile validation, archive state, presence, or
agent ownership proof. Ownership here is a display hint from profile metadata,
not authorization.

## 1. Choice set

For any known channel (stream, untyped channel, forum or DM) that is not
archived and not read-only, the choice set is:

1. the channel's members;
2. the agents that the client offers for mention in this channel;
3. the viewer's own agents from their other communities, which the client can
   bring into this one (section 7); and
4. people and agents found by a community directory search for the current query.

Solo chats MUST NOT add directory people or agents from other communities. This
follows the channel type, so it also holds in Solo chat composers that do not
invite agents, such as media comments and edits. A Solo chat that invites agents uses its own agent list
instead of items 3 and 4. Archived or read-only channels have
no choices. Clients MUST exclude invalid keys and identities known to be
archived, except the viewer's own key: a user always sees themself. Unknown
archive state does not exclude a key.

Labels MUST be resolved against the whole choice set, not only the rows that
match the search. Directory people with no cached profile still take part, so
namesakes get qualified labels.

## 2. Query syntax

Inline completion opens on `@` at the start of the text or after whitespace,
`(`, `[`, or `{`. The query is the text from after `@` up to the caret. It MUST
NOT contain `@`, a line break, or a tab. It MAY contain spaces. A client MAY look
back only 160 characters from the caret. A caret outside the text gives no query.

A query with a space is **admitted** only while it is still the start of a
known name. Compare with the section 3 normalization of the names, but do not
trim the query: its trailing space matters here. A query that is a complete
known name plus a trailing space is not admitted, so the user can keep typing
prose. The known names are the aliases and labels of the current choice set,
including people that the directory search for this query found. This check is
the `admission` fixture section.

Admission does not decide whether the client searches. A multi-word query can
name someone the client does not know yet, for example `@Mary J` for a Mary
Jane outside the channel. The client MUST still run the directory search for
it (subject to section 6), and it checks admission again with the names that
search finds. The client MUST close the inline chooser for a query that is not
admitted only when no directory search for it is pending and the last search
did not fail. While the search runs, the chooser shows no rows for that query.
If the search fails, the chooser keeps its error and a way to retry. The
desktop UI test "a failed multi-word directory search keeps its error and
retry" in [solo-agents.test.tsx](solo-agents.test.tsx) covers this case:
`@Mary J` fails, then Retry finds Mary Jane. The client MAY skip the search
only for the refuted prefix in section 6, or when a complete finished search
for a prefix of the query already answers it (section 6). An `@` inside a mention
that the user already selected, or that is pending (section 5), including one
that has extended over the words typed after it, does not open a query.

## 3. Matching (normative)

Normalize the query and each name the same way. For each code point, apply
Unicode NFKD, remove the combining accents in the Unicode "Combining
Diacritical Marks" blocks (U+0300–U+036F, U+1AB0–U+1AFF, U+1DC0–U+1DFF,
U+20D0–U+20FF, U+FE20–U+FE2F), lowercase (ECMAScript `toLowerCase`), and
replace final sigma `ς` with `σ`. Then trim both ends (ECMAScript `trim`). So
`jose` matches `José`, and `παρος` matches `ΠΑΡΟΣ`. Other marks stay: in many
scripts they make a different letter, so `राम` does not match `रम` and `ジョン`
does not match `ション`. Letters without a decomposition do not fold: `ø`, `ł`,
`æ`, `ß` and `ı` stay themselves. Use Unicode 15.0 or later data; Unicode
normalization does not change for assigned characters, so later versions give
the same fixture results. The `matching` fixtures pin cases that differ between
common folding APIs. A client MUST
NOT substitute a broader case or diacritic folding (for example, Swift
`.diacriticInsensitive` or full Unicode case folding).

Space selection (section 5), query admission (section 2, without trimming the
query), and ordering by normalized labels (section 4) use this same
normalization. Shared code:
[person-match.ts](../../features/search/person-match.ts).

An empty query matches every choice at tier 0. Otherwise, a name matches the
query at the first tier that applies:

| Tier | Rule |
| --- | --- |
| 0 | The name equals the query |
| 1 | The name starts with the query |
| 2 | A word of the name equals the query |
| 3 | A word of the name starts with the query |

A **word** is a run of letters, marks, and digits (Unicode general categories
L, M, and N). Every other code point separates words, so `jane` finds
`Mary-Jane` at tier 2 and `brien` finds `O'Brien`. For tiers 2 and 3, the match
starts where a word starts; it equals the word (tier 2) when the next code point
is not a letter, mark, or digit. A query that contains whitespace matches only
at tiers 0 and 1. Nothing else matches. Text inside a word does not match:
`oney` does not find `Honey`. This check is the `matching` fixture section.

A choice's **match** is the tier of its label. If the label does not match, the
match is 4 plus the best tier among its aliases. A choice with no aliases never
matches a non-empty name query. An exact public key (Terms) is not a name
query: it matches only the choice with that key, at tier 0, even one with no
aliases. Partial keys, partial npubs and key fallback labels MUST NOT match.

## 4. Order (normative)

Remove choices that do not match. Sort the rest by the first rule that differs:

1. Members before outside choices.
2. Everyone in this community before the viewer's agents from their other
   communities.
3. Lower match.
4. Lower best alias tier (the **base match**). This lets `Fizz` rank above
   `Fast Fizz` when both labels match at the same tier.
5. Agents that the viewer owns before all other choices, people included.
6. Block label, by UTF-16 code unit order of normalized labels. Agents with the
   same values for rules 1 to 5 and the same normalized name form one **block**.
   A block's label is the lowest normalized label among its agents. A person, or
   an agent with a name of its own, is a block by itself.
7. On an equal block label: a person before an agent block. Two agent blocks
   are ordered by normalized name, and two people by key.
8. Inside a block:
   1. more recent explicit choice in this channel first;
   2. managed agents first;
   3. presence: online, then away, then unknown.
9. Normalized label, by UTF-16 code unit order.
10. Key.

Every rule is a key of one choice, so the order is the same for any input order.
A person or another name never sorts between two agents of one block. Ownership
and recency never override membership or match. Recency is the
client's memory of explicit selections in this channel. The desktop keeps it in
memory for 100 channels and 100 keys each.

## 5. Space or closing punctuation selects only an exact, unique name

When the user types Space after a query, a choice is the **exact name** among a
set of choices when all of these are true:

- the normalized query is not empty;
- it is the only choice in the set with aliases that has an alias or label equal
  to the query; and
- no choice in the whole known choice set has an alias or label that
  **continues** the query: the normalized name is longer, starts with the
  normalized query, and the next code point is not a letter, mark, or digit
  (`Jose Luis` and `Jose-Luis` continue `jose`; `Josefa` does not). A label's
  key qualifier or generated `(agent)` suffix only tells namesakes apart, so
  `Honey · 4prr` and a generated `Honey (agent)` do not continue `honey`.
  A literal name `Honey (agent)` still continues `honey`. A choice's own longer
  name does not continue the query when that same choice also has an alias or
  label equal to it: an agent known as both `Example` and `Example Agent` is one
  identity, not a namesake of itself, so `example` selects it.

An exact public key (Terms) is the exact name of the choice with that key, even
one with no aliases, and of no other choice, and no name continues it: a key
has no namesakes. Nor does a saved team with the same or a longer name keep it
from selecting. The steps below then apply as for a name.

The **local** choices are the ones known without the directory search: the
channel's members and the agents the client offers for mention (section 1, items
1 to 3, or a Solo chat's own agent list). The client selects:

1. the exact name among the local choices, once every member's name is known
   or known to be absent; otherwise
2. the exact name among the full choice set, once the full choice set is known:
   no directory search for this query is waiting, running, or failed, and the
   search reported no more pages.

In both cases the choice must be shown and can still be chosen. Check against
the whole set, not only the shown rows.

Local choices show before directory results (section 6), so a unique local name
selects at once: directory results cannot make it ambiguous, whether or not the
search has found them yet. A longer directory name still blocks Space once the
search reports it, but not before. A member whose name is not known yet may be a
namesake, so until it is, only step 2 applies. A member whose profile read
completed without finding a profile has no name, so it cannot be a namesake and
does not hold step 1 back; a failed read is not evidence. A name that only a
directory result has could still gain a namesake from a pending search, so Space
MUST NOT select it before the search finishes. Otherwise Space is a normal
space. Tab, Enter, and a click select the highlighted row.

Closing punctuation typed straight after the query (`,` `.` `!` `?` `;` `:` `)`
or a closing quote `'` `’` `"` `”`) SHOULD select exactly as Space does, and the
client keeps the character after the mention in place of the space, so
`@Honey's` mentions Honey. Where Space would not select, the character is typed
into the query instead. A longer known name that continues the query blocks
every one of these characters, as it blocks Space, whichever character comes
next in that name: `'` after `Pat O` while `Pat O'Brien` is known stays in the
query, and so does `,` after `Wes` while `Wes Smith` is known. A saved team with
the same or a longer name blocks them too. Where Space may hold a pending
mention, so may this character, kept after the chip. A selected or pending
mention ends at a name boundary: the next character that is not a letter, mark,
digit or underscore.

While the client cannot yet decide — the member list, member names or agent
list is still loading, or a directory search for the query is waiting or
running — it MAY instead mark the query as a **pending mention**: a chip with
no recipient, shown as still resolving. When the full choice set is known it
applies this section to the pending name as if Space had been typed then: a
selection becomes the recipient (checked for admission as any selection is);
anything else, including a failed or truncated search or a bounded wait
expiring (desktop: 8 s), returns the text to prose. A name the client has
already declined is not pending: a trailing space or punctuation, a multi-word
query that continues no name, a saved team with the same or a longer name, or
a known choice whose name continues the query (a loaded member `Mira Example`
for `mira`) keeps Space a normal space. Such a longer name blocks whatever
else arrives, and the next word may complete it (`@mira Example ` selects the
member), which a chip that ended the query could not. A pending name that,
once the full choice set is known, only longer known names keep from selecting
(`Mira Example`, found by the directory search for `mira` after the chip was
held) MAY instead extend over the words typed after the chip when they spell
one of those names up to a name boundary (`@mira Example hi` becomes a pending
`@mira Example` with ` hi` outside it), taking the longest name the words
complete, as Space would have needed all of it typed; this section then applies
to the longer name as if Space had been typed after it, under the same bound.
Words that stop mid-name or complete none of those names return the text to
prose. A pending mention, extended or not, MUST end at a name boundary: a name
character typed right after it (`@honey`, Space, Backspace, `suckle`) returns
it to the typed query, as an edit does to a recipient. The chooser then reopens over the typed name, and the complete search
for the pending name already settles the directory for every query extending
it (section 6), so no search is waiting and the Space that completes the
longer name selects it: `@mira Exam` returned to prose, then `ple ` selects
`Mira Example`. In a
DM a pending name that resolves to someone outside the DM returns to prose,
since the chooser's "Will not be notified" row was never shown. Sending while
a mention is pending waits for it, through such an extension; if a mention the
send waited for returns to prose, the client MUST NOT send in that same action,
since the user saw the name held and would notify no one: it keeps the draft,
says which name was not tagged and why (it could not be confirmed as one
person or agent, because nothing matched, several did or the search did not
finish; or the match could not be tagged here, would exceed the recipient limit
or would make the message too long), and the next send sends the text. A pending
mention is never a recipient or a reference (section 8).

## 6. List stability (desktop behavior; not in the fixtures)

These rules keep a row from moving under the user's pointer or keyboard.

- Members and offered agents SHOULD show without waiting for the directory.
- A shown row MUST NOT move while the query and the open chooser stay the same.
  New rows are added only at the bottom. Directory people come after the rows
  already shown.
- A row that becomes unavailable stays in place and is disabled. Enter and Tab
  MUST NOT select it or fall through to Send.
- A client MAY show at most 50 rows and ask the user to type more.
- A client SHOULD wait for a short typing pause (desktop: 200 ms) before a
  directory search. While a search runs, it SHOULD keep matching people from the
  last finished search. It MAY cache finished searches for the session. It MUST
  NOT cache failures or searches that find no one. A new opening of the chooser
  searches again for such a query.
- A finished search that reports no more pages holds every match for a longer
  query that starts with its query, because the relay matches names by prefix.
  A client MAY answer such a longer query from that page, filtered by section 3,
  with no search and no typing pause; the directory is then settled for it
  (section 5). A search that reported more pages, or failed, answers nothing
  beyond its own query; the listing shown for an empty query is not a name
  search and answers no query but its own; and an exact public key (Terms) is
  never answered this way. A retry searches afresh.
- A search refutes its query when it finds no one, reports no more pages, and
  the query contains a letter or digit. After that, a client MAY skip the
  directory search for a longer query that starts with the refuted query, and
  treat it as finding no one. It MUST NOT skip the search for an exact public
  key, because that is an author lookup that name prefixes cannot refute. A
  retry, or any new search, clears the refutation.

## 7. Sending to people outside the channel

When a draft addresses an outside key in a stream, untyped channel or forum,
the client MUST ask before it sends. The prompt names the outside people. It
offers these actions, like block/buzz desktop:

| Action | Shown | Result |
| --- | --- | --- |
| Invite | With add-member permission | Add each outside key. Wait until the relay confirms membership. Then send with those keys as recipients. |
| Do nothing | With add-member permission | Send. Outside keys become references. Nobody is added or notified. |
| Send anyway | Without add-member permission | The same as Do nothing. |
| Close or Escape | Always | Do not send. Keep the draft. |

A DM has fixed participants, so there is no choice to make. The client MUST NOT
ask. It sends outside keys in a DM as references, which do not notify them. The
chooser row says so before the user picks the person.

A Solo chat MUST NOT ask either, in any Solo chat composer. Its recipients follow
the Solo chat choice policy.

An agent from the viewer's other communities (section 1, item 3) is not a
member here and cannot be added until it joins this community. Before the
outside-channel prompt, a send that addresses one MUST ask a separate question:
"Bring *name* into *host*?". It says the same agent joins with its name, type
and settings, and that its memory, conversations and attention here start
separate. Its safe action, "Don't bring", has initial focus, so Enter never
brings an agent in. "Bring it here" joins the community (which also unarchives
the agent), adds the agent to the channel when the viewer can add members, and
then sends. Anything that did not carry over, or a failure, shows in the prompt
and keeps the draft. Declining or closing sends nothing and keeps the draft;
the agent never becomes a reference silently.

Adding a member from the outside-channel prompt MUST NOT start an agent. The
sent message is what notifies it. If the draft or its attachments change while adding runs, the
client MUST stop and keep the draft. It SHOULD report partial additions. Member
recipients in the same message are notified as usual.

## 8. Tags (normative)

A kind 9 channel message (or its reply) carries:

- one `["p", key]` tag per recipient; and
- one `["mention", key]` tag per reference.

Each list MUST have unique, valid, lowercase keys, at most 32 per list. Every
recipient MUST be a member when the message is written. A writer MUST reject the
message instead of dropping or converting a bad key.

A reader:

- MUST treat each valid `p` key as an addressed mention;
- MUST treat each valid two-field `mention` key as a reference (it names the key
  for display, and MUST NOT notify or wake it);
- MUST NOT treat a three-field `mention` tag (for example
  `["mention", key, "agent-address"]`) as a reference. Other Buzz clients write
  that form next to a `p` tag as display metadata for an addressed agent;
- MUST ignore invalid keys and remove duplicates, keeping first-seen order; and
- MUST resolve names for both lists. A key in both lists is addressed.

## Conformance fixtures

[mention-rules.fixtures.json](mention-rules.fixtures.json) holds semantic inputs
and literal expected outputs. It has no signed events and no labels to compute:
each choice supplies its own label.

| Section | Tests |
| --- | --- |
| `matching` | Section 3. `expected` is the tier of `label` for `query` (0 to 3), or `null` when it does not match. |
| `ranking` | Sections 3 and 4. `expected` is the full ordered key list. |
| `space` | Section 5 exact name among one complete choice set. The local-first step is tested only in the desktop UI tests. `expected` is a key or `null`. |
| `query` | Section 2 syntax. `expected` is `{start, end, query}` or `null`. |
| `admission` | Section 2 multi-word rule. `expected` is a boolean. |
| `tags.write` | Section 8 writer. `expected` is the ordered `p` and `mention` tags, or an error class: `not_member`, `invalid`, or `too_many`. The sender is a member in addition to `members`. |
| `tags.read` | Section 8 reader. `expected` is `{mentions, references}`. |

Choice defaults: `label` is `name`, `aliases` is `[name]`, and `agent`, `owned`,
and `managed` are false. `elsewhere` (the host of another community) is absent. `history` maps a key to recency (higher is newer).
`presence` maps a key to `online` or `away`; a missing key is unknown.

Section 6 and the prompt in section 7 are interaction rules. Test them with
client UI tests. The desktop tests are in
[solo-agents.test.tsx](solo-agents.test.tsx) and
`tests/browser/mention-rules.spec.mjs`.

Run the fixtures against the desktop code from the repository root:

```sh
bin/pnpm exec vitest run src/bundled/mentions/mention-ranking.test.ts \
  src/bundled/mentions/mention-query.test.ts \
  src/features/relay/fold.test.ts src/features/relay/mentions.test.ts
```

## Desktop adapter (informative)

- Choice set: [mention-candidates.ts](mention-candidates.ts)
  and [use-mention-choices.ts](use-mention-choices.ts). Directory pages come from
  [useMentionDirectory.ts](useMentionDirectory.ts).
- Matching, order, and Space: [mention-ranking.ts](mention-ranking.ts).
  A pending mention is decided by [resolve-space-mention.ts](resolve-space-mention.ts);
  the host holds and settles the chip in
  [MessageComposer.tsx](../../features/messages/MessageComposer.tsx).
- Query syntax: [mention-query.ts](mention-query.ts).
- Member names for Space (§5): the menu loads the whole roster in the background
  ([MentionCompletion.tsx](MentionCompletion.tsx)). The shared profile cache holds
  1,024 profiles; an open channel adds room for its roster, up to 10,240 in total
  ([profile-directory.ts](../../features/relay/profile-directory.ts)). Past that
  cap, a member whose name is not loaded, and not confirmed absent, keeps the
  local Space shortcut off until a read settles it. Selection after a complete
  directory search still applies (§5).
- Recipient admission (host): [mention-admission.ts](../../features/messages/mention-admission.ts).
  Explicit-choice recency (host): [mention-history.ts](../../features/messages/mention-history.ts).
- Outside-channel prompt (host): [useNonmemberMentions.tsx](../../features/messages/useNonmemberMentions.tsx).
- Bring-into-community prompt (host): [useBringAgents.tsx](../../features/messages/useBringAgents.tsx).
- Tags: [messages.ts](../../features/relay/messages.ts) writes them, and
  [fold.ts](../../features/relay/fold.ts) reads them.

## Sources and precedents

- [Contextual identity names](../identity-naming/README.md): the structure and
  fixture style of this spec, and the source of labels.
- block/buzz, inspected at `20131488528e35e6c50f4ccdb0490a9135c28edf`:
  [message_tags.rs](https://github.com/block/buzz/blob/20131488528e35e6c50f4ccdb0490a9135c28edf/desktop/src-tauri/src/events/message_tags.rs)
  writes two-field `mention` reference tags and the three-field `agent-address`
  form. This contract uses the same shapes.
- block/buzz, inspected at `930b8bb800d8149ce29a881ba4c5d9f424580434`:
  [NonMemberMentionDialog.tsx](https://github.com/block/buzz/blob/930b8bb800d8149ce29a881ba4c5d9f424580434/desktop/src/features/messages/ui/NonMemberMentionDialog.tsx)
  is the source of the section 7 actions.

Keep one canonical spec and fixture set. Other clients can link here or vendor a
pinned version.
