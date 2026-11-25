// VSCode image store adapter.
//
// Inside VSCode the document is a real file in a real folder, so pasted images
// are written next to it (via the extension host) and referenced by a plain
// relative path. The webview sets <base href> to the document folder, so
// relative <img src> values resolve without any extra work.

export const PASTED_IMAGE_SCHEME = 'wysiwyg://image/';

export function parsePastedImageLink(href: string): string | null {
    if (!href.startsWith(PASTED_IMAGE_SCHEME)) return null;
    const id = href.slice(PASTED_IMAGE_SCHEME.length);
    return id || null;
}

// Legacy inline image links can't be resolved outside IndexedDB.
export async function getPastedImage(_link: string): Promise<string | null> {
    return null;
}

type ImageSaver = (dataUrl: string) => Promise<string>;

// Default: keep the data URL inline (used by the standalone dev page).
let saver: ImageSaver = async (dataUrl) => dataUrl;

export function setImageSaver(fn: ImageSaver) {
    saver = fn;
}

/** Persist a pasted image and return the link to put in the markdown. */
export function storePastedImage(dataUrl: string): Promise<string> {
    return saver(dataUrl);
}

// Image files on disk are never deleted from the editor: undo could bring the
// reference back, and the user owns the folder.
export async function deletePastedImage(_link: string): Promise<void> {}
