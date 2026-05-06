# Markdown → XTC/XTCH Pipeline

This document describes how a Markdown file becomes an XTC/XTCH binary
ready for an Xteink X4 (480×800 e-paper) reader, and explains *why* the
pipeline is structured the way it is.

## High-level flow

```
.md  ──▶  Markdown Optimizer  ──▶  HTML Renderer  ──▶  EPUB 3 builder  ──▶  CREngine WASM  ──▶  XTC/XTCH
        (cli/markdown.js)        (markdown-it +     (cli/md-to-epub.js)    (cli/converter.js)   (cli/encoder.js)
                                  highlight.js)
```

Every stage but the first reuses code that already exists for the EPUB
path; only the leftmost two boxes are new.

## Why an in-memory EPUB?

CREngine — the same engine CoolReader uses — already paginates XHTML
flawlessly into the device's odd 480×800 viewport. Re-implementing
pagination, hyphenation, font metrics and Unicode shaping for a
second renderer would be a months-long project, easily larger than the
entire rest of the codebase. Wrapping the rendered Markdown in a
minimal EPUB lets CREngine keep doing what it does best.

The EPUB never touches disk during a `convert` operation: `md-to-epub.js`
returns a `Buffer`, `converter.js` accepts either a path or a Buffer,
and the bytes go directly into the WASM heap.

## Markdown Optimizer (`cli/markdown.js`)

The optimizer is the only part of the pipeline that *understands* the
device's constraints. Its goal is to produce a normalised Markdown
document that, once rendered, paginates well at 480×800.

Highlights:

- **Code wrapping.** Long fenced-code lines are wrapped at the
  configured column on word boundaries, then operators / punctuation,
  then never. This avoids horizontal overflow without breaking
  identifiers (which would mislead readers of code documentation).
- **Tab expansion.** Tabs become spaces inside fences (the device's
  default font isn't monospaced for `\t`).
- **GitHub alerts.** `> [!NOTE]`-style admonitions become
  `> **Note:** …` so the alert kind survives even though e-ink can't
  render the GitHub colour boxes.
- **Task lists.** `- [ ]` / `- [x]` become `- ☐` / `- ☑` so they read
  correctly without GitHub's CSS.
- **Wide tables.** Tables wider than `wideTableThreshold` characters
  are transposed to definition-list form (`- **Header:** value`)
  because the device cannot horizontal-scroll.
- **Heading flattening.** `flattenHeadingsAbove` caps heading depth;
  H5/H6 become bold paragraphs which look better in 16pt body text.
- **Smart-typography normalisation.** Smart quotes, em/en dashes and
  ellipsis collapse to ASCII so the (often limited) device font always
  has glyphs.
- **Frontmatter.** YAML frontmatter is parsed via `gray-matter`; the
  parser is wrapped in a try/catch so malformed YAML falls back to
  filename-derived metadata.
- **HTML safety.** `<script>`, `<iframe>`, `<details>`, `<video>` and
  similar blocks are stripped before they ever reach the renderer.

## HTML rendering

`markdown-it` is configured with `html: false` (we have already stripped
what we want), `linkify: true`, and the following plugins:

- `markdown-it-anchor` — heading IDs for the TOC and intra-document links.
- `markdown-it-footnote` — footnote refs and back-links.
- `markdown-it-task-lists` — additional safety net for unconverted tasks.
- `markdown-it-deflist` — definition lists (used by the wide-table transpose).

Syntax highlighting uses `highlight.js` but the resulting `<span class="hljs-…">`
markup is post-processed by `monochromeHighlight()` into `<b>`/`<i>`/`<u>`
elements only — the device has no concept of foreground colour.

## EPUB construction (`cli/md-to-epub.js`)

A minimal EPUB 3 container with this layout is produced in memory:

```
mimetype                   ← stored uncompressed, must be first
META-INF/container.xml     ← points to OEBPS/content.opf
OEBPS/content.opf          ← metadata, manifest, spine
OEBPS/nav.xhtml            ← EPUB 3 navigation document
OEBPS/style.css            ← e-paper friendly stylesheet
OEBPS/chapter-N.xhtml      ← one per heading at `splitChaptersAt`
OEBPS/images/img-N.jpg     ← embedded images (baseline JPEG, ≤480px)
```

Splitting the document into chapter-per-H1 (configurable) makes the
XTC TOC index actually useful — chapter marks land on heading boundaries
instead of arbitrary pages.

Local images referenced as `![alt](path)` or `<img src="path">` are
resolved against the source `.md` directory and pushed through the
shared `image-utils.processImage()` helper so they obey the same
constraints as the EPUB optimizer (grayscale, ≤480px wide, baseline
JPEG, alpha flattened to white). Remote URLs are left alone.

## Web app pipeline

The browser flow mirrors the CLI flow but skips image embedding (a
browser drop-zone has no filesystem context). When a user drops a `.md`
file:

1. `web/markdown-to-epub.js` runs the same text-level optimisations.
2. `markdown-it` (loaded from CDN) renders to HTML.
3. `JSZip` packs an EPUB Blob.
4. `app.js` swaps the original `.md` File for a synthetic `.epub` File
   containing that Blob — the rest of the app, including dithering,
   preview and export, is unchanged.

## Configuration

All knobs live under the `markdown` block of `settings.json`. See
`README.md` for the complete table. Sensible defaults are tuned for
code documentation on the X4.

## Manual verification

To convert this very repository's README:

```bash
cd cli
npm install                                  # one-time
node index.js init                           # writes settings.json
# edit settings.json: set font.path to a TTF
node index.js convert ../README.md -o /tmp/readme.xtc -c settings.json
```

Then copy `/tmp/readme.xtc` to the device and verify that:

- Code fences soft-wrap, no horizontal overflow.
- Tables either fit or appear as `**Header:** value` lists.
- The TOC index has one entry per H1.
- The page index allows random access (long-press / jump UI).

## Why these libraries?

| Library | Why |
|---------|-----|
| `markdown-it` | Most actively maintained CommonMark engine for Node, no native deps, plugin ecosystem. |
| `gray-matter` | De-facto standard for Markdown frontmatter; tolerant parsing. |
| `highlight.js` | Pure-JS, no syntax-tree allocation, easy to post-process for monochrome. |
| `JSZip` | Already a dependency, supports the EPUB constraint that `mimetype` is first and stored. |

## Out of scope

- Authoring/editing Markdown in the web UI.
- A round-trip XTC → Markdown converter.
- Replacing CREngine with a pure-JS Markdown renderer (rejected — too
  much engineering risk for too little benefit).
