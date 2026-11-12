import { useState, type Ref } from "react";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { AvatarEditor } from "../profiles/AvatarEditor";
import { profilePictureError } from "../profiles/avatar-upload";
import type { PersonalProfile } from "./service";
import type { VerifiedProfile } from "../relay/verified-profile";
import { PROFILE_ABOUT_MAX_LENGTH } from "./service";
import { Textarea } from "../../shared/design-system/ui/Textarea";

export function profilesEqual(left: PersonalProfile, right: PersonalProfile) {
  return (
    left.name === right.name &&
    left.picture === right.picture &&
    (left.about ?? "") === (right.about ?? "")
  );
}

export function canSaveProfile(profile: PersonalProfile) {
  return (
    !!profile.name.trim() &&
    !profilePictureError(profile.picture) &&
    (profile.about?.length ?? 0) <= PROFILE_ABOUT_MAX_LENGTH
  );
}

export function ProfileFields({
  profile,
  onChange,
  disabled = false,
  community,
  onBusyChange,
  showAvatar = true,
  showAbout = true,
  emptyAvatarStyle,
  autoFocus = false,
  nameRef,
  verifiedName,
}: {
  profile: PersonalProfile;
  onChange(profile: PersonalProfile): void;
  disabled?: boolean;
  community?: string | undefined;
  onBusyChange?(busy: boolean): void;
  showAvatar?: boolean;
  showAbout?: boolean;
  emptyAvatarStyle?: "dotted-circle";
  /** Focuses the display name on mount, for pages whose only task is this form. */
  autoFocus?: boolean;
  nameRef?: Ref<HTMLInputElement>;
  /** A relay-verified name replaces the editable display name. */
  verifiedName?:
    | {
        name: string;
        username?: string;
        issuerLabel: string;
        status: VerifiedProfile["status"];
      }
    | undefined;
}) {
  // A simplified form must still let people repair an invalid saved description.
  const [repairAbout] = useState(
    () => (profile.about?.length ?? 0) > PROFILE_ABOUT_MAX_LENGTH,
  );
  return (
    <div className="grid gap-4">
      {showAvatar && (
        <AvatarEditor
          personal
          emptyStyle={emptyAvatarStyle}
          value={profile.picture}
          name={profile.name}
          community={community}
          disabled={disabled}
          onBusyChange={onBusyChange}
          onChange={(picture) => onChange({ ...profile, picture })}
        />
      )}
      <Field
        label="Display name"
        description={
          verifiedName
            ? `${
                verifiedName.status === "checked"
                  ? `Name verified by ${verifiedName.issuerLabel}`
                  : `Cached verification from ${verifiedName.issuerLabel}`
              }${
                verifiedName.username &&
                verifiedName.username !== verifiedName.name
                  ? ` · @${verifiedName.username}`
                  : ""
              }`
            : undefined
        }
      >
        <Input
          ref={nameRef}
          autoComplete="nickname"
          spellCheck={false}
          autoFocus={autoFocus}
          required
          disabled={disabled}
          readOnly={!!verifiedName}
          value={verifiedName?.name ?? profile.name}
          maxLength={100}
          onChange={(event) =>
            onChange({ ...profile, name: event.target.value })
          }
        />
      </Field>
      {(showAbout || repairAbout) && (
        <Field
          label="Profile description (optional)"
          description={`${profile.about?.length ?? 0} of ${PROFILE_ABOUT_MAX_LENGTH} characters`}
          error={
            (profile.about?.length ?? 0) > PROFILE_ABOUT_MAX_LENGTH
              ? `Shorten the description to ${PROFILE_ABOUT_MAX_LENGTH} characters before saving.`
              : undefined
          }
        >
          <Textarea
            rows={3}
            disabled={disabled}
            value={profile.about ?? ""}
            onChange={(event) =>
              onChange({ ...profile, about: event.target.value })
            }
          />
        </Field>
      )}
    </div>
  );
}
