// Mounts MarkdownEditor and wires it to a host (real VSCode or the dev mock).
import { mount } from 'svelte';
import MarkdownEditor from './MarkdownEditor.svelte';
import { setImageSaver } from './lib/imageStore';
import type { HostApi, HostToWebview } from './bridge';
import './app.css';
import './vscode.css';

type EditorInstance = {
    setSource(markdown: string): void;
    setMode(mode: 'wysiwyg' | 'preview' | 'source'): Promise<void>;
    flush(): void;
};

// Follow VSCode's light/dark theme (body.vscode-light / vscode-dark /
// vscode-high-contrast*) by mapping it onto the editor's data-theme attribute.
function syncTheme() {
    const cls = document.body.classList;
    const light = cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light');
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
}

export function startEditor(host: HostApi, target: HTMLElement) {
    syncTheme();
    new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    const pending = new Map<string, (value: any) => void>();
    const request = <T>(build: (requestId: string) => Parameters<HostApi['postMessage']>[0]): Promise<T> => {
        const requestId = crypto.randomUUID();
        return new Promise<T>((resolve) => {
            pending.set(requestId, resolve);
            host.postMessage(build(requestId));
        });
    };

    setImageSaver(async (dataUrl) => {
        const link = await request<string | null>((requestId) => ({ type: 'saveImage', requestId, dataUrl }));
        if (!link) throw new Error('Image could not be saved');
        return link;
    });

    let editor: EditorInstance | null = null;

    window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
        const msg = event.data;
        switch (msg?.type) {
            case 'init': {
                if (editor) {
                    editor.setSource(msg.text);
                    return;
                }
                target.textContent = '';
                editor = mount(MarkdownEditor, {
                    target,
                    props: {
                        source: msg.text,
                        mode: msg.mode,
                        fontSize: msg.fontSize,
                        onChange: (text: string) => host.postMessage({ type: 'edit', text }),
                        onModeChange: (mode: 'wysiwyg' | 'preview' | 'source') => {
                            if (mode === 'source') host.postMessage({ type: 'openSource' });
                            else host.postMessage({ type: 'mode', mode });
                        },
                        onOpenLink: (href: string) => host.postMessage({ type: 'openLink', href }),
                        onCopyText: (text: string) => host.postMessage({ type: 'copyText', text }),
                        confirmAction: (message: string, confirmLabel: string) =>
                            request<boolean>((requestId) => ({ type: 'confirm', requestId, message, confirmLabel }))
                    }
                }) as unknown as EditorInstance;
                break;
            }
            case 'update':
                editor?.setSource(msg.text);
                break;
            case 'flush':
                editor?.flush();
                break;
            case 'imageSaved':
                pending.get(msg.requestId)?.(msg.link);
                pending.delete(msg.requestId);
                break;
            case 'confirmResult':
                pending.get(msg.requestId)?.(msg.ok);
                pending.delete(msg.requestId);
                break;
        }
    });

    host.postMessage({ type: 'ready' });
}
