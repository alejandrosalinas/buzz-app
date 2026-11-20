import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MessageRow } from "../../src/features/messages/MessageRow";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { IconButton } from "../../src/shared/design-system/ui/IconButton";
import { ThreadIcon } from "../../src/shared/design-system/icons";
import {
  message,
  profiles,
  reader,
  teammate,
  media,
} from "./message-gallery/examples";
import "../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
function App() {
  useKeyboardFocusVisibility();
  const [options, set] = useState({
    layout: "timeline",
    own: true,
    grouped: true,
    content: "text",
  });
  Object.assign(window, { toolbarFixture: { set } });
  return (
    <ToastProvider>
      <main
        data-scenario={JSON.stringify(options)}
        style={{ padding: "70px 24px" }}
      >
        <div
          data-message-scroller
          style={{
            height: "65vh",
            overflow: "auto",
            border: "1px solid gray",
            padding: "30px 20px",
          }}
        >
          <div style={{ height: 30 }} />
          {["a", "b", "c"].map((id, index) => (
            <MessageRow
              key={JSON.stringify(options) + id}
              row={message(
                id,
                options.content === "media"
                  ? "Caption for this media"
                  : index === 1
                    ? "The message whose toolbar should stay reachable."
                    : "Another message above or below the target.",
                {
                  authorId: options.own ? reader : teammate,
                  createdAt: 1790078400 + index * 30,
                  ...(options.content === "media"
                    ? {
                        attachments: [
                          {
                            url: "https://fixture.test/landscape",
                            kind: "image",
                          } as const,
                        ],
                      }
                    : {}),
                },
              )}
              day={false}
              retry={undefined}
              onOpenLink={() => false}
              viewer={reader}
              profile={profiles.get(options.own ? reader : teammate)}
              participantProfiles={profiles}
              media={media}
              layout={options.layout as "timeline" | "thread" | "continuation"}
              stackPrevious={options.grouped && index > 0}
              stackNext={options.grouped && index < 2}
              onOpenThread={() => {}}
              quickControls={
                <IconButton
                  title="Add reaction"
                  aria-label="Add reaction"
                  size="sm"
                  icon={<ThreadIcon />}
                />
              }
            />
          ))}
          <div style={{ height: 200 }} />
        </div>
      </main>
    </ToastProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App />);
