import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import type { OwnedCommunity } from "./builderlab-account";
import { CommunityUrlField } from "./CommunityUrlField";
import { OnboardingScreen } from "./OnboardingScreen";

/**
 * First-run landing after setup. The community URL is the live action; a
 * linked account's owned communities are offered as rows that take the same
 * path with their address, and, with `onCreate`, Or create a community sits under Continue.
 */
export function JoinCommunity({
  url,
  onUrlChange,
  onFind,
  owned = [],
  onCreate,
}: {
  url: string;
  onUrlChange: (url: string) => void;
  /** Receives the canonical secure origin, and an invite link's code when one was pasted. */
  onFind: (origin: string, code?: string) => void;
  owned?: readonly OwnedCommunity[] | undefined;
  /** Offers Create a community, where the account may create one. */
  onCreate?: (() => void) | undefined;
}) {
  // The in-app Connect to a community landing's layout (CommunityLanding).
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        <>
          <h1
            id="welcome-title"
            tabIndex={-1}
            className="text-heading text-standard"
          >
            Connect to a community
          </h1>
          <p className="m-0 text-body text-subtle">
            Communities are where you work with people and agents.
            {onCreate ? " Join an existing one or create your own." : ""}
          </p>
          <div className="mt-10 mb-6 grid w-full max-w-md gap-10 text-left">
            {owned.length > 0 && (
              // min-w-0 keeps a long hostname truncating rather than widening the grid.
              <div className="flex min-w-0 flex-col gap-2">
                <h2 className="m-0 text-body text-subtle">
                  Communities you own
                </h2>
                <ul
                  aria-label="Communities you own"
                  className="m-0 flex list-none flex-col gap-3 p-0"
                >
                  {owned.map(({ host, url: origin }) => (
                    <li key={origin} className="flex items-center gap-3">
                      <Avatar alt="" fallback={host} />
                      <p className="m-0 min-w-0 flex-1 truncate text-label text-standard">
                        {host}
                      </p>
                      <Button
                        aria-label={`Connect to ${host}`}
                        onClick={() => onFind(origin)}
                      >
                        Connect
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid gap-3">
              <CommunityUrlField
                url={url}
                onUrlChange={onUrlChange}
                onSubmit={onFind}
                stacked
              />
              {onCreate && (
                <Button
                  size="lg"
                  variant="ghost"
                  data-return-focus="create"
                  onClick={onCreate}
                >
                  Or create a community
                </Button>
              )}
            </div>
          </div>
        </>
      }
    >
      {null}
    </OnboardingScreen>
  );
}
