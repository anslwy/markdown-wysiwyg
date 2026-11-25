// Standalone browser harness: `npm run dev` serves dev/index.html, which mounts
// the same editor with a fake VSCode API for fast browser iteration.
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
    root: 'dev',
    plugins: [svelte()],
    server: { port: 5320, strictPort: true }
});
