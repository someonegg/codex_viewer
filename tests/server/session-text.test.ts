import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_TITLE_CHARS,
  sessionTitleFromMarkdown,
  truncateText,
} from "../../src/server/domain/session-text.js";

describe("session title text", () => {
  it("does not split a UTF-16 surrogate pair at the code-unit limit", () => {
    const prefix = "x".repeat(3);

    expect(truncateText(`${prefix}😀tail`, 4)).toEqual({
      text: prefix,
      truncated: true,
    });
  });

  it.each([
    ["intro\n\n# ATX level one", "ATX level one"],
    ["intro\n\n## ATX level two", "ATX level two"],
    ["intro\n\nSetext level one\n================", "Setext level one"],
    ["intro\n\nSetext level two\n----------------", "Setext level two"],
  ])("uses a Markdown H1 or H2 from %j", (markdown, expected) => {
    expect(sessionTitleFromMarkdown(markdown)).toBe(expected);
  });

  it("uses the first H1 or H2 in document order and extracts plain text", () => {
    expect(sessionTitleFromMarkdown(
      "## **First** [heading](https://example.com) with `code`\n\n# Later heading",
    )).toBe("First heading with code");
  });

  it.each([
    ["Fallback line\n\n### Level three", "Fallback line"],
    ["Fallback line\n\n```md\n# Fenced heading\n```", "Fallback line"],
  ])("ignores non-title heading syntax in %j", (markdown, expected) => {
    expect(sessionTitleFromMarkdown(markdown)).toBe(expected);
  });

  it("bounds a Markdown heading to the session title limit", () => {
    const heading = "x".repeat(MAX_SESSION_TITLE_CHARS + 1);
    expect(sessionTitleFromMarkdown(`# ${heading}`)).toBe(
      heading.slice(0, MAX_SESSION_TITLE_CHARS),
    );
  });

  it("safely falls back when Markdown nesting exceeds the title traversal limit", () => {
    const markdown = `${"> ".repeat(5_000)}# Deep heading`;
    expect(sessionTitleFromMarkdown(markdown)).not.toBe("Deep heading");
  });
});
