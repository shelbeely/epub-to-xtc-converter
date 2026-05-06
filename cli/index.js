#!/usr/bin/env node

/**
 * EPUB to XTC/XTCH CLI Converter
 * Converts EPUB files to Xteink e-reader format
 */

const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const { minimatch } = require('minimatch');
const { loadSettings, resolveSettings, validateSettings, validateOptimizerSettings, generateDefaultConfig } = require('./settings');
const { convertEpub, getOutputPath, cleanup } = require('./converter');
const { optimizeEpub } = require('./optimizer');
const { optimizeMarkdown } = require('./markdown');
const { buildEpubFromMarkdownFile } = require('./md-to-epub');

/** Recognised input extensions for the convert command. */
const EPUB_EXT_RE = /\.epub$/i;
const MD_EXT_RE = /\.(md|markdown)$/i;

function isEpubPath(p) { return EPUB_EXT_RE.test(p); }
function isMarkdownPath(p) { return MD_EXT_RE.test(p); }
function isSupportedInput(p) { return isEpubPath(p) || isMarkdownPath(p); }

program
    .name('epub-to-xtc')
    .description('Convert EPUB files to XTC/XTCH format for Xteink e-readers')
    .version('1.0.0');

program
    .command('convert <input>')
    .description('Convert EPUB or Markdown file(s) to XTC/XTCH format')
    .option('-o, --output <path>', 'Output file or directory')
    .option('-c, --config <path>', 'Path to settings JSON file')
    .option('-f, --format <format>', 'Output format: xtc (1-bit) or xtch (2-bit)')
    .action(async (input, options) => {
        try {
            // Load and resolve settings
            let settings = loadSettings(options.config);
            settings = resolveSettings(settings);

            // Override format if specified
            if (options.format) {
                settings.output.format = options.format;
            }

            // Validate settings
            const errors = validateSettings(settings);
            if (errors.length > 0) {
                console.error('Configuration errors:');
                errors.forEach(e => console.error(`  - ${e}`));
                process.exit(1);
            }

            // Resolve input path
            const inputPath = path.resolve(input);

            if (!fs.existsSync(inputPath)) {
                console.error(`Input not found: ${inputPath}`);
                process.exit(1);
            }

            const stat = fs.statSync(inputPath);

            if (stat.isDirectory()) {
                // Convert all EPUBs and Markdown files in directory
                await convertDirectory(inputPath, options.output, settings);
            } else if (stat.isFile() && isSupportedInput(inputPath)) {
                // Convert single file (EPUB or Markdown)
                await convertSingleFile(inputPath, options.output, settings);
            } else {
                console.error('Input must be an EPUB or Markdown file, or a directory containing such files');
                process.exit(1);
            }

        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        } finally {
            cleanup();
        }
    });

program
    .command('init')
    .description('Generate default settings.json file')
    .option('-o, --output <path>', 'Output path', 'settings.json')
    .action((options) => {
        const outputPath = path.resolve(options.output);

        if (fs.existsSync(outputPath)) {
            console.error(`File already exists: ${outputPath}`);
            process.exit(1);
        }

        fs.writeFileSync(outputPath, generateDefaultConfig());
        console.log(`Created default settings file: ${outputPath}`);
        console.log('\nImportant: Edit the file to set font.path to your TTF/OTF font file.');
    });

