import {
    syncedExpressionPortraits,
    getSyncedExpressionPortrait
} from '../core/state.js';
import {
    isSafeImageSrc,
    normalizeImageSrc,
    resolveImageUrl
} from './imageUrls.js';
import { isExpressionsExtensionEnabled } from './sillyTavernExpressions.js';

function normalizeName(name) {
    return String(name || '').trim().toLowerCase();
}

function namesMatch(a, b) {
    const left = normalizeName(a);
    const right = normalizeName(b);
    if (!left || !right) {
        return false;
    }

    return left === right || left.startsWith(right + ' ') || right.startsWith(left + ' ');
}

function isDocumentLikeUrl(src) {
    const candidate = resolveImageUrl(src);
    if (!candidate) {
        return false;
    }

    const current = new URL(window.location.href);
    return candidate.origin === current.origin
        && candidate.pathname === current.pathname
        && candidate.search === current.search;
}

export function isUsableExpressionSrc(src) {
    const normalized = normalizeImageSrc(src);
    if (!normalized) {
        return false;
    }

    if (isDocumentLikeUrl(normalized)) {
        return false;
    }

    return isSafeImageSrc(normalized);
}

export function getExpressionPortraitForCharacter(characterName) {
    if (!isExpressionsExtensionEnabled()) {
        return null;
    }

    const target = normalizeName(characterName);
    if (!target) {
        return null;
    }

    const exact = getSyncedExpressionPortrait(target);
    if (isUsableExpressionSrc(exact)) {
        return exact;
    }

    for (const [storedName, src] of Object.entries(syncedExpressionPortraits)) {
        if (namesMatch(storedName, target) && isUsableExpressionSrc(src)) {
            return src;
        }
    }

    return null;
}
