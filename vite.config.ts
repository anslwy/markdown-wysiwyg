// Builds the webview bundle (Svelte editor) loaded by the VSCode custom editor.
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
    plugins: [svelte()],
    build: {
        outDir: 'dist/webview',
        emptyOutDir: true,
        cssCodeSplit: false,
        sourcemap: true,
        lib: {
            entry: 'webview/main.ts',
            formats: ['iife'],
            name: 'MarkdownWysiwyg',
            fileName: () => 'main.js',
            cssFileName: 'main'
        }
    },
    test: {
        environment: 'jsdom',
        include: ['webview/**/*.test.ts']
    }
} as any);
