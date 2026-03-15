/**
 * Character Expressions -> below-chat Present Characters portrait sync.
 *
 * Derives expression portraits from the current Present Characters thoughts
 * payload, while keeping SillyTavern's native Character Expressions widget
 * independent from the below-chat panel.
 */

import { getContext } from '../../../../../../extensions.js';
import {
    extensionSettings,
    syncedExpressionPortraits,
    setSyncedExpressionPortraits
} from '../../core/state.js';
import {
    getCurrentMessageSwipeTrackerData,
    saveChatData,
    setMessageSwipeTrackerField
} from '../../core/persistence.js';
import { isUsableExpressionSrc } from '../../utils/expressionPortraits.js';
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
const SYNC_DEBOUNCE_DELAY = 80;
const EXPRESSION_SYNC_CACHE_VERSION = 1;
const EXPRESSION_SYNC_CACHE_FIELD = 'expressionSync';

let hiddenExpressionStyleElement = null;
let refreshExpressionConsumersHandler = null;
let scheduledSyncTimer = null;
let activeSyncRunId = 0;
let lastCompletedSyncSignature = null;
let lastExpressionsSettingsSignature = null;

function normalizeName(name) {
    return String(name || '').trim().toLowerCase();
}

function shouldHideNativeExpressionDisplay() {
    return extensionSettings.enabled === true && extensionSettings.hideDefaultExpressionDisplay === true;
}

function shouldSyncExpressionPortraits() {
    return extensionSettings.enabled === true
        && extensionSettings.syncExpressionsToPresentCharacters === true
        && extensionSettings.showAlternatePresentCharactersPanel === true;
}

