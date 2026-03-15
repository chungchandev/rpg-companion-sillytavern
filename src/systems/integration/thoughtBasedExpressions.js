/**
 * Thought-based Character Expressions for the below-chat Present Characters panel.
 *
 * Derives portrait expressions from the current Present Characters thoughts
 * payload, while keeping SillyTavern's native Character Expressions widget
 * independent from the below-chat panel.
 */

import { getContext } from '../../../../../../extensions.js';
import {
    extensionSettings,
    thoughtBasedExpressionPortraits,
    setThoughtBasedExpressionPortraits
} from '../../core/state.js';
import {
    getCurrentMessageSwipeTrackerData,
    saveChatData,
    setMessageSwipeTrackerField
} from '../../core/persistence.js';
import { isUsableThoughtBasedExpressionSrc } from '../../utils/thoughtBasedExpressionPortraits.js';
import {
    getPresentCharactersTrackerData,
    parsePresentCharacters
} from '../../utils/presentCharacters.js';
import {
    classifyExpressionText,
    clearExpressionsCompatibilityCache,
    getExpressionClassificationSettingsSignature,
    getExpressionPortraitSettingsSignature,
    getExpressionsSettingsSignature,
    isExpressionsExtensionEnabled,
    resolveSpriteFolderNameForCharacter,
    resolveExpressionPortraitForCharacter
} from '../../utils/sillyTavernExpressions.js';

const OFF_SCENE_THOUGHT_PATTERN = /\b(not\s+(currently\s+)?(in|at|present|in\s+the)\s+(the\s+)?(scene|area|room|location|vicinity))\b|\b(off[\s-]?scene)\b|\b(not\s+present)\b|\b(absent)\b|\b(away\s+from\s+(the\s+)?scene)\b/i;
const CHAT_CHANGE_RETRY_DELAYS = [0, 80, 220, 500];
const REFRESH_DEBOUNCE_DELAY = 80;
const THOUGHT_BASED_EXPRESSIONS_CACHE_VERSION = 1;
const THOUGHT_BASED_EXPRESSIONS_CACHE_FIELD = 'thoughtBasedExpressions';

let hiddenExpressionStyleElement = null;
let thoughtBasedExpressionsRefreshHandler = null;
let scheduledRefreshTimer = null;
let activeRefreshRunId = 0;
let lastCompletedRefreshSignature = null;
let lastExpressionSettingsSignature = null;

function normalizeName(name) {
    return String(name || '').trim().toLowerCase();
}

function shouldHideNativeExpressionDisplay() {
    return extensionSettings.enabled === true && extensionSettings.hideDefaultExpressionDisplay === true;
}

function shouldUseThoughtBasedExpressions() {
    return extensionSettings.enabled === true
        && extensionSettings.enableThoughtBasedExpressions === true
        && extensionSettings.showAlternatePresentCharactersPanel === true;
}

function notifyThoughtBasedExpressionsConsumers() {
    thoughtBasedExpressionsRefreshHandler?.();
}

function getHideStyleCss() {
    return `
#expression-image,
#expression-holder,
.expression-holder,
[data-expression-container],
#expression-image img,
#expression-holder img,
.expression-holder img,
[data-expression-container] img {
    position: absolute !important;
    left: -10000px !important;
    top: 0 !important;
    width: 1px !important;
    height: 1px !important;
    overflow: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
    visibility: hidden !important;
}
`;
}

function hideNativeExpressionDisplay() {
    if (hiddenExpressionStyleElement?.isConnected) {
        return;
    }

    const styleElement = document.createElement('style');
    styleElement.id = 'rpg-hidden-native-expression-display-style';
    styleElement.textContent = getHideStyleCss();
    document.head.appendChild(styleElement);
    hiddenExpressionStyleElement = styleElement;
}

function showNativeExpressionDisplay() {
    if (hiddenExpressionStyleElement?.isConnected) {
        hiddenExpressionStyleElement.remove();
    } else {
        document.getElementById('rpg-hidden-native-expression-display-style')?.remove();
    }

    hiddenExpressionStyleElement = null;
}

function updateNativeExpressionDisplayVisibility() {
    if (shouldHideNativeExpressionDisplay()) {
        hideNativeExpressionDisplay();
    } else {
        showNativeExpressionDisplay();
    }
}

function clearScheduledRefresh() {
    if (scheduledRefreshTimer !== null) {
        clearTimeout(scheduledRefreshTimer);
        scheduledRefreshTimer = null;
    }
}