program
    .command('optimize <input>')
    .description('Optimize EPUB file(s) for e-paper devices')
    .option('-o, --output <path>', 'Output file or directory')
    .option('-c, --config <path>', 'Path to settings JSON file')
    .action(async (input, options) => {
        try {
            const settings = loadSettings(options.config);
            const opts = settings.optimizer || {};

            const errors = validateOptimizerSettings(settings);
            if (errors.length > 0) {
                console.error('Configuration errors:');
                errors.forEach(e => console.error(`  - ${e}`));
                process.exit(1);
            }

            const inputPath = path.resolve(input);

            if (!fs.existsSync(inputPath)) {
                console.error(`Input not found: ${inputPath}`);
                process.exit(1);
            }

            const stat = fs.statSync(inputPath);

            if (stat.isDirectory()) {
                await optimizeDirectory(inputPath, options.output, opts);
            } else if (stat.isFile() && inputPath.endsWith('.epub')) {
                await optimizeSingleFile(inputPath, options.output, opts);
            } else {
                console.error('Input must be an EPUB file or directory containing EPUB files');
                process.exit(1);
            }

        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

function formatSize(bytes) {
    return (bytes / 1024).toFixed(1) + ' KB';
}

async function optimizeSingleFile(inputPath, outputPath, opts) {
    if (!outputPath) {
        const dir = path.dirname(inputPath);
        const ext = path.extname(inputPath);
        const base = path.basename(inputPath, ext);
        outputPath = path.join(dir, `${base}_optimized${ext}`);
    } else if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
        outputPath = path.join(outputPath, path.basename(inputPath));
    } else {
        outputPath = path.resolve(outputPath);
    }

    const filename = path.basename(inputPath);
    console.log(`Optimizing: ${filename}`);

    const result = await optimizeEpub(inputPath, outputPath, opts);

    console.log(`  Output: ${result.outputPath}`);
    console.log(`  Size: ${formatSize(result.originalSize)} -> ${formatSize(result.optimizedSize)} (${result.reductionPercent}% reduction)`);
}

/**
 * Collect input files from a directory, optionally recursive.
 *
 * `opts.include` may be a single glob string OR an array of globs (a file
 * is collected if it matches any of them). `opts.exclude` works the same
 * way for negative matching. The convert command uses an array to pick
 * up both `*.epub` and `*.md` / `*.markdown`; the optimiser keeps using
 * a single `*.epub` glob so its behaviour is unchanged.
 */
function collectEpubFiles(dir, opts, basedir) {
    basedir = basedir || dir;
    let results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const includes = normaliseGlobs(opts.include, ['*.epub']);
    const excludes = normaliseGlobs(opts.exclude, []);

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(basedir, fullPath);

        if (entry.isDirectory() && opts.recursive) {
            results = results.concat(collectEpubFiles(fullPath, opts, basedir));
        } else if (entry.isFile()) {
            if (!includes.some(g => minimatch(entry.name, g))) continue;
            if (excludes.length && excludes.some(g => minimatch(entry.name, g))) continue;
            results.push({ absolute: fullPath, relative: relPath });
        }
    }

    return results;
}

function normaliseGlobs(value, fallback) {
    if (value === null || value === undefined) return fallback;
    return Array.isArray(value) ? value : [value];
}

async function optimizeDirectory(inputDir, outputDir, opts) {
    const files = collectEpubFiles(inputDir, opts, inputDir);

    if (files.length === 0) {
        console.error('No EPUB files found in directory');
        process.exit(1);
    }

    const inPlace = !outputDir;
    if (!outputDir) {
        outputDir = inputDir;
    } else {
        outputDir = path.resolve(outputDir);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
    }

    console.log(`Optimizing ${files.length} EPUB file(s)...\n`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // Preserve relative directory structure in output
        let outputPath;
        if (inPlace) {
            // Add _optimized suffix to avoid overwriting originals
            const ext = path.extname(file.relative);
            const base = file.relative.slice(0, -ext.length);
            outputPath = path.join(outputDir, `${base}_optimized${ext}`);
        } else {
            outputPath = path.join(outputDir, file.relative);
        }

        console.log(`[${i + 1}/${files.length}] ${file.relative}`);

        try {
            const result = await optimizeEpub(file.absolute, outputPath, opts);

            console.log(`  Output: ${path.basename(result.outputPath)}`);
            console.log(`  Size: ${formatSize(result.originalSize)} -> ${formatSize(result.optimizedSize)} (${result.reductionPercent}% reduction)\n`);
            successCount++;

        } catch (err) {
            console.log(`  Error: ${err.message}\n`);
            failCount++;
        }
    }

    console.log(`\nOptimization complete: ${successCount} succeeded, ${failCount} failed`);
}

async function convertSingleFile(inputPath, outputPath, settings) {
    // Determine output path
    if (!outputPath) {
        const dir = path.dirname(inputPath);
        outputPath = getOutputPath(inputPath, dir, settings.output.format);
    } else if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
        outputPath = getOutputPath(inputPath, outputPath, settings.output.format);
    } else {
        outputPath = path.resolve(outputPath);
    }

    const filename = path.basename(inputPath);
    console.log(`Converting: ${filename}`);

    // Markdown inputs go through the MD → EPUB stage first; the produced
    // buffer is fed straight into convertEpub without touching disk.
    let convertInput = inputPath;
    if (isMarkdownPath(inputPath)) {
        const { buffer } = await buildEpubFromMarkdownFile(inputPath, {
            markdownOpts: settings.markdown,
            imageOpts: {
                maxImageWidth: settings.optimizer && settings.optimizer.maxImageWidth,
                grayscale: !(settings.optimizer && settings.optimizer.grayscale === false)
            }
        });
        convertInput = buffer;
    }

    const result = await convertEpub(convertInput, outputPath, settings, (current, total) => {
        const percent = Math.round((current / total) * 100);
        process.stdout.write(`\r  Progress: ${current}/${total} pages (${percent}%)`);
    });

    console.log(`\n  Output: ${result.outputPath}`);
    console.log(`  Pages: ${result.pageCount}`);
    console.log(`  Format: ${result.format.toUpperCase()}`);
}

