import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SkillMarkdownPreview, resolveSkillResourceLink } from "./SkillMarkdownPreview";

describe("Skill package Markdown preview", () => {
  it("resolves relative package files without crossing the package boundary", () => {
    const paths = ["SKILL.md", "references/notes.md", "assets/image.png"];
    expect(resolveSkillResourceLink("../SKILL.md#usage", "references/notes.md", paths)).toBe(
      "SKILL.md",
    );
    expect(resolveSkillResourceLink("references/notes.md", "SKILL.md", paths)).toBe(
      "references/notes.md",
    );
    for (const value of [
      "../../etc/passwd",
      "%2e%2e/secret",
      "/SKILL.md",
      "file:///SKILL.md",
      "javascript:alert(1)",
      "missing.md",
      "%invalid",
    ])
      expect(resolveSkillResourceLink(value, "SKILL.md", paths)).toBeNull();
  });
  it("renders headings and GFM without raw HTML, runnable code or automatic external image loads", () => {
    const output = renderToStaticMarkup(
      <SkillMarkdownPreview
        currentPath="SKILL.md"
        paths={["SKILL.md", "references/notes.md"]}
        onOpenResource={vi.fn()}
        text={
          '---\nname: Hidden metadata\n---\n# Reading guide\n\n[Notes](references/notes.md)\n\n![Private](https://example.invalid/tracker.png)\n\n<script>alert("unsafe")</script>\n\n| A | B |\n| --- | --- |\n| one | two |\n'
        }
      />,
    );
    expect(output).toContain("<h1>Reading guide</h1>");
    expect(output).toContain("<table>");
    expect(output).toContain(">Notes</button>");
    expect(output).not.toContain("Hidden metadata");
    expect(output).not.toContain("<script");
    expect(output).not.toContain("<img");
    expect(output).not.toContain('src="https://example.invalid');
  });
});
