# Claude

Create agents that run Claude on your computer and answer you in Buzz. Each agent works in its own **Workspace** folder and can run commands and edit files on its own.

## Getting started

1. Go to **Settings** → **Agent setup** → **Harness defaults** → **Claude** to install Claude and paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). Buzz keeps it in the OS credential store (Keychain on macOS), and native code gives it to every Claude process, security reviews included.
2. Choose **New agent** → **Create a new agent**, and pick **Claude** as the **Harness**.
3. Mention your agent in a conversation to give it work.

Open **Settings** → **Claude** to manage the saved key. Focus or click the masked field, or use its chevron, to open **Replace / Remove**. Replacement starts blank and masked, with inline **Cancel / Save** buttons. Settings cannot reveal or copy the saved key. **Remove** deletes it from secure storage after confirmation; the menu is unavailable during replacement. Key management also works when Claude needs installation or an update.

New local Claude sessions and security reviews need a key again; a turn already running can finish. Agents on another computer use that computer's credentials.