async function convertDirectory(inputDir, outputDir, settings) {
    // Recursively find all EPUB and Markdown files, preserving relative paths
    const files = collectEpubFiles(
        inputDir,
        { recursive: true, include: ['*.epub', '*.md', '*.markdown'] },
        inputDir
    );

    if (files.length === 0) {
        console.error('No EPUB or Markdown files found in directory (searched recursively)');
        process.exit(1);
    }

    // Determine output directory
    if (!outputDir) {
        outputDir = inputDir;
    } else {
        outputDir = path.resolve(outputDir);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
    }

    console.log(`Converting ${files.length} file(s)...\n`);

    const ext = settings.output.format === 'xtch' ? '.xtch' : '.xtc';
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const relNoExt = file.relative.slice(0, -path.extname(file.relative).length);
        const outputPath = path.join(outputDir, relNoExt + ext);

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        console.log(`[${i + 1}/${files.length}] ${file.relative}`);

        try {
            // Markdown files take a detour through md-to-epub before
            // entering the renderer; EPUBs go straight in.
            let convertInput = file.absolute;
            if (isMarkdownPath(file.absolute)) {
                const { buffer } = await buildEpubFromMarkdownFile(file.absolute, {
                    markdownOpts: settings.markdown,
                    imageOpts: {
                        maxImageWidth: settings.optimizer && settings.optimizer.maxImageWidth,
                        grayscale: !(settings.optimizer && settings.optimizer.grayscale === false)
                    }
                });
                convertInput = buffer;
            }

            const result = await convertEpub(convertInput, outputPath, settings, (current, total) => {
                const percent = Math.round((current / total) * 100);
                process.stdout.write(`\r  Progress: ${current}/${total} pages (${percent}%)`);
            });

            console.log(`\n  Output: ${path.relative(outputDir, result.outputPath)}`);
            console.log(`  Pages: ${result.pageCount}\n`);
            successCount++;

        } catch (err) {
            console.log(`\n  Error: ${err.message}\n`);
            failCount++;
        }
    }

    console.log(`\nConversion complete: ${successCount} succeeded, ${failCount} failed`);
}

