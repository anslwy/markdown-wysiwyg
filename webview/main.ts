// Webview entry inside VSCode.
import { startEditor } from './mountEditor';
import type { HostApi } from './bridge';

declare function acquireVsCodeApi(): HostApi;

startEditor(acquireVsCodeApi(), document.getElementById('app')!);
