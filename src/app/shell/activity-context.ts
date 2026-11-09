import { createContext } from "react";

export const ACTIVITY_PAGE = "buzz.inbox/inbox";
export type ActivityEmoji = Readonly<{
  content: string;
  source?: string | undefined;
  active: boolean;
}>;
export const ActivityEmojiContext = createContext<ActivityEmoji | undefined>(
  undefined,
);
