import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { relayOrigin } from "../communities/destination";

export type HuddleDestination = Readonly<{
  scope: string;
  viewer: string;
  relayUrl: string;
  channelId: string;
  channelName: string;
}>;
export type HuddleUpdate =
  | { type: "connected"; room: string; participants: string[] }
  | { type: "participants"; participants: string[] }
  | { type: "audio"; peer: string; samples: number[] }
  | { type: "ended"; error: string | null };
export type HuddleBridge = {
  available: boolean;
  open(
    id: string,
    destination: HuddleDestination,
    room: string | undefined,
    receive: (update: HuddleUpdate) => void,
    agent?: string,
  ): Promise<void>;
  close(id: string): Promise<void>;
  touch(id: string): Promise<void>;
  send(id: string, samples: number[]): Promise<void>;
};
export const nativeHuddles: HuddleBridge = {
  available: isTauri(),
  open(id, destination, room, receive, agent) {
    const updates = new Channel<HuddleUpdate>();
    updates.onmessage = receive;
    return invoke("huddle_open", {
      call: {
        id,
        community: relayOrigin(destination.relayUrl),
        viewer: destination.viewer,
        parent: destination.channelId,
        room: room ?? null,
        agent: agent ?? null,
      },
      updates,
    });
  },
  close: (id) => invoke("huddle_close", { id }),
  touch: (id) => invoke("huddle_touch", { id }),
  send: (id, samples) => invoke("huddle_pcm", { id, samples }),
};
