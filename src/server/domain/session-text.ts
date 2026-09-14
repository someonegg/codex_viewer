import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

export const MAX_PREVIEW_CHARS = 256;
export const MAX_SESSION_TITLE_CHARS = 80;
const MAX_TITLE_HEADING_DEPTH = 64;

export function truncateText(
  value: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  let end = limit;
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff &&
    next >= 0xdc00 && next <= 0xdfff;
  if (splitsSurrogatePair) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}

export function normalizeSessionTitle(value: string | null): string | null {
  if (value === null) return null;
  const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine === undefined
    ? null
    : truncateText(firstLine, MAX_SESSION_TITLE_CHARS).text;
}

export function sessionTitleFromMarkdown(value: string): string | null {
  const heading = firstTitleHeading(fromMarkdown(value), 0);
  return normalizeSessionTitle(heading ?? value);
}

function firstTitleHeading(node: Nodes, depth: number): string | null {
  if (node.type === "heading" && (node.depth === 1 || node.depth === 2)) {
    const text = toString(node).trim();
    if (text.length > 0) return text;
  }
  if (depth >= MAX_TITLE_HEADING_DEPTH || !("children" in node)) return null;
  for (const child of node.children) {
    const heading = firstTitleHeading(child, depth + 1);
    if (heading !== null) return heading;
  }
  return null;
}
