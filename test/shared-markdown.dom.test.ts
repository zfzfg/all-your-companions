/**
 * chat.js publishes its markdown renderer on `window.__grokRenderMarkdown` so
 * the desktop file panel — injected into the SAME document after load — can
 * preview `.md` files with the conversation's renderer instead of the ~35-line
 * private subset it used to carry (headings, fences and bold only: no bullets,
 * no tables, no links, no italics).
 *
 * The export is a contract between two surfaces in different files, so it needs
 * its own coverage: deleting it would leave the panel silently degraded to its
 * fallback rather than failing anything.
 */
import { describe, expect, it } from "vitest";
import { bootWebview } from "./webview-harness";

function render(md: string): string {
  const h = bootWebview({ ready: true });
  const fn = (h.window as any).__grokRenderMarkdown;
  expect(typeof fn).toBe("function");
  return String(fn(md));
}

describe("shared markdown renderer (window.__grokRenderMarkdown)", () => {
  it("renders bullets — the panel's own parser never did", () => {
    const html = render("- alpha\n- beta\n");
    expect(html).toContain("<li>");
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
  });

  it("renders GFM tables", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain("md-table-wrap");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
  });

  it("still renders what the old subset did", () => {
    const html = render("# Title\n\n**bold** and `code`\n\n```\nfenced\n```\n");
    expect(html).toContain("Title");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>");
    expect(html).toContain("fenced");
  });

  it("escapes raw HTML in the source — repo files are not trusted markup", () => {
    // The panel previews files from whatever repository is open. If a README
    // could inject live markup it would run inside the Electron renderer, which
    // holds the preload bridge. `inline()` escapes &, < and > first, so this
    // must come back inert.
    const html = render('<img src=x onerror="alert(1)">\n');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("renders markdown images as safe img tags", () => {
    const html = render("![Diagram](images/flow.png)\n");
    expect(html).toContain('<img class="md-image" src="images/flow.png" alt="Diagram" loading="lazy" />');
  });

  it("renders GitHub alerts for NOTE, TIP, WARNING, IMPORTANT, CAUTION", () => {
    const noteHtml = render("> [!NOTE]\n> This is a note.\n");
    expect(noteHtml).toContain("md-alert md-alert-note");
    expect(noteHtml).toContain("NOTE");
    expect(noteHtml).toContain("This is a note.");

    const warnHtml = render("> [!WARNING]\n> Warning details.\n");
    expect(warnHtml).toContain("md-alert md-alert-warning");
    expect(warnHtml).toContain("WARNING");
    expect(warnHtml).toContain("Warning details.");
  });

  it("renders standard blockquotes", () => {
    const html = render("> Plain quote line 1\n> Plain quote line 2\n");
    expect(html).toContain("<blockquote>Plain quote line 1<br>Plain quote line 2</blockquote>");
  });

  it("renders file:// links in markdown", () => {
    const html = render("[Plan File](file:///C:/Users/test/implementation_plan.md)\n");
    expect(html).toContain('<a href="file:///C:/Users/test/implementation_plan.md">Plan File</a>');
  });

  it("survives a null or undefined body without throwing", () => {
    const h = bootWebview({ ready: true });
    const fn = (h.window as any).__grokRenderMarkdown;
    expect(() => fn(null)).not.toThrow();
    expect(() => fn(undefined)).not.toThrow();
  });
});

describe("CRLF files render like LF ones", () => {
  // Most files on Windows are CRLF, and the desktop panel renders whole files
  // off disk, so this was the normal case rather than an edge one.
  //
  // The renderer splits on a newline and then tests each line with $-anchored
  // patterns. A carriage return is a line terminator in JS regex, so `.` cannot
  // match one, and every $-anchored rule failed at the final character:
  // headings kept their hashes, bullets kept their dashes, and both fell
  // through to the paragraph path. Tables, links and bold are not $-anchored,
  // so they kept working — which is why it looked like the renderer was mostly
  // fine, and why this survived review.
  const CRLF = "# Title\r\n\r\n## Section\r\n\r\n- one\r\n- two\r\n\r\n1. first\r\n";

  it("renders headings from a CRLF document", () => {
    const out = render(CRLF);
    expect(out).toContain("<h1");
    expect(out).toContain("<h2");
    expect(out).not.toContain("# Title");
    expect(out).not.toContain("## Section");
  });

  it("renders bullets and numbered lists from a CRLF document", () => {
    const out = render(CRLF);
    expect(out).toContain("<ul");
    expect(out).toContain("<ol");
    expect(out).toContain("<li");
  });

  it("produces exactly the same html as the LF form", () => {
    // The strongest statement of the rule: line endings must not be able to
    // change the output at all.
    expect(render(CRLF)).toBe(render(CRLF.replace(/\r\n/g, "\n")));
  });

  it("survives a lone-CR document", () => {
    expect(render("# Old Mac\r\r- item\r")).toContain("<h1");
  });
});

/**
 * #143 — a code span is LITERAL, and so is a link's href.
 *
 * `inline()` used to run its emphasis pass over its own output, by which point
 * the <code> tags were just characters and the asterisks inside two separate
 * code spans could pair with each other ACROSS the prose between them. The
 * reporter's example rendered `1*2` and `3*4` as one italic run.
 */
describe("markdown: code spans and hrefs are literal (#143)", () => {
  it("does not italicise across two code spans — the reported case", () => {
    const html = render("`1*2` and `3*4`\n");
    expect(html).not.toContain("<em>");
    expect(html).toContain("<code>1*2</code>");
    expect(html).toContain("<code>3*4</code>");
  });

  it("leaves a single code span's asterisks alone", () => {
    expect(render("`a *b* c`\n")).toContain("<code>a *b* c</code>");
  });

  it("does not read markdown syntax inside a code span", () => {
    // Backticks won the first pass even before the fix, but the LINK pass then
    // matched the [a](b) sitting inside the <code> element it had just made.
    const html = render("`[a](b)` stays literal\n");
    expect(html).not.toContain('<a href="b"');
    expect(html).toContain("<code>[a](b)</code>");
  });

  it("keeps an asterisk in a URL out of the emphasis pass", () => {
    const html = render("[x](https://e.com/a*b*c)\n");
    expect(html).toContain('href="https://e.com/a*b*c"');
    expect(html).not.toContain("<em>");
  });

  it("still emphasises LINK TEXT — only the href is held", () => {
    // Deliberate: [**bold**](url) is valid markdown and rendered correctly
    // before, so the fix must not flatten it.
    const html = render("[**bold**](https://e.com)\n");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('href="https://e.com"');
  });

  it("still emphasises ordinary prose around code", () => {
    const html = render("*yes* and `no` and **also**\n");
    expect(html).toContain("<em>yes</em>");
    expect(html).toContain("<strong>also</strong>");
    expect(html).toContain("<code>no</code>");
  });

  it("leaves no placeholder sentinel in the output", () => {
    // The holder uses a NUL-delimited token, same family as the document-level
    // fence and math placeholders. One escaping to the output would be visible
    // garbage, so assert the restore pass is total.
    const NUL = new RegExp(String.fromCharCode(0));
    expect(render("`a` `b` [c](d) *e*\n")).not.toMatch(NUL);
  });
});

describe("markdown: thematic breaks (<hr>) and setext headings", () => {
  it("renders a standalone divider (---) as an <hr> tag", () => {
    const html = render("---\n");
    expect(html).toBe("<hr>");
  });

  it("renders a divider between paragraphs with clean block boundaries", () => {
    const html = render("Paragraph 1\n\n---\n\nParagraph 2\n");
    expect(html).toBe("Paragraph 1<hr>Paragraph 2");
  });

  it("renders thematic breaks with spaces and alternative markers (- - -, ***, ___ , ----)", () => {
    expect(render("- - -\n")).toBe("<hr>");
    expect(render("***\n")).toBe("<hr>");
    expect(render("* * *\n")).toBe("<hr>");
    expect(render("___\n")).toBe("<hr>");
    expect(render("_ _ _\n")).toBe("<hr>");
    expect(render("----\n")).toBe("<hr>");
  });

  it("distinguishes setext headings (level 1 and 2) from standalone thematic breaks", () => {
    // Heading immediately followed by --- (no blank line) -> H2
    const h2 = render("My Section Title\n---\nBody text\n");
    expect(h2).toContain("<h2>My Section Title</h2>");
    expect(h2).not.toContain("<hr>");
    expect(h2).toContain("Body text");

    // Heading immediately followed by === (no blank line) -> H1
    const h1 = render("Top Level Title\n===\nBody text\n");
    expect(h1).toContain("<h1>Top Level Title</h1>");
    expect(h1).not.toContain("<hr>");

    // Separated by blank line -> not a setext heading, but paragraph + divider
    const separated = render("Paragraph\n\n---\n\nMore text\n");
    expect(separated).toContain("<hr>");
    expect(separated).not.toContain("<h2");
  });

  it("preserves inline code containing --- without emitting <hr>", () => {
    const html = render("Check `---` in code span\n");
    expect(html).toContain("<code>---</code>");
    expect(html).not.toContain("<hr>");
  });

  it("preserves code blocks containing --- without emitting <hr>", () => {
    const html = render("```yaml\n---\nkey: value\n---\n```\n");
    expect(html).toContain("<code>---\nkey: value\n---</code>");
    expect(html).not.toContain("<hr>");
  });

  it("preserves table separator rows without emitting <hr>", () => {
    const html = render("| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n");
    expect(html).toContain("md-table-wrap");
    expect(html).toContain("<table>");
    expect(html).not.toContain("<hr>");
  });

  it("closes lists cleanly before a thematic break and preserves --- inside list item text", () => {
    const listThenHr = render("- item 1\n- item 2\n---\nAfter text\n");
    expect(listThenHr).toContain("<ul>");
    expect(listThenHr).toContain("<li>item 1</li>");
    expect(listThenHr).toContain("<li>item 2</li></ul>");
    expect(listThenHr).toContain("<hr>");
    expect(listThenHr).toContain("After text");

    const listWithDashes = render("- item with --- dashes in prose\n");
    expect(listWithDashes).toContain("<li>item with --- dashes in prose</li>");
    expect(listWithDashes).not.toContain("<hr>");
  });

  it("renders thematic breaks identically under CRLF line endings", () => {
    const crlf = "Line 1\r\n\r\n---\r\n\r\nLine 2\r\n";
    const lf = "Line 1\n\n---\n\nLine 2\n";
    expect(render(crlf)).toBe(render(lf));
    expect(render(crlf)).toBe("Line 1<hr>Line 2");
  });

  it("does not produce setext headings during streaming of bullet markers", () => {
    // Single dash on next line should NOT turn previous paragraph into <h2>
    const streaming = render("Here is a list:\n-");
    expect(streaming).not.toContain("<h2>");
    expect(streaming).toContain("Here is a list:");
  });

  it("safely escapes HTML inside setext headings", () => {
    const html = render("<script>alert(1)</script>\n---\n");
    expect(html).toContain("<h2>&lt;script&gt;alert(1)&lt;/script&gt;</h2>");
    expect(html).not.toContain("<script>");
  });

  it("verifies <hr> element creation in happy-dom DOM harness", () => {
    const h = bootWebview({ ready: true });
    const div = h.window.document.createElement("div");
    div.innerHTML = render("First\n\n---\n\nSecond\n");
    const hr = div.querySelector("hr");
    expect(hr).not.toBeNull();
    expect(hr?.tagName.toLowerCase()).toBe("hr");
  });
});


describe("reviewed upstream Markdown additions", () => {
  it("renders all six heading levels", () => { for (let level = 1; level <= 6; level++) expect(render("#".repeat(level) + " Heading")).toContain(`<h${level}>Heading</h${level}>`); });
  it("links bare URLs while protecting code, existing anchors and emphasis", () => {
    const html = render("**https://example.com/a_b** `https://example.com/code` [https://example.com/label](https://example.com/target)");
    expect(html).toContain('<strong><a href="https://example.com/a_b">');
    expect(html).toContain('<code>https://example.com/code</code>');
    expect(html.match(/<a /g)?.length).toBe(2);
  });
  it("renders GitHub PR URLs as a chip with a host-handled href", () => {
    const html = render("https://github.com/org/repo/pull/42.");
    expect(html).toContain('class="pr-open"'); expect(html).toContain('PR #42');
    expect(html).toContain('href="https://github.com/org/repo/pull/42"');
  });
  it("recognizes absolute Windows paths with spaces and parentheses", () => {
    expect(render("[file](<C:/Program Files (x86)/Project/read me.md:12>)")).toContain('href="C:/Program Files (x86)/Project/read me.md:12"');
    expect(render("`C:/Program Files/Project/read me.md:12`")).toContain('class="file-ref-link"');
  });
});

describe("blockquotes", () => {
  it("separates quotes on an unmarked blank line so a following alert is recognized", () => {
    const html = render("> quote\n\n> [!NOTE]\n> note\n");
    expect(html).toBe('<blockquote>quote</blockquote><div class="md-alert md-alert-note"><div class="md-alert-title">NOTE</div><div class="md-alert-body">note</div></div>');
    expect(render("> one\n\n> two\n")).toBe("<blockquote>one</blockquote><blockquote>two</blockquote>");
  });

  it("preserves dividers, setext headings and image markup inside quotes", () => {
    const html = render("> Section\n> ---\n>\n> ![Diagram](images/flow.png)\n>\n> * * *\n");
    expect(html).toContain("<blockquote><h2>Section</h2>");
    expect(html).toContain('<img class="md-image" src="images/flow.png" alt="Diagram" loading="lazy" />');
    expect(html).toContain("<hr></blockquote>");
  });

  it("keeps GitHub alert types and renders block content in their bodies", () => {
    for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
      const html = render(`> [!${kind}]\n> ## Title\n>\n> - first\n> - second\n>\n> > nested\n`);
      expect(html).toContain(`class="md-alert md-alert-${kind.toLowerCase()}"`);
      expect(html).toContain(`<div class="md-alert-title">${kind}</div>`);
      expect(html).toContain('<div class="md-alert-body"><h2>Title</h2><ul><li>first</li><li>second</li></ul><blockquote>nested</blockquote></div>');
    }
  });

  it("renders tables inside alerts and alerts inside a nested quote", () => {
    const html = render("> outer\n>\n> > [!NOTE]\n> > | A | B |\n> > | --- | --- |\n> > | 1 | 2 |\n");
    expect(html).toContain('<blockquote>outer<div class="md-alert md-alert-note">');
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
    expect(html).not.toContain("&gt;");
    expect(html).not.toContain(String.fromCharCode(0));
  });

  it("escapes untrusted quote content and bounds nesting depth", () => {
    expect(render('> <img src=x onerror="alert(1)">\n')).not.toContain("<img");
    const deep = render("> ".repeat(100) + "text\n");
    expect(deep.match(/<blockquote>/g)).toHaveLength(12);
    expect(deep).toContain("text");
    expect(deep).toContain("&gt;");
  });

  it("treats an unknown alert marker as ordinary quoted text", () => {
    expect(render("> [!UNKNOWN]\n> text\n")).toBe("<blockquote>[!UNKNOWN]<br>text</blockquote>");
  });

  it("renders a quote line as a blockquote and drops the marker", () => {
    const html = render("> The best way to predict the future is to invent it.\n");
    expect(html).toBe("<blockquote>The best way to predict the future is to invent it.</blockquote>");
  });

  it("ends the quote when the next line is ordinary text", () => {
    const html = render("before\n\n> quoted\n\nafter\n");
    expect(html).toContain("<blockquote>quoted</blockquote>");
    expect(html.indexOf("before")).toBeLessThan(html.indexOf("<blockquote>"));
    expect(html.indexOf("after")).toBeGreaterThan(html.indexOf("</blockquote>"));
  });

  it("joins consecutive quote lines and breaks on an empty marker line", () => {
    const html = render("> one\n> two\n>\n> three\n");
    expect(html).toBe("<blockquote>one<br>two<br><br>three</blockquote>");
  });

  it("nests a second level and keeps the outer lines", () => {
    const html = render("> outer\n>\n> > inner\n>\n> back\n");
    expect(html.match(/<blockquote>/g)).toHaveLength(2);
    expect(html).toContain("<blockquote>inner</blockquote>");
    expect(html).toContain("outer");
    expect(html).toContain("back");
    expect(html).not.toContain("&gt;");
  });

  it("keeps inline markdown, lists, headings, and tables inside a quote", () => {
    expect(render("> **bold** and `code`\n")).toBe(
      "<blockquote><strong>bold</strong> and <code>code</code></blockquote>",
    );
    expect(render("> - a\n> - b\n")).toBe("<blockquote><ul><li>a</li><li>b</li></ul></blockquote>");
    expect(render("> ## Title\n")).toBe("<blockquote><h2>Title</h2></blockquote>");
    const table = render("> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n");
    expect(table.startsWith("<blockquote>")).toBe(true);
    expect(table).toContain("<table>");
    expect(table).toContain("<th>a</th>");
    expect(table).toContain("<td>1</td>");
    expect(table).not.toContain("&gt;");
  });

  it("does not treat a greater-than mid-line, or one inside a fence, as a quote", () => {
    const mid = render("a > b\n");
    expect(mid).not.toContain("<blockquote>");
    expect(mid).toContain("a &gt; b");
    const fenced = render("```\n> not a quote\n```\n");
    expect(fenced).not.toContain("<blockquote>");
    expect(fenced).toContain("&gt; not a quote");
  });

  it("renders a quote from a CRLF message the same as LF", () => {
    expect(render("> one\r\n> two\r\n")).toBe(render("> one\n> two\n"));
  });

});
