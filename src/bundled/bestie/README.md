# Bestie

Bestie is the account-saved agent pinned in Buzz's left navigation. The
selection is the private `main-agent` record shared with Solo's default-agent
owner; this plugin adds presentation and a conversation destination, not another
selection store.

## Getting started

Bestie starts On for fresh local installs. Upgrades preserve existing saved
choices and retain Off for existing profiles without a saved Bestie choice.
The browser and native plugin storage owners persist that decision; a deliberate
plugin-settings reset uses the current On default. This enables the destination,
not automatic agent creation or messaging. See [plugin defaults](../../../docs/plugin-defaults.md).

### Pinned conversation

When the account has a saved eligible Bestie, the pinned shortcut adopts that
agent's name and avatar and opens their canonical direct message. The canonical
conversation is the newest verified, unarchived, non-cached DM whose roster
contains the viewer and exactly that one other public key. A Solo chat, group DM,
namesake, unknown roster or archived/cached channel never qualifies. If no exact
DM exists, the page asks the shared direct-message service to open one after
rechecking that the agent remains selectable. If agent discovery fails, an
already-verified exact DM stays usable; opening a missing one still requires a
selectable agent. Known-archived agents and agents confirmed absent from a complete
inventory do not keep a pinned conversation.

The page uses the ordinary conversation owners for history, drafts, sending,
threads and unread state. `BestieConversation` owns the local welcome. Its
workspace reuses Messages’ tab state and tab host, with a retained main
timeline/composer and a resizable side pane.
The header also uses the DM’s shared plugin launchers and actions menu, including
Huddle when available, channel details, and eligible plugin menu items.
Threads follow the device’s thread placement preference and support the same
move, rename, close and pane-collapse controls. Profile and plugin links open
in the tab workspace. Thread visits bind to their originating DM. Restoring
one after the Bestie or canonical DM changes retires incompatible thread visits
and shows the current Bestie's chat; it never reads an old thread in the new DM.
⌘F on the page searches this DM, and Search Buzz offers **Search conversation
with** the Bestie, as they do in any other conversation.
While that exact DM is promoted, Messages omits its
ordinary row and clears any old device-local hidden-DM intent. Replacing or
deleting the Bestie, disabling the plugin, changing communities, or losing the
exact roster match releases the promotion and restores the ordinary DM row.

The pinned shortcut and Search Buzz destination show the agent's name and avatar.
Search adds **Bestie** as supporting text and matches either name, so the pinned
DM remains recognizable without presenting a placeholder identity. Agent rows
remain separate **New chat** actions; namesakes stay distinct by exact public key
and use readable owner labels before abbreviated-key fallbacks.

### The Bestie tab

The agent you made your Bestie (with **Make my bestie** in Agents) gets a
**Bestie** tab on its agent page. **Change** picks
another agent and asks before replacing your Bestie. A remote agent, hosted or
on another device, can be your Bestie too. Change, **Make my bestie** and **Make
my Bestie again** offer it, and say before saving that some bestie features
aren't available with remote agents, as **Choosing a Bestie** does: one
question, the replacement's, when it replaces your Bestie. A Bestie on another
device shows no tab, as its instructions and timers aren't on this device; its
card's **Remove as bestie** still removes it, as that saves only to your
account. A
hosted Bestie shows the tab, and its provider can hold its instructions: where
it does (Builderlab does), **Remembers you** reads and saves them through the
provider, as a local agent's synced instructions are, and the row says why
when they can't be read or saved, such as when they would pass the provider's
length limit or you aren't signed in to it. Reading them never starts the
provider's sign-in. A save replaces only the copy the tab shows: if they were
changed elsewhere since, it saves nothing, says so and shows the newer copy.
**Check-ins** stay unavailable for it, as hosted agents have no
Attention timers; a hosted agent whose provider holds no instructions shows
both rows as unavailable. A remote Bestie doesn't start with Remembers you
on. Once it is no longer Bestie, its provider is read once per connection if
this device saw it as Bestie, and it shows **Former Bestie** while its memory
section is on or it is in one of your private channels. If its latest read
fails, even after an earlier one found memory off, the tab stays until a read
succeeds, so its Retry can read again; a read that
started before the newest one recorded never replaces it. **Remove as Bestie**,
in the tab or as **Remove as bestie** in the agent card's menu, asks, then saves
no Bestie to your account: the agent stays, its check-ins stop, and its memory
section and private channels stay, which its Former Bestie tab can turn off.
Both need an account to save none to.

**Remembers you** adds memory rules to the agent's instructions, in a section
marked `<!-- buzz:bestie/memory v1 -->` … `<!-- /buzz:bestie/memory -->`, and
turning it off removes that section. The switch is on while the section is
there, whatever you edit inside it or type next to its markers. Off removes
it with your edits inside it, and keeps text you put before its opening
marker or after its closing one. If you edit, remove or copy one of its
markers, the row says the section was edited instead of showing a switch, so
it never adds a second one. **Restore** puts back the original section in
place of its two markers and what lies between them, when they still show
where it starts and ends; otherwise fix its markers in Instructions. Off
deletes no memory, and the agent's core memory is still in every prompt;
clear memory in the Memory tab.

