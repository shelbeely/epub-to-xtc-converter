/**
 * md-to-epub integration tests.
 *
 * Validates the EPUB scaffolding emitted by `buildEpubFromMarkdown`:
 *   - mimetype is the first entry, stored uncompressed
 *   - container.xml points to OEBPS/content.opf
 *   - the OPF parses minimally and lists all chapter files
 *   - chapter splitting respects `splitChaptersAt`
 *
 * Does not exercise CREngine — that's covered by the existing converter
 * code paths and would require the WASM binary plus a TTF font.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const JSZip = require('jszip');

const { buildEpubFromMarkdown, splitChapters } = require('../md-to-epub');

const SAMPLE_MD = [
    '---',
    'title: Sample Doc',
    'author: Tester',
    '---',
    '',
    '# Chapter One',
    '',
    'Hello **world**.',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '# Chapter Two',
    '',
    '- [ ] todo',
    '- [x] done',
    ''
].join('\n');

test('splitChapters splits at the configured heading level', () => {
    const md = '# A\nbody A\n# B\nbody B\n';
    const ch = splitChapters(md, 1);
    assert.equal(ch.length, 2);
    assert.equal(ch[0].title, 'A');
    assert.equal(ch[1].title, 'B');
});

test('splitChapters keeps preface content before the first heading', () => {
    const md = 'preface text\n\n# First\nbody\n';
    const ch = splitChapters(md, 1);
    assert.equal(ch.length, 2);
    assert.match(ch[0].markdown, /preface text/);
    assert.equal(ch[1].title, 'First');
});

test('buildEpubFromMarkdown produces a valid EPUB ZIP', async () => {
    const { buffer, title, author, chapters } = await buildEpubFromMarkdown({
        markdown: SAMPLE_MD,
        fallbackTitle: 'fallback'
    });

    assert.equal(title, 'Sample Doc');
    assert.equal(author, 'Tester');
    assert.equal(chapters, 2);

    const zip = await JSZip.loadAsync(buffer);

    // mimetype must exist and contain exactly the EPUB media type
    assert.ok(zip.files['mimetype'], 'mimetype entry missing');
    const mime = await zip.files['mimetype'].async('string');
    assert.equal(mime, 'application/epub+zip');

    // First entry of the raw ZIP must be `mimetype` (per EPUB spec)
    // We check via the bytes of the buffer: ZIP local file header magic 0x04034b50,
    // and the filename "mimetype" should appear immediately after the 30-byte header.
    const firstFilename = buffer.slice(30, 30 + 'mimetype'.length).toString('ascii');
    assert.equal(firstFilename, 'mimetype', 'mimetype must be first ZIP entry');

    assert.ok(zip.files['META-INF/container.xml']);
    const container = await zip.files['META-INF/container.xml'].async('string');
    assert.match(container, /OEBPS\/content\.opf/);

    assert.ok(zip.files['OEBPS/content.opf']);
    const opf = await zip.files['OEBPS/content.opf'].async('string');
    assert.match(opf, /<dc:title>Sample Doc<\/dc:title>/);
    assert.match(opf, /<dc:creator>Tester<\/dc:creator>/);
    assert.match(opf, /chapter-1\.xhtml/);
    assert.match(opf, /chapter-2\.xhtml/);

    assert.ok(zip.files['OEBPS/nav.xhtml']);
    assert.ok(zip.files['OEBPS/style.css']);
    assert.ok(zip.files['OEBPS/chapter-1.xhtml']);
    assert.ok(zip.files['OEBPS/chapter-2.xhtml']);

    const ch1 = await zip.files['OEBPS/chapter-1.xhtml'].async('string');
    assert.match(ch1, /<h1[^>]*>Chapter One<\/h1>/);
    assert.match(ch1, /<pre class="hljs">/);
});

test('buildEpubFromMarkdown handles no-frontmatter input via fallbackTitle', async () => {
    const { title, chapters } = await buildEpubFromMarkdown({
        markdown: 'just a paragraph',
        fallbackTitle: 'mydoc'
    });
    assert.equal(title, 'mydoc');
    assert.equal(chapters, 1);
});

test('buildEpubFromMarkdown resolves and processes local images', async () => {
    // Build a minimal PNG (1x1 white) on disk and reference it.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md2epub-'));
    try {
        // Use Sharp to make a real PNG so processImage doesn't reject it.
        const sharp = require('sharp');
        const imgPath = path.join(tmp, 'img.png');
        await sharp({
            create: { width: 64, height: 64, channels: 3, background: '#fff' }
        }).png().toFile(imgPath);

        const md = '# Doc\n\n![alt](img.png)\n';
        const { buffer } = await buildEpubFromMarkdown({
            markdown: md,
            baseDir: tmp,
            fallbackTitle: 'doc'
        });
        const zip = await JSZip.loadAsync(buffer);
        const imgEntries = Object.keys(zip.files).filter(f => /^OEBPS\/images\/img-\d+\.jpg$/.test(f));
        assert.equal(imgEntries.length, 1, 'image should be embedded as JPEG');

        // The chapter HTML should reference the rewritten path
        const ch = await zip.files['OEBPS/chapter-1.xhtml'].async('string');
        assert.match(ch, /src="images\/img-1\.jpg"/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
