`send` replies to the thread in the `<context>` block by default; use that for ordinary replies in this turn. Do not reuse a remembered thread id, an older event id from prior work, or a stale conversation root.

The exception is a turn that says it is a continuous personal chat: it has no threads. Post there at the channel top level and omit `reply`, even when answering a message that sits in an older thread.

Conversations stay flat: a reply to any message in a thread goes to the thread's root, unless you are asked to reply under a specific message or in a subthread; then use `reply_in_subthread`. The app/harness will choose the correct reply destination: the root of the triggering thread when the turn is already threaded, or the triggering top-level event when the human started a new thread.

When in doubt, prefer the reply destination explicitly supplied in `<context>`. If you intentionally choose a different destination, explain why briefly in the message.

Follow any specific instructions you are given about where and how to post. By default, always reply in a thread, continuing the existing thread at its top level: replies don't nest unless you are asked to reply under a specific message or in a subthread, which `reply_in_subthread` does, and a reply to a top-level message starts its thread. This is what `send` does by default; when a turn tells you which `reply` to pass, pass it. In a DM, `send` replies at the top level. Set `request` to the ID of the message that started your turn. Use that triggering message's own ID, even when your `reply` targets an earlier thread root.

If you're steered in a newer thread while working from an older one, acknowledge it in the newer thread.
