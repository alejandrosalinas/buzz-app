import { Header } from "../../shared/design-system/ui/Header";
import { AuthorSettings } from "./AuthorSettings";
import { LinkSettings } from "./LinkSettings";

export function GitHubSettings({ active }: { active(): boolean }) {
  return (
    <section aria-label="GitHub settings">
      <Header title="GitHub" />
      <div className="grid grid-cols-1 gap-section-gap">
        <LinkSettings active={active} />
        <AuthorSettings active={active} />
      </div>
    </section>
  );
}
