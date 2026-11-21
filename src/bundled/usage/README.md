# Usage

Estimates what your agents' Claude Code, Codex and goose sessions on this computer cost, from each harness's own session files: the cost a harness records, or else its token counts at each provider's published API prices, from [genai-prices](https://github.com/pydantic/genai-prices). It is a best-effort estimate, not your bill.

A timer's or watch's turn leaves no conversation behind, so this app keeps a record of the session each one starts: its id and start time only, Usage on or off. While Usage is on, it also keeps which timer or watch it was, for **By routine**. Claude Code, goose and Pi turns run while Usage was off are counted in the totals, and under Other in **By routine**, which shows only once a session in the period has its timer or watch. Codex turns run while Usage was off are not counted: Codex keeps no transcript of them.

An agent set to one session per community runs its timers and watches in that shared session, so **By routine** shows their cost under Other. The total is still right.

## Getting started

1. Open **Settings → Usage**, under Plugins.
2. Choose **Last 7 days** or **Last 30 days**, and an agent or harness to narrow it down.
3. Select a session to open its conversation, or an agent to open it in Agents.
