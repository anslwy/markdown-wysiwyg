import { parsePlaygroundFileId } from './markdown';

/**
 * Finds the link href if the event target is inside an `<a href="...">` element
 * contained within `container`. Returns `null` for non-link targets, empty hrefs,
 * or internal playground file-mention links.
 */
export function findLinkHrefAtTarget(target: EventTarget | null, container: HTMLElement | null): string | null {
    if (!target || !container) return null;
    let element: Element | null = null;
    if (target instanceof Element) {
        element = target;
    } else if (target instanceof Node) {
        element = target.parentElement;
    }
    if (!element) return null;
    const anchor = element.closest('a[href]') as HTMLAnchorElement | null;
    if (!anchor || !container.contains(anchor)) return null;
    const rawHref = (anchor.getAttribute('href') || '').trim();
    if (!rawHref) return null;
    if (parsePlaygroundFileId(rawHref)) return null;
    return rawHref;
}

/**
 * Clamps a fixed-position context menu inside the viewport with a small margin.
 */
export function clampMenuPosition(
    x: number,
    y: number,
    menuWidth: number,
    menuHeight: number,
    viewportWidth: number,
    viewportHeight: number,
    margin = 8
): { left: number; top: number } {
    const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
    const maxTop = Math.max(margin, viewportHeight - menuHeight - margin);
    return {
        left: Math.min(Math.max(margin, x), maxLeft),
        top: Math.min(Math.max(margin, y), maxTop)
    };
}

/**
 * Copies text using `navigator.clipboard.writeText` when permitted, falling back
 * to a host-provided clipboard handler (e.g. VS Code `vscode.env.clipboard.writeText`)
 * when webview clipboard permissions are restricted.
 */
export async function copyTextToClipboard(
    text: string,
    fallbackCopy?: (text: string) => void | Promise<void>
): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Fall through to host clipboard fallback (common in restricted VS Code webviews).
        }
    }
    if (fallbackCopy) {
        await fallbackCopy(text);
        return true;
    }
    return false;
}
