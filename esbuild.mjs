// Builds the extension host bundle. It uses no Node APIs, so the same CommonJS
// file runs in desktop VSCode and in VSCode for the Web (vscode.dev / test-web).
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    format: 'cjs',
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    external: ['vscode'],
    sourcemap: true,
    target: 'es2022',
    logLevel: 'info'
});

if (watch) {
    await ctx.watch();
} else {
    await ctx.rebuild();
    await ctx.dispose();
}