**Private channels Bestie can read** lists the private channels you share with
Bestie, each with **Remove**, which asks first, as the Members dialog does.
**Add to a channel** (**Choose…**) and **Add to
all my private channels** add it to the private channels you are in, most
recently active first; each channel's members see that you added it. Bestie
joins as a guest, so it reads the channel but can't post there. Each
action has a row of its own, so in a narrow panel its button wraps under it.
Until your channel list has loaded in full, the section says so instead of
saying Bestie is in none: a failed read offers **Retry**, the channels already
known keep their rows, and **Add to all** waits for the full list. A channel
known only from a cached list offers no change until it is read again.
When a row or the Add rows leave with focus in them, focus moves to the
control now in their place, or to the section heading if none is left, unless
you already moved it elsewhere.
Changing your Bestie stops an **Add to all** still under way.
Public channels
need nothing: agents read them already. Adding Bestie to new channels you
create is not set up yet.

**Check-ins → Every hour** needs Remembers you, and turning memory off turns it
off too. On adds the `buzz:bestie/checkin.hourly` Hourly upkeep section to the
instructions and an hourly Attention timer, `watch/bestie-hourly-check-in`,
that wakes Bestie in your DM with it. Each check-in reads what is new in
that DM and in the private channels Bestie was added to, and reports only in
the DM. The Watching tab shows the timer. Off removes the section and the
timer. The timer runs while Buzz is open and the Watching plugin is on: this
plugin doesn't call
`controlAttention()`, so turning Watching off still turns Attention off for
every agent. While the timer can't run, the row says it is paused, and a
timer paused on its own in the Attention tab says to turn the switch off and on
again to restart it. If the instructions fail to save after the timer did, On
removes the timer again; a timer still left without its section gets a
**Remove** row. After a sleep it runs once, not once for each missed hour. Each
check-in is a feature in `features.ts`, so another kind is one more entry.

**Changing your Bestie.** Only your Bestie checks in: whenever the saved Bestie
is known, chosen here or read from your account, any other agent here has its
check-ins removed. Once your account is read to have saved no Bestie, as
**Remove as Bestie** does, every agent here has them removed. An account where
no Bestie was ever chosen changes nothing, as an agent here may be Bestie in
another community that shares its instructions. While the account is being read,
or can't be, nothing is removed either. A choice made on another device reaches
this one when it next reads your account, once per connection. Turning the
Bestie plugin off stops a removal under way before its next save. Its memory
section and channels stay. An agent this device makes Bestie starts with
Remembers you on; a choice synced from elsewhere changes nothing, so memory
turned off stays off. A former Bestie running here or hosted keeps a
**Former Bestie** tab while it has a Bestie section, or, if this device saw it
as Bestie, while it is in one of your private channels. The tab has the same switches, **Remove from all** for
its channels, and **Make my Bestie again**.

### Choosing a Bestie

The account choice is read before the page decides what to show. Reconnecting
and incomplete or failed inventory reads remain on the pinned destination with
their own recovery. Once a complete read proves that the saved agent is gone,
the same chooser appears in place instead of sending the owner to another menu.

Setup is opt-in from the pinned Bestie destination; it does not take over the
initial destination or send an automatic message. With no saved choice, the
shortcut cycles through the same Fuzzies, Gloopies and Figgies as mobile, using
bundled stills. The artwork pauses for reduced motion and hidden documents.

Once the account read confirms no saved Bestie and inventory/archive reads settle,
the rotating shortcut reads **Create an agent**, even when the shared
inventory offers existing agents. When no eligible agents are available, the page
shows **Create your first agent**, with matching character artwork, the description
“Buzz is better with your agents. Create one to get started.” and a **Create an
agent** action. That opens the shared creation form for name, avatar and provider
settings—not a separate onboarding creation path. When that form was opened
with a complete, empty identity inventory, finishing creation records local
first-agent provenance before refreshing or saving the Bestie choice. Refresh
and account-save retries retain it. Existing-agent choices, replacements and
archived identities do not establish first-agent provenance.

After the created agent is selected and its exact DM is verified, a local welcome
introduces the sidebar shortcut and Buzz help. It uses the incoming-message
layout, the agent’s avatar and the normal received bubble, without a visible
local-content disclaimer. It is still local decoration, not a sent message:
no relay event, model turn, unread state, timestamp or message actions.
The receipt is device-local, partitioned by account/community/agent and bound to
the first verified DM; a replacement DM does not inherit it. It remains at the
known beginning of history on the pinned page after sending or reopening. It is
hidden while older history remains. Ordinary DM entry points do not add it.
Unavailable local storage omits this optional decoration without blocking creation.
Otherwise **Choose your bestie agent** lets the owner search eligible existing
agents with avatars, names and short public-key labels, or open the same form.
Known hosted agents and agents on another device remain eligible, but require
confirmation before saving: **Some bestie features aren’t available with remote
agents.** This also applies after creating one through Builderlab.
Cancel leaves the account choice unchanged and keeps any newly created agent.
Local choices save directly. Both paths save through `main-agent`, then hand off
to the canonical DM; this does not configure memory or check-ins for remote agents.
A finished agent deletion saves `agent: null` only when a fresh account read still
names that agent. Another choice already visible to that read is left alone.
This is a read/replace, not an atomic compare-and-swap: a choice made on another
device between the read and publish can still be overwritten. A cleanup failure
reports that the agent was deleted but its Bestie choice could not be cleared;
open Bestie to choose another.

Builderlab no longer owns a separate Bestie setup, agent, Solo chat, or
selection path.
