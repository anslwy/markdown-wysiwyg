import * as vscode from 'vscode';
import type { HostToWebview, ViewMode, WebviewToHost } from '../webview/bridge';

const VIEW_TYPE = 'markdownWysiwyg.editor';
const MODE_KEY = 'markdownWysiwyg.lastMode';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, new MarkdownEditorProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: true
        }),
        vscode.commands.registerCommand('markdownWysiwyg.openWysiwyg', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
        })
    );
}

export function deactivate() {}

class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        const webview = panel.webview;
        const docFolder = vscode.Uri.joinPath(document.uri, '..');
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;

        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
                workspaceFolder ?? docFolder
            ]
        };
        webview.html = this.getHtml(webview, docFolder);

        const post = (message: HostToWebview) => webview.postMessage(message);

        // Text we wrote ourselves; used to ignore the echo from onDidChangeTextDocument.
        let lastSyncedText = document.getText();
        // Serialize edits so overlapping applyEdit calls never interleave.
        let editQueue: Promise<unknown> = Promise.resolve();

        const applyText = (text: string) => {
            editQueue = editQueue.then(async () => {
                const current = document.getText();
                if (current === text) return;
                lastSyncedText = text;
                const edit = new vscode.WorkspaceEdit();
                const range = changedRange(document, current, text);
                edit.replace(document.uri, range.range, range.text);
                await vscode.workspace.applyEdit(edit);
            });
        };

        const subscriptions: vscode.Disposable[] = [];

        subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() !== document.uri.toString() || e.contentChanges.length === 0) return;
                const text = document.getText();
                if (text === lastSyncedText) return; // our own edit
                lastSyncedText = text;
                post({ type: 'update', text });
            }),
            // Make Cmd/Ctrl+S include edits still sitting in the editor's debounce.
            vscode.workspace.onWillSaveTextDocument((e) => {
                if (e.document.uri.toString() === document.uri.toString()) post({ type: 'flush' });
            })
        );

        webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
            switch (msg.type) {
                case 'ready':
                    post({
                        type: 'init',
                        text: document.getText(),
                        mode: this.context.globalState.get<ViewMode>(MODE_KEY, 'wysiwyg'),
                        fontSize: vscode.workspace.getConfiguration('editor').get<number>('fontSize', 14)
                    });
                    break;
                case 'edit':
                    applyText(msg.text);
                    break;
                case 'mode':
                    await this.context.globalState.update(MODE_KEY, msg.mode);
                    break;
                case 'openSource':
                    await editQueue;
                    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                    break;
                case 'openLink':
                    await this.openLink(msg.href, docFolder);
                    break;
                case 'copyText':
                    await vscode.env.clipboard.writeText(msg.text);
                    break;
                case 'saveImage':
                    post({ type: 'imageSaved', requestId: msg.requestId, link: await this.saveImage(msg.dataUrl, docFolder) });
                    break;
                case 'confirm': {
                    const choice = await vscode.window.showWarningMessage(msg.message, { modal: true }, msg.confirmLabel);
                    post({ type: 'confirmResult', requestId: msg.requestId, ok: choice === msg.confirmLabel });
                    break;
                }
            }
        }, undefined, subscriptions);

        panel.onDidDispose(() => subscriptions.forEach((d) => d.dispose()));
    }

    private async openLink(href: string, docFolder: vscode.Uri) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            await vscode.env.openExternal(vscode.Uri.parse(href));
            return;
        }
        // Relative link: open the file in the workspace.
        const [path] = href.split('#');
        if (!path) return;
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(docFolder, decodeURIComponent(path)));
    }

    // Pasted images become real files in an `images/` folder next to the document.
    private async saveImage(dataUrl: string, docFolder: vscode.Uri): Promise<string | null> {
        const match = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/i.exec(dataUrl);
        if (!match) return null;
        const ext = match[1].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
        const name = `image-${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
        const folder = vscode.Uri.joinPath(docFolder, 'images');
        try {
            await vscode.workspace.fs.createDirectory(folder);
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, name), bytes);
            return `images/${name}`;
        } catch (err) {
            vscode.window.showErrorMessage(`Could not save pasted image: ${err}`);
            return null;
        }
    }

    private getHtml(webview: vscode.Webview, docFolder: vscode.Uri): string {
        const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
        const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'main.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'main.css'));
        // <base> makes relative image paths in the markdown resolve against the document's folder.
        const base = webview.asWebviewUri(docFolder).toString().replace(/\/?$/, '/');
        const nonce = makeNonce();
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https: data: blob:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <base href="${base}">
    <link rel="stylesheet" href="${style}">
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}

// Replace only the span that actually changed, so VSCode's undo stack, dirty
// markers and git gutter reflect the edit instead of a whole-file rewrite.
function changedRange(document: vscode.TextDocument, oldText: string, newText: string) {
    let start = 0;
    const maxStart = Math.min(oldText.length, newText.length);
    while (start < maxStart && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
        oldEnd--;
        newEnd--;
    }
    return {
        range: new vscode.Range(document.positionAt(start), document.positionAt(oldEnd)),
        text: newText.slice(start, newEnd)
    };
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}
