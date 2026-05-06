/**
 * Shared image-processing helpers for Xteink e-paper devices.
 *
 * Centralises the rules that apply to any image destined for an Xteink
 * e-reader (X4 480x800, X3 528x792):
 *   - skip tiny decorative images (<20px on either axis)
 *   - flatten alpha to white (e-paper has no transparency)
 *   - resize to fit the device decode budget (2048x3072 max)
 *   - optional grayscale
 *   - always emit baseline JPEG (the firmware rejects progressive JPEGs)
 *
 * Used by both `optimizer.js` (existing EPUB optimiser) and the new
 * `md-to-epub.js` Markdown-to-EPUB pipeline so both paths obey the
 * same constraints.
 */

const sharp = require('sharp');

const MAX_IMAGE_DECODE_WIDTH = 2048;
const MAX_IMAGE_DECODE_HEIGHT = 3072;
const MIN_IMAGE_SIZE = 20;

/**
 * Process an image buffer for an Xteink e-paper device.
 *
 * @param {Buffer} imgBuffer - Raw image bytes (any format Sharp can decode).
 * @param {number|undefined} maxWidth - Soft cap on output width (default 2048).
 * @param {boolean} toGrayscale - If true, convert to single-channel grayscale.
 * @returns {Promise<Buffer|null>} Baseline JPEG buffer, or null when the
 *          image was too small (decorative) or could not be decoded.
 */
async function processImage(imgBuffer, maxWidth, toGrayscale) {
    try {
        let pipeline = sharp(imgBuffer);
        const metadata = await pipeline.metadata();

        if (metadata.width < MIN_IMAGE_SIZE || metadata.height < MIN_IMAGE_SIZE) {
            return null;
        }

        if (metadata.channels === 4 || metadata.hasAlpha) {
            pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
        }

        const effectiveMaxWidth = Math.min(maxWidth || MAX_IMAGE_DECODE_WIDTH, MAX_IMAGE_DECODE_WIDTH);
        if (metadata.width > effectiveMaxWidth || metadata.height > MAX_IMAGE_DECODE_HEIGHT) {
            pipeline = pipeline.resize({
                width: effectiveMaxWidth,
                height: MAX_IMAGE_DECODE_HEIGHT,
                fit: 'inside',
                withoutEnlargement: true
            });
        }

        if (toGrayscale) {
            pipeline = pipeline.grayscale();
        }

        return await pipeline.jpeg({ quality: 85, progressive: false }).toBuffer();
    } catch {
        return null;
    }
}

module.exports = {
    MAX_IMAGE_DECODE_WIDTH,
    MAX_IMAGE_DECODE_HEIGHT,
    MIN_IMAGE_SIZE,
    processImage
};
