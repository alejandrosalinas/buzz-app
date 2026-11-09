# Agents

Your home for creating and managing agents. Set them up, group them into teams, and find agents others in your community have shared.

## Getting started

1. Open **Agents**. With no agents yet, bring in the ones you have in your other communities or had in an earlier Buzz, create your first, or explore the marketplace.
2. Later, choose **New agent** and pick **Create a new agent**, **Import an agent**, or **Browse the marketplace**. Import lists everything in one place and stays open, so you can import several agents in a row. An agent from another of your communities comes in as the same agent: its name, type and settings stay shared, while its picture, attention, memory and conversations in each community are its own. A Buzz (Legacy) agent comes in as the type its button names; the button's menu changes it. **Import a team** works the same way for teams. Import remains available when a source cannot be read, so you can inspect its warning. The first-visit import tile waits for candidates, warnings or a failed read. Stop an agent’s old runtime before importing it from Buzz (Legacy), or both runtimes may answer. Instructions and workspace transfer only when the selected type supports them; choose provider, model and other settings afterward.
3. To take an agent out of one community and keep it in the others, use **Remove from this community** in its menu or settings. **Delete agent** removes it from every community.
4. Use **Settings** → **Agent setup** → **Harness defaults** to install or sign in to an agent type such as Claude or Codex.

---

## Developer import scenarios

Development builds expose **Settings → Developer → Agent import**. **What Import finds** supplies simulated community/Legacy findings for reviewing the production Agents page and its dialogs. Simulated imports leave agents unchanged. **Real data** uses actual imports, including when **Show as a new community** hides the existing inventory. Turn that switch off and choose Real data to return to the normal view. These controls are absent from packaged builds.

## Connecting from an old agent’s DM

On desktop, a one-to-one DM can show **Connect [agent name]** when its exact identity is available to import locally and its signed profile confirms you own it. Already managed or visibly online agents do not show this prompt. Saved harness, provider and model choices are preselected where supported; explicitly saved effort is preserved and can be changed later in agent settings. An unavailable runtime or harness without inline setup support requires choosing another harness; unsaved selections use that type’s defaults. Review the inline controls. **Connect** stays disabled until the harness resolves its provider and model, including usable defaults. Then choose **Connect**. Installation or sign-in uses the type’s existing setup dialog. Stop the old runtime first. The import retains the identity and conversation; supported instructions/workspace are adopted. No earlier message is resent.

Channel and thread setup cards require a fresh mention sent while the conversation is open and confirmed delivered; historical mentions do not trigger them. Known-archived identities are excluded. The **X** in the card’s top-right corner saves a per-conversation dismissal for that identity.