function refreshExpressionConsumers() {
    refreshExpressionConsumersHandler?.();
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

function syncNativeExpressionDisplayVisibility() {
    if (shouldHideNativeExpressionDisplay()) {
        hideNativeExpressionDisplay();
    } else {
        showNativeExpressionDisplay();
    }
}

function clearScheduledSync() {
    if (scheduledSyncTimer !== null) {
        clearTimeout(scheduledSyncTimer);
        scheduledSyncTimer = null;
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

function applySyncedExpressionPortraits(nextPortraits) {
    if (arePortraitMapsEqual(syncedExpressionPortraits, nextPortraits)) {
        return false;
    }

    setSyncedExpressionPortraits(nextPortraits);
    return true;
}

function purgeInvalidSyncedExpressionPortraits() {
    const nextPortraits = {};

    for (const [characterName, src] of Object.entries(syncedExpressionPortraits)) {
        if (isUsableExpressionSrc(src)) {
            nextPortraits[characterName] = src;
        }
    }

    return applySyncedExpressionPortraits(nextPortraits);
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

function getSwipeExpressionSyncCache(sourceInfo) {
    const cache = sourceInfo?.swipeData?.[EXPRESSION_SYNC_CACHE_FIELD];
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
        return null;
    }

    if (cache.version !== EXPRESSION_SYNC_CACHE_VERSION) {
        return null;
    }

    return cache;
}

function areExpressionSyncCachesEqual(left, right) {
    return stableStringify(left) === stableStringify(right);
}

function getThoughtSyncEntries(characterThoughtsData) {
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

function buildSyncSignature(thoughtEntries, expressionsSettingsSignature) {
    return JSON.stringify({
        expressionsSettingsSignature,
        thoughtEntries: thoughtEntries.map(entry => ({
            name: normalizeName(entry.name),
            thought: entry.thought,
            spriteFolderName: resolveSpriteFolderNameForCharacter(entry.name)
        }))
    });
}

async function syncExpressionsFromThoughts({ force = false } = {}) {
    syncNativeExpressionDisplayVisibility();

    if (!extensionSettings.enabled) {
        showNativeExpressionDisplay();
        return;
    }

    if (!shouldSyncExpressionPortraits()) {
        return;
    }

    if (!isExpressionsExtensionEnabled()) {
        lastCompletedSyncSignature = null;
        lastExpressionsSettingsSignature = null;
        clearExpressionsCompatibilityCache();
        const portraitsChanged = applySyncedExpressionPortraits({});
        if (portraitsChanged) {
            saveChatData();
        }
        refreshExpressionConsumers();
        return;
    }

    const expressionsSettingsSignature = getExpressionsSettingsSignature();
    if (expressionsSettingsSignature !== lastExpressionsSettingsSignature) {
        clearExpressionsCompatibilityCache();
        lastExpressionsSettingsSignature = expressionsSettingsSignature;
        lastCompletedSyncSignature = null;
    }

    const characterThoughtsData = getPresentCharactersTrackerData({ useCommittedFallback: true });
    const thoughtEntries = getThoughtSyncEntries(characterThoughtsData);
    const syncSignature = buildSyncSignature(thoughtEntries, expressionsSettingsSignature);
    if (!force && syncSignature === lastCompletedSyncSignature) {
        return;
    }

    const sourceInfo = findThoughtSourceMessageInfo(characterThoughtsData);
    const cachedSyncData = getSwipeExpressionSyncCache(sourceInfo);
    const cachedEntries = cachedSyncData?.entries && typeof cachedSyncData.entries === 'object' && !Array.isArray(cachedSyncData.entries)
        ? cachedSyncData.entries
        : {};
    const currentThoughtsSignature = normalizeThoughtPayload(characterThoughtsData);
    const classificationSettingsSignature = getExpressionClassificationSettingsSignature();
    const portraitSettingsSignature = getExpressionPortraitSettingsSignature();
    const runId = ++activeSyncRunId;
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
        const previousSrc = nextPortraits[portraitKey] || syncedExpressionPortraits[portraitKey] || null;
        const canReuseExpression = cachedEntry
            && cachedEntry.thought === entry.thought
            && cachedEntry.classificationSettingsSignature === classificationSettingsSignature
            && cachedEntry.spriteFolderName === spriteFolderName
            && typeof cachedEntry.expression === 'string';

        const expression = canReuseExpression
            ? normalizeExpressionLabel(cachedEntry.expression)
            : normalizeExpressionLabel(await classifyExpressionText(entry.thought, { characterName: entry.name }));
        if (runId !== activeSyncRunId) {
            return;
        }

        const canReusePortrait = cachedEntry
            && cachedEntry.thought === entry.thought
            && cachedEntry.expression === expression
            && cachedEntry.portraitSettingsSignature === portraitSettingsSignature
            && cachedEntry.spriteFolderName === spriteFolderName
            && cachedEntry.portraitResolved === true;

        const portraitSrc = canReusePortrait
            ? (isUsableExpressionSrc(cachedEntry.portraitSrc) ? cachedEntry.portraitSrc : null)
            : await resolveExpressionPortraitForCharacter(entry.name, expression, { previousSrc });
        if (runId !== activeSyncRunId) {
            return;
        }

        if (isUsableExpressionSrc(portraitSrc)) {
            nextPortraits[portraitKey] = portraitSrc;
        }

        nextCacheEntries[portraitKey] = {
            name: entry.name,
            thought: entry.thought,
            spriteFolderName,
            classificationSettingsSignature,
            portraitSettingsSignature,
            expression,
            portraitSrc: isUsableExpressionSrc(portraitSrc) ? portraitSrc : null,
            portraitResolved: true
        };
    }

    if (runId !== activeSyncRunId) {
        return;
    }

    let cacheChanged = false;
    if (sourceInfo) {
        const nextCache = {
            version: EXPRESSION_SYNC_CACHE_VERSION,
            thoughtsSignature: currentThoughtsSignature,
            entries: nextCacheEntries
        };

        if (!areExpressionSyncCachesEqual(cachedSyncData, nextCache)) {
            setMessageSwipeTrackerField(sourceInfo.message, sourceInfo.swipeId, EXPRESSION_SYNC_CACHE_FIELD, nextCache);
            cacheChanged = true;
        }
    }

    lastCompletedSyncSignature = syncSignature;
    const portraitsChanged = applySyncedExpressionPortraits(nextPortraits);
    if (portraitsChanged || cacheChanged) {
        saveChatData();
    }
    if (portraitsChanged) {
        refreshExpressionConsumers();
    }
}

export function setExpressionSyncRefreshHandler(handler) {
    refreshExpressionConsumersHandler = typeof handler === 'function' ? handler : null;
}

export function queueExpressionSyncFromThoughts({ immediate = false, force = false } = {}) {
    clearScheduledSync();

    const runSync = () => {
        syncExpressionsFromThoughts({ force }).catch(error => {
            console.warn('[RPG Companion] Thoughts-driven expression sync failed:', error);
        });
    };

    if (immediate) {
        runSync();
        return;
    }

    scheduledSyncTimer = setTimeout(() => {
        scheduledSyncTimer = null;
        runSync();
    }, SYNC_DEBOUNCE_DELAY);
}

export function initExpressionSync() {
    const purged = purgeInvalidSyncedExpressionPortraits();
    syncNativeExpressionDisplayVisibility();

    if (purged) {
        saveChatData();
        refreshExpressionConsumers();
    }

    if (shouldSyncExpressionPortraits()) {
        queueExpressionSyncFromThoughts({ immediate: true, force: true });
    }
}

export function onExpressionSyncChatChanged() {
    if (!extensionSettings.enabled) {
        showNativeExpressionDisplay();
        return;
    }

    clearScheduledSync();
    activeSyncRunId += 1;
    lastCompletedSyncSignature = null;
    lastExpressionsSettingsSignature = null;
    clearExpressionsCompatibilityCache();

    const purged = purgeInvalidSyncedExpressionPortraits();
    if (purged) {
        saveChatData();
        refreshExpressionConsumers();
    }

    for (const delay of CHAT_CHANGE_RETRY_DELAYS) {
        setTimeout(() => {
            syncNativeExpressionDisplayVisibility();
            if (shouldSyncExpressionPortraits()) {
                queueExpressionSyncFromThoughts({ immediate: true, force: true });
            } else {
                refreshExpressionConsumers();
            }
        }, delay);
    }
}

export function onExpressionSyncSettingChanged(enabled) {
    syncNativeExpressionDisplayVisibility();

    if (enabled) {
        const purged = purgeInvalidSyncedExpressionPortraits();
        if (purged) {
            saveChatData();
            refreshExpressionConsumers();
        }

        if (shouldSyncExpressionPortraits()) {
            queueExpressionSyncFromThoughts({ immediate: true, force: true });
        } else {
            refreshExpressionConsumers();
        }
        return;
    }

    clearScheduledSync();
    activeSyncRunId += 1;
    lastCompletedSyncSignature = null;
    lastExpressionsSettingsSignature = null;
    clearExpressionsCompatibilityCache();
    refreshExpressionConsumers();
}

export function onAlternatePresentCharactersVisibilityChanged() {
    syncNativeExpressionDisplayVisibility();

    if (shouldSyncExpressionPortraits()) {
        queueExpressionSyncFromThoughts({ immediate: true, force: true });
        return;
    }

    clearScheduledSync();
    activeSyncRunId += 1;
    lastCompletedSyncSignature = null;
    lastExpressionsSettingsSignature = null;
}

export function onHideDefaultExpressionDisplaySettingChanged(enabled) {
    extensionSettings.hideDefaultExpressionDisplay = enabled === true;
    syncNativeExpressionDisplayVisibility();
    setTimeout(() => syncNativeExpressionDisplayVisibility(), 0);
    setTimeout(() => syncNativeExpressionDisplayVisibility(), 120);
}

export function clearExpressionSyncCache() {
    clearScheduledSync();
    activeSyncRunId += 1;
    lastCompletedSyncSignature = null;
    lastExpressionsSettingsSignature = null;
    clearExpressionsCompatibilityCache();
    showNativeExpressionDisplay();
}
