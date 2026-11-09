import { useEffect, useState } from "react";

/** Measure CSS font resolution through the same DOM path as the terminal. */
export async function canLoadFont(family: string): Promise<boolean> {
  const sample = "mmmmmmmmmmWWWWWWWWWW0123456789";
  try {
    await document.fonts.load(`32px "${family}"`, sample);
    const probe = document.createElement("span");
    probe.textContent = sample;
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;visibility:hidden;white-space:pre;width:max-content;";
    document.body.append(probe);
    try {
      return ["monospace", "serif"].some((fallback) => {
        probe.style.font = `32px ${fallback}`;
        const baseline = probe.getBoundingClientRect().width;
        probe.style.font = `32px "${family}", ${fallback}`;
        return probe.getBoundingClientRect().width !== baseline;
      });
    } finally {
      probe.remove();
    }
  } catch {
    return false;
  }
}

export function useFontAvailability(family: string | null) {
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<{
    family: string;
    attempt: number;
    available: boolean;
  } | null>(null);
  useEffect(() => {
    if (!family) return;
    let current = true;
    void canLoadFont(family).then((available) => {
      if (current) setResult({ family, attempt, available });
    });
    return () => {
      current = false;
    };
  }, [family, attempt]);
  return {
    status:
      family === null
        ? "available"
        : result?.family !== family || result.attempt !== attempt
          ? "checking"
          : result.available
            ? "available"
            : "unavailable",
    retry: () => retry((value) => value + 1),
  };
}
