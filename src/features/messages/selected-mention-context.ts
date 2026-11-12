import { createContext } from "react";
import type { MentionRecipient } from "./mention-draft";
/** Selected keys participate in naming even if no longer eligible for another selection. */
export const SelectedMentionContext = createContext<
  readonly MentionRecipient[]
>([]);
/** The agents a send from this composer addresses, as its session controls
 * show them; empty while editing. Host-internal. */
export const AddressedAgentsContext = createContext<readonly string[]>([]);
