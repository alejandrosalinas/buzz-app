import {
  type ComponentProps,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import type { BuilderlabPhone } from "../../features/identity/builderlab-account";
import { QrCode, renderQrCode, useQrVariant } from "../../shared/QrCode";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PairingSettings } from "./PairingSettings";

/** The build's mobile app listings (`BUZZ_MOBILE_APP_IOS_URL`,
 * `BUZZ_MOBILE_APP_ANDROID_URL`); a store the build doesn't set is left out. */
export const mobileAppStores = () =>
  [
    {
      name: "the App Store",
      url: import.meta.env.VITE_BUZZ_MOBILE_APP_IOS_URL,
    },
    {
      name: "Google Play",
      url: import.meta.env.VITE_BUZZ_MOBILE_APP_ANDROID_URL,
    },
  ].filter((store): store is Store => !!store.url);

type Store = { name: string; url: string };

/**
 * The mobile card. A phone signed in with Builderlab restores the account's
 * bound, backed-up key, so where that key is this device's the card only says
 * where to get the app. Every other case pairs the phone with this identity.
 */
export function MobileSettings({
  federatedIdentity,
  phone,
  stores = mobileAppStores(),
  ...pairing
}: ComponentProps<typeof PairingSettings> & {
  /** Builderlab's sign-in session, watched for who is signed in; absent in
   * builds without one. */
  federatedIdentity?:
    | Pick<FederatedIdentity, "snapshot" | "subscribe">
    | undefined;
  /** The app-owned account check (`BuilderlabPhone`): whether a phone signed
   * in with Builderlab restores `viewer`. */
  phone?: BuilderlabPhone | undefined;
  stores?: readonly Store[];
}) {
  const session = useSyncExternalStore(
    federatedIdentity?.subscribe ?? noSubscription,
    () => federatedIdentity?.snapshot(),
  );
  const viewer = useSyncExternalStore(
    pairing.communities.subscribe,
    pairing.communities.snapshot,
  ).viewer;
  // A backup finishing after the read may have just backed up the linked key.
  const backedUp = useSyncExternalStore(
    phone?.subscribe ?? noSubscription,
    () => phone?.backupComplete() ?? false,
  );
  const signedIn =
    session?.status === "signed-in" && session.authority ? session : undefined;
  // Restoring or signing in may still end signed in, so neither decides yet.
  const settling =
    !!phone &&
    (session?.status === "restoring" || session?.status === "signing-in");
  const check =
    signedIn && viewer && phone
      ? `${signedIn.revision}:${viewer}:${backedUp}`
      : "";
  const [restores, setRestores] = useState<{ check: string; ok: boolean }>();
  useEffect(() => {
    if (!check || !viewer || !phone) return;
    let current = true;
    phone
      .restoresOnPhone(viewer)
      .catch(() => false)
      .then((ok) => current && setRestores({ check, ok }));
    return () => {
      current = false;
    };
  }, [check, phone, viewer]);
  const answer = restores?.check === check ? restores.ok : undefined;
  const decided: View | undefined =
    settling || (check && answer === undefined)
      ? undefined
      : answer
        ? "app"
        : "pair";
  // Whose app view was shown: the same account, not only the same session.
  const account = session?.authority
    ? `${session.authority.id}:${session.email ?? ""}`
    : "";
  // The view last decided, kept while the account is read again so a recheck
  // never tears down pairing (which cancels it) or flashes the app view.
  const [shown, setShown] = useState<Shown>();
  useEffect(() => {
    if (decided)
      setShown((last) =>
        last?.view === decided &&
        last.viewer === viewer &&
        last.account === account
          ? last
          : { view: decided, viewer, account },
      );
  }, [decided, viewer, account]);
  // Pairing stays for the same identity; the app view only for its account.
  const kept =
    shown &&
    shown.viewer === viewer &&
    (shown.view === "pair" || (!!account && shown.account === account))
      ? shown.view
      : undefined;
  const view = decided ?? kept;
  if (view === "pair") return <PairingSettings {...pairing} />;
  if (view === "app")
    return <GetTheApp email={session?.email ?? null} stores={stores} />;
  // Pairing starts a session as it mounts, so it waits for the answer; the
  // card's heading holds its place meanwhile.
  return (
    <LoadingRegion pending label="Checking your Builderlab account…">
      <section aria-labelledby="mobile-app-title" className="min-w-0">
        <h2 id="mobile-app-title" className="mt-0 mb-2 text-label">
          Mobile app
        </h2>
      </section>
    </LoadingRegion>
  );
}

type View = "pair" | "app";
type Shown = { view: View; viewer: string | undefined; account: string };

const noSubscription = () => () => {};

function GetTheApp({
  email,
  stores,
}: {
  email: string | null;
  stores: readonly Store[];
}) {
  return (
    <section aria-labelledby="mobile-app-title" className="min-w-0">
      <h2 id="mobile-app-title" className="mt-0 mb-2 text-label">
        Get Buzz on your phone
      </h2>
      <p className="mt-0 mb-6 text-body-sm text-muted">
        {`Install Buzz on your phone${stores.length ? "" : " from its app store"}, then sign in with Builderlab${email ? ` as ${email}` : ""}.`}
      </p>
      {stores.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-6 p-0">
          {stores.map((store) => (
            <StoreCode key={store.name} store={store} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A store's QR code to scan with the phone, and its link, in the color
 * mode's variant as invite codes are. A same-size placeholder holds the code's place
 * while it renders. Without the native renderer (the browser host) only the
 * link shows. */
function StoreCode({ store }: { store: Store }) {
  const variant = useQrVariant();
  const key = `${variant}:${store.url}`;
  const [drawn, setDrawn] = useState<{ key: string; svg?: string }>();
  useEffect(() => {
    let current = true;
    renderQrCode(store.url, variant).then(
      (svg) => current && setDrawn({ key, svg }),
      () => current && setDrawn({ key }),
    );
    return () => {
      current = false;
    };
  }, [key, store.url, variant]);
  const code = drawn?.key === key ? drawn : undefined;
  return (
    <li className="flex w-60 max-w-full flex-col items-center gap-3">
      {code?.svg ? (
        <QrCode
          svg={code.svg}
          alt={`Scan with your phone to get Buzz from ${store.name}`}
        />
      ) : (
        !code && (
          <div
            aria-hidden="true"
            className="size-60 max-w-full shrink-0 bg-surface-inset"
          />
        )
      )}
      <a
        className="text-body-sm text-link underline"
        href={store.url}
        target="_blank"
        rel="noreferrer"
      >
        {`Get it on ${store.name}`}
      </a>
    </li>
  );
}
