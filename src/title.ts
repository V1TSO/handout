import { TITLE_MAX_LENGTH } from "./handouts";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function cleanTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_LENGTH);
}

/** Title from the document's own <title>, looking only at the first 64 KB. */
export function titleFromHtml(bytes: Uint8Array): string {
  const head = new TextDecoder().decode(bytes.subarray(0, 65_536));
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (!match?.[1]) return "";
  const text = match[1]
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e);
  return cleanTitle(text);
}

export const UNTITLED = "Untitled";
