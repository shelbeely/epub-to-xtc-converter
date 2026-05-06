/**
 * Settings validator tests for the new `markdown` block.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_SETTINGS,
    validateMarkdownSettings,
    generateDefaultConfig
} = require('../settings');

test('DEFAULT_SETTINGS exposes a markdown block with sensible defaults', () => {
    assert.ok(DEFAULT_SETTINGS.markdown);
    assert.equal(DEFAULT_SETTINGS.markdown.wrapCodeAt, 58);
    assert.equal(DEFAULT_SETTINGS.markdown.splitChaptersAt, 1);
    assert.equal(DEFAULT_SETTINGS.markdown.highlightStyle, 'bold-italic');
});

test('generateDefaultConfig output is valid JSON containing the markdown block', () => {
    const json = generateDefaultConfig();
    const parsed = JSON.parse(json);
    assert.ok(parsed.markdown);
    assert.equal(parsed.markdown.tabSize, 2);
});

test('validateMarkdownSettings accepts defaults', () => {
    const errors = validateMarkdownSettings(DEFAULT_SETTINGS);
    assert.deepEqual(errors, []);
});

test('validateMarkdownSettings rejects out-of-range values', () => {
    const bad = {
        markdown: {
            wrapCodeAt: 9999,
            tabSize: 0,
            flattenHeadingsAbove: 0,
            splitChaptersAt: 7,
            highlightStyle: 'rainbow'
        }
    };
    const errors = validateMarkdownSettings(bad);
    assert.ok(errors.length >= 5, `expected several errors, got: ${JSON.stringify(errors)}`);
});

test('validateMarkdownSettings tolerates missing markdown block', () => {
    assert.deepEqual(validateMarkdownSettings({}), []);
});
