/**
 * Build a minimal EPUB 3 buffer from optimised Markdown.
 *
 * The generated EPUB is consumed entirely in-memory by `converter.js` —
 * it never has to hit disk for the conversion path. Layout:
 *
 *   mimetype                  (stored, no compression)
 *   META-INF/container.xml
 *   OEBPS/content.opf
 *   OEBPS/nav.xhtml
 *   OEBPS/style.css
 *   OEBPS/chapter-N.xhtml     (one per top-level heading at `splitChaptersAt`)
 *   OEBPS/images/<n>.jpg      (referenced images, processed by image-utils)
 *
 * The chapter split granularity is configurable so the XTC TOC matches
 * the document's intent — H1 chapters by default for code documentation.
 *
 * Local image references are resolved relative to the source `.md` file
 * (when `baseDir` is supplied) and pushed through `image-utils.processImage`
 * so the same e-paper rules apply as in the EPUB optimiser. Remote URLs
 * are left as-is (the device has no network — they will simply not load,
 * which matches the existing optimiser behaviour).
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { processImage } = require('./image-utils');
const {
    optimizeMarkdown,
    renderMarkdownToHtml,
    buildToc,
    defaultCodeCss,
    defaultSlugify
} = require('./markdown');

/** XML special-character escape. */
function xmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Split optimised Markdown into chapter chunks at headings of the given level.
 * Anything before the first qualifying heading becomes the "preface" chapter
 * (only included if it has non-whitespace content).
 */
function splitChapters(md, level) {
    const lines = md.split('\n');
    const headingRe = new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`);
    const chapters = [];
    let current = { title: '', body: [] };
    let inFence = false;

    for (const line of lines) {
        if (/^\s{0,3}(```+|~~~+)/.test(line)) inFence = !inFence;
        if (!inFence) {
            const m = line.match(headingRe);
            if (m) {
                if (current.title || current.body.some(l => l.trim() !== '')) {
                    chapters.push(current);
                }
                current = { title: m[1].trim(), body: [line] };
                continue;
            }
        }
        current.body.push(line);
    }
    if (current.title || current.body.some(l => l.trim() !== '')) {
        chapters.push(current);
    }
    if (chapters.length === 0) {
        chapters.push({ title: '', body: lines });
    }
    return chapters.map(ch => ({ title: ch.title, markdown: ch.body.join('\n') }));
}

/* --------------------------- image collection --------------------------- */

/**
 * Walk the Markdown source for local image references.
 * Matches both `![](path)` and `<img src="path">`. Skips data: and absolute
 * URLs (http/https/file/data). Returns a Map of original ref → resolved
 * absolute path on disk.
 */
function collectLocalImageRefs(md, baseDir) {
    const refs = new Map();
    const seen = new Set();

    const add = (ref) => {
        if (!ref || seen.has(ref)) return;
        seen.add(ref);
        if (/^(https?:|data:|file:|\/\/)/i.test(ref)) return;
        if (!baseDir) return;
        const abs = path.resolve(baseDir, ref);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            refs.set(ref, abs);
        }
    };

    // ![alt](url "title")
    const mdImgRe = /!\[[^\]]*\]\(\s*<?([^)\s"]+)>?(?:\s+"[^"]*")?\s*\)/g;
    let m;
    while ((m = mdImgRe.exec(md)) !== null) add(m[1]);

    // <img src="url">
    const htmlImgRe = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    while ((m = htmlImgRe.exec(md)) !== null) add(m[1]);

    return refs;
}

/* --------------------------- EPUB construction -------------------------- */

const CONTAINER_XML =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
    '  <rootfiles>\n' +
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
    '  </rootfiles>\n' +
    '</container>\n';

function buildContentOpf({ title, author, language, identifier, chapterIds, imageItems }) {
    const itemRefs = chapterIds
        .map(id => `    <itemref idref="${id}"/>`)
        .join('\n');
    const chapterItems = chapterIds
        .map(id => `    <item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`)
        .join('\n');
    const imgItems = imageItems
        .map(im => `    <item id="${im.id}" href="${im.href}" media-type="image/jpeg"/>`)
        .join('\n');

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="' + xmlEscape(language) + '">',
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
        `    <dc:identifier id="bookid">${xmlEscape(identifier)}</dc:identifier>`,
        `    <dc:title>${xmlEscape(title)}</dc:title>`,
        `    <dc:language>${xmlEscape(language)}</dc:language>`,
        author ? `    <dc:creator>${xmlEscape(author)}</dc:creator>` : '',
        `    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>`,
        '  </metadata>',
        '  <manifest>',
        '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '    <item id="css" href="style.css" media-type="text/css"/>',
        chapterItems,
        imgItems,
        '  </manifest>',
        '  <spine>',
        itemRefs,
        '  </spine>',
        '</package>',
        ''
    ].filter(Boolean).join('\n');
}

function buildNavXhtml(title, toc) {
    const items = toc
        .filter(t => t.level <= 2)
        .map(t => `      <li><a href="#${xmlEscape(t.slug)}">${xmlEscape(t.title)}</a></li>`)
        .join('\n');
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE html>',
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
        '<head>',
        `  <title>${xmlEscape(title || 'Contents')}</title>`,
        '  <link rel="stylesheet" type="text/css" href="style.css"/>',
        '</head>',
        '<body>',
        '  <nav epub:type="toc" id="toc">',
        '    <h1>Contents</h1>',
        '    <ol>',
        items || '      <li><a href="chapter-1.xhtml">Start</a></li>',
        '    </ol>',
        '  </nav>',
        '</body>',
        '</html>',
        ''
    ].join('\n');
}

