/**
 * Settings management and defaults for CLI converter
 */

const fs = require('fs');
const path = require('path');

// Device presets
const DEVICES = {
    'xteink-x4': { width: 480, height: 800, name: 'Xteink X4' },
    'xteink-x3': { width: 528, height: 792, name: 'Xteink X3' },
    'custom': { width: 480, height: 800, name: 'Custom' }
};

// Text alignment values for CREngine
const TEXT_ALIGN = {
    'left': 0,
    'right': 1,
    'center': 2,
    'justify': 3
};

// Default settings
const DEFAULT_SETTINGS = {
    device: 'xteink-x4',
    width: 480,
    height: 800,
    font: {
        path: null,  // Required: path to TTF/OTF font file
        size: 34,
        weight: 400
    },
    margins: {
        left: 16,
        top: 16,
        right: 16,
        bottom: 16
    },
    lineHeight: 120,
    textAlign: 'justify',
    hyphenation: {
        enabled: true,
        language: 'en'
    },
    output: {
        format: 'xtc',  // 'xtc' (1-bit) or 'xtch' (2-bit)
        dithering: true,
        ditherStrength: 0.7,
        negative: false
    },
    optimizer: {
        removeCss: true,
        stripFonts: true,
        processImages: true,
        removeUnsupportedImages: true,
        grayscale: true,
        maxImageWidth: 480,
        injectCss: true,
        recursive: true,
        include: '*.epub',
        exclude: null
    },
    markdown: {
        wrapCodeAt: 58,
        tabSize: 2,
        flattenHeadingsAbove: 4,
        transposeWideTables: true,
        wideTableThreshold: 32,
        syntaxHighlight: true,
        highlightStyle: 'bold-italic',
        dropEmoji: true,
        smartTypography: true,
        taskListGlyphs: true,
        flattenAlerts: true,
        stripDangerousHtml: true,
        frontmatterAuthorField: 'author',
        splitChaptersAt: 1,
        injectCodeCss: true
    }
};

/**
 * Load settings from JSON file
 */
function loadSettings(configPath) {
    if (!configPath || !fs.existsSync(configPath)) {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const userSettings = JSON.parse(content);
        return mergeSettings(DEFAULT_SETTINGS, userSettings);
    } catch (err) {
        throw new Error(`Failed to load config file: ${err.message}`);
    }
}

/**
 * Deep merge settings objects
 */
function mergeSettings(defaults, user) {
    const result = { ...defaults };

    for (const key of Object.keys(user)) {
        if (user[key] !== null && typeof user[key] === 'object' && !Array.isArray(user[key])) {
            result[key] = mergeSettings(defaults[key] || {}, user[key]);
        } else {
            result[key] = user[key];
        }
    }

    return result;
}

/**
 * Resolve settings with device preset
 */
function resolveSettings(settings) {
    const resolved = { ...settings };

    // Apply device preset dimensions if not custom
    if (settings.device !== 'custom' && DEVICES[settings.device]) {
        resolved.width = DEVICES[settings.device].width;
        resolved.height = DEVICES[settings.device].height;
    }

    // Convert text align string to CREngine value
    resolved.textAlignValue = TEXT_ALIGN[settings.textAlign] || 3;

    // Resolve font path to absolute
    if (resolved.font.path) {
        resolved.font.path = path.resolve(resolved.font.path);
    }

    return resolved;
}

/**
 * Validate settings
 */
function validateSettings(settings) {
    const errors = [];

    if (!settings.font.path) {
        errors.push('Font path is required. Set font.path in your config file.');
    } else if (!fs.existsSync(settings.font.path)) {
        errors.push(`Font file not found: ${settings.font.path}`);
    }

    if (settings.width <= 0 || settings.height <= 0) {
        errors.push('Width and height must be positive integers');
    }

    if (settings.font.size < 8 || settings.font.size > 100) {
        errors.push('Font size must be between 8 and 100');
    }

    if (settings.output.ditherStrength < 0 || settings.output.ditherStrength > 1) {
        errors.push('Dither strength must be between 0 and 1');
    }

    const validFormats = ['xtc', 'xtch'];
    if (!validFormats.includes(settings.output.format)) {
        errors.push(`Invalid output format: ${settings.output.format}. Must be 'xtc' or 'xtch'`);
    }

    validateOptimizerFields(settings, errors);
    errors.push(...validateMarkdownSettings(settings));

    return errors;
}

/**
 * Validate optimizer-specific settings (no font.path required)
 */
function validateOptimizerSettings(settings) {
    const errors = [];
    validateOptimizerFields(settings, errors);
    return errors;
}

function validateOptimizerFields(settings, errors) {
    if (settings.optimizer) {
        if (settings.optimizer.maxImageWidth !== undefined &&
            (settings.optimizer.maxImageWidth < 1 || settings.optimizer.maxImageWidth > 2048)) {
            errors.push('optimizer.maxImageWidth must be between 1 and 2048');
        }
    }
}

/**
 * Validate the `markdown` settings block. All checks are best-effort —
 * unknown keys are tolerated so user configs can carry extras.
 */
function validateMarkdownSettings(settings) {
    const errors = [];
    const md = settings.markdown;
    if (!md) return errors;

    if (md.wrapCodeAt !== undefined && md.wrapCodeAt !== null &&
        (typeof md.wrapCodeAt !== 'number' || md.wrapCodeAt < 0 || md.wrapCodeAt > 500)) {
        errors.push('markdown.wrapCodeAt must be a number between 0 and 500');
    }
    if (md.tabSize !== undefined &&
        (typeof md.tabSize !== 'number' || md.tabSize < 1 || md.tabSize > 16)) {
        errors.push('markdown.tabSize must be a number between 1 and 16');
    }
    if (md.flattenHeadingsAbove !== undefined &&
        (typeof md.flattenHeadingsAbove !== 'number' ||
         md.flattenHeadingsAbove < 1 || md.flattenHeadingsAbove > 6)) {
        errors.push('markdown.flattenHeadingsAbove must be between 1 and 6');
    }
    if (md.splitChaptersAt !== undefined &&
        (typeof md.splitChaptersAt !== 'number' ||
         md.splitChaptersAt < 1 || md.splitChaptersAt > 6)) {
        errors.push('markdown.splitChaptersAt must be between 1 and 6');
    }
    if (md.highlightStyle !== undefined &&
        md.highlightStyle !== 'bold-italic' && md.highlightStyle !== 'none') {
        errors.push("markdown.highlightStyle must be 'bold-italic' or 'none'");
    }
    return errors;
}

/**
 * Generate default config file content
 */
function generateDefaultConfig() {
    return JSON.stringify(DEFAULT_SETTINGS, null, 2);
}

module.exports = {
    DEVICES,
    TEXT_ALIGN,
    DEFAULT_SETTINGS,
    loadSettings,
    resolveSettings,
    validateSettings,
    validateOptimizerSettings,
    validateMarkdownSettings,
    generateDefaultConfig
};
