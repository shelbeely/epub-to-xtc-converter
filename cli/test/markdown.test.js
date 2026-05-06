/**
 * Markdown optimiser unit tests.
 *
 * Run with: `node --test cli/test/markdown.test.js`
 *
 * These tests cover the deterministic, text-level transforms — they do
 * not require the CREngine WASM binary or the Sharp image pipeline, so
 * they can run anywhere Node 18+ is installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    optimizeMarkdown,
    renderMarkdownToHtml,
    buildToc,
    _internal
} = require('../markdown');

test('optimizeMarkdown wraps long code-fence lines on word boundaries', () => {
    const longLine = 'const veryLongVariableName = someFunction(arg1, arg2, arg3, arg4, arg5);';
    const src = '```js\n' + longLine + '\n```\n';
    const { content } = optimizeMarkdown(src, { wrapCodeAt: 30 });
    const lines = content.split('\n');
    // Expect at least 2 fenced lines instead of one
    const codeLines = lines.slice(1, -2);
    assert.ok(codeLines.length >= 2, `expected wrap, got: ${JSON.stringify(codeLines)}`);
    // No line should exceed wrap budget by more than the indent allowance
    for (const l of codeLines) {
        assert.ok(l.length <= 80, `line too long: ${l}`);
    }
});

test('optimizeMarkdown does NOT wrap text outside fences', () => {
    const para = 'This is a normal paragraph that is fairly long but should remain on one single line because it is not inside a code fence.';
    const { content } = optimizeMarkdown(para + '\n', { wrapCodeAt: 30 });
    assert.equal(content.trim(), para);
});

test('optimizeMarkdown expands tabs in code blocks', () => {
    const src = '```\n\tindented\n```\n';
    const { content } = optimizeMarkdown(src, { tabSize: 4 });
    assert.match(content, /^ {4}indented$/m);
});

test('optimizeMarkdown rewrites task-list markers to glyphs', () => {
    const src = '- [ ] todo\n- [x] done\n';
    const { content } = optimizeMarkdown(src);
    assert.match(content, /- ☐ todo/);
    assert.match(content, /- ☑ done/);
});

test('optimizeMarkdown flattens GFM alerts to bold-quoted prose', () => {
    const src = '> [!NOTE]\n> Pay attention.\n';
    const { content } = optimizeMarkdown(src);
    assert.match(content, /\*\*Note:\*\*/);
});

test('optimizeMarkdown caps headings at flattenHeadingsAbove', () => {
    const src = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n';
    const { content } = optimizeMarkdown(src, { flattenHeadingsAbove: 4 });
    assert.match(content, /^# H1$/m);
    assert.match(content, /^#### H4$/m);
    assert.match(content, /^\*\*H5\*\*$/m);
    assert.match(content, /^\*\*H6\*\*$/m);
});

test('optimizeMarkdown strips dangerous HTML blocks', () => {
    const src = 'before\n<script>alert(1)</script>\n<details><summary>x</summary>y</details>\nafter\n';
    const { content } = optimizeMarkdown(src);
    assert.doesNotMatch(content, /<script/i);
    assert.doesNotMatch(content, /<details/i);
});

test('optimizeMarkdown drops emoji when configured', () => {
    const src = 'hello 🎉 world\n';
    const { content } = optimizeMarkdown(src, { dropEmoji: true });
    assert.doesNotMatch(content, /🎉/);

    const kept = optimizeMarkdown(src, { dropEmoji: false }).content;
    assert.match(kept, /🎉/);
});

test('optimizeMarkdown normalises smart typography', () => {
    const src = '\u201CHello\u201D \u2014 world\u2026\n';
    const { content } = optimizeMarkdown(src);
    assert.match(content, /"Hello" -- world\.\.\./);
});

test('optimizeMarkdown extracts title from H1', () => {
    const { title } = optimizeMarkdown('# My Doc\n\nbody\n');
    assert.equal(title, 'My Doc');
});

test('optimizeMarkdown reads frontmatter title and author', () => {
    const src = '---\ntitle: From FM\nauthor: Alice\n---\n\nbody\n';
    const { title, author, data } = optimizeMarkdown(src);
    assert.equal(title, 'From FM');
    assert.equal(author, 'Alice');
    assert.equal(data.title, 'From FM');
});

test('optimizeMarkdown tolerates malformed YAML frontmatter', () => {
    // Unbalanced quotes / bad indent — should not throw, just skip
    const src = '---\ntitle: "unbalanced\n---\n\nbody\n';
    const result = optimizeMarkdown(src);
    assert.ok(typeof result.content === 'string');
});

test('optimizeMarkdown transposes wide tables to definition-list form', () => {
    const wideTable = [
        '| Name             | Description                              | Status   |',
        '|------------------|------------------------------------------|----------|',
        '| FooBarBaz        | Lorem ipsum dolor sit amet               | active   |',
        ''
    ].join('\n');
    const { content } = optimizeMarkdown(wideTable, { transposeWideTables: true, wideTableThreshold: 30 });
    assert.match(content, /\*\*Name:\*\*/);
    assert.match(content, /\*\*Description:\*\*/);
});

test('renderMarkdownToHtml produces HTML with headings and paragraphs', () => {
    const html = renderMarkdownToHtml('# Title\n\nparagraph\n');
    assert.match(html, /<h1[^>]*>Title<\/h1>/);
    assert.match(html, /<p>paragraph<\/p>/);
});

test('renderMarkdownToHtml emits monochrome highlighting (no colour spans)', () => {
    const md = '```js\nconst x = 1;\n```\n';
    const html = renderMarkdownToHtml(md, { syntaxHighlight: true });
    // The hljs-* classes should not survive monochrome conversion for inner spans
    // (the wrapper <pre class="hljs"><code> may still carry the class).
    const innerOnly = html.replace(/<pre class="hljs">/, '<pre>');
    assert.doesNotMatch(innerOnly, /class="hljs-/);
});

test('buildToc returns headings in document order, ignoring fenced regions', () => {
    const md = '# A\n\n```\n# not a heading\n```\n\n## B\n### C\n';
    const toc = buildToc(md);
    assert.deepEqual(toc.map(t => t.title), ['A', 'B', 'C']);
    assert.deepEqual(toc.map(t => t.level), [1, 2, 3]);
});

test('_internal.wrapCodeLine never breaks a single token mid-word', () => {
    const word = 'a'.repeat(80);
    const wrapped = _internal.wrapCodeLine(word, 30);
    assert.equal(wrapped.length, 1, 'should not split unbreakable token');
    assert.equal(wrapped[0], word);
});
