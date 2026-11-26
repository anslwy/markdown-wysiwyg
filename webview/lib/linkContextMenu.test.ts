// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { findLinkHrefAtTarget, clampMenuPosition, copyTextToClipboard } from './linkContextMenu';

describe('linkContextMenu', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    describe('findLinkHrefAtTarget', () => {
        it('returns href when right-clicking directly on an anchor element', () => {
            const container = document.createElement('div');
            container.innerHTML = '<p>Visit <a href="https://example.com/docs">Docs</a></p>';
            document.body.appendChild(container);
            const anchor = container.querySelector('a')!;

            expect(findLinkHrefAtTarget(anchor, container)).toBe('https://example.com/docs');
        });

        it('returns href when right-clicking a nested child or text node inside an anchor', () => {
            const container = document.createElement('div');
            container.innerHTML = '<p><a href="https://github.com/anslwy/markdown-wysiwyg"><code>repo</code></a></p>';
            document.body.appendChild(container);
            const code = container.querySelector('code')!;
            const textNode = code.firstChild!;

            expect(findLinkHrefAtTarget(code, container)).toBe('https://github.com/anslwy/markdown-wysiwyg');
            expect(findLinkHrefAtTarget(textNode, container)).toBe('https://github.com/anslwy/markdown-wysiwyg');
        });

        it('returns null for non-link text, empty hrefs, playground links, or anchors outside the container', () => {
            const container = document.createElement('div');
            container.innerHTML = [
                '<p id="plain">Plain text</p>',
                '<a id="empty" href="   ">Empty</a>',
                '<a id="playground" href="wysiwyg://file/abc123">File</a>'
            ].join('');
            const outside = document.createElement('a');
            outside.setAttribute('href', 'https://outside.example.com');
            document.body.append(container, outside);

            expect(findLinkHrefAtTarget(container.querySelector('#plain'), container)).toBeNull();
            expect(findLinkHrefAtTarget(container.querySelector('#empty'), container)).toBeNull();
            expect(findLinkHrefAtTarget(container.querySelector('#playground'), container)).toBeNull();
            expect(findLinkHrefAtTarget(outside, container)).toBeNull();
            expect(findLinkHrefAtTarget(null, container)).toBeNull();
        });
    });

    describe('clampMenuPosition', () => {
        it('keeps menu at pointer when inside viewport and clamps near edges', () => {
            expect(clampMenuPosition(120, 200, 160, 76, 800, 600)).toEqual({ left: 120, top: 200 });
            expect(clampMenuPosition(780, 590, 160, 76, 800, 600)).toEqual({ left: 632, top: 516 });
            expect(clampMenuPosition(-10, 2, 160, 76, 800, 600)).toEqual({ left: 8, top: 8 });
        });
    });

    describe('copyTextToClipboard', () => {
        it('uses navigator.clipboard.writeText when available', async () => {
            const writeText = vi.fn().mockResolvedValue(undefined);
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText },
                configurable: true
            });
            const fallback = vi.fn();

            const ok = await copyTextToClipboard('https://example.com', fallback);
            expect(ok).toBe(true);
            expect(writeText).toHaveBeenCalledWith('https://example.com');
            expect(fallback).not.toHaveBeenCalled();
        });

        it('falls back to the host clipboard callback when navigator.clipboard rejects or is unavailable', async () => {
            const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText },
                configurable: true
            });
            const fallback = vi.fn();

            const ok = await copyTextToClipboard('https://example.com/fallback', fallback);
            expect(ok).toBe(true);
            expect(writeText).toHaveBeenCalledWith('https://example.com/fallback');
            expect(fallback).toHaveBeenCalledWith('https://example.com/fallback');

            Object.defineProperty(navigator, 'clipboard', {
                value: undefined,
                configurable: true
            });
            const fallback2 = vi.fn();
            const ok2 = await copyTextToClipboard('https://example.com/no-api', fallback2);
            expect(ok2).toBe(true);
            expect(fallback2).toHaveBeenCalledWith('https://example.com/no-api');
        });
    });
});
