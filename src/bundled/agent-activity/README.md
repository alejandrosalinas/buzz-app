# Agent Activity

Shows an incoming agent response on the left while your request is being handled.
The avatar and bubble begin with typing dots, then show the current tool step.
The working cue retires when work ends; actual replies and recorded coordination
messages remain readable.

Confirmed failures keep a compact **Couldn’t finish** balloon after the live
progress retires, including when the agent never sends a reply. Expand it for
the explanation and supported activity/recovery actions. The status appears below
Collapse in the expanded view. There is no automatic expiry; **Stopped** remains
neutral. Passive unknown status stays in the internal recovery model without
creating a conversation error balloon. Real coordination messages remain history.

## Getting started

1. Mention an agent in a conversation.
2. Its picture and typing bubble appear on the agent's side of the conversation.
3. Tool details appear in that bubble as they arrive. Hover for activity controls, including Stop, or click to open the thread when available.
