# Changesets

Shows the files a local agent changed during its reply, with a diff for each.

## Getting started

1. Turn it on in **Settings → Plugins**. It works in the desktop app, for agents that run on this computer in a chat with project folders.
2. After an agent finishes a turn, a card under its last message lists the files it changed with their added and removed lines.
3. Choose a file to open its diff beside the chat.

---

Before and after each turn, the plugin snapshots every project folder that is a Git repository: it adds the working tree to a temporary index and writes the tree. Your branch, index, and working files are untouched, but the snapshot objects are stored in the repository's object store. Run `git gc` to prune them once they are unreferenced. Snapshots take in at most 1,000 changed files, and leave out files over 5 MB.

Snapshots include untracked files that Git does not ignore, so a secret in an unignored file is copied into the object store. Keep secrets in `.gitignore`; a file added to `.gitignore` is left out of later snapshots, but copies already stored remain until `git gc`.

The first snapshot is taken when Buzz sees the turn begin, which can be slightly after the agent starts. Edits made in that gap are missing, and the card says so when the snapshot was slow. Worktrees the agent creates during a turn are included, measured from the commit they were created at.

If another local agent works in the same folder during a turn, the card says some changes may not be that turn's. Agents on other computers and remote agents are not tracked. The most recent 300 turns are kept in this browser profile's local storage.
