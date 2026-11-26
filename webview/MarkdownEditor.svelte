<script lang="ts">
    import { tick, onMount, onDestroy, createEventDispatcher } from 'svelte';
    import Tooltip from './lib/Tooltip.svelte';
    import { languageIconSvg } from './lib/languageIcon';
    import { renderMarkdown, renderMarkdownPlain, htmlToMarkdown, removeFencedCodeBlock, wrapImageThumbnails, wrapCodeBlocksWithCopy, highlightCodeBlocks, getCodeBlockLanguage, setCodeBlockLanguage, normalizeCodeLanguage, ensureTrailingEmptyLine, ensureFileMentionCarets, prepareTaskListCheckboxes, isTaskListItem, isEmptyTaskListItem, createTaskCheckbox, ensureTaskCheckbox, ensureTaskItemCaretAnchor, removeTaskCheckbox, inlineCodeSpanHtml, INLINE_CODE_STYLE_MARKER, THUMB_WRAPPER_CLASS, THUMB_DELETE_CLASS, CODE_COPY_WRAPPER_CLASS, CODE_LANGUAGE_INPUT_CLASS, CODE_LANGUAGE_DATALIST_ID, CODE_LANGUAGE_OPTIONS, resolvePastedImages, isUrlLike, normalizeUrl, linkHtml, parsePlaygroundFileId, playgroundFileHref, extractPlaygroundFileId, fileMentionHtml, FILE_MENTION_CLASS } from './lib/markdown';
    import { storePastedImage, deletePastedImage, parsePastedImageLink } from './lib/imageStore';
    import { findLinkHrefAtTarget, clampMenuPosition, copyTextToClipboard } from './lib/linkContextMenu';

    // ===== VSCode port: host-facing API =====================================
    // The playground drives this editor from its file store and tab model. Here
    // there is exactly one document: `source` is its markdown, and every edit is
    // reported through `onChange`. Host-only actions are callbacks.
    type MarkdownViewMode = 'wysiwyg' | 'preview';
    export let source = '';
    export let mode: MarkdownViewMode = 'wysiwyg';
    export let fontSize = 14;
    export let isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
    export let onChange: (markdown: string) => void = () => {};
    export let onModeChange: (mode: MarkdownViewMode | 'source') => void = () => {};
    export let onOpenLink: (href: string) => void = (href) => { window.open(href, '_blank', 'noopener,noreferrer'); };
    export let onCopyText: ((text: string) => void) | undefined = undefined;
    export let confirmAction: (message: string, confirmLabel: string) => Promise<boolean> = async (message) => window.confirm(message);

    /** Replace the document from outside (e.g. the text editor changed it). */
    export function setSource(markdown: string) {
        if (markdown === source) return;
        source = markdown;
        if (previewEditMode && wysiwygEl) {
            if (wysiwygDebounce) {
                clearTimeout(wysiwygDebounce);
                wysiwygDebounce = null;
            }
            renderWysiwygFromStore();
        }
    }

    /** Flush pending WYSIWYG edits (debounced) to `onChange` right away. */
    export function flush() {
        commitWysiwygEdits();
    }

    export async function setMode(next: MarkdownViewMode | 'source') {
        if (next === 'source') {
            commitWysiwygEdits();
            onModeChange('source');
            return;
        }
        mode = next;
        onModeChange(next);
        if (next === 'wysiwyg') await enterPreviewEditMode(true);
        else exitPreviewEditMode();
    }

    // ===== VSCode port: shims for playground state ===========================
    const DOC_ID = 'doc';
    type TabMeta = { fileId: string; fileName: string; isOpen?: boolean; lastUpdated?: number; type?: string; sourceFileId?: string };
    const activeTab: TabMeta = { fileId: 'preview:' + DOC_ID, fileName: '', type: 'preview', sourceFileId: DOC_ID };
    // No workspace file list yet, so @-mentions and in-app file links are inert.
    const tabs: TabMeta[] = [];
    const tabLanguages: Record<string, string> = {};
    const isDesktopMode = false;
    function getLanguageForTab(_fileId: string): string | null { return null; }
    function fileLabelFor(_fileId: string, fallback: string): string { return fallback; }
    function getFilePath(_fileId: string): string { return '/'; }
    function activateTab(_fileId: string) {}
    function uuidv4(): string { return crypto.randomUUID(); }

    function exitPreviewEditMode() {
        if (previewEditMode) {
            commitWysiwygEdits();
            resetWysiwygHistory();
        }
        clearWysiwygFindHighlights();
        wysiwygFindOpen = false;
        previewEditMode = false;
        wysiwygSourceFileId = null;
        showLinkInput = false;
        savedLinkRange = null;
        savedLinkHistoryBefore = null;
        closeMentionPopup();
    }

    $: previewHtml = previewEditMode ? '' : renderMarkdown(source, { imageThumbnails: true });
    let previewEl: HTMLDivElement | null = null;
    // Builds the markdown snippet inserted when an image is pasted into a
    // markdown file. The base64 payload is stored in IndexedDB and the source
    // gets a fake link (wysiwyg://image/<id>) that previews resolve back to
    // the payload (see resolvePastedImages).
    async function markdownImageSnippet(dataUrl: string): Promise<string> {
        const link = await storePastedImage(dataUrl);
        return `![image](${link})`;
    }

    // --- Image lightbox (full-size view opened from thumbnails) ---
    let lightboxSrc: string | null = null;
    function openLightbox(src: string) {
        lightboxSrc = src;
    }
    function closeLightbox() {
        lightboxSrc = null;
    }

    // --- Markdown preview WYSIWYG editing ---
    let previewEditMode = false;
    let wysiwygEl: HTMLDivElement | null = null;
    let wysiwygDebounce: ReturnType<typeof setTimeout> | null = null;
    let wysiwygSourceFileId: string | null = null;
    // Markdown-to-HTML rendering is lossy, so only serialize after a real edit.
    let wysiwygDirty = false;
    let lastActiveTabFileId: string | null = null;
    // Native contenteditable history omits scripted DOM changes and can lose a
    // paste when highlighting replaces code nodes, so keep bounded edit history.
    type WysiwygSelectionPoint = { path: number[]; offset: number };
    type WysiwygSelection = {
        start: WysiwygSelectionPoint;
        end: WysiwygSelectionPoint;
        backward: boolean;
    };
    type WysiwygHistoryState = {
        html: string;
        sourceContent: string | null;
        selection: WysiwygSelection | null;
        activeElementPath: number[] | null;
        sourceFileId: string;
    };
    type WysiwygHistoryEntry = {
        before: WysiwygHistoryState;
        after: WysiwygHistoryState;
        kind: string;
        timestamp: number;
    };
    const WYSIWYG_HISTORY_LIMIT = 100;
    const WYSIWYG_HISTORY_MAX_CHARS = 5 * 1024 * 1024;
    const WYSIWYG_PENDING_IMAGE_ATTR = 'data-wysiwyg-pending-image';
    let wysiwygUndoStack: WysiwygHistoryEntry[] = [];
    let wysiwygRedoStack: WysiwygHistoryEntry[] = [];
    let pendingWysiwygHistory: WysiwygHistoryState | null = null;
    let pendingWysiwygHistoryKind: string | null = null;
    let pendingWysiwygHistoryTimeout: ReturnType<typeof setTimeout> | null = null;
    let applyingWysiwygHistory = false;
    let manualWysiwygHistoryDepth = 0;
    const wysiwygTrackedImageLinks = new Set<string>();
    let showLinkInput = false;
    let linkUrl = '';
    let linkInputEl: HTMLInputElement | null = null;
    let savedLinkRange: Range | null = null;
    let savedLinkHistoryBefore: WysiwygHistoryState | null = null;

    // --- WYSIWYG find in current document (Cmd/Ctrl+F) ---
    let wysiwygFindOpen = false;
    let wysiwygFindQuery = '';
    let wysiwygFindCaseSensitive = false;
    let wysiwygFindRegex = false;
    let wysiwygFindWholeWord = false;
    let wysiwygFindMatches: HTMLElement[] = [];
    let wysiwygFindActiveIndex = -1;
    let wysiwygFindInputEl: HTMLInputElement | null = null;
    let applyingWysiwygFind = false;
    const WYSIWYG_FIND_MARK_CLASS = 'wysiwyg-find-match';
    const WYSIWYG_FIND_ACTIVE_CLASS = 'wysiwyg-find-active';

    // @-mention file picker in the WYSIWYG editor
    let showMentionPopup = false;
    let mentionQuery = '';
    let mentionSelectedIndex = 0;
    let savedMentionRange: Range | null = null;
    let mentionPopupStyle = '';
    let mentionResultsEl: HTMLDivElement | null = null;

    $: mentionFilteredFiles = (() => {
        const currentFileId =
            wysiwygSourceFileId ??
            (activeTab?.type === 'preview' ? activeTab.sourceFileId : activeTab?.fileId) ??
            null;
        const files = tabs.filter((t) => t.type !== 'preview' && t.fileId !== currentFileId);
        return mentionQuery
            ? files.filter((t) => t.fileName.toLowerCase().includes(mentionQuery.toLowerCase()))
            : files.slice().sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
    })();

    $: if (mentionQuery !== undefined) mentionSelectedIndex = 0;

    function getPreviewSourceContent(sourceFileId: string): string {
        return sourceFileId === DOC_ID ? source : '';
    }

    function renderWysiwygFromStore() {
        if (!wysiwygEl || !wysiwygSourceFileId) return;
        wysiwygEl.innerHTML = renderMarkdownPlain(getPreviewSourceContent(wysiwygSourceFileId), {
            resolveFileLanguage: (fileId) => getLanguageForTab(fileId)
        });
        wrapImageThumbnails(wysiwygEl);
        wrapCodeBlocksWithCopy(wysiwygEl);
        ensureFileMentionCarets(wysiwygEl);
        prepareTaskListCheckboxes(wysiwygEl);
        ensureTrailingEmptyLine(wysiwygEl);
        resolvePastedImages(wysiwygEl);
        wysiwygDirty = false;
        resetWysiwygHistory();
        if (wysiwygFindOpen) {
            // Re-apply find highlights after a full re-render (e.g. file switch)
            tick().then(() => updateWysiwygFindHighlights());
        }
    }

    function clearWysiwygFindHighlights() {
        try {
            (CSS as any).highlights?.delete?.('wysiwyg-find');
            (CSS as any).highlights?.delete?.('wysiwyg-find-active');
        } catch {}
        if (!wysiwygEl) {
            wysiwygFindMatches = [];
            wysiwygFindActiveIndex = -1;
            return;
        }
        applyingWysiwygFind = true;
        try {
            const marks = Array.from(wysiwygEl.querySelectorAll(`.${WYSIWYG_FIND_MARK_CLASS}, mark[data-find-mark]`));
            for (const mark of marks) {
                const parent = mark.parentNode;
                if (!parent) continue;
                while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
                parent.removeChild(mark);
            }
            if (marks.length) wysiwygEl.normalize();
        } finally {
            applyingWysiwygFind = false;
        }
        wysiwygFindMatches = [];
        wysiwygFindActiveIndex = -1;
    }

    function getWysiwygFindRegExp(): RegExp | null {
        if (!wysiwygFindQuery) return null;
        try {
            if (wysiwygFindRegex) {
                return new RegExp(wysiwygFindQuery, wysiwygFindCaseSensitive ? 'g' : 'gi');
            }
            const escaped = wysiwygFindQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = wysiwygFindWholeWord ? `\\b${escaped}\\b` : escaped;
            return new RegExp(pattern, wysiwygFindCaseSensitive ? 'g' : 'gi');
        } catch {
            return null;
        }
    }

    function updateWysiwygFindHighlights(keepActive = false) {
        if (!wysiwygEl || !wysiwygFindOpen) return;
        const prevActive = keepActive ? wysiwygFindActiveIndex : 0;
        clearWysiwygFindHighlights();
        const query = wysiwygFindQuery;
        if (!query) return;
        const pattern = getWysiwygFindRegExp();
        if (!pattern) return;

        const walker = document.createTreeWalker(wysiwygEl, NodeFilter.SHOW_TEXT, {
            acceptNode: (node: Node) => {
                const parent = (node as Text).parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (parent.closest(`.${CODE_COPY_WRAPPER_CLASS} .code-block-actions`)) return NodeFilter.FILTER_REJECT;
                if (parent.closest(`.${WYSIWYG_FIND_MARK_CLASS}`)) return NodeFilter.FILTER_REJECT;
                if (parent.tagName === 'BUTTON' || parent.closest(`.${THUMB_WRAPPER_CLASS}`)) return NodeFilter.FILTER_REJECT;
                const text = node.textContent || '';
                if (!text) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const textNodes: Text[] = [];
        let n: Node | null;
        while ((n = walker.nextNode())) textNodes.push(n as Text);

        type Match = { node: Text; start: number; length: number };
        const allMatches: Match[] = [];
        for (const textNode of textNodes) {
            const text = textNode.textContent || '';
            const re = new RegExp(pattern.source, pattern.flags);
            let m: RegExpExecArray | null;
            while ((m = re.exec(text))) {
                if (m[0].length === 0) {
                    re.lastIndex++;
                    continue;
                }
                allMatches.push({ node: textNode, start: m.index, length: m[0].length });
                if (m.index === re.lastIndex) re.lastIndex++;
            }
        }

        applyingWysiwygFind = true;
        const marks: HTMLElement[] = [];
        try {
            const byNode = new Map<Text, Match[]>();
            for (const match of allMatches) {
                const list = byNode.get(match.node) ?? [];
                list.push(match);
                byNode.set(match.node, list);
            }
            for (const [node, matches] of byNode) {
                matches.sort((a, b) => b.start - a.start);
                for (const match of matches) {
                    const range = document.createRange();
                    try {
                        range.setStart(node, match.start);
                        range.setEnd(node, match.start + match.length);
                        const mark = document.createElement('mark');
                        mark.className = WYSIWYG_FIND_MARK_CLASS;
                        mark.dataset.findMark = '1';
                        range.surroundContents(mark);
                        marks.push(mark);
                    } catch {}
                }
            }
        } finally {
            applyingWysiwygFind = false;
        }

        marks.sort((a, b) => {
            const pos = a.compareDocumentPosition(b);
            return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        wysiwygFindMatches = marks;
        if (marks.length) {
            setWysiwygFindActive(Math.min(Math.max(prevActive, 0), marks.length - 1));
        }
    }

    function setWysiwygFindActive(index: number) {
        if (!wysiwygEl || wysiwygFindMatches.length === 0) {
            wysiwygFindActiveIndex = -1;
            return;
        }
        const clamped = ((index % wysiwygFindMatches.length) + wysiwygFindMatches.length) % wysiwygFindMatches.length;
        wysiwygFindActiveIndex = clamped;
        wysiwygFindMatches.forEach((m, i) => m.classList.toggle(WYSIWYG_FIND_ACTIVE_CLASS, i === clamped));
        const active = wysiwygFindMatches[clamped];
        if (active) {
            active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }

    function nextWysiwygFindMatch(delta = 1) {
        if (wysiwygFindMatches.length === 0) return;
        setWysiwygFindActive(wysiwygFindActiveIndex + delta);
    }

    function openWysiwygFind() {
        if (!wysiwygEl || !previewEditMode) return;
        const sel = window.getSelection();
        let initial = '';
        if (sel && !sel.isCollapsed && wysiwygEl.contains(sel.anchorNode) && wysiwygEl.contains(sel.focusNode)) {
            initial = sel.toString().slice(0, 120);
        }
        const wasOpen = wysiwygFindOpen;
        wysiwygFindOpen = true;
        if (initial && !wasOpen) wysiwygFindQuery = initial;
        tick().then(() => {
            wysiwygFindInputEl?.focus();
            wysiwygFindInputEl?.select();
            updateWysiwygFindHighlights();
        });
    }

    function closeWysiwygFind() {
        const wasOpen = wysiwygFindOpen;
        wysiwygFindOpen = false;
        clearWysiwygFindHighlights();
        if (wasOpen) wysiwygEl?.focus({ preventScroll: true });
    }

    function handleWysiwygFindInputKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) nextWysiwygFindMatch(-1);
            else nextWysiwygFindMatch(1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeWysiwygFind();
        }
    }

    $: if (!previewEditMode && wysiwygFindOpen) closeWysiwygFind();

    async function enterPreviewEditMode(force = false) {
        const sourceFileId = activeTab?.type === 'preview' ? activeTab.sourceFileId : null;
        if (!sourceFileId) return;
        if (!force && previewEditMode && wysiwygSourceFileId === sourceFileId && wysiwygEl) {
            return;
        }
        wysiwygSourceFileId = sourceFileId;
        previewEditMode = true;
        await tick();
        if (
            wysiwygEl &&
            wysiwygSourceFileId === sourceFileId &&
            activeTab?.type === 'preview' &&
            activeTab.sourceFileId === sourceFileId
        ) {
            renderWysiwygFromStore();
            wysiwygEl.focus();
        }
    }

    async function togglePreviewEditMode() {
        if (previewEditMode) {
            exitPreviewEditMode();
            return;
        }
        await enterPreviewEditMode(true);
    }

    let activeLangPicker: {
        wrapper: HTMLElement;
        button: HTMLElement;
        currentLang: string;
        rect: DOMRect;
        historyBefore: WysiwygHistoryState | null;
    } | null = null;
    let langSearchQuery = '';
    let langSearchInputEl: HTMLInputElement | null = null;
    let langPickerListEl: HTMLElement | null = null;
    let langSelectedIndex = 0;

    $: filteredLanguages = CODE_LANGUAGE_OPTIONS.filter((opt) => {
        if (!langSearchQuery.trim()) return true;
        const q = langSearchQuery.trim().toLowerCase();
        return opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q);
    });

    $: if (filteredLanguages) {
        if (filteredLanguages.length === 0) {
            if (langSelectedIndex !== 0) langSelectedIndex = 0;
        } else if (langSelectedIndex >= filteredLanguages.length) {
            langSelectedIndex = filteredLanguages.length - 1;
        } else if (langSelectedIndex < 0) {
            langSelectedIndex = 0;
        }
    }

    function scrollLangSelectedIntoView() {
        tick().then(() => {
            const el = langPickerListEl?.querySelector('.lang-picker-option.focused') as HTMLElement | null;
            el?.scrollIntoView({ block: 'nearest' });
        });
    }

    function openLangPicker(btn: HTMLElement, wrapper: HTMLElement) {
        const pre = wrapper.querySelector('pre');
        const currentLang = pre ? getCodeBlockLanguage(pre) : (wrapper.dataset.language || '');
        const rect = btn.getBoundingClientRect();
        langSearchQuery = '';
        const initialFiltered = CODE_LANGUAGE_OPTIONS;
        const normalizedCurrent = normalizeCodeLanguage(currentLang);
        const currentIdx = initialFiltered.findIndex((opt) => normalizeCodeLanguage(opt.value) === normalizedCurrent);
        langSelectedIndex = currentIdx >= 0 ? currentIdx : 0;
        activeLangPicker = { wrapper, button: btn, currentLang, rect, historyBefore: captureWysiwygHistoryState() };
        wrapper.classList.add('lang-picker-active');
        setTimeout(() => {
            if (langSearchInputEl) langSearchInputEl.focus();
            scrollLangSelectedIntoView();
        }, 20);
    }

    function closeLangPicker() {
        if (activeLangPicker) {
            activeLangPicker.wrapper.classList.remove('lang-picker-active');
            activeLangPicker = null;
        }
    }

    function selectCodeLanguage(langValue: string) {
        if (!activeLangPicker) return;
        const { wrapper, historyBefore } = activeLangPicker;
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        const elTop = wysiwygEl?.scrollTop ?? 0;
        const elLeft = wysiwygEl?.scrollLeft ?? 0;
        if (historyBefore && wysiwygEl) {
            wysiwygEl.focus({ preventScroll: true });
            restoreWysiwygSelection(historyBefore);
        }
        setCodeBlockLanguage(wrapper, langValue);
        closeLangPicker();
        // Keep the action bar visible for a moment after picking a language so
        // the user can see the result, then fade back to hover-only.
        wrapper.classList.add('lang-picker-active');
        setTimeout(() => {
            if (wrapper.isConnected) wrapper.classList.remove('lang-picker-active');
        }, 2500);
        handleWysiwygInput();
        finishWysiwygHistoryEntry(historyBefore);
        wysiwygEl?.focus({ preventScroll: true });
        if (wysiwygEl) {
            wysiwygEl.scrollTop = elTop;
            wysiwygEl.scrollLeft = elLeft;
        }
        window.scrollTo(scrollX, scrollY);
    }

    function handleLangSearchKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeLangPicker();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (filteredLanguages.length > 0) {
                langSelectedIndex = (langSelectedIndex + 1) % filteredLanguages.length;
                scrollLangSelectedIntoView();
            } else if (langSearchQuery.trim()) {
                // single custom option, keep at 0
                langSelectedIndex = 0;
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (filteredLanguages.length > 0) {
                langSelectedIndex = (langSelectedIndex - 1 + filteredLanguages.length) % filteredLanguages.length;
                scrollLangSelectedIntoView();
            } else if (langSearchQuery.trim()) {
                langSelectedIndex = 0;
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (filteredLanguages.length > 0) {
                const idx = Math.min(Math.max(0, langSelectedIndex), filteredLanguages.length - 1);
                selectCodeLanguage(filteredLanguages[idx].value);
            } else if (langSearchQuery.trim()) {
                selectCodeLanguage(langSearchQuery.trim());
            }
        }
    }

    function getWysiwygNodePath(root: Node, node: Node): number[] | null {
        const path: number[] = [];
        let current: Node | null = node;
        while (current && current !== root) {
            const parent: Node | null = current.parentNode;
            if (!parent) return null;
            const index = Array.prototype.indexOf.call(parent.childNodes, current);
            if (index < 0) return null;
            path.unshift(index);
            current = parent;
        }
        return current === root ? path : null;
    }

    function getWysiwygNodeAtPath(root: Node, path: number[]): Node | null {
        let node = root;
        for (const index of path) {
            const child = node.childNodes[index];
            if (!child) return null;
            node = child;
        }
        return node;
    }

    function getWysiwygSnapshotHtml(): string | null {
        if (!wysiwygEl) return null;
        const snapshotRoot = wysiwygEl.cloneNode(true) as HTMLElement;
        snapshotRoot.querySelectorAll('img[data-wysiwyg-img]').forEach((image) => {
            const fakeLink = image.getAttribute('data-wysiwyg-img');
            if (fakeLink) image.setAttribute('src', fakeLink);
            image.removeAttribute('data-wysiwyg-img');
        });
        snapshotRoot.querySelectorAll('.code-block-actions').forEach((element) => element.remove());
        snapshotRoot.querySelectorAll('.lang-picker-active').forEach((element) => {
            element.classList.remove('lang-picker-active');
        });
        snapshotRoot.querySelectorAll(`.${WYSIWYG_FIND_MARK_CLASS}`).forEach((mark) => {
            const parent = mark.parentNode;
            if (!parent) return;
            while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
            parent.removeChild(mark);
            if ((parent as HTMLElement).normalize) (parent as HTMLElement).normalize();
        });
        return snapshotRoot.innerHTML;
    }

    function captureWysiwygHistoryState(): WysiwygHistoryState | null {
        if (!wysiwygEl || !wysiwygSourceFileId) return null;
        const html = getWysiwygSnapshotHtml();
        if (html === null) return null;
        let selection: WysiwygSelection | null = null;
        const browserSelection = window.getSelection();
        if (browserSelection && browserSelection.rangeCount > 0) {
            const range = browserSelection.getRangeAt(0);
            const startPath = getWysiwygNodePath(wysiwygEl, range.startContainer);
            const endPath = getWysiwygNodePath(wysiwygEl, range.endContainer);
            if (startPath && endPath) {
                let backward = false;
                if (!browserSelection.isCollapsed && browserSelection.anchorNode && browserSelection.focusNode) {
                    if (browserSelection.anchorNode === browserSelection.focusNode) {
                        backward = browserSelection.anchorOffset > browserSelection.focusOffset;
                    } else {
                        const directionRange = document.createRange();
                        directionRange.setStart(browserSelection.anchorNode, browserSelection.anchorOffset);
                        directionRange.setEnd(browserSelection.focusNode, browserSelection.focusOffset);
                        backward = directionRange.collapsed;
                    }
                }
                selection = {
                    start: { path: startPath, offset: range.startOffset },
                    end: { path: endPath, offset: range.endOffset },
                    backward
                };
            }
        }
        const activeElement = document.activeElement;
        const activeElementPath = activeElement instanceof HTMLElement && wysiwygEl.contains(activeElement)
            ? getWysiwygNodePath(wysiwygEl, activeElement)
            : null;
        return {
            html,
            sourceContent: wysiwygDirty ? null : getPreviewSourceContent(wysiwygSourceFileId),
            selection,
            activeElementPath,
            sourceFileId: wysiwygSourceFileId
        };
    }

    function restoreWysiwygSelection(state: WysiwygHistoryState): boolean {
        if (!wysiwygEl || !state.selection) return false;
        const startNode = getWysiwygNodeAtPath(wysiwygEl, state.selection.start.path);
        const endNode = getWysiwygNodeAtPath(wysiwygEl, state.selection.end.path);
        if (!startNode || !endNode) return false;
        const maxOffset = (node: Node) => node.nodeType === Node.TEXT_NODE
            ? node.textContent?.length ?? 0
            : node.childNodes.length;
        const startOffset = Math.min(state.selection.start.offset, maxOffset(startNode));
        const endOffset = Math.min(state.selection.end.offset, maxOffset(endNode));
        const range = document.createRange();
        try {
            range.setStart(startNode, startOffset);
            range.setEnd(endNode, endOffset);
        } catch {
            return false;
        }
        const selection = window.getSelection();
        if (!selection) return false;
        selection.removeAllRanges();
        if (state.selection.backward && typeof selection.setBaseAndExtent === 'function') {
            selection.setBaseAndExtent(endNode, endOffset, startNode, startOffset);
        } else {
            selection.addRange(range);
        }
        return true;
    }

    function restoreWysiwygFocus(state: WysiwygHistoryState) {
        if (!wysiwygEl) return;
        const activeNode = state.activeElementPath !== null
            ? getWysiwygNodeAtPath(wysiwygEl, state.activeElementPath)
            : null;
        if (activeNode instanceof HTMLElement && (activeNode === wysiwygEl || wysiwygEl.contains(activeNode))) {
            (activeNode as HTMLElement).focus({ preventScroll: true } as FocusOptions);
        } else {
            wysiwygEl.focus({ preventScroll: true });
        }
    }

    function resetWysiwygHistory() {
        if (pendingWysiwygHistoryTimeout) clearTimeout(pendingWysiwygHistoryTimeout);
        pendingWysiwygHistoryTimeout = null;
        pendingWysiwygHistory = null;
        pendingWysiwygHistoryKind = null;
        showLinkInput = false;
        linkUrl = '';
        savedLinkRange = null;
        savedLinkHistoryBefore = null;
        closeLangPicker();
        wysiwygUndoStack = [];
        wysiwygRedoStack = [];
        cleanupWysiwygHistoryImages(true);
    }

    function sameWysiwygSelection(a: WysiwygSelection | null, b: WysiwygSelection | null): boolean {
        if (!a || !b) return a === b;
        const samePoint = (left: WysiwygSelectionPoint, right: WysiwygSelectionPoint) =>
            left.offset === right.offset &&
            left.path.length === right.path.length &&
            left.path.every((value, index) => value === right.path[index]);
        return a.backward === b.backward && samePoint(a.start, b.start) && samePoint(a.end, b.end);
    }

    function wysiwygHistoryMergeGroup(kind: string): string | null {
        if (kind === 'insertText' || kind === 'insertCompositionText') return 'insertText';
        if (kind === 'deleteContentBackward' || kind === 'deleteWordBackward') return 'deleteBackward';
        if (kind === 'deleteContentForward' || kind === 'deleteWordForward') return 'deleteForward';
        return null;
    }

    function wysiwygHistoryStateChars(state: WysiwygHistoryState): number {
        return state.html.length + (state.sourceContent?.length ?? 0);
    }

    function wysiwygHistoryReferencesImage(link: string): boolean {
        if (wysiwygEl?.innerHTML.includes(link)) return true;
        if (source.includes(link)) return true;
        return [...wysiwygUndoStack, ...wysiwygRedoStack].some((entry) =>
            entry.before.html.includes(link) || entry.after.html.includes(link) ||
            entry.before.sourceContent?.includes(link) || entry.after.sourceContent?.includes(link)
        );
    }

    function wysiwygHistoryStateImageLinks(state: WysiwygHistoryState): Set<string> {
        const root = document.createElement('div');
        root.innerHTML = state.html;
        const links = new Set<string>();
        root.querySelectorAll('img').forEach((image) => {
            const link = image.getAttribute('data-wysiwyg-img') || image.getAttribute('src') || '';
            if (parsePastedImageLink(link)) links.add(link);
        });
        return links;
    }

    function trackRemovedWysiwygImages(before: WysiwygHistoryState, after: WysiwygHistoryState) {
        if (!before.html.includes('wysiwyg://image/')) return;
        const afterLinks = wysiwygHistoryStateImageLinks(after);
        for (const link of wysiwygHistoryStateImageLinks(before)) {
            if (!afterLinks.has(link)) wysiwygTrackedImageLinks.add(link);
        }
    }

    function cleanupWysiwygHistoryImages(finalize = false) {
        for (const link of wysiwygTrackedImageLinks) {
            const referenced = wysiwygHistoryReferencesImage(link);
            if (!referenced) void deletePastedImage(link);
            if (finalize || !referenced) wysiwygTrackedImageLinks.delete(link);
        }
    }

    function findPendingWysiwygImage(root: HTMLElement, token: string): HTMLElement | null {
        return Array.from(root.querySelectorAll<HTMLElement>(`[${WYSIWYG_PENDING_IMAGE_ATTR}]`))
            .find((element) => element.getAttribute(WYSIWYG_PENDING_IMAGE_ATTR) === token) ?? null;
    }

    function replacePendingWysiwygImage(root: HTMLElement, token: string, link: string | null): boolean {
        const placeholder = findPendingWysiwygImage(root, token);
        if (!placeholder) return false;
        if (link) {
            const image = document.createElement('img');
            image.src = link;
            image.alt = '';
            placeholder.replaceWith(image);
            wrapImageThumbnails(root);
        } else {
            placeholder.removeAttribute(WYSIWYG_PENDING_IMAGE_ATTR);
            placeholder.removeAttribute('contenteditable');
        }
        return true;
    }

    function replacePendingWysiwygImageInState(
        state: WysiwygHistoryState,
        token: string,
        link: string | null
    ): boolean {
        const root = document.createElement('div');
        root.innerHTML = state.html;
        const previous = link ? { ...state } : null;
        if (!replacePendingWysiwygImage(root, token, link)) return false;
        state.html = root.innerHTML;
        if (link && state.sourceContent !== null) state.sourceContent = htmlToMarkdown(state.html);
        if (previous) trackRemovedWysiwygImages(previous, state);
        return true;
    }

    function settlePendingWysiwygImage(
        token: string,
        sourceFileId: string,
        link: string | null
    ) {
        let referenced = false;
        for (const entry of [...wysiwygUndoStack, ...wysiwygRedoStack]) {
            referenced = replacePendingWysiwygImageInState(entry.before, token, link) || referenced;
            referenced = replacePendingWysiwygImageInState(entry.after, token, link) || referenced;
        }
        if (pendingWysiwygHistory) {
            referenced = replacePendingWysiwygImageInState(pendingWysiwygHistory, token, link) || referenced;
        }
        if (savedLinkHistoryBefore) {
            referenced = replacePendingWysiwygImageInState(savedLinkHistoryBefore, token, link) || referenced;
        }
        if (activeLangPicker?.historyBefore) {
            referenced = replacePendingWysiwygImageInState(activeLangPicker.historyBefore, token, link) || referenced;
        }

        const currentBefore = link ? captureWysiwygHistoryState() : null;
        if (
            previewEditMode &&
            wysiwygSourceFileId === sourceFileId &&
            wysiwygEl &&
            replacePendingWysiwygImage(wysiwygEl, token, link)
        ) {
            referenced = true;
            ensureTrailingEmptyLine(wysiwygEl);
            if (link) {
                const currentAfter = captureWysiwygHistoryState();
                if (currentBefore && currentAfter) trackRemovedWysiwygImages(currentBefore, currentAfter);
                wysiwygDirty = true;
                void resolvePastedImages(wysiwygEl);
                commitWysiwygEdits();
            }
        }

        if (!link) {
            wysiwygUndoStack = wysiwygUndoStack.filter((entry) => entry.before.html !== entry.after.html);
            wysiwygRedoStack = wysiwygRedoStack.filter((entry) => entry.before.html !== entry.after.html);
            return;
        }
        if (referenced) {
            wysiwygTrackedImageLinks.add(link);
            cleanupWysiwygHistoryImages();
        } else {
            void deletePastedImage(link);
        }
    }

    function trimWysiwygHistory() {
        let chars = wysiwygUndoStack.reduce(
            (total, entry) => total + wysiwygHistoryStateChars(entry.before) + wysiwygHistoryStateChars(entry.after),
            0
        );
        while (wysiwygUndoStack.length > WYSIWYG_HISTORY_LIMIT || chars > WYSIWYG_HISTORY_MAX_CHARS) {
            const removed = wysiwygUndoStack.shift();
            if (!removed) break;
            chars -= wysiwygHistoryStateChars(removed.before) + wysiwygHistoryStateChars(removed.after);
        }
        cleanupWysiwygHistoryImages();
    }

    function finishWysiwygHistoryEntry(
        before: WysiwygHistoryState | null,
        kind = 'command',
        after = captureWysiwygHistoryState()
    ) {
        if (!before || applyingWysiwygHistory || before.sourceFileId !== wysiwygSourceFileId) return;
        if (!after || before.html === after.html) return;
        if (savedLinkHistoryBefore && before !== savedLinkHistoryBefore) {
            showLinkInput = false;
            linkUrl = '';
            savedLinkRange = null;
            savedLinkHistoryBefore = null;
        }
        if (activeLangPicker?.historyBefore && before !== activeLangPicker.historyBefore) closeLangPicker();
        trackRemovedWysiwygImages(before, after);
        const timestamp = Date.now();
        const previous = wysiwygUndoStack[wysiwygUndoStack.length - 1];
        const mergeGroup = wysiwygHistoryMergeGroup(kind);
        if (
            mergeGroup &&
            previous &&
            wysiwygHistoryMergeGroup(previous.kind) === mergeGroup &&
            timestamp - previous.timestamp < 1500 &&
            previous.after.html === before.html &&
            sameWysiwygSelection(previous.after.selection, before.selection)
        ) {
            previous.after = after;
            previous.timestamp = timestamp;
        } else {
            wysiwygUndoStack.push({ before, after, kind, timestamp });
        }
        trimWysiwygHistory();
        if (wysiwygRedoStack.length > 0) {
            wysiwygRedoStack = [];
            cleanupWysiwygHistoryImages();
        }
    }

    function runWysiwygHistoryTransaction<T>(
        edit: () => T,
        before = captureWysiwygHistoryState(),
        kind = 'command'
    ): T {
        manualWysiwygHistoryDepth++;
        try {
            return edit();
        } finally {
            manualWysiwygHistoryDepth--;
            finishWysiwygHistoryEntry(before, kind);
        }
    }

    function queueWysiwygHistoryEntry(before: WysiwygHistoryState | null, kind: string) {
        if (!before || applyingWysiwygHistory) return;
        if (pendingWysiwygHistoryTimeout) clearTimeout(pendingWysiwygHistoryTimeout);
        pendingWysiwygHistory = before;
        pendingWysiwygHistoryKind = kind;
        pendingWysiwygHistoryTimeout = setTimeout(() => {
            if (pendingWysiwygHistory === before) {
                pendingWysiwygHistory = null;
                pendingWysiwygHistoryKind = null;
            }
            pendingWysiwygHistoryTimeout = null;
        }, 0);
    }

    function handleWysiwygBeforeInput(event: InputEvent) {
        if (applyingWysiwygFind) return;
        if (manualWysiwygHistoryDepth > 0) return;
        if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
            event.preventDefault();
            if (event.inputType === 'historyUndo') undoWysiwygHistory();
            else redoWysiwygHistory();
            return;
        }
        if (!pendingWysiwygHistory) {
            queueWysiwygHistoryEntry(captureWysiwygHistoryState(), event.inputType || 'input');
        }
        if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
            exitInlineCodeAtEnd();
        }
    }

    function wysiwygHistoryStateMatches(state: WysiwygHistoryState): boolean {
        return !!wysiwygEl &&
            state.sourceFileId === wysiwygSourceFileId &&
            getWysiwygSnapshotHtml() === state.html;
    }

    function applyWysiwygHistoryState(state: WysiwygHistoryState): boolean {
        if (!wysiwygEl || state.sourceFileId !== wysiwygSourceFileId) return false;
        applyingWysiwygHistory = true;
        const prevScrollTop = wysiwygEl.scrollTop;
        const prevScrollLeft = wysiwygEl.scrollLeft;
        const winX = window.scrollX;
        const winY = window.scrollY;
        try {
            if (pendingWysiwygHistoryTimeout) clearTimeout(pendingWysiwygHistoryTimeout);
            pendingWysiwygHistoryTimeout = null;
            pendingWysiwygHistory = null;
            pendingWysiwygHistoryKind = null;
            closeMentionPopup();
            closeLangPicker();
            showLinkInput = false;
            linkUrl = '';
            savedLinkRange = null;
            savedLinkHistoryBefore = null;
            wysiwygEl.innerHTML = state.html;
            wrapCodeBlocksWithCopy(wysiwygEl);
            wysiwygDirty = true;
            restoreWysiwygSelection(state);
            restoreWysiwygFocus(state);
            commitWysiwygEdits(state.sourceContent ?? undefined);
            restoreWysiwygSelection(state);
            restoreWysiwygFocus(state);
            void resolvePastedImages(wysiwygEl);
            return true;
        } finally {
            applyingWysiwygHistory = false;
            // innerHTML replacement resets scroll to 0; restore previous
            // viewport so undo/redo doesn't jump to top.
            if (wysiwygEl) {
                wysiwygEl.scrollTop = prevScrollTop;
                wysiwygEl.scrollLeft = prevScrollLeft;
                if (window.scrollX !== winX || window.scrollY !== winY) window.scrollTo(winX, winY);
            }
        }
    }

    function undoWysiwygHistory(): boolean {
        const entry = wysiwygUndoStack[wysiwygUndoStack.length - 1];
        if (!entry || !wysiwygHistoryStateMatches(entry.after)) return false;
        if (!applyWysiwygHistoryState(entry.before)) return false;
        wysiwygUndoStack.pop();
        wysiwygRedoStack.push(entry);
        return true;
    }

    function redoWysiwygHistory(): boolean {
        const entry = wysiwygRedoStack[wysiwygRedoStack.length - 1];
        if (!entry || !wysiwygHistoryStateMatches(entry.before)) return false;
        if (!applyWysiwygHistoryState(entry.after)) return false;
        wysiwygRedoStack.pop();
        wysiwygUndoStack.push(entry);
        return true;
    }

    function handleWysiwygInput(event?: Event) {
        if (applyingWysiwygFind) return;
        const target = event?.target;
        if (target instanceof HTMLInputElement && target.type === 'checkbox') {
            if (pendingWysiwygHistoryTimeout) clearTimeout(pendingWysiwygHistoryTimeout);
            pendingWysiwygHistoryTimeout = null;
            pendingWysiwygHistory = null;
            pendingWysiwygHistoryKind = null;
            return;
        }
        const historyBefore = pendingWysiwygHistory;
        const historyKind = pendingWysiwygHistoryKind ?? 'input';
        if (historyBefore) {
            pendingWysiwygHistory = null;
            pendingWysiwygHistoryKind = null;
            if (pendingWysiwygHistoryTimeout) clearTimeout(pendingWysiwygHistoryTimeout);
            pendingWysiwygHistoryTimeout = null;
        }
        if (!applyingWysiwygHistory && wysiwygRedoStack.length > 0) {
            wysiwygRedoStack = [];
            cleanupWysiwygHistoryImages();
        }
        if (target instanceof HTMLInputElement && target.classList.contains(CODE_LANGUAGE_INPUT_CLASS)) {
            const wrapper = target.closest(`.${CODE_COPY_WRAPPER_CLASS}`) as HTMLElement | null;
            if (wrapper) setCodeBlockLanguage(wrapper, target.value);
        }
        wysiwygDirty = true;
        removeOrphanCodeWrappers();
        healTaskListStructure();
        if (wysiwygEl?.querySelector('li input[type="checkbox"][disabled]')) {
            prepareTaskListCheckboxes(wysiwygEl);
        }
        maybeAutoInsertHorizontalRule();
        maybeAutoInsertCodeBlock();
        const beforeInlineCode = historyBefore ? captureWysiwygHistoryState() : null;
        const autoClosedInlineCode = maybeAutoCloseInlineCode();
        rehighlightWysiwygCodeBlocks();
        updateMentionPopup();
        if (autoClosedInlineCode && beforeInlineCode) {
            finishWysiwygHistoryEntry(historyBefore, historyKind, beforeInlineCode);
            finishWysiwygHistoryEntry(beforeInlineCode, 'inlineCode');
        } else {
            finishWysiwygHistoryEntry(historyBefore, historyKind);
        }
        if (wysiwygFindOpen) {
            // Keep find highlights in sync with the latest content, but don't
            // include the marks themselves in history.
            tick().then(() => updateWysiwygFindHighlights(true));
        }
        if (wysiwygDebounce) clearTimeout(wysiwygDebounce);
        const sourceFileId = wysiwygSourceFileId;
        wysiwygDebounce = setTimeout(() => {
            if (wysiwygSourceFileId === sourceFileId) commitWysiwygEdits();
        }, 300);
    }

    let applyingHorizontalRule = false;
    function maybeAutoInsertHorizontalRule() {
        if (applyingHorizontalRule || !wysiwygEl) return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (!range.collapsed || !wysiwygEl.contains(range.startContainer)) return;

        const parent = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer as HTMLElement
            : range.startContainer.parentElement;
        if (!parent || parent.closest('pre, code')) return;

        let line: HTMLElement | null = parent;
        while (line && line.parentElement !== wysiwygEl) line = line.parentElement;
        if (!line || line.parentElement !== wysiwygEl || !/^(P|DIV)$/.test(line.tagName)) return;
        // Only the visible text must be the fence: ignore inline formatting
        // wrappers (e.g. <strong>---</strong> when bold is still active after a
        // bold line). Never trigger inside inline code. A soft break (<br>) is
        // invisible to textContent, so "-<br>--" must not count as one fence.
        if (line.querySelector('pre, code, br')) return;
        if ((line.textContent || '').replace(/\u200B/g, '') !== '---') return;

        insertWysiwygHorizontalRule(line);
    }

    function insertWysiwygHorizontalRule(lineToReplace?: HTMLElement) {
        if (!wysiwygEl) return false;
        wysiwygEl.focus();
        const selection = window.getSelection();
        if (!selection) return false;
        const selectedRange = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        if (!lineToReplace && selectedRange && Array.from(wysiwygEl.querySelectorAll('table')).some((table) => selectedRange.intersectsNode(table))) return false;
        if (lineToReplace) {
            const lineRange = document.createRange();
            lineRange.selectNodeContents(lineToReplace);
            selection.removeAllRanges();
            selection.addRange(lineRange);
        } else if (selection.rangeCount === 0 || !wysiwygEl.contains(selection.anchorNode)) {
            return false;
        }

        const existingRules = new Set(wysiwygEl.querySelectorAll('hr'));
        applyingHorizontalRule = true;
        manualWysiwygHistoryDepth++;
        try {
            document.execCommand('insertHorizontalRule');
        } finally {
            manualWysiwygHistoryDepth--;
            applyingHorizontalRule = false;
        }

        const insertedRule = Array.from(wysiwygEl.querySelectorAll('hr')).find((rule) => !existingRules.has(rule));
        if (!insertedRule) return false;

        let next = insertedRule.nextSibling;
        if (!next || (next instanceof HTMLElement && (next.tagName === 'HR' || next.contentEditable === 'false'))) {
            const paragraph = document.createElement('p');
            paragraph.innerHTML = '<br>';
            insertedRule.after(paragraph);
            next = paragraph;
        }

        const nextRange = document.createRange();
        nextRange.selectNodeContents(next);
        nextRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(nextRange);
        return true;
    }

    let applyingCodeBlock = false;
    // Notion-style: typing an exact ``` line turns it into a code block.
    function maybeAutoInsertCodeBlock() {
        if (applyingCodeBlock || !wysiwygEl) return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (!range.collapsed || !wysiwygEl.contains(range.startContainer)) return;

        const parent = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer as HTMLElement
            : range.startContainer.parentElement;
        if (!parent || parent.closest('pre, code')) return;

        let line: HTMLElement | null = parent;
        while (line && line.parentElement !== wysiwygEl) line = line.parentElement;
        if (!line || line.parentElement !== wysiwygEl || !/^(P|DIV)$/.test(line.tagName)) return;
        // Only the visible text must be the fence: ignore inline formatting
        // wrappers (e.g. <strong>```</strong> when bold is still active after a
        // bold line). Never trigger inside inline code.
        if (line.querySelector('pre, code')) return;
        if ((line.textContent || '').replace(/\u200B/g, '') !== '```') return;

        insertWysiwygCodeBlock(line);
    }

    function insertWysiwygCodeBlock(lineToReplace: HTMLElement) {
        if (!wysiwygEl) return false;
        wysiwygEl.focus();
        const selection = window.getSelection();
        if (!selection) return false;
        const lineRange = document.createRange();
        lineRange.selectNodeContents(lineToReplace);
        selection.removeAllRanges();
        selection.addRange(lineRange);

        applyingCodeBlock = true;
        manualWysiwygHistoryDepth++;
        try {
            document.execCommand('formatBlock', false, 'pre');
        } finally {
            manualWysiwygHistoryDepth--;
            applyingCodeBlock = false;
        }

        const insertedPre = Array.from(wysiwygEl.querySelectorAll('pre')).find(
            (pre) => (pre.textContent || '').replace(/\u200B/g, '') === '```'
        );
        if (!insertedPre) return false;

        // Notion-style: the fence disappears and the caret lands inside the
        // freshly created code block, ready to type. A ZWSP keeps the empty
        // block in the DOM (and markdown) until the user types something.
        insertedPre.textContent = '';
        const zwsp = document.createTextNode('\u200B');
        insertedPre.appendChild(zwsp);
        wrapCodeBlocksWithCopy(wysiwygEl);
        // Keep a paragraph after the code block so the caret can move past it
        if (!insertedPre.parentElement?.nextElementSibling) {
            const paragraph = document.createElement('p');
            paragraph.innerHTML = '<br>';
            insertedPre.parentElement?.after(paragraph);
        }
        const caret = document.createRange();
        caret.setStart(zwsp, 0);
        caret.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caret);
        return true;
    }

    // The <pre> the caret is inside, if any (within the WYSIWYG editor).
    function getPreFromSelection(): HTMLElement | null {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !wysiwygEl) return null;
        const range = selection.getRangeAt(0);
        if (!wysiwygEl.contains(range.startContainer)) return null;
        let node: Node | null = range.startContainer;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
        if (!node || !(node instanceof HTMLElement)) return null;
        const pre = node.closest('pre');
        return pre && wysiwygEl.contains(pre) ? pre : null;
    }

    function getCaretTextOffset(root: HTMLElement): number | null {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !selection.isCollapsed || !root.contains(selection.anchorNode)) return null;
        const range = selection.getRangeAt(0).cloneRange();
        const before = document.createRange();
        before.selectNodeContents(root);
        before.setEnd(range.startContainer, range.startOffset);
        return before.toString().length;
    }

    function restoreCaretTextOffset(root: HTMLElement, offset: number) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let remaining = offset;
        let node = walker.nextNode() as Text | null;
        let lastText: Text | null = null;
        while (node) {
            lastText = node;
            const length = node.textContent?.length ?? 0;
            if (remaining <= length) {
                const range = document.createRange();
                range.setStart(node, remaining);
                range.collapse(true);
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
                return;
            }
            remaining -= length;
            node = walker.nextNode() as Text | null;
        }

        const range = document.createRange();
        if (lastText) range.setStart(lastText, lastText.length);
        else range.setStart(root, 0);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }

    function rehighlightWysiwygCodeBlocks() {
        if (!wysiwygEl) return;
        const activePre = getPreFromSelection();
        const caretOffset = activePre ? getCaretTextOffset(activePre) : null;
        highlightCodeBlocks(wysiwygEl);
        if (activePre?.isConnected && caretOffset !== null) {
            restoreCaretTextOffset(activePre, caretOffset);
        }
    }

    // The char range (in the ZWSP-stripped text) of the line the caret is on
    // inside the pre, when that line is already empty. Returns null otherwise.
    function emptyLineInPre(pre: HTMLElement): { start: number; end: number; total: number } | null {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        const prefixRange = document.createRange();
        prefixRange.selectNodeContents(pre);
        prefixRange.setEnd(range.startContainer, range.startOffset);
        const before = prefixRange.toString().replace(/\u200B/g, '');
        const total = (pre.textContent || '').replace(/\u200B/g, '');
        const after = total.slice(before.length);
        const lastNewline = before.lastIndexOf('\n');
        const start = lastNewline === -1 ? 0 : lastNewline + 1;
        const nextNewline = after.indexOf('\n');
        const end = nextNewline === -1 ? total.length : before.length + nextNewline;
        if (total.slice(start, end).trim() !== '') return null;
        return { start, end, total: total.length };
    }

    function selectAllInWysiwygCodeBlock(pre: HTMLElement) {
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        const code = pre.firstElementChild?.tagName === 'CODE' ? pre.firstElementChild : pre;
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // Enter inside a code block: insert a real newline so the line stays part
    // of the same code block.
    function insertNewlineInPre() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (!range.collapsed) range.deleteContents();
        const nl = document.createTextNode('\n');
        range.insertNode(nl);
        range.setStartAfter(nl);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // Notion-style exit from a code block: Enter on an empty last line. An
    // empty code block is deleted; a non-empty one stays — with the empty
    // line removed — and the caret moves to a fresh paragraph right after it.
    function escapeWysiwygCodeBlock(pre: HTMLElement, line: { start: number; total: number }) {
        const wrapper = pre.parentElement?.classList.contains(CODE_COPY_WRAPPER_CLASS) ? pre.parentElement : null;
        const block = wrapper ?? pre;
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        const empty = !(pre.textContent || '').replace(/\u200B/g, '').trim();
        if (!empty) {
            // Drop the empty line the caret is on (the '\n' that starts it), so
            // the code block does not keep a phantom empty last line.
            if (line.start > 0) {
                const text = (pre.textContent || '').replace(/\u200B/g, '');
                pre.textContent = text.slice(0, line.start - 1) + text.slice(line.start);
            }
        }
        if (empty || !(pre.textContent || '').replace(/\u200B/g, '').trim()) {
            block.replaceWith(p);
        } else {
            block.after(p);
        }
        const selection = window.getSelection();
        if (selection) {
            const caret = document.createRange();
            caret.selectNodeContents(p);
            caret.collapse(false);
            selection.removeAllRanges();
            selection.addRange(caret);
        }
    }

    // The browser sometimes deletes a code block on its own (e.g. Backspace
    // emptying it and merging into the previous paragraph), leaving the copy
    // button wrapper behind like a widow. Remove orphan wrappers, and empty
    // ones the caret has moved out of.
    function removeOrphanCodeWrappers() {
        if (!wysiwygEl || applyingWysiwygHistory) return;
        const selection = window.getSelection();
        const caretNode = selection?.anchorNode ?? null;
        const focusedLanguageInput = document.activeElement instanceof HTMLInputElement &&
            document.activeElement.classList.contains(CODE_LANGUAGE_INPUT_CLASS)
            ? document.activeElement
            : null;
        wysiwygEl.querySelectorAll(`.${CODE_COPY_WRAPPER_CLASS}`).forEach((wrapper) => {
            const pres = wrapper.querySelectorAll('pre');
            if (pres.length === 0) {
                wrapper.remove();
                return;
            }
            if (activeLangPicker && wrapper === activeLangPicker.wrapper) return;
            if (focusedLanguageInput && wrapper.contains(focusedLanguageInput)) return;
            if (caretNode && wrapper.contains(caretNode)) return;
            const hasText = Array.from(pres).some((p) => (p.textContent || '').replace(/\u200B/g, '').trim() !== '');
            if (!hasText) wrapper.remove();
        });
    }

    // True when el is an inline code element: a toolbar-wrapped <code> or a
    // marker span created by the backtick auto-close.
    function isInlineCodeElement(el: Element | null): boolean {
        if (!(el instanceof HTMLElement)) return false;
        if (el.tagName === 'CODE') return el.parentElement?.tagName !== 'PRE';
        return (el.getAttribute('style') || '').includes(INLINE_CODE_STYLE_MARKER);
    }

    // Breaks at the end of inline code must start outside its formatting;
    // otherwise the browser clones empty code pills into the following lines.
    function exitInlineCodeAtEnd() {
        const selection = window.getSelection();
        if (!wysiwygEl || !selection?.isCollapsed || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (!wysiwygEl.contains(range.startContainer)) return;
        let ancestor = range.startContainer instanceof Element
            ? range.startContainer : range.startContainer.parentElement;
        if (ancestor?.closest('pre')) return;
        let code: Element | null = null;
        while (ancestor && ancestor !== wysiwygEl) {
            if (isInlineCodeElement(ancestor)) code = ancestor;
            ancestor = ancestor.parentElement;
        }
        if (!code) return;
        const remaining = range.cloneRange();
        remaining.setEnd(code, code.childNodes.length);
        if (remaining.toString().replace(/\u200B/g, '') !== '') return;

        // A caret immediately after an inline element still inherits its style
        // in Chrome. Place it after a plain-text anchor instead, as auto-close does.
        const anchor = document.createTextNode('\u200B');
        code.after(anchor);
        range.setStart(anchor, 1);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // When the user types a closing backtick, try to match it with a previous
    // backtick in the same text node and form an inline code element. Runs on
    // the input event, after the backtick has been typed, so a single ctrl+z
    // (undo) cancels the auto-format and restores exactly what was typed.
    // Chrome sanitizes <code> tags in execCommand HTML, so a marker span is
    // inserted instead and converted back to inline code by htmlToMarkdown.
    let applyingInlineCode = false;
    function maybeAutoCloseInlineCode(): boolean {
        if (applyingInlineCode || !wysiwygEl) return false;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return false;
        const range = selection.getRangeAt(0);
        if (!range.collapsed) return false;
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE || !wysiwygEl.contains(node)) return false;
        const parentEl = node.parentElement;
        if (!parentEl || parentEl.closest('pre')) return false;
        // Never wrap inside an existing inline code element (a toolbar <code>
        // or a previous marker span): the caret inside one would nest another
        // span and corrupt the stored markdown.
        let ancestor: Element | null = parentEl;
        while (ancestor && ancestor !== wysiwygEl) {
            if (isInlineCodeElement(ancestor)) return false;
            ancestor = ancestor.parentElement;
        }
        const text = node.textContent ?? '';
        const offset = range.startOffset;
        if (offset < 1 || text.charAt(offset - 1) !== '`') return false;
        const openIdx = text.slice(0, offset - 1).lastIndexOf('`');
        if (openIdx === -1) return false;
        const codeText = text.slice(openIdx + 1, offset - 1);
        if (!codeText || codeText !== codeText.trim()) return false;
        let didInsert = false;
        applyingInlineCode = true;
        try {
            const replaceRange = document.createRange();
            replaceRange.setStart(node, openIdx);
            replaceRange.setEnd(node, offset);
            selection.removeAllRanges();
            selection.addRange(replaceRange);
            // Track the spans that exist before inserting so the freshly
            // inserted one can be found reliably: insertHTML can place it
            // before other spans in the document, so picking the last span
            // in document order would re-mark an unrelated span and leave the
            // new one without the marker (breaking the markdown round-trip).
            const existingSpans = new Set(wysiwygEl.querySelectorAll('span'));
            manualWysiwygHistoryDepth++;
            try {
                document.execCommand('insertHTML', false, inlineCodeSpanHtml(codeText));
            } finally {
                manualWysiwygHistoryDepth--;
            }
            const inserted = Array.from(wysiwygEl.querySelectorAll('span')).find((span) => !existingSpans.has(span));
            const markerSpan = inserted instanceof HTMLElement ? inserted : null;
            if (markerSpan) {
                didInsert = true;
                // Rewrite the inserted span's background from the concrete
                // color (which the sanitizer kept) to the theme-variable
                // marker, so the code adapts to the active theme and
                // round-trips back to backticks.
                markerSpan.style.backgroundColor = INLINE_CODE_STYLE_MARKER;
                // Anchor the caret just after the marker span so further
                // typing continues outside the (already closed) inline code.
                // Chrome redirects typing at the end of a paragraph after a
                // trailing inline element back INTO that element (a caret
                // after the span, in an empty node, or before a ZWSP all
                // resolve inside the span), so the caret must sit AFTER a
                // ZWSP in the text node that follows the span. htmlToMarkdown
                // strips the ZWSP, so it never reaches the stored markdown.
                let after: Node | null = markerSpan.nextSibling;
                if (after && after.nodeType === Node.TEXT_NODE && after.textContent !== '') {
                    // Existing text right after the span: caret at its start.
                } else {
                    if (after && after.nodeType === Node.TEXT_NODE) {
                        after.textContent = '\u200B';
                    } else {
                        after = document.createTextNode('\u200B');
                        markerSpan.after(after);
                    }
                }
                const caret = document.createRange();
                caret.setStart(after, after.textContent === '\u200B' ? 1 : 0);
                caret.collapse(true);
                selection.removeAllRanges();
                selection.addRange(caret);
            }
        } finally {
            applyingInlineCode = false;
        }
        return didInsert;
    }

    // Toggle inline code on the current selection (or the word at the caret).
    function toggleInlineCode() {
        if (!wysiwygEl) return;
        wysiwygEl.focus();
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        // If the caret/selection is inside an inline <code>, unwrap it
        let node: Node | null = selection.anchorNode;
        let existing: HTMLElement | null = null;
        while (node && node !== wysiwygEl) {
            if (node instanceof HTMLElement && node.tagName === 'CODE' && node.parentElement?.tagName !== 'PRE') {
                existing = node;
                break;
            }
            node = node.parentNode;
        }
        if (existing) {
            const parent = existing.parentNode;
            if (parent) {
                while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
                parent.removeChild(existing);
                parent.normalize();
            }
            handleWysiwygInput();
            return;
        }
        let range = selection.getRangeAt(0);
        if (range.collapsed) {
            // Expand to the word around the caret
            const textNode = range.startContainer;
            if (textNode.nodeType !== Node.TEXT_NODE) return;
            const text = textNode.textContent ?? '';
            let start = range.startOffset;
            let end = range.startOffset;
            while (start > 0 && !/\s/.test(text.charAt(start - 1))) start--;
            while (end < text.length && !/\s/.test(text.charAt(end))) end++;
            if (start === end) return;
            range.setStart(textNode, start);
            range.setEnd(textNode, end);
            selection.removeAllRanges();
            selection.addRange(range);
            range = selection.getRangeAt(0);
        }
        const frag = range.extractContents();
        // If the selection spans block-level content (e.g. Ctrl+A over several
        // paragraphs), wrapping everything in one inline <code> would nest block
        // elements inside it and corrupt the stored markdown. Wrap each block's
        // text in its own <code> instead.
        const blocks = Array.from(frag.children).filter(
            (el): el is HTMLElement => el instanceof HTMLElement && /^(P|DIV|LI|H[1-6]|PRE)$/.test(el.tagName)
        );
        const codeEl = document.createElement('code');
        if (blocks.length > 0) {
            for (const block of blocks) {
                if (block.tagName === 'PRE' || !block.textContent?.trim()) continue;
                const nestedCode = document.createElement('code');
                while (block.firstChild) nestedCode.appendChild(block.firstChild);
                block.appendChild(nestedCode);
            }
            range.insertNode(frag);
            // Reselect the first wrapped block so toggling again unwraps it
            const firstWrapped = blocks.find((b) => b.tagName !== 'PRE' && b.textContent?.trim());
            if (firstWrapped?.firstElementChild) {
                selection.removeAllRanges();
                const newRange = document.createRange();
                newRange.selectNodeContents(firstWrapped.firstElementChild);
                selection.addRange(newRange);
            }
        } else {
            codeEl.appendChild(frag);
            range.insertNode(codeEl);
            // Reselect the wrapped content so toggling again unwraps it
            selection.removeAllRanges();
            const newRange = document.createRange();
            newRange.selectNodeContents(codeEl);
            selection.addRange(newRange);
        }
        handleWysiwygInput();
    }

    // Toggle a code block around the current block, or unwrap the <pre> the
    // caret is inside back into a paragraph.
    function toggleCodeBlock() {
        if (!wysiwygEl) return false;
        wysiwygEl.focus();
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return false;
        const range = selection.getRangeAt(0);
        if (!wysiwygEl.contains(range.startContainer)) return false;

        let node: Node | null = range.startContainer;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
        const pre = node instanceof HTMLElement ? node.closest('pre') : null;
        if (pre && wysiwygEl.contains(pre)) {
            // Unwrap: replace the code block (and its copy-button wrapper, if
            // the block was rendered from markdown) with a plain paragraph.
            const block = pre.parentElement?.classList.contains(CODE_COPY_WRAPPER_CLASS) ? pre.parentElement : pre;
            const p = document.createElement('p');
            for (const child of Array.from(pre.childNodes)) {
                // Rendered code blocks are <pre><code>…</code></pre>; unwrap the
                // <code> so toggling off yields a plain paragraph, not inline code
                if (child instanceof HTMLElement && child.tagName === 'CODE') {
                    p.append(...Array.from(child.childNodes));
                } else {
                    p.appendChild(child);
                }
            }
            block.replaceWith(p);
            const caret = document.createRange();
            caret.selectNodeContents(p);
            caret.collapse(false);
            selection.removeAllRanges();
            selection.addRange(caret);
            handleWysiwygInput();
            return true;
        }

        // execCommand produces a bare <pre>; htmlToMarkdown's bareCodeBlock
        // rule round-trips it back to a fenced code block. Wrap it right away
        // so the copy button shows up immediately, like rendered code blocks.
        document.execCommand('formatBlock', false, 'pre');
        wrapCodeBlocksWithCopy(wysiwygEl);
        handleWysiwygInput();
        return true;
    }

    // If the click target is a playground file link, switch to that tab in-app.
    function tryOpenPlaygroundFileLink(event: MouseEvent, container: HTMLElement | null): boolean {
        if (!container) return false;
        const anchor = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
        if (!anchor || !container.contains(anchor)) return false;
        const fileId = parsePlaygroundFileId(anchor.getAttribute('href') || '');
        if (!fileId) return false;
        event.preventDefault();
        event.stopPropagation();
        closeMentionPopup();
        activateTab(fileId);
        return true;
    }

    // Browsers do not consistently activate links inside contenteditable
    // elements. Desktop mode delegates target=_blank to Tauri's opener hook,
    // so only provide the explicit browser fallback here.
    function tryOpenExternalLink(event: MouseEvent, container: HTMLElement | null): boolean {
        if (!container) return false;
        const anchor = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
        if (!anchor || !container.contains(anchor) || anchor.target !== '_blank') return false;
        if (parsePlaygroundFileId(anchor.getAttribute('href') || '')) return false;
        event.preventDefault();
        event.stopPropagation();
        onOpenLink(anchor.getAttribute('href') || anchor.href);
        return true;
    }

    // Keep checkbox HTML attributes in sync after native toggle so innerHTML
    // (and turndown) sees the current checked state.
    function handleWysiwygChange(event: Event) {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
        if (!wysiwygEl?.contains(target)) return;
        const historyBefore = captureWysiwygHistoryState();
        if (target.checked) target.setAttribute('checked', '');
        else target.removeAttribute('checked');
        handleWysiwygInput();
        finishWysiwygHistoryEntry(historyBefore);
    }

    function getListItemFromSelection(): HTMLLIElement | null {
        if (!wysiwygEl) return null;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        let node: Node | null = selection.getRangeAt(0).startContainer;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
        while (node && node !== wysiwygEl) {
            if (node instanceof HTMLLIElement) return node;
            node = node.parentElement;
        }
        return null;
    }

    function placeCaretInTaskItem(li: HTMLElement, atStart = true) {
        const selection = window.getSelection();
        if (!selection) return;
        wysiwygEl?.focus();
        const anchor = ensureTaskItemCaretAnchor(li);
        const range = document.createRange();
        if (atStart && anchor) {
            // Offset 1 sits after the ZWSP, so the caret paints to the right of
            // the checkbox instead of the left (browser default for <input>).
            range.setStart(anchor, Math.min(1, anchor.length));
            range.collapse(true);
        } else if (!atStart) {
            range.selectNodeContents(li);
            range.collapse(false);
        } else {
            range.selectNodeContents(li);
            range.collapse(false);
        }
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function breakOutOfListItem(li: HTMLLIElement) {
        const list = li.parentElement;
        if (!list || !/^(UL|OL)$/.test(list.tagName)) return;
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        const hasPrev = !!li.previousElementSibling;
        const hasNext = !!li.nextElementSibling;
        let nodeAfter = li.nextSibling;
        li.remove();
        if (!hasPrev && !hasNext) {
            list.replaceWith(p);
        } else if (!hasNext) {
            list.after(p);
        } else if (!hasPrev) {
            list.before(p);
        } else {
            const newList = document.createElement(list.tagName);
            while (nodeAfter) {
                const nextNode = nodeAfter.nextSibling;
                newList.appendChild(nodeAfter);
                nodeAfter = nextNode;
            }
            list.after(p);
            p.after(newList);
        }
        const selection = window.getSelection();
        const range = document.createRange();
        range.setStart(p, 0);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
    }

    // Enter in a checklist item continues the checklist; empty item breaks out.
    function handleTaskListEnter(li: HTMLLIElement): boolean {
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false;

        if (isEmptyTaskListItem(li)) {
            breakOutOfListItem(li);
            return true;
        }

        const range = selection.getRangeAt(0);
        const afterRange = document.createRange();
        afterRange.selectNodeContents(li);
        afterRange.setStart(range.startContainer, range.startOffset);
        const fragment = afterRange.extractContents();

        ensureTaskCheckbox(li);
        if (isEmptyTaskListItem(li) && !li.querySelector('br')) {
            li.appendChild(document.createElement('br'));
        }

        const newLi = document.createElement('li');
        newLi.appendChild(createTaskCheckbox());
        newLi.appendChild(document.createTextNode('\u200B'));
        while (fragment.firstChild) {
            const child = fragment.firstChild;
            if (
                child.nodeType === Node.ELEMENT_NODE &&
                (child as HTMLElement).tagName === 'INPUT' &&
                (child as HTMLInputElement).type === 'checkbox'
            ) {
                fragment.removeChild(child);
                continue;
            }
            // Drop a leading ZWSP/space from the split fragment; the new item
            // already has its own caret anchor.
            if (
                child.nodeType === Node.TEXT_NODE &&
                newLi.childNodes.length === 2 &&
                /^[\u200B\s]/.test(child.textContent || '')
            ) {
                child.textContent = (child.textContent || '').replace(/^[\u200B\s]+/, '');
                if (!child.textContent) {
                    fragment.removeChild(child);
                    continue;
                }
            }
            newLi.appendChild(child);
        }
        if (isEmptyTaskListItem(newLi)) {
            // Keep a trailing <br> so the empty item has a line box, but the
            // caret still lives in the ZWSP after the checkbox.
            if (![...newLi.childNodes].some((n) => n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === 'BR')) {
                newLi.appendChild(document.createElement('br'));
            }
        }
        ensureTaskItemCaretAnchor(newLi);
        li.after(newLi);
        placeCaretInTaskItem(newLi, true);
        return true;
    }

    function insertOrToggleTaskList() {
        if (!wysiwygEl) return;
        wysiwygEl.focus();
        const li = getListItemFromSelection();
        if (li && isTaskListItem(li)) {
            removeTaskCheckbox(li);
            handleWysiwygInput();
            return;
        }
        if (li) {
            ensureTaskCheckbox(li);
            placeCaretInTaskItem(li, false);
            handleWysiwygInput();
            return;
        }
        document.execCommand(
            'insertHTML',
            false,
            '<ul><li><input type="checkbox" contenteditable="false">\u200B<br></li></ul>'
        );
        prepareTaskListCheckboxes(wysiwygEl);
        const created = getListItemFromSelection();
        if (created) placeCaretInTaskItem(created, true);
        handleWysiwygInput();
    }

    // True when the collapsed caret sits at the very start of a task item,
    // i.e. nothing editable between the checkbox and the caret.
    function isCaretAtTaskItemStart(li: HTMLElement): boolean {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return false;
        const range = selection.getRangeAt(0);
        if (!range.collapsed) return false;
        const node = range.startContainer;
        if (node === li) {
            const offset = range.startOffset;
            for (let i = 0; i < offset; i++) {
                if (!isZwspOnlyText(li.childNodes[i])) return false;
            }
            return true;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            const before = (node.textContent || '').slice(0, range.startOffset);
            if (before.replace(/\u200B/g, '').length > 0) return false;
            let prev: Node | null = node.previousSibling;
            while (prev && isZwspOnlyText(prev)) prev = prev.previousSibling;
            return !!prev && prev instanceof HTMLInputElement && prev.type === 'checkbox';
        }
        return false;
    }

    // Backspace at the very start of a task item: with a previous item, merge
    // (standard list behavior); otherwise remove the checkbox so the item
    // becomes a plain bullet.
    function handleTaskListBackspace(): boolean {
        const li = getListItemFromSelection();
        if (!li || !isTaskListItem(li)) return false;
        if (!isCaretAtTaskItemStart(li)) return false;
        const prev = li.previousElementSibling;
        if (prev && prev.tagName === 'LI') {
            appendListItemContent(prev as HTMLElement, li);
            placeCaretAtLiEnd(prev as HTMLElement);
            handleWysiwygInput();
            return true;
        }
        removeTaskCheckbox(li);
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(li);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        handleWysiwygInput();
        return true;
    }

    // True when the collapsed caret is at the very start of an li, with only
    // whitespace/ZWSP/br between the li's beginning and the caret.
    function isCaretAtLiStart(li: HTMLElement): boolean {
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false;
        const range = selection.getRangeAt(0);
        const node = range.startContainer;
        const beforeIsStructural = (n: Node | null): boolean =>
            !!n && ((n.nodeType === Node.TEXT_NODE && /^[\u200B\s]*$/.test(n.textContent || '')) ||
                (n.nodeType === Node.ELEMENT_NODE && n.nodeName === 'BR'));
        if (node === li) {
            for (let i = 0; i < range.startOffset; i++) {
                if (!beforeIsStructural(li.childNodes[i])) return false;
            }
            return true;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            if (!/^[\u200B\s]*$/.test((node.textContent || '').slice(0, range.startOffset))) return false;
            let prev: Node | null = node.previousSibling;
            while (prev && beforeIsStructural(prev)) prev = prev.previousSibling;
            return !prev;
        }
        return false;
    }

    // True when the collapsed caret is at the very end of an li, with only
    // whitespace/ZWSP/br between the caret and the li's end.
    function isCaretAtLiEnd(li: HTMLElement): boolean {
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false;
        const range = selection.getRangeAt(0);
        const node = range.startContainer;
        const afterIsStructural = (n: Node | null): boolean =>
            !!n && ((n.nodeType === Node.TEXT_NODE && /^[\u200B\s]*$/.test(n.textContent || '')) ||
                (n.nodeType === Node.ELEMENT_NODE && n.nodeName === 'BR'));
        if (node === li) {
            for (let i = range.startOffset; i < li.childNodes.length; i++) {
                if (!afterIsStructural(li.childNodes[i])) return false;
            }
            return true;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            if (!/^[\u200B\s]*$/.test((node.textContent || '').slice(range.startOffset))) return false;
            let next: Node | null = node.nextSibling;
            while (next && afterIsStructural(next)) next = next.nextSibling;
            return !next;
        }
        return false;
    }

    function placeCaretAtLiEnd(li: HTMLElement) {
        const selection = window.getSelection();
        if (!selection) return;
        wysiwygEl?.focus();
        const range = document.createRange();
        if (isTaskListItem(li)) {
            const anchor = ensureTaskItemCaretAnchor(li);
            if (anchor) {
                range.setStart(anchor, anchor.length);
                range.collapse(true);
            } else {
                range.selectNodeContents(li);
                range.collapse(false);
            }
        } else {
            range.selectNodeContents(li);
            range.collapse(false);
        }
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function placeCaretAtBlockStart(el: HTMLElement) {
        const selection = window.getSelection();
        if (!selection) return;
        wysiwygEl?.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // Merges the content of `source` li into the end of `target` li, dropping
    // the source's checkbox and structural whitespace. Manual DOM merge so the
    // browser never rebuilds the <li> (Chrome drops the checkbox inputs when
    // it natively merges list items).
    function appendListItemContent(target: HTMLElement, source: HTMLElement) {
        const frag = document.createDocumentFragment();
        for (const child of Array.from(source.childNodes)) {
            if (
                child.nodeType === Node.ELEMENT_NODE &&
                (child as HTMLElement).tagName === 'INPUT' &&
                (child as HTMLInputElement).type === 'checkbox'
            ) {
                continue;
            }
            frag.appendChild(child);
        }
        while (frag.firstChild && frag.firstChild.nodeType === Node.TEXT_NODE && /^[\u200B\s]*$/.test(frag.firstChild.textContent || '')) {
            frag.removeChild(frag.firstChild);
        }
        while (frag.lastChild && frag.lastChild.nodeType === Node.ELEMENT_NODE && (frag.lastChild as HTMLElement).tagName === 'BR') {
            frag.removeChild(frag.lastChild);
        }
        const lastTarget = target.lastChild;
        if (
            lastTarget && lastTarget.nodeType === Node.TEXT_NODE &&
            frag.firstChild && frag.firstChild.nodeType === Node.TEXT_NODE
        ) {
            target.appendChild(document.createTextNode(' '));
        }
        if (frag.childNodes.length > 0) target.appendChild(frag);
        const list = source.parentElement;
        source.remove();
        if (list && !list.querySelector('li')) list.remove();
        if (![...target.childNodes].some((n) => n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === 'BR')) {
            if (!target.textContent?.replace(/\u200B/g, '').trim()) target.appendChild(document.createElement('br'));
        }
        ensureTaskItemCaretAnchor(target);
    }

    // Delete at a task-list boundary: never let the browser natively merge
    // list items, because Chrome rebuilds the <li> elements and drops the
    // checkbox inputs (turning "- [ ] A" into "-  A" or corrupting the list).
    function handleTaskBoundaryDelete(): boolean {
        const li = getListItemFromSelection();
        if (!li || !wysiwygEl?.contains(li)) return false;
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false;
        const isTask = isTaskListItem(li);
        const next = li.nextElementSibling;
        const prev = li.previousElementSibling;
        const nextIsLi = !!next && next.tagName === 'LI';
        const prevIsLi = !!prev && prev.tagName === 'LI';
        const nextIsTask = nextIsLi && isTaskListItem(next as HTMLElement);
        const prevIsTask = prevIsLi && isTaskListItem(prev as HTMLElement);

        if (isCaretAtLiEnd(li)) {
            // Delete at the end merges the following item into this one.
            if (isTask || nextIsTask) {
                if (nextIsLi) {
                    appendListItemContent(li, next as HTMLElement);
                    placeCaretAtLiEnd(li);
                } else if (next) {
                    // A block follows: move the caret into it instead of
                    // letting Chrome absorb the list item into the block.
                    placeCaretAtBlockStart(next as HTMLElement);
                } else {
                    return false;
                }
                handleWysiwygInput();
                return true;
            }
            return false;
        }

        if (isCaretAtLiStart(li)) {
            // Delete at the very start of an empty item merges the previous
            // item into it.
            if ((isTask || prevIsTask) && !li.textContent?.replace(/\u200B/g, '').trim()) {
                if (prevIsLi) {
                    const frag = document.createDocumentFragment();
                    while (prev.firstChild) frag.appendChild(prev.firstChild);
                    li.insertBefore(frag, li.firstChild);
                    if (prevIsTask) ensureTaskItemCaretAnchor(li);
                    placeCaretAtLiEnd(li);
                    handleWysiwygInput();
                    return true;
                }
                return false;
            }
            return false;
        }
        return false;
    }

    // Backspace at the start of a plain item whose previous item is a task
    // item would let Chrome merge and rebuild the task <li>. Merge manually.
    function handlePlainItemBackspaceIntoTask(): boolean {
        const li = getListItemFromSelection();
        if (!li || isTaskListItem(li) || !wysiwygEl?.contains(li)) return false;
        if (!isCaretAtLiStart(li)) return false;
        const prev = li.previousElementSibling;
        if (!prev || prev.tagName !== 'LI' || !isTaskListItem(prev as HTMLElement)) return false;
        appendListItemContent(prev as HTMLElement, li);
        placeCaretAtLiEnd(prev as HTMLElement);
        handleWysiwygInput();
        return true;
    }

    // Tab/Shift+Tab inside a list item (bullet, ordered, or task list) indents
    // and outdents. The <li> nodes are moved wholesale so checkboxes and any
    // nested lists stay intact (the browser's native editing rebuilds items and
    // drops checkbox inputs).
    function handleWysiwygTab(e: KeyboardEvent): boolean {
        const li = getListItemFromSelection();
        if (!li || !wysiwygEl?.contains(li)) return false;
        const list = li.parentElement;
        if (!list || !/^(UL|OL)$/.test(list.tagName)) return false;
        return e.shiftKey ? outdentListItem(li) : indentListItem(li);
    }

    // Remembers the caret position as (node, offset) plain values, so the
    // position can be re-applied after a DOM move. (A cloned Range gets
    // re-mapped by Chrome when list nodes are moved around in a
    // contenteditable, silently dropping the caret into a neighboring text
    // node.)
    function saveWysiwygCaret(): { node: Node; offset: number } | null {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        return { node: range.startContainer, offset: range.startOffset };
    }

    function restoreWysiwygCaret(caret: { node: Node; offset: number } | null) {
        if (!caret) return;
        const selection = window.getSelection();
        const range = document.createRange();
        try {
            range.setStart(caret.node, caret.offset);
        } catch {
            return;
        }
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
    }

    // Nests the item (with its own nested lists) under the previous item.
    function indentListItem(li: HTMLElement): boolean {
        const list = li.parentElement;
        if (!list || !/^(UL|OL)$/.test(list.tagName)) return false;
        const prev = li.previousElementSibling;
        if (!prev || prev.tagName !== 'LI') return false;

        const savedCaret = saveWysiwygCaret();
        let nested: HTMLElement | null = null;
        for (let i = 0; i < prev.childNodes.length; i++) {
            const child = prev.childNodes[i];
            if (child instanceof HTMLElement && /^(UL|OL)$/.test(child.tagName)) {
                nested = child;
                break;
            }
        }
        if (!nested) {
            nested = document.createElement(list.tagName);
            prev.appendChild(nested);
        }
        nested.appendChild(li);
        restoreWysiwygCaret(savedCaret);
        handleWysiwygInput();
        return true;
    }

    // Moves the item out of its nested list, placing it after its parent item.
    function outdentListItem(li: HTMLElement): boolean {
        const list = li.parentElement;
        if (!list || !/^(UL|OL)$/.test(list.tagName)) return false;
        const parentLi = list.parentElement;
        if (!parentLi || parentLi.tagName !== 'LI') return false;
        const outerList = parentLi.parentElement;
        if (!outerList || !/^(UL|OL)$/.test(outerList.tagName)) return false;

        const savedCaret = saveWysiwygCaret();
        li.remove();
        if (!list.querySelector('li')) list.remove();
        parentLi.after(li);
        restoreWysiwygCaret(savedCaret);
        handleWysiwygInput();
        return true;
    }

    // Repairs DOMs the browser already corrupted (e.g. a native merge put
    // several checkboxes into one <li>): split them back into separate items.
    function healTaskListStructure() {
        if (!wysiwygEl) return;
        wysiwygEl.querySelectorAll('li').forEach((li) => {
            const boxes = Array.from(li.children).filter(
                (c): c is HTMLInputElement => c instanceof HTMLInputElement && c.type === 'checkbox'
            );
            for (let i = 1; i < boxes.length; i++) {
                const box = boxes[i];
                const newLi = document.createElement('li');
                let node: Node | null = box;
                while (node) {
                    const nextNode = node.nextSibling;
                    newLi.appendChild(node);
                    node = nextNode;
                }
                if (
                    ![...newLi.childNodes].some((n) => n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === 'BR') &&
                    isEmptyTaskListItem(newLi)
                ) {
                    newLi.appendChild(document.createElement('br'));
                }
                li.after(newLi);
            }
        });
        prepareTaskListCheckboxes(wysiwygEl);
    }

    // Click handling inside the WYSIWYG area: trash icon deletes the image,
    // clicking the thumbnail opens the full-size lightbox. Checkboxes toggle
    // via the native control + change handler.
    function handleWysiwygClick(event: MouseEvent) {
        const target = event.target as HTMLElement;
        const langBtn = target.closest('.code-lang-btn') as HTMLElement | null;
        if (langBtn) {
            event.preventDefault();
            event.stopPropagation();
            const wrapper = langBtn.closest(`.${CODE_COPY_WRAPPER_CLASS}`) as HTMLElement | null;
            if (wrapper) {
                if (activeLangPicker && activeLangPicker.button === langBtn) {
                    closeLangPicker();
                } else {
                    openLangPicker(langBtn, wrapper);
                }
            }
            return;
        }
        const deleteCodeBtn = target.closest('.delete-code-button') as HTMLElement | null;
        if (deleteCodeBtn && wysiwygEl?.contains(deleteCodeBtn)) {
            event.preventDefault();
            const wrapper = deleteCodeBtn.closest(`.${CODE_COPY_WRAPPER_CLASS}`) as HTMLElement | null;
            if (wrapper) deleteWysiwygCodeBlock(wrapper);
            return;
        }
        if (activeLangPicker && !target.closest('.lang-picker-popover')) {
            closeLangPicker();
        }
        if (tryOpenPlaygroundFileLink(event, wysiwygEl)) return;
        if (tryOpenExternalLink(event, wysiwygEl)) return;
        if (target instanceof HTMLInputElement && target.classList.contains(CODE_LANGUAGE_INPUT_CLASS)) return;
        const cleanupBefore = captureWysiwygHistoryState();
        removeOrphanCodeWrappers();
        if (cleanupBefore && getWysiwygSnapshotHtml() !== cleanupBefore.html) {
            wysiwygDirty = true;
            commitWysiwygEdits();
            finishWysiwygHistoryEntry(cleanupBefore);
        }
        if (target instanceof HTMLInputElement && target.type === 'checkbox' && wysiwygEl?.contains(target)) {
            // Let the native checkbox toggle; change handler syncs markdown.
            return;
        }
        const deleteBtn = target.closest(`.${THUMB_DELETE_CLASS}`) as HTMLElement | null;
        if (deleteBtn && wysiwygEl?.contains(deleteBtn)) {
            event.preventDefault();
            const img = deleteBtn.closest(`.${THUMB_WRAPPER_CLASS}`)?.querySelector('img');
            const fakeLink = img?.dataset.wysiwygImg;
            if (fakeLink) wysiwygTrackedImageLinks.add(fakeLink);
            const scrollTop = wysiwygEl.scrollTop;
            const scrollLeft = wysiwygEl.scrollLeft;
            const winX = window.scrollX;
            const winY = window.scrollY;
            runWysiwygHistoryTransaction(() => {
                deleteBtn.closest(`.${THUMB_WRAPPER_CLASS}`)?.remove();
                if (!wysiwygEl) return;
                ensureTrailingEmptyLine(wysiwygEl);
                handleWysiwygInput();
                wysiwygEl.focus({ preventScroll: true });
            });
            commitWysiwygEdits();
            wysiwygEl.scrollTop = scrollTop;
            wysiwygEl.scrollLeft = scrollLeft;
            if (window.scrollX !== winX || window.scrollY !== winY) window.scrollTo(winX, winY);
            return;
        }
        const img = target.closest(`.${THUMB_WRAPPER_CLASS} img`) as HTMLImageElement | null;
        if (img && wysiwygEl?.contains(img)) {
            event.preventDefault();
            openLightbox(img.src);
        }
    }

    // Click handling in the read-only markdown preview.
    function handlePreviewClick(event: MouseEvent) {
        const container = event.currentTarget as HTMLElement;
        const target = event.target as HTMLElement;
        const langBtn = target.closest('.code-lang-btn') as HTMLElement | null;
        if (langBtn) {
            event.preventDefault();
            event.stopPropagation();
            const wrapper = langBtn.closest(`.${CODE_COPY_WRAPPER_CLASS}`) as HTMLElement | null;
            if (wrapper) {
                if (activeLangPicker && activeLangPicker.button === langBtn) {
                    closeLangPicker();
                } else {
                    openLangPicker(langBtn, wrapper);
                }
            }
            return;
        }
        const deleteCodeBtn = target.closest('.delete-code-button') as HTMLElement | null;
        if (deleteCodeBtn && container.contains(deleteCodeBtn)) {
            event.preventDefault();
            const wrapper = deleteCodeBtn.closest('.code-block-wrapper') as HTMLElement | null;
            if (wrapper) void deletePreviewCodeBlock(wrapper);
            return;
        }
        if (activeLangPicker && !target.closest('.lang-picker-popover')) {
            closeLangPicker();
        }
        if (tryOpenPlaygroundFileLink(event, container)) return;
        const deleteBtn = target.closest(`.${THUMB_DELETE_CLASS}`) as HTMLElement | null;
        if (deleteBtn && container.contains(deleteBtn)) {
            event.preventDefault();
            const img = deleteBtn.closest(`.${THUMB_WRAPPER_CLASS}`)?.querySelector('img');
            const fakeLink = img?.dataset.wysiwygImg;
            const src = fakeLink || img?.getAttribute('src');
            if (!src) return;
            if (fakeLink) deletePastedImage(fakeLink);
            deletePreviewImage(src);
            return;
        }
        const img = target.closest(`.${THUMB_WRAPPER_CLASS} img`) as HTMLImageElement | null;
        if (img && container.contains(img)) {
            event.preventDefault();
            openLightbox(img.src);
        }
    }

    // Removes the image with the given src from the preview's source markdown.
    function deletePreviewImage(src: string) {
        const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`!\\[[^\\]]*\\]\\(\\s*${escaped}(?:\\s+"[^"]*")?\\s*\\)`, 'g');
        const next = source
            .replace(pattern, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n');
        if (next !== source) {
            source = next;
            onChange(next);
        }
    }

    // Deletes a code block from the WYSIWYG editor. This is a scripted DOM edit,
    // so record it in the editor history rather than relying on native undo.
    function deleteWysiwygCodeBlock(wrapper: HTMLElement) {
        if (!wysiwygEl || !wrapper.isConnected) return;
        if (activeLangPicker && activeLangPicker.wrapper === wrapper) closeLangPicker();
        const historyBefore = captureWysiwygHistoryState();
        const scrollTop = wysiwygEl.scrollTop;
        const scrollLeft = wysiwygEl.scrollLeft;
        const winX = window.scrollX;
        const winY = window.scrollY;
        wrapper.remove();
        ensureTrailingEmptyLine(wysiwygEl);
        handleWysiwygInput();
        finishWysiwygHistoryEntry(historyBefore);
        commitWysiwygEdits();
        wysiwygEl.focus({ preventScroll: true });
        wysiwygEl.scrollTop = scrollTop;
        wysiwygEl.scrollLeft = scrollLeft;
        if (window.scrollX !== winX || window.scrollY !== winY) window.scrollTo(winX, winY);
    }

    // Deletes a code block from the source markdown when its trash button is
    // clicked in the read-only preview.
    async function deletePreviewCodeBlock(wrapper: HTMLElement) {
        const confirmed = await confirmAction('Delete this code block?', 'Delete');
        if (!confirmed) return;
        const pre = wrapper.querySelector('pre');
        const code = pre?.firstElementChild?.tagName === 'CODE' ? (pre.firstElementChild as HTMLElement) : null;
        const language = code
            ? (Array.from(code.classList).find((name) => name.startsWith('language-'))?.slice('language-'.length) ?? '')
            : '';
        const content = code ? (code.textContent || '') : (pre?.textContent || '');
        const next = removeFencedCodeBlock(source, language, content);
        if (next !== source) {
            source = next;
            onChange(next);
        }
    }

    function commitWysiwygEdits(markdownOverride?: string) {
        if (wysiwygDebounce) {
            clearTimeout(wysiwygDebounce);
            wysiwygDebounce = null;
        }
        if (!previewEditMode || !wysiwygEl || !wysiwygSourceFileId || !wysiwygDirty) return;
        removeOrphanCodeWrappers();
        healTaskListStructure();
        prepareTaskListCheckboxes(wysiwygEl);
        let htmlForMarkdown = wysiwygEl.innerHTML;
        // Strip find highlights so they don't leak into stored markdown
        if (wysiwygFindOpen && htmlForMarkdown.includes(WYSIWYG_FIND_MARK_CLASS)) {
            const temp = document.createElement('div');
            temp.innerHTML = htmlForMarkdown;
            temp.querySelectorAll(`.${WYSIWYG_FIND_MARK_CLASS}`).forEach((mark) => {
                const parent = mark.parentNode;
                if (!parent) return;
                while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
                parent.removeChild(mark);
                if ((parent as HTMLElement).normalize) (parent as HTMLElement).normalize();
            });
            htmlForMarkdown = temp.innerHTML;
        }
        const markdown = markdownOverride ?? htmlToMarkdown(htmlForMarkdown);
        if (markdown !== source) {
            source = markdown;
            onChange(markdown);
        }
        wysiwygDirty = false;
    }

    function handleWysiwygBlur() {
        const historyBefore = captureWysiwygHistoryState();
        commitWysiwygEdits();
        finishWysiwygHistoryEntry(historyBefore);
    }

    // Paste images into the WYSIWYG area as <img> elements backed by IndexedDB
    // (the source keeps a fake wysiwyg://image/<id> link; resolvePastedImages
    // swaps it for the payload). Plain URL strings are inserted as clickable
    // links (new tab).
    function handleWysiwygPaste(event: ClipboardEvent) {
        const historyBefore = captureWysiwygHistoryState();
        const pasted = event.clipboardData?.getData('text/plain') ?? '';

        // Code blocks are plain-text editing surfaces. Handling this ourselves
        // avoids rich clipboard HTML and keeps highlighting in one undo step.
        // `execCommand('insertText')` with a multiline string splits the <pre>
        // into multiple <pre> elements (one per line) inside the same wrapper,
        // which then round-trips to multiple fenced blocks (see reproduction).
        // Insert via Range as a single TextNode so newlines stay inside one <pre>.
        if (getPreFromSelection()) {
            event.preventDefault();
            runWysiwygHistoryTransaction(() => {
                const selection = window.getSelection();
                if (!selection || selection.rangeCount === 0) return;
                const range = selection.getRangeAt(0);
                if (!range.collapsed) range.deleteContents();
                const normalized = pasted.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                if (normalized.length === 0) {
                    handleWysiwygInput();
                    return;
                }
                const textNode = document.createTextNode(normalized);
                range.insertNode(textNode);
                range.setStartAfter(textNode);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                handleWysiwygInput();
            }, historyBefore, 'insertFromPaste');
            return;
        }

        const items = event.clipboardData?.items;
        if (items) {
            for (const item of items) {
                if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
                const file = item.getAsFile();
                if (!file) continue;
                event.preventDefault();
                const sourceFileId = wysiwygSourceFileId;
                if (!sourceFileId) return;
                const token = uuidv4();
                let inserted = false;
                runWysiwygHistoryTransaction(() => {
                    const selection = window.getSelection();
                    if (!selection || selection.rangeCount === 0 || !wysiwygEl) return;
                    const range = selection.getRangeAt(0);
                    if (!wysiwygEl.contains(range.startContainer) || !wysiwygEl.contains(range.endContainer)) return;
                    const placeholder = document.createElement('span');
                    placeholder.setAttribute(WYSIWYG_PENDING_IMAGE_ATTR, token);
                    placeholder.setAttribute('contenteditable', 'false');
                    const replacedContent = range.extractContents();
                    if (replacedContent.hasChildNodes()) placeholder.appendChild(replacedContent);
                    else placeholder.appendChild(document.createTextNode('\u200B'));
                    range.insertNode(placeholder);
                    range.setStartAfter(placeholder);
                    range.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    inserted = true;
                    ensureTrailingEmptyLine(wysiwygEl);
                }, historyBefore, 'insertFromPaste');
                if (!inserted) return;

                const reader = new FileReader();
                const discard = () => settlePendingWysiwygImage(token, sourceFileId, null);
                reader.onerror = discard;
                reader.onload = () => {
                    if (typeof reader.result !== 'string') {
                        discard();
                        return;
                    }
                    void storePastedImage(reader.result)
                        .then((link) => settlePendingWysiwygImage(token, sourceFileId, link))
                        .catch(discard);
                };
                reader.readAsDataURL(file);
                return;
            }
        }

        const pastedFileId = extractPlaygroundFileId(pasted);
        if (!isUrlLike(pasted) && !pastedFileId) {
            queueWysiwygHistoryEntry(historyBefore, 'insertFromPaste');
            return;
        }

        event.preventDefault();
        const selection = window.getSelection();
        const hasSelection =
            !!selection &&
            !selection.isCollapsed &&
            !!wysiwygEl &&
            !!selection.anchorNode &&
            wysiwygEl.contains(selection.anchorNode);

        runWysiwygHistoryTransaction(() => {
            if (pastedFileId) {
                const href = playgroundFileHref(pastedFileId);
                const selectedText = hasSelection ? (selection?.toString() ?? '').trim() : '';
                const label = selectedText || fileLabelFor(pastedFileId, pasted.trim());
                insertHtmlAtSelection(fileMentionHtml(href, label, getLanguageForTab(pastedFileId)));
            } else {
                insertLinkAtSelection(normalizeUrl(pasted), pasted.trim());
            }
            ensureWysiwygLinksOpenInNewTab();
            handleWysiwygInput();
        }, historyBefore, 'insertFromPaste');
    }

    // Insert HTML or wrap the current WYSIWYG selection in an <a> using the DOM
    // Range API instead of document.execCommand('createLink' / 'insertHTML').
    // In Electron / VSCode webviews, Cmd+V runs inside webContents.paste(), where
    // re-entrant document.execCommand calls silently return false and do nothing.
    function insertHtmlAtSelection(html: string) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !wysiwygEl) return;
        const range = selection.getRangeAt(0);
        if (!wysiwygEl.contains(range.startContainer) || !wysiwygEl.contains(range.endContainer)) return;
        if (!range.collapsed) range.deleteContents();
        const fragment = range.createContextualFragment(html);
        const lastNode = fragment.lastChild;
        range.insertNode(fragment);
        if (lastNode) {
            range.setStartAfter(lastNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }

    function createLinkElement(href: string): HTMLAnchorElement {
        const a = document.createElement('a');
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        return a;
    }

    function unwrapNestedAnchors(root: DocumentFragment | HTMLElement) {
        for (const nested of Array.from(root.querySelectorAll('a'))) {
            const parent = nested.parentNode;
            if (!parent) continue;
            while (nested.firstChild) parent.insertBefore(nested.firstChild, nested);
            parent.removeChild(nested);
        }
    }

    function insertLinkAtSelection(href: string, fallbackText: string) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !wysiwygEl) return;
        const range = selection.getRangeAt(0);
        if (!wysiwygEl.contains(range.startContainer) || !wysiwygEl.contains(range.endContainer)) return;

        if (range.collapsed) {
            const a = createLinkElement(href);
            a.textContent = fallbackText;
            range.insertNode(a);
            range.setStartAfter(a);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            return;
        }

        const ancestorEl =
            range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
                ? (range.commonAncestorContainer as Element)
                : range.commonAncestorContainer.parentElement;
        const existingAnchor = ancestorEl?.closest('a[href]') as HTMLAnchorElement | null;
        if (existingAnchor && wysiwygEl.contains(existingAnchor) && !existingAnchor.classList.contains(FILE_MENTION_CLASS)) {
            existingAnchor.setAttribute('href', href);
            existingAnchor.setAttribute('target', '_blank');
            existingAnchor.setAttribute('rel', 'noopener noreferrer');
            return;
        }

        const fragment = range.extractContents();
        unwrapNestedAnchors(fragment);

        const BLOCK_SELECTOR = 'p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th';
        if (fragment.querySelector(BLOCK_SELECTOR)) {
            const leafBlocks = Array.from(fragment.querySelectorAll(BLOCK_SELECTOR)).filter(
                (el) => !el.querySelector(BLOCK_SELECTOR)
            );
            let lastAnchor: HTMLAnchorElement | null = null;
            for (const block of leafBlocks) {
                if (!block.textContent?.trim()) continue;
                const a = createLinkElement(href);
                while (block.firstChild) a.appendChild(block.firstChild);
                block.appendChild(a);
                lastAnchor = a;
            }
            range.insertNode(fragment);
            if (lastAnchor) {
                range.setStartAfter(lastAnchor);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            }
            return;
        }

        const a = createLinkElement(href);
        a.appendChild(fragment);
        if (!a.textContent) a.textContent = fallbackText;
        range.insertNode(a);
        range.selectNodeContents(a);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function ensureWysiwygLinksOpenInNewTab() {
        if (!wysiwygEl) return;
        for (const a of Array.from(wysiwygEl.querySelectorAll('a[href]'))) {
            const href = a.getAttribute('href') || '';
            const fileId = parsePlaygroundFileId(href);
            if (fileId) {
                // Upgrade plain playground links (e.g. from createLink) into mention chips,
                // normalizing aliases (absolute URLs, wysiwyg:// / app:// links) to the
                // canonical relative form so stored markdown stays consistent.
                const canonical = playgroundFileHref(fileId);
                if (!a.classList.contains(FILE_MENTION_CLASS) || href !== canonical) {
                    const label = (a.textContent || href).trim();
                    a.outerHTML = fileMentionHtml(canonical, label, getLanguageForTab(fileId));
                } else {
                    a.removeAttribute('target');
                    a.removeAttribute('rel');
                    a.setAttribute('contenteditable', 'false');
                }
                continue;
            }
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
        }
        ensureFileMentionCarets(wysiwygEl);
    }

    function closeMentionPopup() {
        showMentionPopup = false;
        mentionQuery = '';
        mentionSelectedIndex = 0;
        savedMentionRange = null;
        mentionPopupStyle = '';
    }

    function scrollSelectedMentionIntoView() {
        tick().then(() => {
            const el = mentionResultsEl?.querySelector('.mention-result-item.selected') as HTMLElement | null;
            el?.scrollIntoView({ block: 'nearest' });
        });
    }

    // Detect an in-progress @mention immediately before the caret.
    function getMentionMatch(): { query: string; range: Range } | null {
        if (!wysiwygEl) return null;
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
        const caretRange = selection.getRangeAt(0);
        if (!wysiwygEl.contains(caretRange.startContainer)) return null;
        if (caretRange.startContainer.nodeType !== Node.TEXT_NODE) return null;
        const textNode = caretRange.startContainer as Text;
        const offset = caretRange.startOffset;
        const textBefore = textNode.textContent?.slice(0, offset) ?? '';
        const match = textBefore.match(/@([^\s@]*)$/);
        if (!match) return null;
        const atIndex = offset - match[0].length;
        if (atIndex > 0) {
            const charBefore = textBefore[atIndex - 1];
            // Avoid triggering inside emails like user@domain
            if (charBefore && /[\w.]/.test(charBefore)) return null;
        }
        const range = document.createRange();
        range.setStart(textNode, atIndex);
        range.setEnd(textNode, offset);
        return { query: match[1], range };
    }

    function updateMentionPopup() {
        if (!previewEditMode || !wysiwygEl) {
            if (showMentionPopup) closeMentionPopup();
            return;
        }
        const mention = getMentionMatch();
        if (!mention) {
            if (showMentionPopup) closeMentionPopup();
            return;
        }
        savedMentionRange = mention.range.cloneRange();
        mentionQuery = mention.query;
        showMentionPopup = true;
        const rect = mention.range.getBoundingClientRect();
        const top = Math.min(rect.bottom + 4, window.innerHeight - 240);
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - 328);
        mentionPopupStyle = `top:${Math.max(8, top)}px;left:${left}px;`;
    }

    // Inline tags that should not wrap a file mention (looks wrong + breaks markdown).
    function isInlineFormatElement(el: Element): boolean {
        const tag = el.tagName;
        if (tag === 'B' || tag === 'STRONG' || tag === 'I' || tag === 'EM' || tag === 'U' ||
            tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || tag === 'CODE') {
            return true;
        }
        // WYSIWYG auto-matched inline code spans
        if (tag === 'SPAN' && (el.getAttribute('style') || '').includes(INLINE_CODE_STYLE_MARKER)) {
            return true;
        }
        return false;
    }

    // Lift node out of bold/italic/etc. so the mention is unformatted.
    function liftOutOfInlineFormatting(node: Node, root: HTMLElement) {
        while (node.parentElement && node.parentElement !== root && isInlineFormatElement(node.parentElement)) {
            const parent = node.parentElement;
            const grand = parent.parentNode;
            if (!grand) break;

            const afterParent = parent.cloneNode(false) as HTMLElement;
            let sibling = node.nextSibling;
            while (sibling) {
                const next = sibling.nextSibling;
                afterParent.appendChild(sibling);
                sibling = next;
            }

            grand.insertBefore(node, parent.nextSibling);
            if (afterParent.childNodes.length > 0) {
                grand.insertBefore(afterParent, node.nextSibling);
            }
            if (!parent.hasChildNodes()) parent.remove();
        }
    }

    function insertFileMention(file: TabMeta) {
        if (!wysiwygEl || !savedMentionRange) return;
        const historyBefore = captureWysiwygHistoryState();
        // Prefer the underlying source file so the link stays valid if a preview tab is closed.
        const targetId = file.type === 'preview' && file.sourceFileId ? file.sourceFileId : file.fileId;
        const href = playgroundFileHref(targetId);
        const html = fileMentionHtml(href, file.fileName, getLanguageForTab(targetId));
        const range = savedMentionRange.cloneRange();
        closeMentionPopup();
        wysiwygEl.focus();

        // DOM insert (not execCommand) so we can place the caret immediately after the
        // contenteditable=false mention. Browsers otherwise park it at the end of the block.
        range.deleteContents();
        const template = document.createElement('template');
        template.innerHTML = html;
        const mentionNode = template.content.firstElementChild;
        if (!mentionNode) return;
        range.insertNode(mentionNode);
        // Don't keep bold/italic/code wrappers around the mention.
        liftOutOfInlineFormatting(mentionNode, wysiwygEl);

        // Zero-width space gives the caret a text node to sit in after the atomic mention.
        const zwsp = document.createTextNode('\u200B');
        mentionNode.after(zwsp);
        const selection = window.getSelection();
        const caret = document.createRange();
        caret.setStart(zwsp, 1);
        caret.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(caret);

        handleWysiwygInput();
        finishWysiwygHistoryEntry(historyBefore);
    }

    function selectMentionByIndex(index: number) {
        if (mentionFilteredFiles.length === 0) return;
        const file = mentionFilteredFiles[index];
        if (file) insertFileMention(file);
    }

    function applyWysiwygCommand(command: string, value?: string) {
        if (!wysiwygEl) return;
        runWysiwygHistoryTransaction(() => {
            wysiwygEl?.focus();
            document.execCommand(command, false, value);
            handleWysiwygInput();
        });
    }

    function isFileMentionEl(node: Node | null | undefined): node is HTMLElement {
        return !!node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).classList?.contains(FILE_MENTION_CLASS);
    }

    function isZwspOnlyText(node: Node | null | undefined): boolean {
        return !!node && node.nodeType === Node.TEXT_NODE && /^[\u200B]*$/.test(node.textContent || '');
    }

    function removeFileMention(mention: HTMLElement) {
        if (!wysiwygEl) return;
        const historyBefore = captureWysiwygHistoryState();
        // Drop caret-anchor ZWSPs next to the mention
        const prev = mention.previousSibling;
        const next = mention.nextSibling;
        if (isZwspOnlyText(prev)) prev?.parentNode?.removeChild(prev);
        if (isZwspOnlyText(next)) next?.parentNode?.removeChild(next);

        const parent = mention.parentNode;
        const anchor = document.createTextNode('\u200B');
        parent?.insertBefore(anchor, mention);
        mention.remove();

        const selection = window.getSelection();
        const caret = document.createRange();
        caret.setStart(anchor, 0);
        caret.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(caret);
        handleWysiwygInput();
        finishWysiwygHistoryEntry(historyBefore);
    }

    // Mention immediately before a collapsed caret (skipping ZWSP anchors).
    function fileMentionBeforeCaret(): HTMLElement | null {
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed || selection.rangeCount === 0 || !wysiwygEl) return null;
        const range = selection.getRangeAt(0);
        if (!wysiwygEl.contains(range.startContainer)) return null;

        const node = range.startContainer;
        const offset = range.startOffset;

        if (node.nodeType === Node.TEXT_NODE) {
            const before = (node.textContent || '').slice(0, offset);
            // Real characters before the caret → not adjacent to a mention
            if (before.replace(/\u200B/g, '').length > 0) return null;
            let prev: Node | null = offset === 0 || /^[\u200B]*$/.test(before) ? node.previousSibling : null;
            // Caret inside a ZWSP-only text node after a mention
            if (!prev && /^[\u200B]*$/.test(before)) prev = node.previousSibling;
            while (prev && isZwspOnlyText(prev)) prev = prev.previousSibling;
            if (isFileMentionEl(prev)) return prev;
            return null;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            let i = offset - 1;
            while (i >= 0) {
                const child = node.childNodes[i];
                if (isZwspOnlyText(child)) { i--; continue; }
                if (isFileMentionEl(child)) return child;
                break;
            }
        }
        return null;
    }

    // Mention immediately after a collapsed caret (skipping ZWSP anchors).
    function fileMentionAfterCaret(): HTMLElement | null {
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed || selection.rangeCount === 0 || !wysiwygEl) return null;
        const range = selection.getRangeAt(0);
        if (!wysiwygEl.contains(range.startContainer)) return null;

        const node = range.startContainer;
        const offset = range.startOffset;

        if (node.nodeType === Node.TEXT_NODE) {
            const after = (node.textContent || '').slice(offset);
            if (after.replace(/\u200B/g, '').length > 0) return null;
            let next: Node | null = node.nextSibling;
            while (next && isZwspOnlyText(next)) next = next.nextSibling;
            if (isFileMentionEl(next)) return next;
            return null;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            let i = offset;
            while (i < node.childNodes.length) {
                const child = node.childNodes[i];
                if (isZwspOnlyText(child)) { i++; continue; }
                if (isFileMentionEl(child)) return child;
                break;
            }
        }
        return null;
    }

    // Keyboard shortcuts while editing the WYSIWYG area: Ctrl/Cmd+B bold,
    // Ctrl/Cmd+I italic, Ctrl/Cmd+Shift+X strikethrough, Ctrl/Cmd+E inline
    // code, Ctrl/Cmd+K insert link. Also navigates the @-mention popup and
    // deletes file mentions atomically on Backspace/Delete.
    function handleWysiwygKeydown(e: KeyboardEvent) {
        if ((e.metaKey || e.ctrlKey) && !e.altKey) {
            const historyKey = e.key.toLowerCase();
            if (!e.shiftKey && historyKey === 'z') {
                e.preventDefault();
                e.stopPropagation();
                undoWysiwygHistory();
                return;
            }
            if ((e.shiftKey && historyKey === 'z') || (!e.shiftKey && historyKey === 'y')) {
                e.preventDefault();
                e.stopPropagation();
                redoWysiwygHistory();
                return;
            }
            if (!e.shiftKey && historyKey === 'f') {
                e.preventDefault();
                e.stopPropagation();
                openWysiwygFind();
                return;
            }
        }
        if (wysiwygFindOpen && e.key === 'Escape') {
            e.preventDefault();
            closeWysiwygFind();
            return;
        }
        if (showMentionPopup) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (mentionFilteredFiles.length === 0) return;
                mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionFilteredFiles.length;
                scrollSelectedMentionIntoView();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (mentionFilteredFiles.length === 0) return;
                mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionFilteredFiles.length) % mentionFilteredFiles.length;
                scrollSelectedMentionIntoView();
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                if (mentionFilteredFiles.length > 0) {
                    e.preventDefault();
                    selectMentionByIndex(mentionSelectedIndex);
                    return;
                }
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeMentionPopup();
                return;
            }
        }

        // Tab/Shift+Tab indents/outdents list items (including checklists).
        if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const historyBefore = captureWysiwygHistoryState();
            if (handleWysiwygTab(e)) {
                e.preventDefault();
                finishWysiwygHistoryEntry(historyBefore);
                return;
            }
        }

        // Checklist: Enter continues with a new checkbox; empty item breaks out.
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const taskItem = getListItemFromSelection();
            if (taskItem && isTaskListItem(taskItem)) {
                const historyBefore = captureWysiwygHistoryState();
                e.preventDefault();
                if (handleTaskListEnter(taskItem)) {
                    handleWysiwygInput();
                    finishWysiwygHistoryEntry(historyBefore);
                }
                return;
            }
        }

        // Code block: Enter inserts a new line inside the block (staying in
        // it); Enter on an empty last line exits the block (an empty line in
        // the middle just adds a new line).
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const pre = getPreFromSelection();
            if (!pre) return;
            const historyBefore = captureWysiwygHistoryState();
            e.preventDefault();
            const selection = window.getSelection();
            const line = selection && selection.isCollapsed ? emptyLineInPre(pre) : null;
            if (line && line.end === line.total) {
                escapeWysiwygCodeBlock(pre, line);
            } else {
                insertNewlineInPre();
            }
            handleWysiwygInput();
            finishWysiwygHistoryEntry(historyBefore);
        }

        // Backspace at the start of a task item removes the checkbox.
        if (e.key === 'Backspace' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const historyBefore = captureWysiwygHistoryState();
            if (handleTaskListBackspace()) {
                e.preventDefault();
                finishWysiwygHistoryEntry(historyBefore);
                return;
            }
            if (handlePlainItemBackspaceIntoTask()) {
                e.preventDefault();
                finishWysiwygHistoryEntry(historyBefore);
                return;
            }
        }

        // Delete at a task-list boundary: merge manually so the browser never
        // rebuilds the <li> (which drops the checkbox inputs).
        if (e.key === 'Delete' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const historyBefore = captureWysiwygHistoryState();
            if (handleTaskBoundaryDelete()) {
                e.preventDefault();
                finishWysiwygHistoryEntry(historyBefore);
                return;
            }
        }

        // One Backspace/Delete removes the whole mention (not just the ZWSP caret anchor,
        // and not the browser's intermediate "select the atom" step).
        if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
            const selection = window.getSelection();
            // Browser may already have selected the atomic mention
            if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const frag = range.cloneContents();
                const nodes = Array.from(frag.childNodes).filter(
                    (n) => !(n.nodeType === Node.TEXT_NODE && /^[\u200B]*$/.test(n.textContent || ''))
                );
                if (nodes.length === 1 && isFileMentionEl(nodes[0])) {
                    // Resolve the live node from the selection range
                    let live: HTMLElement | null = null;
                    if (isFileMentionEl(range.startContainer)) {
                        live = range.startContainer;
                    } else if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
                        for (let i = range.startOffset; i < range.startContainer.childNodes.length; i++) {
                            const c = range.startContainer.childNodes[i];
                            if (isZwspOnlyText(c)) continue;
                            if (isFileMentionEl(c)) { live = c; break; }
                            break;
                        }
                    }
                    if (!live) {
                        live = (range.commonAncestorContainer as Element).closest?.(`.${FILE_MENTION_CLASS}`) as HTMLElement | null;
                    }
                    if (live && wysiwygEl?.contains(live)) {
                        e.preventDefault();
                        removeFileMention(live);
                        return;
                    }
                }
            }

            const mention = e.key === 'Backspace' ? fileMentionBeforeCaret() : fileMentionAfterCaret();
            if (mention) {
                e.preventDefault();
                removeFileMention(mention);
                return;
            }
        }

        if (!e.metaKey && !e.ctrlKey) return;
        const key = e.key.toLowerCase();
        if (key === 'a' && !e.shiftKey && !e.altKey) {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            const pre = getPreFromSelection();
            if (!pre) return;
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0) return;
            const end = selection.getRangeAt(0).endContainer;
            if (end !== pre && !pre.contains(end)) return;
            e.preventDefault();
            e.stopPropagation();
            selectAllInWysiwygCodeBlock(pre);
            return;
        }
        if (key === 'b' && !e.shiftKey && !e.altKey) {
            const selection = window.getSelection();
            const hasTextSelection =
                !!selection &&
                !selection.isCollapsed &&
                selection.rangeCount > 0 &&
                !!wysiwygEl &&
                !!selection.anchorNode &&
                !!selection.focusNode &&
                wysiwygEl.contains(selection.anchorNode) &&
                wysiwygEl.contains(selection.focusNode) &&
                selection.toString().replace(/\u200B/g, '').trim().length > 0;
            if (!hasTextSelection) {
                // No text selected inside the WYSIWYG editor — let the global
                // Cmd/Ctrl+B handler toggle the sidebar instead of applying bold.
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            applyWysiwygCommand('bold');
        } else if (key === 'i' && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            applyWysiwygCommand('italic');
        } else if (key === 'x' && e.shiftKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            applyWysiwygCommand('strikeThrough');
        } else if (key === 'e' && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            runWysiwygHistoryTransaction(() => toggleInlineCode());
        } else if (key === 'k' && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            openLinkInput();
        }
    }

    // Toolbar buttons run on mousedown (preventDefault) so the text selection
    // inside the editable area is preserved.
    function handleToolbarMouseDown(event: MouseEvent) {
        const btn = (event.target as HTMLElement).closest('button[data-command]') as HTMLButtonElement | null;
        if (!btn) return;
        event.preventDefault();
        const command = btn.dataset.command!;
        if (command === 'link') {
            openLinkInput();
            return;
        }
        if (command === 'inlineCode') {
            runWysiwygHistoryTransaction(() => toggleInlineCode());
            return;
        }
        if (command === 'insertHorizontalRule') {
            runWysiwygHistoryTransaction(() => {
                if (insertWysiwygHorizontalRule()) handleWysiwygInput();
            });
            return;
        }
        if (command === 'insertTaskList') {
            runWysiwygHistoryTransaction(() => insertOrToggleTaskList());
            return;
        }
        if (command === 'codeBlock') {
            runWysiwygHistoryTransaction(() => toggleCodeBlock());
            return;
        }
        applyWysiwygCommand(command, btn.dataset.value);
    }

    // Keyboard-triggered clicks (Enter/Space) have detail === 0 and don't fire mousedown
    function handleToolbarClick(event: MouseEvent) {
        if (event.detail !== 0) return;
        const btn = (event.target as HTMLElement).closest('button[data-command]') as HTMLButtonElement | null;
        if (!btn) return;
        const command = btn.dataset.command!;
        if (command === 'link') {
            openLinkInput();
            return;
        }
        if (command === 'inlineCode') {
            runWysiwygHistoryTransaction(() => toggleInlineCode());
            return;
        }
        if (command === 'insertHorizontalRule') {
            runWysiwygHistoryTransaction(() => {
                if (insertWysiwygHorizontalRule()) handleWysiwygInput();
            });
            return;
        }
        if (command === 'insertTaskList') {
            runWysiwygHistoryTransaction(() => insertOrToggleTaskList());
            return;
        }
        if (command === 'codeBlock') {
            runWysiwygHistoryTransaction(() => toggleCodeBlock());
            return;
        }
        applyWysiwygCommand(command, btn.dataset.value);
    }

    function openLinkInput() {
        if (!wysiwygEl) return;
        savedLinkHistoryBefore = captureWysiwygHistoryState();
        const selection = window.getSelection();
        savedLinkRange = selection && selection.rangeCount > 0 && wysiwygEl.contains(selection.anchorNode)
            ? selection.getRangeAt(0).cloneRange()
            : null;
        showLinkInput = true;
        tick().then(() => linkInputEl?.focus());
    }

    function applyLink() {
        const url = linkUrl.trim();
        if (url && wysiwygEl) {
            runWysiwygHistoryTransaction(() => {
                wysiwygEl?.focus();
                if (savedLinkRange) {
                    const selection = window.getSelection();
                    selection?.removeAllRanges();
                    selection?.addRange(savedLinkRange);
                }
                const linkFileId = extractPlaygroundFileId(url);
                if (linkFileId) {
                    // Insert file links as mention chips directly: execCommand
                    // createLink does not reliably create links for custom
                    // schemes, and only wysiwyg:// links become mentions.
                    const linkSelection = window.getSelection();
                    const linkLabel = (linkSelection && !linkSelection.isCollapsed
                        ? (linkSelection.toString() ?? '').trim()
                        : '') || fileLabelFor(linkFileId, url);
                    insertHtmlAtSelection(fileMentionHtml(playgroundFileHref(linkFileId), linkLabel, getLanguageForTab(linkFileId)));
                    ensureWysiwygLinksOpenInNewTab();
                    handleWysiwygInput();
                    return;
                }
                const href = isUrlLike(url) ? normalizeUrl(url) : url;
                insertLinkAtSelection(href, url);
                ensureWysiwygLinksOpenInNewTab();
                handleWysiwygInput();
            }, savedLinkHistoryBefore);
        }
        showLinkInput = false;
        linkUrl = '';
        savedLinkRange = null;
        savedLinkHistoryBefore = null;
    }

    // Custom context menu when right-clicking a link in WYSIWYG or Preview.
    let linkContextMenu: { href: string; left: number; top: number } | null = null;
    let linkContextMenuEl: HTMLDivElement | null = null;

    function closeLinkContextMenu() {
        linkContextMenu = null;
    }

    async function handleLinkContextMenu(event: MouseEvent) {
        const container = event.currentTarget as HTMLElement | null;
        const href = findLinkHrefAtTarget(event.target, container);
        if (!href) {
            closeLinkContextMenu();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1000;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
        const initial = clampMenuPosition(event.clientX, event.clientY, 180, 76, vw, vh);
        linkContextMenu = { href, left: initial.left, top: initial.top };
        await tick();
        if (linkContextMenu && linkContextMenuEl) {
            const rect = linkContextMenuEl.getBoundingClientRect();
            const clamped = clampMenuPosition(event.clientX, event.clientY, rect.width, rect.height, vw, vh);
            linkContextMenu = { href: linkContextMenu.href, left: clamped.left, top: clamped.top };
        }
    }

    async function handleCopyLinkFromMenu() {
        const href = linkContextMenu?.href;
        closeLinkContextMenu();
        if (!href) return;
        await copyTextToClipboard(href, onCopyText);
    }

    function handleOpenLinkFromMenu() {
        const href = linkContextMenu?.href;
        closeLinkContextMenu();
        if (!href) return;
        onOpenLink(href);
    }

    // ===== VSCode port: window-level handlers (from the playground's onMount)
    onMount(() => {
        const handleDocClick = (e: MouseEvent) => {
            if (showMentionPopup) {
                const target = e.target as HTMLElement;
                if (!target.closest('.mention-popup') && !wysiwygEl?.contains(target)) closeMentionPopup();
            }
        };
        const handleDocMouseDown = (e: MouseEvent) => {
            if (linkContextMenu) {
                const target = e.target instanceof Element ? e.target : null;
                if (!target?.closest('.link-context-menu')) closeLinkContextMenu();
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            if (e.key === 'Escape') {
                if (linkContextMenu) {
                    closeLinkContextMenu();
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                closeLightbox();
                closeMentionPopup();
            }
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && previewEditMode) {
                e.preventDefault();
                e.stopPropagation();
                openWysiwygFind();
            }
        };
        const handleUnload = () => commitWysiwygEdits();
        document.addEventListener('click', handleDocClick);
        document.addEventListener('mousedown', handleDocMouseDown, true);
        window.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('scroll', closeLinkContextMenu, true);
        window.addEventListener('blur', closeLinkContextMenu);
        window.addEventListener('beforeunload', handleUnload);
        if (mode === 'wysiwyg') void enterPreviewEditMode(true);
        return () => {
            document.removeEventListener('click', handleDocClick);
            document.removeEventListener('mousedown', handleDocMouseDown, true);
            window.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('scroll', closeLinkContextMenu, true);
            window.removeEventListener('blur', closeLinkContextMenu);
            window.removeEventListener('beforeunload', handleUnload);
        };
    });
    onDestroy(() => commitWysiwygEdits());
</script>

<div class="md-editor-root">
    <div class="md-editor-header">
            <div class="markdown-mode-switch" role="group" aria-label="Markdown view mode">
                <button
                    class="markdown-mode-btn"
                    class:active={previewEditMode}
                    title="WYSIWYG"
                    aria-label="WYSIWYG"
                    aria-pressed={previewEditMode}
                    on:click={() => setMode('wysiwyg')}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M12 3l1.09 3.34L16.5 7.5l-3.41 1.16L12 12l-1.09-3.34L7.5 7.5l3.41-1.16L12 3z" fill="currentColor"/>
                        <path d="M18.5 13l.7 2.15L21.5 16l-2.3.78L18.5 19l-.7-2.22L15.5 16l2.3-.85L18.5 13z" fill="currentColor"/>
                        <path d="M6.5 14l.55 1.68L8.8 16.3l-1.75.6L6.5 18.6l-.55-1.7L4.2 16.3l1.75-.62L6.5 14z" fill="currentColor"/>
                    </svg>
                    WYSIWYG
                </button>
                <button
                    class="markdown-mode-btn"
                    class:active={!previewEditMode}
                    title="Preview"
                    aria-label="Preview"
                    aria-pressed={!previewEditMode}
                    on:click={() => setMode('preview')}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Preview
                </button>
                <button
                    class="markdown-mode-btn"
                    title="Source"
                    aria-label="Source"
                    aria-pressed={false}
                    on:click={() => setMode('source')}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Source
                </button>
            </div>
    </div>
    <div class="editor-container">
    {#if previewEditMode}
        <div class="wysiwyg-container">
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div class="wysiwyg-toolbar" on:mousedown={handleToolbarMouseDown} on:click={handleToolbarClick}>
                <Tooltip text={isMac ? "Cmd+B" : "Ctrl+B"} pos="right">
                    <button type="button" data-command="bold" aria-label="Bold">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>
                    </button>
                </Tooltip>
                <Tooltip text={isMac ? "Cmd+I" : "Ctrl+I"} pos="bottom">
                    <button type="button" data-command="italic" aria-label="Italic">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>
                    </button>
                </Tooltip>
                <Tooltip text={isMac ? "Cmd+Shift+X" : "Ctrl+Shift+X"} pos="bottom">
                    <button type="button" data-command="strikeThrough" aria-label="Strikethrough">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/></svg>
                    </button>
                </Tooltip>
                <span class="wysiwyg-separator"></span>
                <button type="button" data-command="formatBlock" data-value="h1" title="Heading 1" aria-label="Heading 1"><span class="wysiwyg-text-btn">H1</span></button>
                <button type="button" data-command="formatBlock" data-value="h2" title="Heading 2" aria-label="Heading 2"><span class="wysiwyg-text-btn">H2</span></button>
                <button type="button" data-command="formatBlock" data-value="h3" title="Heading 3" aria-label="Heading 3"><span class="wysiwyg-text-btn">H3</span></button>
                <span class="wysiwyg-separator"></span>
                <button type="button" data-command="insertUnorderedList" title="Bulleted list" aria-label="Bulleted list">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                </button>
                <button type="button" data-command="insertOrderedList" title="Numbered list" aria-label="Numbered list">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>
                </button>
                <button type="button" data-command="insertTaskList" title="Checklist" aria-label="Checklist">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="m4 8 1.5 1.5L9 6"/><line x1="13" y1="8" x2="21" y2="8"/><rect x="3" y="13" width="6" height="6" rx="1"/><line x1="13" y1="16" x2="21" y2="16"/></svg>
                </button>
                <button type="button" data-command="formatBlock" data-value="blockquote" title="Quote" aria-label="Quote">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1zm12 0c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
                </button>
                <button type="button" data-command="codeBlock" title="Code block" aria-label="Code block">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                </button>
                <Tooltip text={isMac ? "Cmd+E" : "Ctrl+E"} pos="bottom">
                    <button type="button" data-command="inlineCode" aria-label="Inline code">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
                    </button>
                </Tooltip>
                <button type="button" data-command="insertHorizontalRule" title="Horizontal rule" aria-label="Horizontal rule">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="12" x2="20" y2="12"/></svg>
                </button>
                <span class="wysiwyg-separator"></span>
                <Tooltip text={isMac ? "Cmd+K" : "Ctrl+K"} pos="bottom">
                    <button type="button" data-command="link" aria-label="Insert link">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    </button>
                </Tooltip>
                <button type="button" data-command="removeFormat" title="Clear formatting" aria-label="Clear formatting">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>
                </button>
                {#if showLinkInput}
                    <input
                        class="wysiwyg-link-input"
                        type="text"
                        placeholder="https://example.com"
                        aria-label="Link URL"
                        bind:value={linkUrl}
                        bind:this={linkInputEl}
                        on:keydown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
                            else if (e.key === 'Escape') { e.preventDefault(); showLinkInput = false; linkUrl = ''; savedLinkRange = null; savedLinkHistoryBefore = null; }
                        }}
                    />
                {/if}
            </div>
            {#if wysiwygFindOpen}
                <div class="wysiwyg-find-bar" role="search" aria-label="Find in document">
                    <div class="wysiwyg-find-input-wrap">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                        <input
                            class="wysiwyg-find-input"
                            type="text"
                            placeholder="Find"
                            aria-label="Find"
                            value={wysiwygFindQuery}
                            bind:this={wysiwygFindInputEl}
                            on:input={(e) => { wysiwygFindQuery = (e.currentTarget as HTMLInputElement).value; updateWysiwygFindHighlights(); }}
                            on:keydown={handleWysiwygFindInputKeydown}
                        />
                        {#if wysiwygFindQuery}
                            <span class="wysiwyg-find-count">
                                {#if wysiwygFindMatches.length === 0}
                                    No results
                                {:else}
                                    {wysiwygFindActiveIndex + 1} of {wysiwygFindMatches.length}
                                {/if}
                            </span>
                        {/if}
                    </div>
                    <div class="wysiwyg-find-actions">
                        <button
                            type="button"
                            class="wysiwyg-find-toggle {wysiwygFindCaseSensitive ? 'active' : ''}"
                            title="Match Case"
                            aria-label="Match Case"
                            aria-pressed={wysiwygFindCaseSensitive}
                            on:click={() => { wysiwygFindCaseSensitive = !wysiwygFindCaseSensitive; updateWysiwygFindHighlights(); wysiwygFindInputEl?.focus(); }}
                        >Aa</button>
                        <button
                            type="button"
                            class="wysiwyg-find-toggle {wysiwygFindWholeWord ? 'active' : ''}"
                            title="Match Whole Word"
                            aria-label="Match Whole Word"
                            aria-pressed={wysiwygFindWholeWord}
                            on:click={() => { wysiwygFindWholeWord = !wysiwygFindWholeWord; updateWysiwygFindHighlights(); wysiwygFindInputEl?.focus(); }}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="1"/><path d="M8 9h8M8 13h5M8 17h8"/></svg>
                        </button>
                        <button
                            type="button"
                            class="wysiwyg-find-toggle {wysiwygFindRegex ? 'active' : ''}"
                            title="Use Regular Expression"
                            aria-label="Use Regular Expression"
                            aria-pressed={wysiwygFindRegex}
                            on:click={() => { wysiwygFindRegex = !wysiwygFindRegex; updateWysiwygFindHighlights(); wysiwygFindInputEl?.focus(); }}
                        >.*</button>
                    </div>
                    <div class="wysiwyg-find-nav">
                        <button
                            type="button"
                            class="wysiwyg-find-nav-btn"
                            title="Previous Match (Shift+Enter)"
                            aria-label="Previous Match"
                            on:click={() => nextWysiwygFindMatch(-1)}
                            disabled={wysiwygFindMatches.length === 0}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6"/></svg>
                        </button>
                        <button
                            type="button"
                            class="wysiwyg-find-nav-btn"
                            title="Next Match (Enter)"
                            aria-label="Next Match"
                            on:click={() => nextWysiwygFindMatch(1)}
                            disabled={wysiwygFindMatches.length === 0}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
                        </button>
                    </div>
                    <button
                        type="button"
                        class="wysiwyg-find-close"
                        title="Close (Esc)"
                        aria-label="Close"
                        on:click={closeWysiwygFind}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            {/if}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
                class="markdown-preview markdown-body wysiwyg-editing"
                style="font-size: {fontSize}px;"
                contenteditable="true"
                role="textbox"
                aria-multiline="true"
                aria-label="Markdown editor (WYSIWYG)"
                tabindex="0"
                bind:this={wysiwygEl}
                on:beforeinput={handleWysiwygBeforeInput}
                on:input={handleWysiwygInput}
                on:keydown={handleWysiwygKeydown}
                on:paste={handleWysiwygPaste}
                on:click={handleWysiwygClick}
                on:contextmenu={handleLinkContextMenu}
                on:change={handleWysiwygChange}
                on:blur={handleWysiwygBlur}
            ></div>
            <datalist id={CODE_LANGUAGE_DATALIST_ID}>
                {#each CODE_LANGUAGE_OPTIONS as option}
                    <option value={option.value} label={option.label}></option>
                {/each}
            </datalist>
        </div>
    {:else}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="markdown-preview markdown-body" bind:this={previewEl} on:click={handlePreviewClick} on:contextmenu={handleLinkContextMenu}>
            {@html previewHtml}
        </div>
    {/if}

    {#if activeLangPicker}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="lang-picker-backdrop" on:click={closeLangPicker}></div>
        <div
            class="lang-picker-popover"
            style="position: fixed; top: {activeLangPicker.rect.bottom + 4}px; left: {Math.max(8, Math.min((typeof window !== 'undefined' ? window.innerWidth : 1000) - 230, activeLangPicker.rect.right - 220))}px;"
            role="dialog"
            aria-label="Select code block language"
        >
            <div class="lang-picker-search">
                <input
                    type="text"
                    class="lang-search-input"
                    placeholder="Search for a language..."
                    bind:value={langSearchQuery}
                    bind:this={langSearchInputEl}
                    on:keydown={handleLangSearchKeyDown}
                    on:input={(e) => {
                        const q = (e.target as HTMLInputElement).value;
                        if (!q.trim()) {
                            const normalized = normalizeCodeLanguage(activeLangPicker?.currentLang ?? '');
                            const fallback = CODE_LANGUAGE_OPTIONS.findIndex((opt) => normalizeCodeLanguage(opt.value) === normalized);
                            langSelectedIndex = fallback >= 0 ? fallback : 0;
                        } else {
                            langSelectedIndex = 0;
                        }
                        scrollLangSelectedIntoView();
                    }}
                    aria-autocomplete="list"
                    aria-controls="lang-picker-list"
                    aria-activedescendant={filteredLanguages[langSelectedIndex] ? `lang-option-${filteredLanguages[langSelectedIndex].value}` : undefined}
                />
            </div>
            <div class="lang-picker-list" bind:this={langPickerListEl} id="lang-picker-list" role="listbox">
                {#each filteredLanguages as option, i}
                    <button
                        type="button"
                        id={`lang-option-${option.value}`}
                        role="option"
                        aria-selected={i === langSelectedIndex}
                        class="lang-picker-option {normalizeCodeLanguage(option.value) === normalizeCodeLanguage(activeLangPicker.currentLang) ? 'selected' : ''} {i === langSelectedIndex ? 'focused' : ''}"
                        on:click={() => selectCodeLanguage(option.value)}
                        on:mouseenter={() => langSelectedIndex = i}
                    >
                        <span class="lang-option-label">{option.label}</span>
                        {#if normalizeCodeLanguage(option.value) === normalizeCodeLanguage(activeLangPicker.currentLang)}
                            <svg class="lang-check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                        {/if}
                    </button>
                {/each}
                {#if filteredLanguages.length === 0 && langSearchQuery.trim()}
                    <button
                        type="button"
                        role="option"
                        aria-selected="true"
                        class="lang-picker-option custom-lang {langSelectedIndex === 0 ? 'focused' : ''}"
                        on:click={() => selectCodeLanguage(langSearchQuery.trim())}
                        on:mouseenter={() => langSelectedIndex = 0}
                    >
                        <span class="lang-option-label">Use "{langSearchQuery.trim()}"</span>
                    </button>
                {/if}
            </div>
        </div>
    {/if}
    {#if linkContextMenu}
        <div
            class="link-context-menu"
            bind:this={linkContextMenuEl}
            style="left: {linkContextMenu.left}px; top: {linkContextMenu.top}px;"
            role="menu"
            aria-label="Link actions"
        >
            <button
                type="button"
                class="link-context-menu-item"
                role="menuitem"
                on:click={handleCopyLinkFromMenu}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                <span>Copy Link</span>
            </button>
            <button
                type="button"
                class="link-context-menu-item"
                role="menuitem"
                on:click={handleOpenLinkFromMenu}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                    <polyline points="15 3 21 3 21 9"></polyline>
                    <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
                <span>Open Link</span>
            </button>
        </div>
    {/if}
    </div>
{#if lightboxSrc}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="image-lightbox" role="dialog" aria-modal="true" aria-label="Full-size image" tabindex="-1" on:click={closeLightbox}>
            <button type="button" class="lightbox-close" title="Close (Esc)" aria-label="Close image viewer" on:click|stopPropagation={closeLightbox}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
            <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
            <img src={lightboxSrc} alt="Full-size" on:click|stopPropagation={() => {}} />
        </div>
    {/if}
    {#if showMentionPopup}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="mention-popup" style={mentionPopupStyle} on:mousedown|preventDefault>
            <div class="mention-popup-header">Search files by name...</div>
            <div class="mention-results" bind:this={mentionResultsEl}>
                {#each mentionFilteredFiles as file, i}
                    <!-- svelte-ignore a11y-click-events-have-key-events -->
                    <div
                        class="mention-result-item {i === mentionSelectedIndex ? 'selected' : ''}"
                        on:click={() => insertFileMention(file)}
                        on:mouseenter={() => mentionSelectedIndex = i}
                    >
                        <span class="search-file-info">
                            {@html languageIconSvg(tabLanguages[file.fileId] ?? 'markdown', 17)}
                            <span class="search-file-name">{file.fileName}</span>
                        </span>
                        <span class="search-file-meta">
                            {#if getFilePath(file.fileId) !== '/'}
                                <span class="search-file-path">{getFilePath(file.fileId).replace(/^\/|\/$/g, '')}</span>
                            {/if}
                        </span>
                    </div>
                {/each}
                {#if mentionFilteredFiles.length === 0}
                    <div class="search-no-results">No matching files</div>
                {/if}
            </div>
        </div>
    {/if}
</div>

<style>
    /* VSCode port: the editor fills the whole webview. */
    .md-editor-root {
        height: 100%;
        display: flex;
        flex-direction: column;
        background: var(--color-bg);
    }

    .md-editor-header {
        flex-shrink: 0;
        display: flex;
        justify-content: flex-end;
        align-items: center;
        padding: var(--spacing-1) var(--spacing-2);
        border-bottom: 1px solid var(--color-border);
    }

    .workspace {
        display: flex;
        flex-direction: row;
        height: 100vh;
        padding: 0;
        background-color: var(--color-bg); /* Use the main background */
    }

    .editor-pane {
        background-color: var(--color-surface); /* Floating surface */
        display: flex;
        flex-direction: column;
        overflow: hidden;
        flex: 1;
    }

    /* Activity Bar */
    .activity-bar {
        width: 48px;
        background-color: var(--color-bg);
        border-right: 1px solid var(--color-border);
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-top: var(--spacing-2);
        flex-shrink: 0;
        z-index: 10;
    }

    /* macOS-style auto-hide: bar slides off-canvas, reappears on left-edge hover */
    .workspace.auto-hide-activity-bar {
        position: relative;
    }
    .workspace.auto-hide-activity-bar .activity-bar-hover-zone {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 16px;
        z-index: 40;
        background: transparent;
    }
    .workspace.auto-hide-activity-bar .activity-bar {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        z-index: 41;
        transform: translateX(-102%);
        opacity: 0;
        pointer-events: none;
        transition:
            transform 0.22s ease 0.12s,
            opacity 0.18s ease 0.12s,
            box-shadow 0.22s ease;
        box-shadow: none;
    }
    .workspace.auto-hide-activity-bar .activity-bar-hover-zone:hover + .activity-bar,
    .workspace.auto-hide-activity-bar .activity-bar:hover,
    .workspace.auto-hide-activity-bar .activity-bar:focus-within {
        transform: translateX(0);
        opacity: 1;
        pointer-events: auto;
        transition-delay: 0s;
        box-shadow: 8px 0 24px rgba(0, 0, 0, 0.18);
    }
    @media (prefers-reduced-motion: reduce) {
        .workspace.auto-hide-activity-bar .activity-bar {
            transition: none;
        }
    }

    .activity-icon {
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: var(--color-text-secondary);
        cursor: pointer;
        position: relative;
        padding: 0;
    }

    .activity-icon:hover {
        color: var(--color-text);
    }

    .activity-icon.active {
        color: var(--color-text);
        border-left: 2px solid var(--color-highlight); /* Visual indicator */
    }

    .cloud-icon-legend {
        position: absolute;
        top: 5px;
        right: 6px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--color-medium);
        box-shadow: 0 0 0 2px var(--color-bg);
    }

    .cloud-icon-legend.loading {
        background: transparent;
        border: 1.5px solid var(--color-text-secondary);
        border-top-color: var(--color-highlight, var(--color-text));
        box-shadow: 0 0 0 1px var(--color-bg);
        animation: cloud-icon-spin 0.7s linear infinite;
    }

    .cloud-icon-legend.success,
    .cloud-icon-legend.error {
        background: transparent;
        border: none;
        box-shadow: 0 0 0 1px var(--color-bg);
        width: 12px;
        height: 12px;
    }

    .cloud-icon-legend.success::after {
        content: '';
        position: absolute;
        left: 6px;
        top: 0;
        width: 5px;
        height: 8px;
        border: solid #2ecc71;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
        animation: cloud-icon-success-pop 0.25s ease-out;
    }

    .cloud-icon-legend.error::before,
    .cloud-icon-legend.error::after {
        content: '';
        position: absolute;
        left: 6px;
        top: 2px;
        width: 8px;
        height: 2px;
        background: #e74c3c;
    }

    .cloud-icon-legend.error::before {
        transform: rotate(45deg);
    }

    .cloud-icon-legend.error::after {
        transform: rotate(-45deg);
    }

    @keyframes cloud-icon-success-pop {
        from {
            transform: rotate(45deg) scale(0.4);
            opacity: 0;
        }
        to {
            transform: rotate(45deg) scale(1);
            opacity: 1;
        }
    }

    @keyframes cloud-icon-spin {
        to {
            transform: rotate(360deg);
        }
    }

    .cloud-icon-offline {
        opacity: 0.5;
    }

    /* Sidebar Styles */
    .sidebar {
        width: 250px;
        background-color: var(--color-bg);
        border-right: 1px solid var(--color-border);
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
    }

    .sidebar-header {
        height: 53px; /* Match editor header height roughly */
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 var(--spacing-2);
        border-bottom: 1px solid var(--color-border);
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--color-text-secondary);
        letter-spacing: 0.05em;
    }

    .sidebar-header-actions {
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .import-file-input {
        display: none;
    }

    .add-menu-wrapper {
        position: relative;
    }

    .add-menu {
        position: absolute;
        top: 32px;
        right: 0;
        min-width: 140px;
        border: 1px solid var(--color-border);
        background-color: var(--color-bg);
        border-radius: 6px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        z-index: 20;
        padding: 4px;
        display: flex;
        flex-direction: column;
    }

    .add-menu-item {
        background: transparent;
        border: none;
        color: var(--color-text);
        text-align: left;
        padding: 8px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.85rem;
        white-space: nowrap;
    }

    .add-menu-item:hover {
        background-color: var(--color-second-bg);
    }

    .file-list {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-1) 0;
        min-height: 0;
    }

    .file-list.drag-over-root {
        box-shadow: inset 0 0 0 1px var(--color-highlight);
    }

    .sidebar.drag-over-root {
        box-shadow: inset 0 0 0 1px var(--color-highlight);
    }

    .file-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px var(--spacing-2);
        cursor: pointer;
        color: var(--color-text-secondary);
        font-size: 0.9rem;
        user-select: none;
        touch-action: none;
    }

    .file-item.is-dragging {
        opacity: 0.45;
    }

    .file-item.empty-folder-label {
        cursor: default;
        opacity: 0.5;
        font-style: italic;
    }

    .file-item.empty-folder-label:hover {
        background-color: transparent;
        color: var(--color-text-secondary);
    }

    :global(body.explorer-dragging) {
        cursor: grabbing !important;
        user-select: none !important;
    }

    :global(body.explorer-dragging .file-item) {
        cursor: grabbing;
    }

    .file-item:hover {
        background-color: var(--color-second-bg);
        color: var(--color-text);
    }

    .file-item.active {
        background-color: var(--color-third-bg);
        color: var(--color-text);
    }

    .file-item.dotfile {
        opacity: 0.6;
    }

    .file-item.drag-over-folder {
        background-color: var(--color-third-bg);
        box-shadow: inset 0 0 0 1px var(--color-highlight);
    }

    .folder-chevron {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-right: 2px;
        flex-shrink: 0;
        color: var(--color-text-secondary);
        background: transparent;
        border: none;
        padding: 2px;
        border-radius: 4px;
        cursor: pointer;
        touch-action: manipulation;
    }

    .folder-chevron:hover {
        background-color: rgba(255, 255, 255, 0.08);
        color: var(--color-text);
    }

    .folder-chevron svg {
        transition: transform 0.12s ease;
        display: block;
    }

    .folder-icon {
        color: var(--color-text-secondary);
    }

    .file-name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        user-select: none;
        -webkit-user-select: none;
    }

    .file-lang-icon {
        display: inline-flex;
        align-items: center;
        margin-right: 6px;
        flex-shrink: 0;
    }

    .file-actions {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        opacity: 0;
        pointer-events: none;
    }

    .file-item:hover .file-actions,
    .file-item.actions-open .file-actions {
        opacity: 1;
        pointer-events: auto;
    }

    .file-actions-menu {
        position: fixed;
        min-width: 156px;
        border: 1px solid var(--color-border);
        background-color: var(--color-bg);
        border-radius: 6px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        z-index: 1000;
        padding: 4px;
        display: flex;
        flex-direction: column;
    }

    .file-actions-menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        background: transparent;
        border: none;
        color: var(--color-text);
        text-align: left;
        padding: 6px 8px;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 0.82rem;
        white-space: nowrap;
    }

    .file-actions-menu-item svg {
        flex-shrink: 0;
        color: var(--color-text-secondary);
    }

    .file-actions-menu-item:hover {
        background-color: var(--color-second-bg);
    }

    .file-actions-menu-item:hover svg {
        color: var(--color-text);
    }

    .file-rename-input {
        background: var(--color-bg);
        border: 1px solid var(--color-highlight);
        color: var(--color-text);
        border-radius: 2px;
        padding: 2px 4px;
        font-size: 0.9rem;
        width: 100%;
        min-width: 0;
    }

    .rename-wrap {
        position: relative;
        display: inline-flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
    }

    .rename-warning {
        position: fixed;
        z-index: 60;
        max-width: 240px;
        padding: 3px 6px;
        border-radius: 4px;
        background: var(--color-third-bg);
        border: 1px solid #e53e3e;
        color: #e53e3e;
        font-size: 0.7rem;
        line-height: 1.3;
        white-space: normal;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    /* Search Panel Styles */
    .search-panel {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
    }

    .search-input-row {
        padding: var(--spacing-2);
    }

    .search-input-container {
        display: flex;
        align-items: center;
        border: 1px solid var(--color-border);
        border-radius: 2px;
        padding: 2px;
        transition: border-color 0.2s;
    }

    .search-input-container:focus-within {
        border-color: var(--color-highlight);
    }

    .search-input {
        width: 100%;
        background: transparent;
        border: none;
        color: var(--color-text);
        outline: none;
        font-family: inherit;
        flex: 1;
    }

    .search-input::placeholder {
        color: var(--color-text-secondary);
        opacity: 0.5;
    }

    .search-toggle-buttons {
        display: flex;
        gap: 2px;
        padding-right: 2px;
    }

    .search-toggle-btn {
        background: transparent;
        border: 1px solid transparent;
        color: var(--color-text-secondary);
        border-radius: 3px;
        padding: 1px 4px;
        font-size: 0.75rem;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-weight: 400;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 20px;
    }

    .search-toggle-btn:hover {
        background: var(--color-second-bg);
        color: var(--color-text);
    }

    .search-toggle-btn.active {
        color: var(--color-text);
        background: rgba(var(--color-highlight-rgb, 59, 130, 246), 0.3);
        border-color: var(--color-highlight);
    }

    .search-results-summary {
        padding: 4px var(--spacing-2);
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        opacity: 0.8;
    }

    .search-results {
        flex: 1;
        overflow-y: auto;
        padding: 0;
    }

    .search-result-group {
        margin-bottom: 0;
    }

    .search-result-file {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px var(--spacing-1);
        cursor: pointer;
        color: var(--color-text);
        font-size: 0.85rem;
        font-weight: 400;
        user-select: none;
    }

    .search-result-file-info {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: 1;
        min-width: 0;
    }

    .search-result-file:hover {
        background-color: var(--color-second-bg);
    }

    .chevron-icon {
        color: var(--color-text-secondary);
        opacity: 0.7;
        flex-shrink: 0;
        transition: transform 0.1s ease;
    }

    .file-icon {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
    }

    .search-result-count {
        margin-left: auto;
        background: var(--color-second-bg);
        color: var(--color-text-secondary);
        border-radius: 10px;
        padding: 0 6px;
        font-size: 0.7rem;
        font-weight: 600;
        min-width: 18px;
        text-align: center;
    }

    .search-result-match {
        display: flex;
        align-items: baseline;
        gap: 12px;
        padding: 2px var(--spacing-2) 2px 42px;
        cursor: pointer;
        font-size: 0.82rem;
        color: var(--color-text-secondary);
        white-space: nowrap;
    }

    .search-result-match:hover {
        background-color: var(--color-second-bg);
        color: var(--color-text);
    }

    .search-result-line {
        color: var(--color-text-secondary);
        opacity: 0.5;
        font-size: 0.75rem;
        flex-shrink: 0;
        min-width: 24px;
        text-align: right;
    }

    .search-result-text {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: pre;
        font-family: var(--font-mono, monospace);
        font-size: 0.8rem;
    }

    .search-result-text :global(mark), .search-result-file :global(mark) {
        background: rgba(234, 179, 8, 0.4); /* VSCode-like yellow highlight */
        color: inherit;
        border-radius: 1px;
    }

    /* Right Pane Layout */
    .editor-pane {
        padding: 0; /* No padding on the pane itself */
    }

    .exec-panel-host {
        display: contents;
    }
    .exec-panel-host.hidden {
        display: none;
    }

    .editor-container {
        flex-grow: 1;
        min-height: 0;
        padding: var(--spacing-1);
        display: flex;
        flex-direction: column;
    }

    .editor-container.whiteboard-active {
        padding: 0;
        position: relative;
        overflow: hidden;
    }

    .whiteboard-host {
        position: absolute;
        inset: 0;
        min-height: 0;
    }

    .markdown-preview {
        flex-grow: 1;
        min-height: 0;
        overflow-y: auto;
        padding: var(--spacing-4);
        width: 100%;
        text-align: left;
    }

    .markdown-preview img {
        max-width: 100%;
        box-sizing: content-box;
    }

    .markdown-preview a {
        color: var(--color-highlight);
        text-decoration: none;
    }

    .markdown-preview a:hover {
        text-decoration: underline;
    }

    /* WYSIWYG editing */
    .wysiwyg-container {
        flex-grow: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .wysiwyg-toolbar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 2px;
        padding: var(--spacing-1) var(--spacing-2);
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
    }

    .wysiwyg-toolbar button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 26px;
        height: 26px;
        padding: 0 4px;
        border-radius: 6px;
        background: transparent;
        color: var(--color-text-secondary);
        border: 1px solid transparent;
        cursor: pointer;
    }

    .wysiwyg-toolbar button:hover {
        background: var(--color-bg-tertiary, rgba(128, 128, 128, 0.15));
        color: var(--color-text);
    }

    .wysiwyg-text-btn {
        font-size: 0.72rem;
        font-weight: 700;
        font-family: inherit;
    }

    .wysiwyg-separator {
        width: 1px;
        height: 16px;
        background: var(--color-border);
        margin: 0 4px;
    }

    .wysiwyg-link-input {
        margin-left: var(--spacing-1);
        padding: 2px 8px;
        font-size: 0.8rem;
        border: 1px solid var(--color-border);
        border-radius: 6px;
        background: var(--color-bg);
        color: var(--color-text);
        min-width: 200px;
    }

    .wysiwyg-link-input:focus {
        outline: 1px solid var(--color-highlight);
        border-color: var(--color-highlight);
    }

    .wysiwyg-editing {
        outline: none;
        cursor: var(--cursor-text, text);
    }

    .wysiwyg-editing :global(a) {
        cursor: pointer;
    }

    .wysiwyg-editing:focus {
        box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--color-highlight) 40%, transparent);
        border-radius: var(--border-radius-md);
    }

    /* WYSIWYG find in document */
    .wysiwyg-find-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        background: var(--color-bg);
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
    }

    .wysiwyg-find-input-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
        min-width: 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        padding: 4px 8px;
    }

    .wysiwyg-find-input-wrap:focus-within {
        border-color: var(--color-highlight);
    }

    .wysiwyg-find-input {
        flex: 1;
        min-width: 0;
        background: transparent;
        border: none;
        outline: none;
        color: var(--color-text);
        font-size: 0.85rem;
        font-family: inherit;
    }

    .wysiwyg-find-count {
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        white-space: nowrap;
        flex-shrink: 0;
    }

    .wysiwyg-find-actions {
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .wysiwyg-find-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        height: 22px;
        padding: 0 4px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 0.7rem;
        font-family: var(--font-mono, monospace);
        cursor: pointer;
    }

    .wysiwyg-find-toggle:hover {
        background: var(--color-second-bg);
        color: var(--color-text);
    }

    .wysiwyg-find-toggle.active {
        background: rgba(var(--color-highlight-rgb, 59, 130, 246), 0.3);
        border-color: var(--color-highlight);
        color: var(--color-text);
    }

    .wysiwyg-find-nav {
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .wysiwyg-find-nav-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text-secondary);
        cursor: pointer;
    }

    .wysiwyg-find-nav-btn:hover:not(:disabled) {
        background: var(--color-second-bg);
        color: var(--color-text);
    }

    .wysiwyg-find-nav-btn:disabled {
        opacity: 0.4;
        cursor: default;
    }

    .wysiwyg-find-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
    }

    .wysiwyg-find-close:hover {
        background: var(--color-second-bg);
        color: var(--color-text);
    }

    :global(::highlight(wysiwyg-find)) {
        background-color: rgba(234, 179, 8, 0.4);
    }

    :global(::highlight(wysiwyg-find-active)) {
        background-color: rgba(234, 179, 8, 0.85);
    }

    :global(.wysiwyg-find-match) {
        background: rgba(234, 179, 8, 0.4);
        border-radius: 2px;
    }

    :global(.wysiwyg-find-match.wysiwyg-find-active) {
        background: rgba(234, 179, 8, 0.85);
        outline: 1px solid #eab308;
    }

    .icon-button.active {
        color: var(--color-highlight);
        background: color-mix(in srgb, var(--color-highlight) 15%, transparent);
    }

    .markdown-mode-switch {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 3px;
        border-radius: 999px;
        background: var(--color-second-bg);
    }

    .markdown-mode-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 0.8rem;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
    }

    .markdown-mode-btn:hover {
        color: var(--color-text);
    }

    .markdown-mode-btn.active {
        background: var(--color-surface);
        color: var(--color-highlight);
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    }

    .markdown-mode-btn.active:hover {
        color: var(--color-highlight);
    }

    :global(:root[data-theme='dark']) .markdown-mode-btn.active {
        background: #1c1917;
        box-shadow: none;
    }

    :global(:root[data-theme='dark']) .markdown-mode-btn.active:hover {
        background: #1c1917;
    }

    /* --- Browser-like Tabs --- */
    .tab-bar {
        display: flex;
        align-items: flex-end;
        gap: 6px;
        padding: 0 var(--spacing-1) var(--spacing-1) var(--spacing-1);
        overflow-x: auto;
        scrollbar-width: thin;
        flex: 1;
        min-width: 0;
        flex-wrap: nowrap;
        position: relative;
    }
    /* Compact the tab bar when shown inside the header */
    .editor-header .tab-bar {
        padding: 0;
        flex: 0 1 auto;
    }
    .tab-add {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: 1px solid var(--color-border);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        margin-left: 4px;
        flex-shrink: 0;
    }
    .tab-add:hover {
        background: rgba(255,255,255,0.06);
        color: var(--color-text);
    }
    .tab {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border: 1px solid var(--color-border);
        background: rgba(255,255,255,0.02);
        color: var(--color-text);
        border-radius: 10px 10px 0 0;
        font-size: 0.85rem;
        line-height: 1;
        user-select: none;
        -webkit-user-select: none;
        cursor: grab;
        touch-action: none;
    }
    .tab.is-dragging {
        opacity: 0.45;
    }
    .tab-drop-indicator {
        position: absolute;
        top: 4px;
        bottom: 4px;
        width: 2px;
        border-radius: 1px;
        background: var(--color-highlight);
        pointer-events: none;
        z-index: 5;
    }
    :global(body.tab-dragging) {
        cursor: grabbing !important;
        user-select: none !important;
    }
    :global(body.tab-dragging .tab) {
        cursor: grabbing;
    }
    .tab.active {
        background-color: var(--color-surface);
        border-bottom-color: var(--color-highlight);
        box-shadow: 0 -1px 0 var(--color-surface), 0 1px 0 var(--color-surface);
    }
    .tab.dotfile {
        opacity: 0.5;
    }
    .tab.dotfile.active {
        opacity: 0.5;
    }
    .tab-title {
        white-space: nowrap;
        max-width: 24ch;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .tab-lang-icon {
        display: inline-flex;
        align-items: center;
        margin-right: 6px;
        flex-shrink: 0;
    }
    .tab:hover {
        background: rgba(255,255,255,0.06);
        color: var(--color-text);
        cursor: pointer;
    }

    .tab-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 4px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        line-height: 1;
        font-size: 12px;
        padding: 0;
        visibility: hidden;
        opacity: 0;
        transition: opacity 0.12s ease-in-out;
    }
    .tab-close:hover {
        background: rgba(255,255,255,0.06);
        color: var(--color-text);
    }

    .tab-rename {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        margin-left: 4px;
        border-radius: 4px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        line-height: 1;
        font-size: 12px;
        padding: 0;
        visibility: hidden;
        opacity: 0;
        transition: opacity 0.12s ease-in-out;
    }
    .tab-rename:hover {
        background: rgba(255,255,255,0.06);
        color: var(--color-text);
    }

    .tab:hover .tab-rename,
    .tab:hover .tab-close,
    .tab.active .tab-rename,
    .tab.active .tab-close {
        visibility: visible;
        opacity: 1;
    }

    .tab-rename-input {
        background: rgba(0,0,0,0.2);
        border: 1px solid var(--color-border);
        color: var(--color-text);
        border-radius: 4px;
        padding: 2px 4px;
        font-size: 0.85rem;
        width: 100%;
        max-width: 18ch;
    }

    .tabs-container {
        display: flex;
        gap: var(--spacing-2);
        align-items: center;
        flex: 1;
        min-width: 0;
    }


    /* Small, subtle icon button */
    .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        background: transparent;
        color: var(--color-text-secondary);
        border: 1px solid transparent;
        cursor: pointer;
        transition: all 0.2s ease-in-out;
    }

    .icon-button:hover {
        transform: translateY(-2px);
    }

    /* Settings dropdown (activity bar — opens to the right) */
    .settings-wrapper {
        position: relative;
        display: inline-block;
    }
    .settings-wrapper.activity-settings {
        display: flex;
        width: 100%;
        justify-content: center;
    }
    .settings-dropdown {
        position: absolute;
        top: 0;
        left: calc(100% + 4px);
        right: auto;
        border: 1px solid var(--color-border);
        background-color: var(--color-bg);
        border-radius: var(--border-radius-md);
        padding: var(--spacing-2);
        box-shadow: 0 8px 24px rgba(0,0,0,0.25);
        z-index: 30;
        min-width: 170px;
        display: grid;
        gap: var(--spacing-1);
    }
    .settings-dropdown label {
        font-size: 0.85rem;
        color: var(--color-text-secondary);
    }
    .settings-dropdown select, #language-select {
        background: var(--color-bg);
        color: var(--color-text);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        padding: 6px 8px;
        font-family: inherit;
    }

    .file-group-header {
        padding: 4px var(--spacing-2);
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-top: 8px;
    }
    .file-group:first-child .file-group-header {
        margin-top: 0;
    }

    /* Empty State */
    .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-secondary);
        background-color: var(--color-bg);
        user-select: none;
    }
    .empty-state-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2rem;
    }
    .empty-shortcuts {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        width: 100%;
        max-width: 540px;
    }
    .empty-section {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        width: 100%;
        max-width: 540px;
    }
    .empty-section-title {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0 2px;
    }
    .recent-files-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        width: 100%;
    }
    .recent-file-card {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 4px;
        padding: 10px 12px;
        background-color: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        cursor: pointer;
        transition: background-color 0.15s, border-color 0.15s;
        text-align: left;
        min-width: 0;
    }
    .recent-file-card:hover {
        background-color: rgba(255, 255, 255, 0.06);
        border-color: var(--color-text-secondary);
    }
    .recent-file-card.dotfile {
        opacity: 0.6;
    }
    .recent-file-card-header {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }
    .recent-file-card-title {
        font-size: 0.88rem;
        font-weight: 500;
        color: var(--color-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
    }
    .recent-file-card-path {
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .shortcut-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.9rem;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        transition: background-color 0.2s;
    }

    .shortcut-row:hover {
        background-color: var(--color-surface);
    }
    .shortcut-keys {
        display: flex;
        gap: 4px;
    }
    .key {
        background-color: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 3px;
        padding: 2px 6px;
        font-size: 0.8rem;
        min-width: 20px;
        text-align: center;
        box-shadow: 0 1px 0 var(--color-border);
        color: var(--color-text);
    }

    /* Image lightbox (full-size view) */
    .image-lightbox {
        position: fixed;
        inset: 0;
        z-index: 4000;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px;
        cursor: zoom-out;
    }

    .image-lightbox img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: var(--border-radius-md);
        box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
        cursor: default;
    }

    .lightbox-close {
        position: absolute;
        top: 16px;
        right: 16px;
        width: 36px;
        height: 36px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        cursor: pointer;
    }

    .lightbox-close:hover {
        background: rgba(255, 255, 255, 0.25);
    }

    /* @-mention file picker (WYSIWYG) */
    .mention-popup {
        position: fixed;
        z-index: 1100;
        width: 320px;
        max-width: calc(100vw - 16px);
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.35);
        overflow: hidden;
    }

    .mention-popup-header {
        padding: 8px 12px;
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        border-bottom: 1px solid var(--color-border);
    }

    .mention-results {
        max-height: 240px;
        overflow-y: auto;
    }

    .mention-result-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        cursor: pointer;
        color: var(--color-text-secondary);
    }

    .mention-result-item.selected {
        background: var(--color-highlight);
        color: var(--color-text);
    }

    /* Search Overlay */
    .search-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.5);
        z-index: 1000;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding-top: 80px;
    }

    .search-modal {
        width: 600px;
        max-width: 90vw;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .search-input {
        width: 100%;
        background: var(--color-bg);
        color: var(--color-text);
        border: none;
        outline: none;
    }

    .search-file-input {
        width: 100%;
        padding: 12px 16px;
        font-size: 1.1rem;
        background: var(--color-bg);
        color: var(--color-text);
        border: none;
        border-bottom: 1px solid var(--color-border);
        outline: none;
    }

    .search-results {
        max-height: 400px;
        overflow-y: auto;
    }

    .search-result-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px;
        cursor: pointer;
        border-bottom: 1px solid transparent;
        color: var(--color-text-secondary);
    }

    .search-result-item.selected {
        background: var(--color-highlight);
        color: var(--color-text);
    }

    .search-file-info {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        flex: 1;
        overflow: hidden;
    }

    .search-file-name {
        font-size: 0.95rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .search-file-meta {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        margin-left: 12px;
    }

    .search-file-path {
        font-size: 0.8rem;
        color: var(--color-text-secondary);
        white-space: nowrap;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        opacity: 0.85;
    }

    .search-result-item.selected .search-file-path {
        color: var(--color-text);
        opacity: 0.75;
    }

    .search-file-badge {
        font-size: 0.75rem;
        padding: 2px 6px;
        background: var(--color-bg);
        border-radius: 4px;
        color: var(--color-text-secondary);
        flex-shrink: 0;
    }

    .search-no-results {
        padding: 16px;
        text-align: center;
        color: var(--color-text-secondary);
    }

    .unsaved-dot {
        position: absolute;
        top: 4px;
        right: 4px;
        width: 6px;
        height: 6px;
        background-color: var(--color-highlight);
        border-radius: 50%;
        border: 1px solid var(--color-bg);
    }

    .link-context-menu {
        position: fixed;
        z-index: 10050;
        min-width: 160px;
        padding: 4px;
        border-radius: 6px;
        background: var(--vscode-menu-background, var(--color-surface));
        color: var(--vscode-menu-foreground, var(--color-text));
        border: 1px solid var(--vscode-menu-border, var(--color-border));
        box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.25));
        display: flex;
        flex-direction: column;
        gap: 2px;
        user-select: none;
    }

    .link-context-menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: inherit;
        font-family: var(--font-sans);
        font-size: 13px;
        line-height: 1.25;
        text-align: left;
        cursor: pointer;
    }

    .link-context-menu-item:hover,
    .link-context-menu-item:focus-visible {
        outline: none;
        background: var(--vscode-menu-selectionBackground, var(--color-surface-hover));
        color: var(--vscode-menu-selectionForeground, var(--color-text));
    }
</style>
