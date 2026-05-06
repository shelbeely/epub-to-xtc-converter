/**
 * Markdown ingestion + optimisation for Xteink e-paper devices.
 *
 * Two responsibilities:
 *
 *   1. `optimizeMarkdown(md, opts)` — operates on the raw Markdown text
 *      (token-aware, not regex-on-everything) to produce a normalised
 *      version suited to the X4's 480x800 display: long code lines wrapped,
 *      tabs expanded, GitHub alerts flattened to bold-prefixed quotes,
 *      tasks rewritten to ☐/☑ glyphs, footnote refs kept as `[n]`,
 *      wide tables transposed, emoji optionally dropped, headings deeper
 *      than `flattenHeadingsAbove` collapsed to bold paragraphs, smart
 *      typography normalised. Frontmatter (YAML) is detected and
 *      returned alongside the body.
 *
 *   2. `renderMarkdownToHtml(md, opts)` — runs the optimised Markdown
 *      through `markdown-it` with anchor / footnote / task-list / deflist
 *      plugins and a 1-bit-friendly highlight.js theme that emits only
 *      `<b>` / `<i>` / `<u>` (no colour). The result is XHTML-safe HTML
 *      ready to be wrapped in an EPUB by `md-to-epub.js`.
 *
 * Together these two stages keep the heavy lifting out of CREngine and
 * mean the existing XTC/XTCH encoder stays untouched.
 */

const matter = require('gray-matter');
const MarkdownIt = require('markdown-it');
const markdownItAnchor = require('markdown-it-anchor');
const markdownItFootnote = require('markdown-it-footnote');
const markdownItTaskLists = require('markdown-it-task-lists');
const markdownItDeflist = require('markdown-it-deflist');
const hljs = require('highlight.js');

/** Default Markdown optimiser settings — mirrored in `cli/settings.js`. */
const DEFAULT_MARKDOWN_OPTS = {
    wrapCodeAt: 58,
    tabSize: 2,
    flattenHeadingsAbove: 4,
    transposeWideTables: true,
    syntaxHighlight: true,
    highlightStyle: 'bold-italic',     // 'bold-italic' or 'none'
    dropEmoji: true,
    frontmatterAuthorField: 'author',
    splitChaptersAt: 1,
    injectCodeCss: true,
    smartTypography: true,
    taskListGlyphs: true,
    flattenAlerts: true,
    stripDangerousHtml: true,
    wideTableThreshold: 32             // chars per row before transpose kicks in
};

/* ----------------------------- helpers ---------------------------------- */

function withDefaults(opts) {
    return Object.assign({}, DEFAULT_MARKDOWN_OPTS, opts || {});
}

/**
 * Split a single overlong code line at sensible boundaries (spaces, then
 * common operators / punctuation). Never breaks mid-token. Returns one or
 * more lines that each fit within `maxLen` whenever possible.
 */
function wrapCodeLine(line, maxLen) {
    if (line.length <= maxLen) return [line];

    // Preserve leading indent on continuation lines.
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    const continuation = indent + '  '; // two-space hang for readability
    const out = [];

    let remaining = line;
    while (remaining.length > maxLen) {
        // Look for a break point in [maxLen, 0]
        let breakAt = -1;
        for (let i = Math.min(maxLen, remaining.length - 1); i > indent.length; i--) {
            const c = remaining[i];
            if (c === ' ' || c === '\t') { breakAt = i; break; }
        }
        if (breakAt === -1) {
            // Fall back to operator / punctuation boundary
            for (let i = Math.min(maxLen, remaining.length - 1); i > indent.length; i--) {
                const c = remaining[i];
                if (c === ',' || c === ';' || c === '|' || c === '&' ||
                    c === '+' || c === '.' || c === ')' || c === ']' || c === '}') {
                    breakAt = i + 1;
                    break;
                }
            }
        }
        if (breakAt <= indent.length) {
            // No clean boundary — leave the line alone rather than break a token.
            break;
        }
        out.push(remaining.slice(0, breakAt).replace(/\s+$/, ''));
        remaining = continuation + remaining.slice(breakAt).replace(/^\s+/, '');
    }
    out.push(remaining);
    return out;
}

/** Expand tabs to spaces. */
function expandTabs(text, tabSize) {
    if (!tabSize || tabSize < 1) return text;
    const spaces = ' '.repeat(tabSize);
    return text.replace(/\t/g, spaces);
}