function wrapChapterXhtml(title, bodyHtml) {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE html>',
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
        '<head>',
        `  <title>${xmlEscape(title || 'Chapter')}</title>`,
        '  <link rel="stylesheet" type="text/css" href="style.css"/>',
        '</head>',
        '<body>',
        bodyHtml,
        '</body>',
        '</html>',
        ''
    ].join('\n');
}

/**
 * Rewrite `<img src="...">` tags inside rendered HTML to reference EPUB-internal
 * resources, using the renames map produced when we processed images.
 */
function rewriteImageSrcs(html, renames) {
    if (!renames || renames.size === 0) return html;
    return html.replace(/(<img\b[^>]*\bsrc\s*=\s*")([^"]+)(")/gi, (full, pre, src, post) => {
        const replacement = renames.get(src);
        return replacement ? pre + replacement + post : full;
    });
}

/* ------------------------------ entry point ----------------------------- */

/**
 * Convert a Markdown source (string + base directory for image resolution)
 * into an EPUB 3 buffer ready for the existing XTC pipeline.
 *
 * @param {object} args
 * @param {string} args.markdown   Raw Markdown source (frontmatter allowed).
 * @param {string} [args.baseDir]  Directory used to resolve relative image refs.
 * @param {string} [args.fallbackTitle] Used when no H1/frontmatter title.
 * @param {object} [args.markdownOpts]  Override `DEFAULT_MARKDOWN_OPTS`.
 * @param {object} [args.imageOpts]     `{ maxImageWidth, grayscale }`.
 * @returns {Promise<{buffer: Buffer, title: string, author: string, chapters: number}>}
 */
async function buildEpubFromMarkdown(args) {
    const {
        markdown,
        baseDir,
        fallbackTitle,
        markdownOpts,
        imageOpts
    } = args;

    const optimised = optimizeMarkdown(markdown, markdownOpts);
    const splitLevel = (markdownOpts && markdownOpts.splitChaptersAt) || 1;
    const chapters = splitChapters(optimised.content, splitLevel);
    const toc = buildToc(optimised.content);

    const title = optimised.title || fallbackTitle || 'Document';
    const author = optimised.author || '';
    const language =
        (optimised.data && (optimised.data.language || optimised.data.lang)) || 'en';
    const identifier =
        (optimised.data && optimised.data.identifier) ||
        `urn:uuid:md-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    // ---- images ----
    const imgOpts = imageOpts || {};
    const refs = collectLocalImageRefs(optimised.content, baseDir);
    const renames = new Map();
    const imageItems = [];
    let imgIndex = 0;
    for (const [originalRef, absPath] of refs.entries()) {
        try {
            const data = fs.readFileSync(absPath);
            const processed = await processImage(
                data,
                imgOpts.maxImageWidth || 480,
                imgOpts.grayscale !== false
            );
            if (!processed) continue;
            imgIndex++;
            const href = `images/img-${imgIndex}.jpg`;
            renames.set(originalRef, href);
            imageItems.push({
                id: `img-${imgIndex}`,
                href,
                buffer: processed
            });
        } catch {
            // Silently skip unreadable images — matches optimiser behaviour.
        }
    }

    // ---- chapter HTML ----
    const chapterIds = [];
    const chapterFiles = [];
    for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        const html = renderMarkdownToHtml(ch.markdown, markdownOpts);
        const rewritten = rewriteImageSrcs(html, renames);
        const chId = `chapter-${i + 1}`;
        chapterIds.push(chId);
        chapterFiles.push({
            id: chId,
            xhtml: wrapChapterXhtml(ch.title || title, rewritten)
        });
    }

    // ---- assemble ZIP ----
    const zip = new JSZip();
    // mimetype must be the FIRST entry, stored uncompressed.
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', CONTAINER_XML);

    const opf = buildContentOpf({
        title,
        author,
        language,
        identifier,
        chapterIds,
        imageItems
    });
    zip.file('OEBPS/content.opf', opf);
    zip.file('OEBPS/nav.xhtml', buildNavXhtml(title, toc));

    const userInjectedCss = (markdownOpts && markdownOpts.injectCodeCss === false)
        ? '' : defaultCodeCss();
    zip.file('OEBPS/style.css', userInjectedCss);

    for (const ch of chapterFiles) {
        zip.file(`OEBPS/${ch.id}.xhtml`, ch.xhtml);
    }
    for (const im of imageItems) {
        zip.file(`OEBPS/${im.href}`, im.buffer);
    }

    const buffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
        // Ensure mimetype stays uncompressed and first.
        mimeType: 'application/epub+zip'
    });

    return {
        buffer,
        title,
        author,
        chapters: chapters.length
    };
}

/**
 * Read a `.md` file and return an EPUB buffer for it. Convenience wrapper
 * around `buildEpubFromMarkdown` that fills in `baseDir`/`fallbackTitle`.
 */
async function buildEpubFromMarkdownFile(mdPath, opts) {
    const src = fs.readFileSync(mdPath, 'utf8');
    return buildEpubFromMarkdown({
        markdown: src,
        baseDir: path.dirname(path.resolve(mdPath)),
        fallbackTitle: path.basename(mdPath, path.extname(mdPath)),
        markdownOpts: opts && opts.markdownOpts,
        imageOpts: opts && opts.imageOpts
    });
}

module.exports = {
    buildEpubFromMarkdown,
    buildEpubFromMarkdownFile,
    splitChapters,
    collectLocalImageRefs,
    // exported for tests
    _internal: { CONTAINER_XML, buildContentOpf, buildNavXhtml, wrapChapterXhtml, xmlEscape }
};
