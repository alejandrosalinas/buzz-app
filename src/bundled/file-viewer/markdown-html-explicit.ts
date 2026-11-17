// CommonMark HTML blocks with explicit terminators retain their kind across cuts.
export type ExplicitHtml = Readonly<{
  kind: "pi" | "cdata" | "declaration";
  visible: boolean;
  lineTail?: boolean;
}>;

export function explicitHtmlStart(line: string): ExplicitHtml | undefined {
  if (/^ {0,3}<\?/.test(line)) return { kind: "pi", visible: false };
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return { kind: "cdata", visible: false };
  // The installed CommonMark parser accepts either ASCII case.
  if (/^ {0,3}<![A-Za-z]/.test(line))
    return { kind: "declaration", visible: false };
  return undefined;
}
export const explicitHtmlEnd = (state: ExplicitHtml): string =>
  state.kind === "pi" ? "?>" : state.kind === "cdata" ? "]]>" : ">";