/**
 * Apply smart-typography normalisations: smart quotes → straight quotes,
 * em/en dashes → hyphens, ellipsis → three dots. (We move the document
 * *toward* plain ASCII so the device's limited fonts always have glyphs.)
 */
function normaliseTypography(text) {
    return text
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/\u2014/g, '--')
        .replace(/\u2013/g, '-')
        .replace(/\u2026/g, '...');
}

/** Remove emoji codepoints (BMP and supplementary planes). */
function dropEmojiChars(text) {
    // Strip common emoji ranges; conservative so we don't nuke math symbols.
    return text.replace(
        /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{1F1E6}-\u{1F1FF}]/gu,
        ''
    );
}

/** True for lines that mark a fenced code block boundary (``` or ~~~). */
function isFenceLine(line) {
    return /^\s{0,3}(```+|~~~+)/.test(line);
}

/** Rewrite GFM alerts (`> [!NOTE]` blockquotes) as plain bold-prefixed quotes. */
function flattenGfmAlerts(text) {
    // Match a blockquote whose first line opens with [!TYPE]
    return text.replace(
        /^(\s*>\s*)\[!(\w+)\]\s*\n((?:\s*>.*\n?)+)/gm,
        (_match, _prefix, kind, body) => {
            const label = kind.charAt(0) + kind.slice(1).toLowerCase();
            // Inject a bold label as the first paragraph of the quote.
            return `> **${label}:** ${body.replace(/^\s*>\s?/, '').trimStart()}`;
        }
    );
}

/** Convert `- [ ]` / `- [x]` to `- ☐` / `- ☑`. */
function rewriteTaskListGlyphs(text) {
    return text
        .replace(/^(\s*[-*+]\s+)\[ \]/gm, '$1☐')
        .replace(/^(\s*[-*+]\s+)\[[xX]\]/gm, '$1☑');
}

/** Strip HTML elements that don't render on e-ink (or are unsafe). */
function stripDangerousHtmlBlocks(text) {
    const tags = ['script', 'style', 'iframe', 'video', 'audio', 'details', 'summary', 'object', 'embed'];
    let out = text;
    for (const tag of tags) {
        // Block form
        const blockRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
        out = out.replace(blockRe, '');
        // Self-closing / void
        const voidRe = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
        out = out.replace(voidRe, '');
    }
    return out;
}

/** Cap heading depth — anything deeper becomes bold paragraph. */
function flattenDeepHeadings(text, maxDepth) {
    if (!maxDepth || maxDepth < 1 || maxDepth >= 6) return text;
    return text.replace(/^(#{1,6})\s+(.+)$/gm, (full, hashes, body) => {
        if (hashes.length <= maxDepth) return full;
        return `**${body.trim()}**`;
    });
}

/**
 * Detect a wide markdown table and transpose to definition-list form.
 * Heuristic: any line whose total character count exceeds `threshold` and
 * which lives inside a table block triggers a transpose for that block.
 */
function maybeTransposeTables(text, threshold) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        // Look for a table header followed by a separator line
        if (
            i + 1 < lines.length &&
            /^\s*\|.+\|\s*$/.test(lines[i]) &&
            /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])
        ) {
            // Collect the whole table
            const tableStart = i;
            let j = i + 2;
            while (j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j])) j++;
            const tableLines = lines.slice(tableStart, j);
            const widest = tableLines.reduce((m, l) => Math.max(m, l.length), 0);
            if (widest > threshold) {
                const headers = splitRow(tableLines[0]);
                for (let r = 2; r < tableLines.length; r++) {
                    const cells = splitRow(tableLines[r]);
                    const rowOut = [];
                    for (let c = 0; c < headers.length; c++) {
                        const h = (headers[c] || '').trim();
                        const v = (cells[c] || '').trim();
                        if (h) rowOut.push(`- **${h}:** ${v}`);
                    }
                    out.push(rowOut.join('\n'));
                    out.push('');
                }
            } else {
                out.push(...tableLines);
            }
            i = j;
            continue;
        }
        out.push(lines[i]);
        i++;
    }
    return out.join('\n');
}

function splitRow(line) {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|');
}

/* ------------------------ optimiser entry point ------------------------- */

/**
 * Optimise a Markdown source document for e-ink rendering.
 *
 * Returns `{ content, data, title, author }` where `content` is the
 * normalised Markdown body, `data` is the parsed frontmatter object,
 * and `title`/`author` are convenience extractions.
 *
 * @param {string} src - Raw Markdown source (may include YAML frontmatter).
 * @param {object} [userOpts] - Override `DEFAULT_MARKDOWN_OPTS`.
 */
function optimizeMarkdown(src, userOpts) {
    const opts = withDefaults(userOpts);

    // 1. Parse frontmatter (tolerant — falls back gracefully on bad YAML).
    let parsed;
    try {
        parsed = matter(src);
    } catch {
        parsed = { content: src, data: {} };
    }

    let body = (parsed.content || '').replace(/\r\n?/g, '\n');

    // 2. Cheap text-level passes that are safe outside fences.
    body = stripBomAndZwsp(body);
    if (opts.smartTypography) body = normaliseTypography(body);
    if (opts.dropEmoji) body = dropEmojiChars(body);
    if (opts.stripDangerousHtml) body = stripDangerousHtmlBlocks(body);
    if (opts.flattenAlerts) body = flattenGfmAlerts(body);

    // 3. Per-line passes that respect fenced code regions.
    const lines = body.split('\n');
    const outLines = [];
    let inFence = false;
    for (const raw of lines) {
        if (isFenceLine(raw)) {
            inFence = !inFence;
            outLines.push(raw);
            continue;
        }
        if (inFence) {
            const expanded = expandTabs(raw, opts.tabSize);
            const wrapped = opts.wrapCodeAt
                ? wrapCodeLine(expanded, opts.wrapCodeAt)
                : [expanded];
            outLines.push(...wrapped);
        } else {
            outLines.push(raw);
        }
    }
    body = outLines.join('\n');

    // 4. Whole-document structural transforms.
    if (opts.taskListGlyphs) body = rewriteTaskListGlyphs(body);
    if (opts.flattenHeadingsAbove) body = flattenDeepHeadings(body, opts.flattenHeadingsAbove);
    if (opts.transposeWideTables) body = maybeTransposeTables(body, opts.wideTableThreshold);

    const data = parsed.data || {};
    const title = extractTitle(body, data);
    const author = data[opts.frontmatterAuthorField] || data.author || '';

    return { content: body, data, title, author };
}

function stripBomAndZwsp(text) {
    return text.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\u2060]/g, '');
}

function extractTitle(body, data) {
    if (data && data.title) return String(data.title);
    const h1 = body.match(/^#\s+(.+?)\s*$/m);
    if (h1) return h1[1].trim();
    return '';
}

/* --------------------------- HTML rendering ----------------------------- */

/**
 * Build a markdown-it instance configured for e-ink output. Exposed so
 * tests and callers can render incrementally if needed.
 */
function buildRenderer(opts) {
    const o = withDefaults(opts);

    const md = new MarkdownIt({
        html: false,                  // Raw HTML disabled — we already stripped what we want.
        linkify: true,
        typographer: false,           // Smart typography handled in the optimiser.
        breaks: false,
        highlight(code, lang) {
            if (!o.syntaxHighlight || o.highlightStyle === 'none') {
                return ''; // markdown-it falls back to plain `<pre><code>`
            }
            let highlighted;
            try {
                highlighted = lang && hljs.getLanguage(lang)
                    ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
                    : hljs.highlightAuto(code).value;
            } catch {
                return '';
            }
            // Convert hljs's coloured spans to 1-bit-friendly emphasis.
            const monoised = monochromeHighlight(highlighted);
            return `<pre class="hljs"><code>${monoised}</code></pre>`;
        }
    });

    md.use(markdownItAnchor, { permalink: false, slugify: defaultSlugify });
    md.use(markdownItFootnote);
    md.use(markdownItTaskLists, { enabled: false, label: false });
    md.use(markdownItDeflist);

    return md;
}

/**
 * Render an optimised Markdown document to a single XHTML body fragment.
 *
 * The returned HTML does NOT include `<html>` / `<head>` wrappers — that's
 * the responsibility of `md-to-epub.js`, which knows about chapter
 * splitting and CSS injection.
 */
function renderMarkdownToHtml(optimisedMd, userOpts) {
    const md = buildRenderer(userOpts);
    return md.render(optimisedMd);
}

/**
 * Convert highlight.js coloured spans into bold/italic/underline only.
 * This keeps syntax cues legible on a 1-bit display without relying on
 * colours the e-paper can't show.
 */
function monochromeHighlight(html) {
    // Map of class fragments → wrapper tag(s) we want to apply.
    const ITALIC = ['comment', 'doctag', 'meta', 'quote'];
    const BOLD = [
        'keyword', 'built_in', 'type', 'literal', 'title', 'section',
        'selector-tag', 'name', 'strong', 'tag', 'attribute', 'attr',
        'class', 'function'
    ];
    const UNDERLINE = ['string', 'number', 'regexp', 'link', 'symbol', 'bullet'];

    return html.replace(
        /<span class="hljs-([a-z0-9_-]+(?:\s+hljs-[a-z0-9_-]+)*)">([\s\S]*?)<\/span>/g,
        (_match, classNames, inner) => {
            const cls = classNames.split(/\s+/).map(c => c.replace(/^hljs-/, ''));
            const wantsBold = cls.some(c => BOLD.includes(c));
            const wantsItalic = cls.some(c => ITALIC.includes(c));
            const wantsUnderline = cls.some(c => UNDERLINE.includes(c));

            let out = inner;
            if (wantsUnderline) out = `<u>${out}</u>`;
            if (wantsItalic) out = `<i>${out}</i>`;
            if (wantsBold) out = `<b>${out}</b>`;
            return out;
        }
    );
}

/** GitHub-style slug for heading anchors / TOC. */
function defaultSlugify(s) {
    return String(s)
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 64) || 'section';
}

/**
 * Build a TOC from the optimised Markdown body.
 * Returns an array of `{ level, title, slug }` objects in document order.
 */
function buildToc(optimisedMd) {
    const lines = optimisedMd.split('\n');
    const toc = [];
    let inFence = false;
    for (const line of lines) {
        if (isFenceLine(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (m) {
            toc.push({
                level: m[1].length,
                title: m[2].trim(),
                slug: defaultSlugify(m[2])
            });
        }
    }
    return toc;
}

/**
 * Default e-paper CSS for the rendered HTML. Tuned for code documentation:
 * monospace pre/code, no background tint, soft-wrapping inside <pre>,
 * page-break hints around headings and code blocks. Hyphenation is
 * disabled inside code so identifiers stay intact.
 */
function defaultCodeCss() {
    return [
        'body { font-family: serif; line-height: 1.4; margin: 0; padding: 0; }',
        'p { margin: 0.5em 0; }',
        'h1, h2, h3, h4 { margin: 1em 0 0.4em 0; page-break-after: avoid; }',
        'h1 { page-break-before: always; }',
        'pre, code, kbd, samp, tt { font-family: monospace; }',
        'pre { white-space: pre-wrap; word-wrap: break-word; margin: 0.6em 0; padding: 0.4em; border: 1px solid #000; page-break-inside: avoid; -epub-hyphens: none; hyphens: none; }',
        'code { -epub-hyphens: none; hyphens: none; }',
        'blockquote { margin: 0.6em 0 0.6em 1em; padding-left: 0.6em; border-left: 2px solid #000; }',
        'table { border-collapse: collapse; margin: 0.6em 0; }',
        'th, td { border: 1px solid #000; padding: 2px 4px; text-align: left; }',
        'img { max-width: 100%; height: auto; }',
        'b, strong { font-weight: bold; }',
        'i, em { font-style: italic; }',
        'u { text-decoration: underline; }',
        'hr { border: 0; border-top: 1px solid #000; margin: 1em 0; }',
        'ul, ol { margin: 0.4em 0 0.4em 1.2em; padding: 0; }',
        '.footnotes { font-size: 0.9em; margin-top: 1em; border-top: 1px solid #000; padding-top: 0.4em; }'
    ].join('\n');
}

module.exports = {
    DEFAULT_MARKDOWN_OPTS,
    optimizeMarkdown,
    renderMarkdownToHtml,
    buildRenderer,
    buildToc,
    defaultCodeCss,
    defaultSlugify,
    // Exposed for unit tests:
    _internal: {
        wrapCodeLine,
        expandTabs,
        normaliseTypography,
        dropEmojiChars,
        flattenGfmAlerts,
        rewriteTaskListGlyphs,
        flattenDeepHeadings,
        maybeTransposeTables,
        stripDangerousHtmlBlocks,
        monochromeHighlight
    }
};
