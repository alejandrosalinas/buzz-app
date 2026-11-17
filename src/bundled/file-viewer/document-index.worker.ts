import { type DocumentKind, indexData } from "./document-parts";

self.onmessage = (
  event: MessageEvent<{ text: string; kind: DocumentKind }>,
) => {
  try {
    self.postMessage({ data: indexData(event.data.text, event.data.kind) });
  } catch {
    self.postMessage({ error: "The file couldn't be indexed." });
  }
};
