// Message protocol between the webview (editor) and the extension host.

export type ViewMode = 'wysiwyg' | 'preview';

export type HostToWebview =
    | { type: 'init'; text: string; mode: ViewMode; fontSize: number }
    | { type: 'update'; text: string }
    | { type: 'imageSaved'; requestId: string; link: string | null }
    | { type: 'confirmResult'; requestId: string; ok: boolean }
    | { type: 'flush' };

export type WebviewToHost =
    | { type: 'ready' }
    | { type: 'edit'; text: string }
    | { type: 'mode'; mode: ViewMode }
    | { type: 'openSource' }
    | { type: 'openLink'; href: string }
    | { type: 'copyText'; text: string }
    | { type: 'saveImage'; requestId: string; dataUrl: string }
    | { type: 'confirm'; requestId: string; message: string; confirmLabel: string };

export interface HostApi {
    postMessage(message: WebviewToHost): void;
    getState<T>(): T | undefined;
    setState<T>(state: T): void;
}
