// Standalone harness: a fake VSCode host backed by the textarea on the right.
import { startEditor } from '../webview/mountEditor';
import type { HostApi, HostToWebview, WebviewToHost } from '../webview/bridge';
import sample from '../sample/README.md?raw';

const sourceEl = document.getElementById('source') as HTMLTextAreaElement;
const logEl = document.getElementById('log')!;
const darkEl = document.getElementById('dark') as HTMLInputElement;

const STORAGE_KEY = 'markdown-wysiwyg-dev-doc';
sourceEl.value = localStorage.getItem(STORAGE_KEY) ?? sample;
let mode: 'wysiwyg' | 'preview' = (localStorage.getItem(STORAGE_KEY + ':mode') as any) || 'wysiwyg';

const toWebview = (msg: HostToWebview) => window.postMessage(msg, '*');
const log = (text: string) => { logEl.textContent = text; };

const host: HostApi = {
    postMessage(msg: WebviewToHost) {
        switch (msg.type) {
            case 'ready':
                toWebview({ type: 'init', text: sourceEl.value, mode, fontSize: 14 });
                break;
            case 'edit':
                sourceEl.value = msg.text;
                localStorage.setItem(STORAGE_KEY, msg.text);
                log(`edit · ${msg.text.length} chars · ${new Date().toLocaleTimeString()}`);
                break;
            case 'mode':
                mode = msg.mode;
                localStorage.setItem(STORAGE_KEY + ':mode', mode);
                log(`mode → ${mode}`);
                break;
            case 'openSource':
                log('openSource → VSCode would reopen this file in the text editor');
                sourceEl.focus();
                break;
            case 'openLink':
                log(`openLink → ${msg.href}`);
                window.open(msg.href, '_blank', 'noopener');
                break;
            case 'copyText':
                log(`copyText → ${msg.text}`);
                void navigator.clipboard?.writeText(msg.text).catch(() => {});
                break;
            case 'saveImage':
                // No file system here: keep the image inline as a data URL.
                toWebview({ type: 'imageSaved', requestId: msg.requestId, link: msg.dataUrl });
                break;
            case 'confirm':
                toWebview({ type: 'confirmResult', requestId: msg.requestId, ok: window.confirm(msg.message) });
                break;
        }
    },
    getState: () => undefined,
    setState: () => {}
};

sourceEl.addEventListener('input', () => {
    localStorage.setItem(STORAGE_KEY, sourceEl.value);
    toWebview({ type: 'update', text: sourceEl.value });
});

darkEl.addEventListener('change', () => {
    document.body.classList.toggle('vscode-dark', darkEl.checked);
    document.body.classList.toggle('vscode-light', !darkEl.checked);
});

startEditor(host, document.getElementById('app')!);
