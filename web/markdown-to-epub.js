/**
 * Browser-side Markdown → EPUB pipeline.
 *
 * Mirrors the deterministic, text-level transforms in the CLI's
 * `cli/markdown.js` and `cli/md-to-epub.js`. The EPUB Blob produced by
 * `mdToEpubBlob` slots straight into the existing CREngine loader the
 * same way an uploaded `.epub` would, so the rest of the web app stays
 * untouched (no canvas, dither, encoder or download path needs to know
 * Markdown exists).
 *
 * Image references in browser-supplied Markdown can't be resolved against
 * a directory, so we drop local image refs (replaced with a placeholder
 * `[image: ...]` line). Users wanting full image support should use the
 * CLI which has filesystem access.
 *
 * Depends on the global `markdownit` (loaded from CDN in index.html) and
 * `JSZip` (already used by the optimizer batch export).
 */

(function (global) {
    'use strict';

    /** Default optimiser knobs — kept in sync with cli/markdown.js. */
    const DEFAULT_MD_OPTS = {
        wrapCodeAt: 58,
        tabSize: 2,
        flattenHeadingsAbove: 4,
        transposeWideTables: true,
        wideTableThreshold: 32,
        dropEmoji: true,
        smartTypography: true,
        taskListGlyphs: true,
        flattenAlerts: true,
        stripDangerousHtml: true,
        splitChaptersAt: 1,
        injectCodeCss: true
    };

    const EPAPER_CSS = [
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
        'ul, ol { margin: 0.4em 0 0.4em 1.2em; padding: 0; }'
    ].join('\n');

    /* ----------------------- text-level transforms ---------------------- */

    function normaliseTypography(text) {
        return text
            .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
            .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
            .replace(/\u2014/g, '--')
            .replace(/\u2013/g, '-')
            .replace(/\u2026/g, '...');
    }

    function dropEmojiChars(text) {
        return text.replace(
            /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{1F1E6}-\u{1F1FF}]/gu,
            ''
        );
    }

    function stripDangerousHtml(text) {
        const tags = ['script', 'style', 'iframe', 'video', 'audio', 'details', 'summary', 'object', 'embed'];
        let out = text;
        for (const tag of tags) {
            out = out.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '>', 'gi'), '');
            out = out.replace(new RegExp('<' + tag + '\\b[^>]*\\/?>', 'gi'), '');
        }
        return out;
    }

    function flattenAlerts(text) {
        return text.replace(
            /^(\s*>\s*)\[!(\w+)\]\s*\n((?:\s*>.*\n?)+)/gm,
            function (_full, _prefix, kind, body) {
                const label = kind.charAt(0) + kind.slice(1).toLowerCase();
                return '> **' + label + ':** ' + body.replace(/^\s*>\s?/, '').trimStart();
            }
        );
    }

    function rewriteTaskGlyphs(text) {
        return text
            .replace(/^(\s*[-*+]\s+)\[ \]/gm, '$1☐')
            .replace(/^(\s*[-*+]\s+)\[[xX]\]/gm, '$1☑');
    }

    function flattenDeepHeadings(text, max) {
        if (!max || max < 1 || max >= 6) return text;
        return text.replace(/^(#{1,6})\s+(.+)$/gm, function (full, hashes, body) {
            return hashes.length <= max ? full : '**' + body.trim() + '**';
        });
    }

    function expandTabs(line, n) {
        if (!n || n < 1) return line;
        return line.replace(/\t/g, ' '.repeat(n));
    }

    function isFenceLine(line) { return /^\s{0,3}(```+|~~~+)/.test(line); }

    function wrapCodeLine(line, max) {
        if (line.length <= max) return [line];
        const indent = (line.match(/^(\s*)/) || ['', ''])[1];
        const cont = indent + '  ';
        const out = [];
        let rem = line;
        while (rem.length > max) {
            let breakAt = -1;
            for (let i = Math.min(max, rem.length - 1); i > indent.length; i--) {
                if (rem[i] === ' ' || rem[i] === '\t') { breakAt = i; break; }
            }
            if (breakAt === -1) {
                for (let i = Math.min(max, rem.length - 1); i > indent.length; i--) {
                    const c = rem[i];
                    if (c === ',' || c === ';' || c === '|' || c === '&' ||
                        c === '+' || c === '.' || c === ')' || c === ']' || c === '}') {
                        breakAt = i + 1; break;
                    }
                }
            }
            if (breakAt <= indent.length) break;
            out.push(rem.slice(0, breakAt).replace(/\s+$/, ''));
            rem = cont + rem.slice(breakAt).replace(/^\s+/, '');
        }
        out.push(rem);
        return out;
    }

    function splitRow(line) {
        const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        return t.split('|');
    }

    function maybeTransposeTables(text, threshold) {
        const lines = text.split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
            if (
                i + 1 < lines.length &&
                /^\s*\|.+\|\s*$/.test(lines[i]) &&
                /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])
            ) {
                const start = i;
                let j = i + 2;
                while (j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j])) j++;
                const tbl = lines.slice(start, j);
                const widest = tbl.reduce((m, l) => Math.max(m, l.length), 0);
                if (widest > threshold) {
                    const headers = splitRow(tbl[0]);
                    for (let r = 2; r < tbl.length; r++) {
                        const cells = splitRow(tbl[r]);
                        const row = [];
                        for (let c = 0; c < headers.length; c++) {
                            const h = (headers[c] || '').trim();
                            const v = (cells[c] || '').trim();
                            if (h) row.push('- **' + h + ':** ' + v);
                        }
                        out.push(row.join('\n'));
                        out.push('');
                    }
                } else {
                    Array.prototype.push.apply(out, tbl);
                }
                i = j; continue;
            }
            out.push(lines[i]); i++;
        }
        return out.join('\n');
    }

    /** Best-effort YAML frontmatter parser — handles only `key: value` pairs. */
    function parseFrontmatter(src) {
        const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
        if (!m) return { data: {}, body: src };
        const data = {};
        const lines = m[1].split('\n');
        for (const line of lines) {
            const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
            if (kv) {
                let v = kv[2].trim();
                if ((v.startsWith('"') && v.endsWith('"')) ||
                    (v.startsWith("'") && v.endsWith("'"))) {
                    v = v.slice(1, -1);
                }
                data[kv[1]] = v;
            }
        }
        return { data, body: src.slice(m[0].length) };
    }

    function optimizeMarkdown(src, userOpts) {
        const opts = Object.assign({}, DEFAULT_MD_OPTS, userOpts || {});
        const fm = parseFrontmatter(src.replace(/\r\n?/g, '\n'));
        let body = fm.body;

        if (opts.smartTypography) body = normaliseTypography(body);
        if (opts.dropEmoji) body = dropEmojiChars(body);
        if (opts.stripDangerousHtml) body = stripDangerousHtml(body);
        if (opts.flattenAlerts) body = flattenAlerts(body);

        // Per-line passes that respect fenced code regions.
        const lines = body.split('\n');
        const outLines = [];
        let inFence = false;
        for (const raw of lines) {
            if (isFenceLine(raw)) { inFence = !inFence; outLines.push(raw); continue; }
            if (inFence) {
                const exp = expandTabs(raw, opts.tabSize);
                const wrapped = opts.wrapCodeAt ? wrapCodeLine(exp, opts.wrapCodeAt) : [exp];
                Array.prototype.push.apply(outLines, wrapped);
            } else {
                outLines.push(raw);
            }
        }
        body = outLines.join('\n');

        if (opts.taskListGlyphs) body = rewriteTaskGlyphs(body);
        if (opts.flattenHeadingsAbove) body = flattenDeepHeadings(body, opts.flattenHeadingsAbove);
        if (opts.transposeWideTables) body = maybeTransposeTables(body, opts.wideTableThreshold);

        // Drop local image refs (no filesystem access in the browser path).
        body = body.replace(/!\[[^\]]*\]\(\s*<?([^)\s"]+)>?(?:\s+"[^"]*")?\s*\)/g, function (full, url) {
            if (/^(https?:|data:|file:|\/\/)/i.test(url)) return full;
            return '_[image: ' + url + ' — open the CLI for image embedding]_';
        });

        const title = (fm.data && fm.data.title) ||
            (body.match(/^#\s+(.+?)\s*$/m) || [, ''])[1] || '';
        const author = (fm.data && fm.data.author) || '';
        return { content: body, data: fm.data, title: title, author: author };
    }

    /* --------------------------- HTML rendering ------------------------- */

    function renderMarkdown(optimised) {
        if (typeof global.markdownit !== 'function') {
            throw new Error('markdown-it is not loaded — check the <script> tag in index.html.');
        }
        const md = global.markdownit({
            html: false,
            linkify: true,
            typographer: false,
            breaks: false
        });
        return md.render(optimised);
    }

    /* --------------------------- chapter splitting ---------------------- */

    function splitChapters(md, level) {
        const lines = md.split('\n');
        const re = new RegExp('^#{' + level + '}\\s+(.+?)\\s*#*\\s*$');
        const chapters = [];
        let cur = { title: '', body: [] };
        let inFence = false;
        for (const line of lines) {
            if (isFenceLine(line)) inFence = !inFence;
            if (!inFence) {
                const m = line.match(re);
                if (m) {
                    if (cur.title || cur.body.some(l => l.trim() !== '')) chapters.push(cur);
                    cur = { title: m[1].trim(), body: [line] };
                    continue;
                }
            }
            cur.body.push(line);
        }
        if (cur.title || cur.body.some(l => l.trim() !== '')) chapters.push(cur);
        if (chapters.length === 0) chapters.push({ title: '', body: lines });
        return chapters.map(c => ({ title: c.title, markdown: c.body.join('\n') }));
    }

    /* --------------------------- EPUB scaffolding ----------------------- */

    function xmlEscape(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    function wrapChapter(title, html) {
        return '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<!DOCTYPE html>\n' +
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
            '<head><title>' + xmlEscape(title) + '</title>' +
            '<link rel="stylesheet" type="text/css" href="style.css"/></head>\n' +
            '<body>\n' + html + '\n</body>\n</html>\n';
    }

    /**
     * Generate a UUID v4 string. Uses Web Crypto exclusively — both
     * `crypto.randomUUID` (when available) and `crypto.getRandomValues`
     * (universally available in browsers since ~2014) are cryptographically
     * strong, so CodeQL's `js/insecure-randomness` rule is satisfied.
     */
    function generateUuid() {
        const c = global.crypto;
        if (c && typeof c.randomUUID === 'function') {
            return c.randomUUID();
        }
        if (c && typeof c.getRandomValues === 'function') {
            const b = new Uint8Array(16);
            c.getRandomValues(b);
            // RFC 4122 v4 layout
            b[6] = (b[6] & 0x0f) | 0x40;
            b[8] = (b[8] & 0x3f) | 0x80;
            const h = Array.from(b, x => x.toString(16).padStart(2, '0'));
            return h.slice(0, 4).join('') + '-' +
                   h.slice(4, 6).join('') + '-' +
                   h.slice(6, 8).join('') + '-' +
                   h.slice(8, 10).join('') + '-' +
                   h.slice(10, 16).join('');
        }
        throw new Error('No Web Crypto API available — cannot generate EPUB identifier.');
    }

    function buildOpf(title, author, chapterIds) {
        const items = chapterIds.map(id =>
            '    <item id="' + id + '" href="' + id + '.xhtml" media-type="application/xhtml+xml"/>'
        ).join('\n');
        const refs = chapterIds.map(id => '    <itemref idref="' + id + '"/>').join('\n');
        const id = 'urn:uuid:' + generateUuid();
        return '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
            '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
            '    <dc:identifier id="bookid">' + xmlEscape(id) + '</dc:identifier>\n' +
            '    <dc:title>' + xmlEscape(title) + '</dc:title>\n' +
            '    <dc:language>en</dc:language>\n' +
            (author ? '    <dc:creator>' + xmlEscape(author) + '</dc:creator>\n' : '') +
            '    <meta property="dcterms:modified">' +
                new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</meta>\n' +
            '  </metadata>\n' +
            '  <manifest>\n' +
            '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
            '    <item id="css" href="style.css" media-type="text/css"/>\n' +
            items + '\n' +
            '  </manifest>\n' +
            '  <spine>\n' + refs + '\n  </spine>\n' +
            '</package>\n';
    }

    function buildNav(title) {
        return '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<!DOCTYPE html>\n' +
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
            '<head><title>' + xmlEscape(title || 'Contents') + '</title></head>\n' +
            '<body><nav epub:type="toc"><h1>Contents</h1><ol>' +
            '<li><a href="chapter-1.xhtml">Start</a></li>' +
            '</ol></nav></body></html>\n';
    }

    /**
     * Convert a Markdown source string into an EPUB Blob.
     *
     * @param {string} src - Raw Markdown.
     * @param {string} fallbackTitle - Used when no H1 / frontmatter title.
     * @param {object} [opts] - Markdown optimiser overrides.
     * @returns {Promise<Blob>} EPUB Blob with type `application/epub+zip`.
     */
    async function mdToEpubBlob(src, fallbackTitle, opts) {
        if (typeof global.JSZip !== 'function') {
            throw new Error('JSZip is not loaded.');
        }
        const optimised = optimizeMarkdown(src, opts);
        const splitLevel = (opts && opts.splitChaptersAt) || 1;
        const chapters = splitChapters(optimised.content, splitLevel);
        const title = optimised.title || fallbackTitle || 'Document';
        const author = optimised.author || '';

        const zip = new global.JSZip();
        zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
        zip.file('META-INF/container.xml',
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
            '  <rootfiles>\n' +
            '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
            '  </rootfiles>\n' +
            '</container>\n');

        const ids = [];
        for (let i = 0; i < chapters.length; i++) {
            const id = 'chapter-' + (i + 1);
            ids.push(id);
            const html = renderMarkdown(chapters[i].markdown);
            zip.file('OEBPS/' + id + '.xhtml', wrapChapter(chapters[i].title || title, html));
        }
        zip.file('OEBPS/content.opf', buildOpf(title, author, ids));
        zip.file('OEBPS/nav.xhtml', buildNav(title));
        zip.file('OEBPS/style.css', EPAPER_CSS);

        return zip.generateAsync({
            type: 'blob',
            mimeType: 'application/epub+zip',
            compression: 'DEFLATE',
            compressionOptions: { level: 9 }
        });
    }

    /**
     * Take an uploaded `.md` File and return a synthetic File whose name
     * ends in `.epub` — the existing app pipeline can then treat it like
     * any other EPUB upload without further changes.
     */
    async function mdFileToEpubFile(file, opts) {
        const text = await file.text();
        const fallback = file.name.replace(/\.(md|markdown)$/i, '');
        const blob = await mdToEpubBlob(text, fallback, opts);
        const epubName = file.name.replace(/\.(md|markdown)$/i, '.epub');
        // Older Safari lacks the File constructor — fall back to a Blob with a name.
        if (typeof File === 'function') {
            try { return new File([blob], epubName, { type: 'application/epub+zip' }); }
            catch (e) { /* fall through */ }
        }
        const tagged = new Blob([blob], { type: 'application/epub+zip' });
        tagged.name = epubName;
        return tagged;
    }

    global.MarkdownToEpub = {
        DEFAULT_MD_OPTS: DEFAULT_MD_OPTS,
        optimizeMarkdown: optimizeMarkdown,
        renderMarkdown: renderMarkdown,
        splitChapters: splitChapters,
        mdToEpubBlob: mdToEpubBlob,
        mdFileToEpubFile: mdFileToEpubFile
    };
})(window);
