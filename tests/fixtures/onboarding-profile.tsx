import { createRoot } from "react-dom/client";
import { ProfileStep } from "../../src/features/identity/ProfileStep";
import { WireframeScreen } from "../../src/features/identity/Wireframe";
import "../../src/shared/styles/globals.css";

// The first-run profile step with its dotted-circle avatar; no relay behind it.
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <WireframeScreen>
      <ProfileStep
        found={{ url: "wss://relay.example", host: "relay.example" }}
        read={{ exists: false } as never}
        defaultName="Fixture human"
        onContinue={async () => {}}
      />
    </WireframeScreen>,
  );
