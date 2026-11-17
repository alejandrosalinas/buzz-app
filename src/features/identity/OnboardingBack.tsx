import { ArrowLeftIcon } from "../../shared/design-system/icons";
import {
  IconButton,
  type IconButtonProps,
} from "../../shared/design-system/ui/IconButton";

export function OnboardingBack({
  "aria-label": label = "Back",
  ...props
}: Omit<IconButtonProps, "icon" | "emoji" | "aria-label"> & {
  "aria-label"?: string;
}) {
  return (
    <IconButton
      {...props}
      aria-label={label}
      icon={<ArrowLeftIcon />}
      size="lg"
      shape="round"
      variant="subtle"
      data-onboarding-back=""
    />
  );
}
