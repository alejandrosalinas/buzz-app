import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import "../../src/shared/styles/globals.css";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { createScreen } from "../../src/bundled/terminal/renderer";
import type { TerminalInputSource } from "../../src/bundled/terminal/renderer";
import { createTerminalFontPreference } from "../../src/bundled/terminal/font-preference";

function Fixture() {
  useKeyboardFocusVisibility();
  const host = useRef<HTMLDivElement>(null);
  const [visible, show] = useState(true);
  const [input, setInput] = useState("");
  const [dimensions, resized] = useState("");
  const [font] = useState(() => createTerminalFontPreference());
  const [generated] = useState<{ data: string; source: TerminalInputSource }[]>(
    [],
  );
  const [screen] = useState(() =>
    createScreen(
      (data, source) => {
        generated.push({ data, source });
        setInput((value) => value + data);
      },
      (cols, rows) => resized(`${cols}x${rows}`),
      font,
    ),
  );
  useEffect(() => {
    if (visible && host.current) return screen.mount(host.current);
  }, [visible, screen]);
  useEffect(() => {
    Object.assign(window, {
      terminalRenderer: {
        generated,
        font,
        output: (data: string) => screen.output(new TextEncoder().encode(data)),
      },
    });
    return () => {
      screen.dispose();
      font.dispose();
    };
  }, [screen, generated, font]);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          document.documentElement.dataset.colorMode =
            document.documentElement.dataset.colorMode === "dark"
              ? "light"
              : "dark";
        }}
      >
        Toggle theme
      </button>
      <button
        type="button"
        onClick={() => {
          document.documentElement.style.setProperty(
            "--buzz-text-scale",
            "1.5",
          );
        }}
      >
        Enlarge text
      </button>
      <button type="button" onClick={() => show((v) => !v)}>
        Toggle mount
      </button>
      <button
        type="button"
        onClick={() =>
          void screen.output(
            new TextEncoder().encode(
              "\x1b[2J\x1b[HBUZZ_RENDERER_READY\r\n" +
                "\x1b[97;40mANSI_WHITE_ON_BLACK\x1b[0m\r\n" +
                "\x1b[37;100mANSI_WHITE_ON_GRAY\x1b[0m\r\n" +
                "\x1b[97mANSI_WHITE_ON_DEFAULT\x1b[0m\r\n" +
                "\x1b[30mANSI_BLACK_ON_DEFAULT\x1b[0m\r\n",
            ),
          )
        }
      >
        Paint terminal
      </button>
      <button
        type="button"
        onClick={() =>
          void screen.output(
            new TextEncoder().encode("\x1b[?1049hFULL_SCREEN\x1b[?1049l"),
          )
        }
      >
        Alternate screen
      </button>
      <output aria-label="Input">{JSON.stringify(input)}</output>
      <output aria-label="Dimensions">{dimensions}</output>
      {visible && (
        <div
          ref={host}
          style={{ width: "80vw", height: 320, background: "var(--bg-panel)" }}
        />
      )}
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Fixture />);