program
    .command('optimize-md <input>')
    .description('Optimize Markdown file(s) for e-paper rendering (writes optimized .md)')
    .option('-o, --output <path>', 'Output file or directory')
    .option('-c, --config <path>', 'Path to settings JSON file')
    .action(async (input, options) => {
        try {
            const settings = loadSettings(options.config);
            const inputPath = path.resolve(input);

            if (!fs.existsSync(inputPath)) {
                console.error(`Input not found: ${inputPath}`);
                process.exit(1);
            }

            const stat = fs.statSync(inputPath);
            if (stat.isDirectory()) {
                const files = collectEpubFiles(
                    inputPath,
                    { recursive: true, include: ['*.md', '*.markdown'] },
                    inputPath
                );
                if (files.length === 0) {
                    console.error('No Markdown files found in directory');
                    process.exit(1);
                }
                let outputDir = options.output ? path.resolve(options.output) : inputPath;
                if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
                for (const file of files) {
                    const inPlace = !options.output;
                    const ext = path.extname(file.relative);
                    const base = file.relative.slice(0, -ext.length);
                    const outPath = inPlace
                        ? path.join(outputDir, `${base}_optimized${ext}`)
                        : path.join(outputDir, file.relative);
                    fs.mkdirSync(path.dirname(outPath), { recursive: true });
                    optimizeMarkdownFile(file.absolute, outPath, settings.markdown);
                    console.log(`Optimized: ${file.relative}`);
                }
            } else if (stat.isFile() && isMarkdownPath(inputPath)) {
                let outPath = options.output
                    ? path.resolve(options.output)
                    : path.join(
                        path.dirname(inputPath),
                        `${path.basename(inputPath, path.extname(inputPath))}_optimized${path.extname(inputPath)}`
                    );
                if (fs.existsSync(outPath) && fs.statSync(outPath).isDirectory()) {
                    outPath = path.join(outPath, path.basename(inputPath));
                }
                optimizeMarkdownFile(inputPath, outPath, settings.markdown);
                console.log(`Optimized: ${outPath}`);
            } else {
                console.error('Input must be a Markdown (.md/.markdown) file or directory');
                process.exit(1);
            }
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program
    .command('md-to-epub <input>')
    .description('Convert Markdown file(s) to EPUB (intermediate format used by `convert`)')
    .option('-o, --output <path>', 'Output file or directory')
    .option('-c, --config <path>', 'Path to settings JSON file')
    .action(async (input, options) => {
        try {
            const settings = loadSettings(options.config);
            const inputPath = path.resolve(input);

            if (!fs.existsSync(inputPath)) {
                console.error(`Input not found: ${inputPath}`);
                process.exit(1);
            }

            const imageOpts = {
                maxImageWidth: settings.optimizer && settings.optimizer.maxImageWidth,
                grayscale: !(settings.optimizer && settings.optimizer.grayscale === false)
            };

            const stat = fs.statSync(inputPath);
            if (stat.isDirectory()) {
                const files = collectEpubFiles(
                    inputPath,
                    { recursive: true, include: ['*.md', '*.markdown'] },
                    inputPath
                );
                if (files.length === 0) {
                    console.error('No Markdown files found in directory');
                    process.exit(1);
                }
                let outputDir = options.output ? path.resolve(options.output) : inputPath;
                if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
                for (const file of files) {
                    const ext = path.extname(file.relative);
                    const base = file.relative.slice(0, -ext.length);
                    const outPath = path.join(outputDir, base + '.epub');
                    fs.mkdirSync(path.dirname(outPath), { recursive: true });
                    const { buffer } = await buildEpubFromMarkdownFile(file.absolute, {
                        markdownOpts: settings.markdown,
                        imageOpts
                    });
                    fs.writeFileSync(outPath, buffer);
                    console.log(`Wrote: ${path.relative(outputDir, outPath)}`);
                }
            } else if (stat.isFile() && isMarkdownPath(inputPath)) {
                let outPath = options.output
                    ? path.resolve(options.output)
                    : path.join(
                        path.dirname(inputPath),
                        path.basename(inputPath, path.extname(inputPath)) + '.epub'
                    );
                if (fs.existsSync(outPath) && fs.statSync(outPath).isDirectory()) {
                    outPath = path.join(
                        outPath,
                        path.basename(inputPath, path.extname(inputPath)) + '.epub'
                    );
                }
                const { buffer, title, chapters } = await buildEpubFromMarkdownFile(inputPath, {
                    markdownOpts: settings.markdown,
                    imageOpts
                });
                fs.writeFileSync(outPath, buffer);
                console.log(`Wrote: ${outPath}`);
                console.log(`  Title: ${title}`);
                console.log(`  Chapters: ${chapters}`);
            } else {
                console.error('Input must be a Markdown (.md/.markdown) file or directory');
                process.exit(1);
            }
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

/**
 * Optimize a single Markdown file and write the result. Used by `optimize-md`.
 * Preserves frontmatter as a YAML block (if present) so downstream tools
 * still see the metadata.
 */
function optimizeMarkdownFile(inputPath, outputPath, mdOpts) {
    const src = fs.readFileSync(inputPath, 'utf8');
    const result = optimizeMarkdown(src, mdOpts);

    // Re-emit frontmatter when the source had any so users round-tripping
    // the file don't lose metadata.
    let out = result.content;
    const dataKeys = result.data ? Object.keys(result.data) : [];
    if (dataKeys.length > 0) {
        const yaml = dataKeys
            .map(k => `${k}: ${JSON.stringify(result.data[k])}`)
            .join('\n');
        out = `---\n${yaml}\n---\n\n${out}`;
    }
    fs.writeFileSync(outputPath, out);
}

program.parse();
