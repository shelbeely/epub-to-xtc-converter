# EPUB / Markdown to XTC Converter & Optimizer

A tool for converting EPUB and Markdown files to XTC/XTCH format and optimizing EPUBs for e-ink readers. Available as a browser-based web app and Node.js CLI. Markdown support is geared toward developer/code documentation on the Xteink X4 (480×800).

**[Live Demo](https://liashkov.site/epub-to-xtc-converter/)**

## Features

### EPUB to XTC/XTCH Converter
- Convert EPUB books to Xteink's native XTC (1-bit) or XTCH (2-bit grayscale) format
- Uses CREngine WASM for accurate rendering (same as CoolReader)
- Batch processing - convert multiple files at once

### Markdown to XTC/XTCH (developer docs)
- Convert `.md` / `.markdown` files (e.g. README, API references, code snippets) to XTC/XTCH
- Markdown is normalised by a dedicated optimizer before being rendered:
  - Long code lines wrapped at the configured column on word/operator boundaries (never mid-token)
  - Tabs expanded, smart quotes/dashes/ellipsis normalised to ASCII
  - GitHub `[!NOTE]` / `[!WARNING]` alerts flattened to bold-prefixed quotes
  - `- [ ]` / `- [x]` task items rewritten to ☐/☑ glyphs
  - Wide tables transposed to definition-list form (Xteink can't horizontal-scroll)
  - Headings deeper than `flattenHeadingsAbove` collapsed to bold paragraphs
  - YAML frontmatter parsed for title/author (malformed YAML tolerated)
  - Dangerous/unrenderable HTML (`<script>`, `<iframe>`, `<details>`, …) stripped
  - Optional emoji removal (no colour glyphs on e-ink)
- Syntax highlighting via `highlight.js` rendered in **monochrome** (`<b>`/`<i>`/`<u>` instead of colour spans)
- Pipeline: Markdown → optimised HTML → in-memory EPUB → existing XTC/XTCH encoder
  (CREngine WASM, dithering, encoder all reused)
- Customizable settings:
  - Device presets (Xteink X4, X3, custom dimensions)
  - Monitor DPI for accurate preview scaling
  - Font family, size, weight (Google Fonts + custom upload)
  - Line height and margins
  - Text alignment and hyphenation (42 languages)
  - Dithering with adjustable strength
  - Progress bar (page numbers, percentages, chapter marks)
  - Dark mode (negative)
- Export individual pages or entire books
- Download all as ZIP for batch exports

### EPUB Optimizer
- Optimize EPUB files for e-ink readers
- Remove problematic CSS (floats, flex, grid, fixed positioning)
- Strip embedded fonts to reduce file size
- Image processing (toggleable):
  - Convert images to grayscale
  - Resize images to configurable max width/height
  - Flatten alpha transparency to white background
  - Skip tiny decorative images (<20px)
  - Re-encode images to baseline JPEG (required by e-paper devices)
- Remove unsupported image formats (SVG, WebP, TIFF)
- Inject e-paper optimized CSS
- Batch processing with ZIP export

## Supported Devices

| Device | Resolution | Format |
|--------|------------|--------|
| Xteink X4 | 480x800 | XTC/XTCH |
| Xteink X3 | 528x792 | XTC/XTCH |
| Custom | Any | XTC/XTCH |

## Usage

1. Open the web app in your browser
2. Drop EPUB files onto the drop zone (or click to browse)
3. Adjust settings in the sidebar
4. Preview pages using navigation buttons
5. Click "Export XTC" for single file or "Export All" for batch

### Converter Tab
- **Device**: Select target device or enter custom dimensions
- **Orientation**: Rotate output (0°, 90°, 180°, 270°)
- **Monitor DPI**: Scale preview to match your monitor (default 96 DPI)
- **Text Settings**: Font, size, weight, line height, margins, alignment, hyphenation language
- **Image Settings**: Quality mode (1-bit/2-bit), dithering strength, dark mode
- **Progress Bar**: Book/chapter progress, page numbers (X/Y), percentages, chapter marks

### Optimizer Tab
- Drop EPUBs and switch to the Optimizer tab
- Configure optimization options (CSS removal, font stripping, image processing, unsupported format removal, CSS injection)
- Image sub-controls (grayscale, max width, unsupported format removal) are disabled when "Process images" is unchecked
- Click "Optimize EPUBs" to download optimized files

### CLI Usage

For batch processing without a browser, use the Node.js CLI:

```bash
cd cli
npm install

# Generate default settings file
node index.js init

# Edit settings.json to set font.path to your TTF/OTF font file

# Convert single file
node index.js convert book.epub -o book.xtc -c settings.json

# Convert all EPUBs in a directory (recurses into subdirectories,
# mirroring their structure under the output directory)
node index.js convert ./epubs/ -o ./output/ -c settings.json

# Convert a Markdown file (auto-detected by extension; goes through
# the Markdown optimizer + an in-memory EPUB before the XTC encoder)
node index.js convert README.md -o README.xtc -c settings.json

# Mixed directories work too — both *.epub and *.md / *.markdown
# are picked up recursively
node index.js convert ./docs/ -o ./out/ -c settings.json

# Use XTCH format (2-bit grayscale)
node index.js convert book.epub -f xtch -c settings.json

# Optimize single EPUB for e-paper
node index.js optimize book.epub -o book_optimized.epub -c settings.json

# Optimize all EPUBs in a directory
node index.js optimize ./epubs/ -o ./output/ -c settings.json

# Optimize recursively (set "recursive": true in settings.json optimizer section)
node index.js optimize ./library/ -o ./optimized/ -c settings.json

# Markdown-only utilities (do not require a font / WASM):
#   - optimize-md: write a normalised .md file
#   - md-to-epub: write the intermediate EPUB to disk (handy for debugging
#                 or for piping back through `optimize` to re-strip CSS)
node index.js optimize-md README.md -o README_optimized.md
node index.js md-to-epub README.md -o README.epub
```

Optimization options are configured in `settings.json` under the `optimizer` section:
- Set `recursive` to `true` to process subdirectories (preserves directory structure in output)
- Use `include`/`exclude` glob patterns to filter files (e.g., `"exclude": "*_optimized.epub"`)

Example `settings.json`:
```json
{
  "device": "xteink-x4",
  "font": { "path": "./LiterataTT.ttf", "size": 34, "weight": 400 },
  "margins": { "left": 16, "top": 16, "right": 16, "bottom": 16 },
  "lineHeight": 120,
  "textAlign": "justify",
  "hyphenation": { "enabled": true, "language": "en" },
  "output": { "format": "xtc", "dithering": true, "ditherStrength": 0.7 },
  "optimizer": {
    "removeCss": true,
    "stripFonts": true,
    "processImages": true,
    "removeUnsupportedImages": true,
    "grayscale": true,
    "maxImageWidth": 480,
    "injectCss": true,
    "recursive": false,
    "include": "*.epub",
    "exclude": null
  },
  "markdown": {
    "wrapCodeAt": 58,
    "tabSize": 2,
    "flattenHeadingsAbove": 4,
    "transposeWideTables": true,
    "wideTableThreshold": 32,
    "syntaxHighlight": true,
    "highlightStyle": "bold-italic",
    "dropEmoji": true,
    "smartTypography": true,
    "taskListGlyphs": true,
    "flattenAlerts": true,
    "stripDangerousHtml": true,
    "frontmatterAuthorField": "author",
    "splitChaptersAt": 1,
    "injectCodeCss": true
  }
}
```

### Markdown Optimizer options

All settings live under the `markdown` block in `settings.json`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wrapCodeAt` | int | 58 | Soft-wrap code-fence lines at this column on word/operator boundaries (0 disables). |
| `tabSize` | int | 2 | Number of spaces a tab expands to inside code fences. |
| `flattenHeadingsAbove` | int | 4 | Headings deeper than this become `**bold paragraphs**`. |
| `transposeWideTables` | bool | true | Detect tables wider than `wideTableThreshold` and rewrite as definition lists. |
| `wideTableThreshold` | int | 32 | Char-count threshold for table transposition. |
| `syntaxHighlight` | bool | true | Run `highlight.js` on fenced code blocks. |
| `highlightStyle` | str | "bold-italic" | "bold-italic" emits `<b>`/`<i>`/`<u>` only; "none" disables highlight. |
| `dropEmoji` | bool | true | Strip emoji codepoints (no colour glyphs on e-ink). |
| `smartTypography` | bool | true | Normalise smart quotes / em-dash / ellipsis to ASCII. |
| `taskListGlyphs` | bool | true | Rewrite `- [ ]` / `- [x]` to ☐ / ☑. |
| `flattenAlerts` | bool | true | Flatten GFM `> [!NOTE]` admonitions to `> **Note:** …`. |
| `stripDangerousHtml` | bool | true | Remove `<script>`, `<iframe>`, `<details>`, `<video>`, … blocks. |
| `frontmatterAuthorField` | str | "author" | Frontmatter key to read as document author. |
| `splitChaptersAt` | int | 1 | Heading level used as chapter boundaries in the intermediate EPUB. |
| `injectCodeCss` | bool | true | Inject the e-paper code-friendly CSS (monospace `<pre>`, soft-wrap, page breaks). |

## XTC/XTCH Format

Native binary ebook format for Xteink e-readers. Stores pre-rendered bitmap pages optimized for the device's e-paper display.

| Extension | Container | Page Format | Bit Depth | Description |
|-----------|-----------|-------------|-----------|-------------|
| `.xtc`    | XTC       | XTG         | 1-bit     | Monochrome, fast rendering, smaller files |
| `.xtch`   | XTCH      | XTH         | 2-bit     | 4-level grayscale, better image quality |

### Xteink X4 Specifics

- **Display**: 480x800 e-paper (4.3")
- **XTG (1-bit)**: Row-major scan, 8 pixels per byte, MSB = leftmost pixel
- **XTH (2-bit)**: Vertical scan order (columns right-to-left), optimized for e-paper refresh
- **Grayscale LUT**: Non-linear mapping (0=white, 1=dark gray, 2=light gray, 3=black)

Both formats include:
- Document metadata (title, author)
- Chapter navigation (TOC)
- Page index for random access

See [XTC Format Specification](docs/xtc-format-spec.md) for technical details.

## Self-Hosting

Clone the repository and serve the web directory:

```bash
git clone https://github.com/bigbag/epub-optimizer-xteink.git
cd epub-optimizer-xteink

# Using Docker
make docker-serve              # http://localhost:8000
make docker-serve PORT=3000    # custom port

# Using Python
cd web && python -m http.server 8000

# Using Node.js
cd web && npx serve .

# Using PHP
cd web && php -S localhost:8000
```

Then open http://localhost:8000 in your browser.

## Project Structure

```
/
├── web/                        # Browser-based web app
│   ├── index.html              # Main HTML structure
│   ├── style.css               # Application styles
│   ├── app.js                  # Main application logic
│   ├── markdown-to-epub.js     # Browser-side Markdown → EPUB shim
│   ├── crengine.js             # CREngine WASM loader
│   ├── crengine.wasm           # CREngine binary (CoolReader engine)
│   └── dither-worker.js        # Web Worker for Floyd-Steinberg dithering
├── cli/                        # Node.js CLI tool
│   ├── index.js                # CLI entry point (convert / optimize / md-to-epub / optimize-md)
│   ├── converter.js            # WASM integration and conversion logic (accepts Buffer or path)
│   ├── encoder.js              # XTG/XTH/XTC format encoding
│   ├── dither.js               # Floyd-Steinberg dithering
│   ├── optimizer.js            # EPUB optimizer for e-paper
│   ├── markdown.js             # Markdown optimizer + HTML renderer
│   ├── md-to-epub.js           # Build in-memory EPUB 3 from Markdown
│   ├── image-utils.js          # Shared image processing (used by optimizer + md-to-epub)
│   ├── settings.js             # Settings management
│   ├── test/                   # node --test suites
│   └── package.json            # CLI dependencies
├── docs/
│   ├── xtc-format-spec.md      # XTC format specification
│   └── markdown-pipeline.md    # Markdown → XTC pipeline overview
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Pages deployment
├── LICENSE
└── README.md
```

## Dependencies

### Web App
- [JSZip](https://stuk.github.io/jszip/) - ZIP file handling (loaded from CDN)
- [markdown-it](https://github.com/markdown-it/markdown-it) - Markdown parser (loaded from CDN, used when a `.md` file is dropped)
- CREngine - EPUB rendering (bundled as WASM, see [docs/building-crengine-wasm.md](docs/building-crengine-wasm.md) for provenance and rebuild notes)
- Google Fonts (loaded on demand): Literata, Lora, Merriweather, Source Serif 4, Noto Serif, Noto Sans, Open Sans, Roboto, EB Garamond, Crimson Pro
- Custom TTF/OTF font upload also supported

### CLI
- Node.js 18+
- [Commander](https://github.com/tj/commander.js) - CLI framework
- [JSZip](https://stuk.github.io/jszip/) - ZIP file handling
- [sharp](https://sharp.pixelplumbing.com/) - Image processing (optimizer, Markdown image embedding)
- [minimatch](https://github.com/isaacs/minimatch) - Glob pattern matching (optimizer)
- [markdown-it](https://github.com/markdown-it/markdown-it) + plugins (`-anchor`, `-footnote`, `-task-lists`, `-deflist`) — Markdown parsing
- [highlight.js](https://highlightjs.org/) — syntax highlighting (rendered monochrome for e-ink)
- [gray-matter](https://github.com/jonschlinkert/gray-matter) — YAML frontmatter parsing
- CREngine WASM (shared with web app)

## Browser Support

Requires a modern browser with:
- WebAssembly support
- Web Workers
- File API
- Canvas API

Tested on: Chrome 90+, Firefox 88+, Safari 14+, Edge 90+

## GitHub Pages Deployment

This project auto-deploys to GitHub Pages via GitHub Actions:

1. Push to the `main` branch
2. The workflow automatically deploys the `web/` folder
3. Go to Settings > Pages to verify deployment

The site will be available at `https://<username>.github.io/epub-optimizer-xteink/`

## Credits

- CREngine from [CoolReader](https://github.com/buggins/coolreader)
- CREngine WASM build by [fdkevin0](https://github.com/fdkevin0/x4converter.rho.sh) (vendored unmodified — see [docs/building-crengine-wasm.md](docs/building-crengine-wasm.md))
- XTC format specification from [CrazyCoder's Gist](https://gist.github.com/CrazyCoder/b125f26d6987c0620058249f59f1327d)
- Inspired by [x4converter.rho.sh](https://x4converter.rho.sh)

## License

MIT License - see [LICENSE](LICENSE) file.