function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(item => stableStringify(item)).join(',')}]`;
    }

    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }

    return JSON.stringify(value);
}

function normalizeThoughtPayload(payload) {
    if (!payload) {
        return null;
    }

    if (typeof payload === 'object') {
        return stableStringify(payload);
    }

    if (typeof payload !== 'string') {
        return String(payload);
    }

    const trimmed = payload.trim();
    if (!trimmed) {
        return null;
    }

    try {
        return stableStringify(JSON.parse(trimmed));
    } catch {
        return trimmed.replace(/\r\n/g, '\n');
    }
}

function normalizeExpressionLabel(label) {
    return String(label || '').trim().toLowerCase();
}

function arePortraitMapsEqual(left, right) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    return leftKeys.every(key => left[key] === right[key]);
}

function applyThoughtBasedExpressionPortraits(nextPortraits) {
    if (arePortraitMapsEqual(thoughtBasedExpressionPortraits, nextPortraits)) {
        return false;
    }

    setThoughtBasedExpressionPortraits(nextPortraits);
    return true;
}

function purgeInvalidThoughtBasedExpressionPortraits() {
    const nextPortraits = {};

    for (const [characterName, src] of Object.entries(thoughtBasedExpressionPortraits)) {
        if (isUsableThoughtBasedExpressionSrc(src)) {
            nextPortraits[characterName] = src;
        }
    }

    return applyThoughtBasedExpressionPortraits(nextPortraits);
}

function getMessageThoughtPayload(message) {
    if (!message || message.is_user) {
        return null;
    }

    const swipeData = getCurrentMessageSwipeTrackerData(message);
    return normalizeThoughtPayload(swipeData?.characterThoughts ?? null);
}

function findThoughtSourceMessageInfo(characterThoughtsData) {
    const chatMessages = getContext()?.chat || [];
    const currentThoughts = normalizeThoughtPayload(characterThoughtsData);
    let fallback = null;

    for (let i = chatMessages.length - 1; i >= 0; i--) {
        const message = chatMessages[i];
        if (!message || message.is_user || message.is_system) {
            continue;
        }

        const swipeData = getCurrentMessageSwipeTrackerData(message);
        if (!swipeData) {
            continue;
        }

        const sourceInfo = {
            message,
            messageIndex: i,
            swipeId: Number(message.swipe_id ?? 0),
            swipeData
        };

        if (!fallback) {
            fallback = sourceInfo;
        }

        const messageThoughts = getMessageThoughtPayload(message);
        if (currentThoughts && messageThoughts === currentThoughts) {
            return sourceInfo;
        }
    }

    return currentThoughts ? null : fallback;
}

function isThoughtBasedExpressionsCache(candidate) {
    return !!(
        candidate
        && typeof candidate === 'object'
        && !Array.isArray(candidate)
        && candidate.version === THOUGHT_BASED_EXPRESSIONS_CACHE_VERSION
        && candidate.entries
        && typeof candidate.entries === 'object'
        && !Array.isArray(candidate.entries)
    );
}

function getSwipeThoughtBasedExpressionsCache(sourceInfo) {
    const directCache = sourceInfo?.swipeData?.[THOUGHT_BASED_EXPRESSIONS_CACHE_FIELD];
    return isThoughtBasedExpressionsCache(directCache) ? directCache : null;
}

function areThoughtBasedExpressionsCachesEqual(left, right) {
    return stableStringify(left) === stableStringify(right);
}

function getThoughtBasedExpressionEntries(characterThoughtsData) {
    const thoughtsConfig = extensionSettings.trackerConfig?.presentCharacters?.thoughts;
    if (thoughtsConfig?.enabled === false) {
        return [];
    }

    if (!characterThoughtsData) {
        return [];
    }

    const presentCharacters = parsePresentCharacters(characterThoughtsData);
    return presentCharacters
        .map(character => ({
            name: String(character?.name || '').trim(),
            thought: String(character?.ThoughtsContent || '').trim()
        }))
        .filter(character => character.name && character.thought && !OFF_SCENE_THOUGHT_PATTERN.test(character.thought));
}

function buildRefreshSignature(thoughtEntries, expressionsSettingsSignature) {
    return JSON.stringify({
        expressionsSettingsSignature,
        thoughtEntries: thoughtEntries.map(entry => ({
            name: normalizeName(entry.name),
            thought: entry.thought,
            spriteFolderName: resolveSpriteFolderNameForCharacter(entry.name)
        }))
    });
}

async function refreshThoughtBasedExpressions({ force = false } = {}) {
    updateNativeExpressionDisplayVisibility();

    if (!extensionSettings.enabled) {
        showNativeExpressionDisplay();
        return;
    }

    if (!shouldUseThoughtBasedExpressions()) {
        return;
    }

    if (!isExpressionsExtensionEnabled()) {
        lastCompletedRefreshSignature = null;
        lastExpressionSettingsSignature = null;
        clearExpressionsCompatibilityCache();
        const portraitsChanged = applyThoughtBasedExpressionPortraits({});
        if (portraitsChanged) {
            saveChatData();
        }
        notifyThoughtBasedExpressionsConsumers();
        return;
    }

    const expressionsSettingsSignature = getExpressionsSettingsSignature();
    if (expressionsSettingsSignature !== lastExpressionSettingsSignature) {
        clearExpressionsCompatibilityCache();
        lastExpressionSettingsSignature = expressionsSettingsSignature;
        lastCompletedRefreshSignature = null;
    }

    const characterThoughtsData = getPresentCharactersTrackerData({ useCommittedFallback: true });
    const thoughtEntries = getThoughtBasedExpressionEntries(characterThoughtsData);
    const refreshSignature = buildRefreshSignature(thoughtEntries, expressionsSettingsSignature);
    if (!force && refreshSignature === lastCompletedRefreshSignature) {
        return;
    }

    const sourceInfo = findThoughtSourceMessageInfo(characterThoughtsData);
    const cachedThoughtBasedExpressions = getSwipeThoughtBasedExpressionsCache(sourceInfo);
    const cachedEntries = cachedThoughtBasedExpressions?.entries && typeof cachedThoughtBasedExpressions.entries === 'object' && !Array.isArray(cachedThoughtBasedExpressions.entries)
        ? cachedThoughtBasedExpressions.entries
        : {};
    const currentThoughtsSignature = normalizeThoughtPayload(characterThoughtsData);
    const classificationSettingsSignature = getExpressionClassificationSettingsSignature();
    const portraitSettingsSignature = getExpressionPortraitSettingsSignature();
    const runId = ++activeRefreshRunId;
    const nextPortraits = {};
    const nextCacheEntries = {};

    for (const entry of thoughtEntries) {
        const portraitKey = normalizeName(entry.name);
        if (!portraitKey) {
            continue;
        }

        const spriteFolderName = resolveSpriteFolderNameForCharacter(entry.name);
        const cachedEntry = cachedEntries[portraitKey] && typeof cachedEntries[portraitKey] === 'object'
            ? cachedEntries[portraitKey]
            : null;
        const previousSrc = nextPortraits[portraitKey] || thoughtBasedExpressionPortraits[portraitKey] || null;
        const canReuseExpression = cachedEntry
            && cachedEntry.thought === entry.thought
            && cachedEntry.classificationSettingsSignature === classificationSettingsSignature
            && cachedEntry.spriteFolderName === spriteFolderName
            && typeof cachedEntry.expression === 'string';

        const expression = canReuseExpression
            ? normalizeExpressionLabel(cachedEntry.expression)
            : normalizeExpressionLabel(await classifyExpressionText(entry.thought, { characterName: entry.name }));
        if (runId !== activeRefreshRunId) {
            return;
        }

        const canReusePortrait = cachedEntry
            && cachedEntry.thought === entry.thought
            && cachedEntry.expression === expression
            && cachedEntry.portraitSettingsSignature === portraitSettingsSignature
            && cachedEntry.spriteFolderName === spriteFolderName
            && cachedEntry.portraitResolved === true;

        const portraitSrc = canReusePortrait
            ? (isUsableThoughtBasedExpressionSrc(cachedEntry.portraitSrc) ? cachedEntry.portraitSrc : null)
            : await resolveExpressionPortraitForCharacter(entry.name, expression, { previousSrc });
        if (runId !== activeRefreshRunId) {
            return;
        }

        if (isUsableThoughtBasedExpressionSrc(portraitSrc)) {
            nextPortraits[portraitKey] = portraitSrc;
        }

        nextCacheEntries[portraitKey] = {
            name: entry.name,
            thought: entry.thought,
            spriteFolderName,
            classificationSettingsSignature,
            portraitSettingsSignature,
            expression,
            portraitSrc: isUsableThoughtBasedExpressionSrc(portraitSrc) ? portraitSrc : null,
            portraitResolved: true
        };
    }

    if (runId !== activeRefreshRunId) {
        return;
    }

    let cacheChanged = false;
    if (sourceInfo) {
        const nextCache = {
            version: THOUGHT_BASED_EXPRESSIONS_CACHE_VERSION,
            thoughtsSignature: currentThoughtsSignature,
            entries: nextCacheEntries
        };

        if (!areThoughtBasedExpressionsCachesEqual(cachedThoughtBasedExpressions, nextCache)) {
            setMessageSwipeTrackerField(sourceInfo.message, sourceInfo.swipeId, THOUGHT_BASED_EXPRESSIONS_CACHE_FIELD, nextCache);
            cacheChanged = true;
        }
    }

    lastCompletedRefreshSignature = refreshSignature;
    const portraitsChanged = applyThoughtBasedExpressionPortraits(nextPortraits);
    if (portraitsChanged || cacheChanged) {
        saveChatData();
    }
    if (portraitsChanged) {
        notifyThoughtBasedExpressionsConsumers();
    }
}

export function setThoughtBasedExpressionsRefreshHandler(handler) {
    thoughtBasedExpressionsRefreshHandler = typeof handler === 'function' ? handler : null;
}

export function queueThoughtBasedExpressionsUpdate({ immediate = false, force = false } = {}) {
    clearScheduledRefresh();

    const runRefresh = () => {
        refreshThoughtBasedExpressions({ force }).catch(error => {
            console.warn('[RPG Companion] Thought-based expressions update failed:', error);
        });
    };

    if (immediate) {
        runRefresh();
        return;
    }

    scheduledRefreshTimer = setTimeout(() => {
        scheduledRefreshTimer = null;
        runRefresh();
    }, REFRESH_DEBOUNCE_DELAY);
}

export function initThoughtBasedExpressions() {
    const purged = purgeInvalidThoughtBasedExpressionPortraits();
    updateNativeExpressionDisplayVisibility();

    if (purged) {
        saveChatData();
        notifyThoughtBasedExpressionsConsumers();
    }

    if (shouldUseThoughtBasedExpressions()) {
        queueThoughtBasedExpressionsUpdate({ immediate: true, force: true });
    }
}

export function onThoughtBasedExpressionsChatChanged() {
    if (!extensionSettings.enabled) {
        showNativeExpressionDisplay();
        return;
    }

    clearScheduledRefresh();
    activeRefreshRunId += 1;
    lastCompletedRefreshSignature = null;
    lastExpressionSettingsSignature = null;
    clearExpressionsCompatibilityCache();

    const purged = purgeInvalidThoughtBasedExpressionPortraits();
    if (purged) {
        saveChatData();
        notifyThoughtBasedExpressionsConsumers();
    }

    for (const delay of CHAT_CHANGE_RETRY_DELAYS) {
        setTimeout(() => {
            updateNativeExpressionDisplayVisibility();
            if (shouldUseThoughtBasedExpressions()) {
                queueThoughtBasedExpressionsUpdate({ immediate: true, force: true });
            } else {
                notifyThoughtBasedExpressionsConsumers();
            }
        }, delay);
    }
}

export function onThoughtBasedExpressionsSettingChanged(enabled) {
    updateNativeExpressionDisplayVisibility();

    if (enabled) {
        const purged = purgeInvalidThoughtBasedExpressionPortraits();
        if (purged) {
            saveChatData();
            notifyThoughtBasedExpressionsConsumers();
        }

        if (shouldUseThoughtBasedExpressions()) {
            queueThoughtBasedExpressionsUpdate({ immediate: true, force: true });
        } else {
            notifyThoughtBasedExpressionsConsumers();
        }
        return;
    }

    clearScheduledRefresh();
    activeRefreshRunId += 1;
    lastCompletedRefreshSignature = null;
    lastExpressionSettingsSignature = null;
    clearExpressionsCompatibilityCache();
    notifyThoughtBasedExpressionsConsumers();
}

export function onAlternatePresentCharactersVisibilityChanged() {
    updateNativeExpressionDisplayVisibility();

    if (shouldUseThoughtBasedExpressions()) {
        queueThoughtBasedExpressionsUpdate({ immediate: true, force: true });
        return;
    }

    clearScheduledRefresh();
    activeRefreshRunId += 1;
    lastCompletedRefreshSignature = null;
    lastExpressionSettingsSignature = null;
}

export function onHideDefaultExpressionDisplaySettingChanged(enabled) {
    extensionSettings.hideDefaultExpressionDisplay = enabled === true;
    updateNativeExpressionDisplayVisibility();
    setTimeout(() => updateNativeExpressionDisplayVisibility(), 0);
    setTimeout(() => updateNativeExpressionDisplayVisibility(), 120);
}

export function clearThoughtBasedExpressionsCache() {
    clearScheduledRefresh();
    activeRefreshRunId += 1;
    lastCompletedRefreshSignature = null;
    lastExpressionSettingsSignature = null;
    clearExpressionsCompatibilityCache();
    showNativeExpressionDisplay();
}
