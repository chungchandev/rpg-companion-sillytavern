import { Fuse } from '../../../../../../lib.js';
import {
    characters,
    eventSource,
    event_types,
    generateQuietPrompt,
    generateRaw,
    getRequestHeaders,
    online_status,
    substituteParams,
    substituteParamsExtended,
    this_chid
} from '../../../../../../script.js';
import {
    doExtrasFetch,
    extension_settings as stExtensionSettings,
    getApiUrl,
    modules
} from '../../../../../extensions.js';
import { selected_group, getGroupMembers } from '../../../../../group-chats.js';
import { removeReasoningFromString } from '../../../../../reasoning.js';
import { isJsonSchemaSupported } from '../../../../../textgen-settings.js';
import { trimToEndSentence, trimToStartSentence, waitUntilCondition } from '../../../../../utils.js';
import { generateWebLlmChatPrompt, isWebLlmSupported } from '../../../../../extensions/shared.js';
import { namesMatch } from './presentCharacters.js';
import { normalizeImageSrc } from './imageUrls.js';

const EXPRESSIONS_EXTENSION_NAME = 'expressions';
const DEFAULT_FALLBACK_EXPRESSION = 'joy';
const DEFAULT_LLM_PROMPT = 'Ignore previous instructions. Classify the emotion of the last message. Output just one word, e.g. "joy" or "anger". Choose only one of the following labels: {{labels}}';
const DEFAULT_EXPRESSIONS = [
    'admiration',
    'amusement',
    'anger',
    'annoyance',
    'approval',
    'caring',
    'confusion',
    'curiosity',
    'desire',
    'disappointment',
    'disapproval',
    'disgust',
    'embarrassment',
    'excitement',
    'fear',
    'gratitude',
    'grief',
    'joy',
    'love',
    'nervousness',
    'optimism',
    'pride',
    'realization',
    'relief',
    'remorse',
    'sadness',
    'surprise',
    'neutral'
];

export const EXPRESSION_API = {
    local: 0,
    extras: 1,
    llm: 2,
    webllm: 3,
    none: 99
};

const PROMPT_TYPE = {
    raw: 'raw',
    full: 'full'
};

let expressionsListCache = null;
const spriteCache = new Map();

function getNormalizedExpressionsSettings() {
    const settings = stExtensionSettings.expressions || {};

    return {
        api: Number.isInteger(settings.api) ? settings.api : EXPRESSION_API.none,
        custom: Array.isArray(settings.custom) ? settings.custom.slice() : [],
        showDefault: settings.showDefault === true,
        translate: settings.translate === true,
        fallbackExpression: typeof settings.fallback_expression === 'string' && settings.fallback_expression.trim()
            ? settings.fallback_expression.trim().toLowerCase()
            : '',
        llmPrompt: typeof settings.llmPrompt === 'string' && settings.llmPrompt.trim()
            ? settings.llmPrompt
            : DEFAULT_LLM_PROMPT,
        allowMultiple: settings.allowMultiple !== false,
        rerollIfSame: settings.rerollIfSame === true,
        filterAvailable: settings.filterAvailable === true,
        promptType: settings.promptType === PROMPT_TYPE.full ? PROMPT_TYPE.full : PROMPT_TYPE.raw,
        expressionOverrides: Array.isArray(stExtensionSettings.expressionOverrides)
            ? stExtensionSettings.expressionOverrides.slice()
            : []
    };
}

export function isExpressionsExtensionEnabled() {
    return !stExtensionSettings.disabledExtensions?.includes(EXPRESSIONS_EXTENSION_NAME);
}

export function getExpressionsSettingsSignature() {
    if (!isExpressionsExtensionEnabled()) {
        return 'disabled';
    }

    const settings = getNormalizedExpressionsSettings();
    return JSON.stringify({
        api: settings.api,
        custom: settings.custom,
        showDefault: settings.showDefault,
        translate: settings.translate,
        fallbackExpression: settings.fallbackExpression,
        llmPrompt: settings.llmPrompt,
        allowMultiple: settings.allowMultiple,
        rerollIfSame: settings.rerollIfSame,
        filterAvailable: settings.filterAvailable,
        promptType: settings.promptType,
        expressionOverrides: settings.expressionOverrides
    });
}

export function getExpressionClassificationSettingsSignature() {
    if (!isExpressionsExtensionEnabled()) {
        return 'disabled';
    }

    const settings = getNormalizedExpressionsSettings();
    return JSON.stringify({
        api: settings.api,
        custom: settings.custom,
        translate: settings.translate,
        fallbackExpression: settings.fallbackExpression,
        llmPrompt: settings.llmPrompt,
        filterAvailable: settings.filterAvailable,
        promptType: settings.promptType
    });
}

export function getExpressionPortraitSettingsSignature() {
    if (!isExpressionsExtensionEnabled()) {
        return 'disabled';
    }

    const settings = getNormalizedExpressionsSettings();
    return JSON.stringify({
        custom: settings.custom,
        showDefault: settings.showDefault,
        fallbackExpression: settings.fallbackExpression,
        allowMultiple: settings.allowMultiple,
        rerollIfSame: settings.rerollIfSame
    });
}

export function clearExpressionsCompatibilityCache() {
    expressionsListCache = null;
    spriteCache.clear();
}

function uniqueValues(values) {
    return values.filter((value, index) => values.indexOf(value) === index);
}

function normalizeExpressionLabel(label) {
    return String(label || '').trim().toLowerCase();
}

function stripExtension(fileName) {
    return String(fileName || '').replace(/\.[^/.]+$/, '');
}

function resolveFolderOverride(folderName, expressionOverrides) {
    const override = expressionOverrides.find(entry => entry?.name === folderName);
    return override?.path ? String(override.path) : folderName;
}

function getAvatarFolderName(avatar) {
    if (!avatar || avatar === 'none') {
        return '';
    }

    return String(avatar).replace(/\.[^/.]+$/, '');
}

export function resolveSpriteFolderNameForCharacter(characterName) {
    if (!characterName) {
        return '';
    }

    const settings = getNormalizedExpressionsSettings();
    const groupId = selected_group;

    if (groupId) {
        try {
            const groupMembers = getGroupMembers(groupId) || [];
            const matchingMember = groupMembers.find(member =>
                member?.name && namesMatch(member.name, characterName));

            const memberFolder = getAvatarFolderName(matchingMember?.avatar);
            if (memberFolder) {
                return resolveFolderOverride(memberFolder, settings.expressionOverrides);
            }
        } catch {
            // Ignore group lookup issues and continue through the fallback chain.
        }
    }

    if (Array.isArray(characters) && characters.length > 0) {
        const matchingCharacter = characters.find(character =>
            character?.name && namesMatch(character.name, characterName));

        const characterFolder = getAvatarFolderName(matchingCharacter?.avatar);
        if (characterFolder) {
            return resolveFolderOverride(characterFolder, settings.expressionOverrides);
        }
    }

    if (this_chid !== undefined && characters?.[this_chid]?.name && namesMatch(characters[this_chid].name, characterName)) {
        const currentCharacterFolder = getAvatarFolderName(characters[this_chid].avatar);
        if (currentCharacterFolder) {
            return resolveFolderOverride(currentCharacterFolder, settings.expressionOverrides);
        }
    }

    return '';
}

function sampleClassifyText(text, expressionsApi) {
    if (!text) {
        return '';
    }

    let result = substituteParams(text).replace(/[*"]/g, '');

    if (expressionsApi === EXPRESSION_API.llm) {
        return result.trim();
    }

    const SAMPLE_THRESHOLD = 500;
    const HALF_SAMPLE_THRESHOLD = SAMPLE_THRESHOLD / 2;

    if (text.length < SAMPLE_THRESHOLD) {
        result = trimToEndSentence(result);
    } else {
        result = `${trimToEndSentence(result.slice(0, HALF_SAMPLE_THRESHOLD))} ${trimToStartSentence(result.slice(-HALF_SAMPLE_THRESHOLD))}`;
    }

    return result.trim();
}

function getJsonSchema(labels) {
    return {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            emotion: {
                type: 'string',
                enum: labels
            }
        },
        required: ['emotion'],
        additionalProperties: false
    };
}

function buildFullContextThoughtPrompt(prompt, text) {
    return [
        prompt,
        '',
        'Classify the emotion of the following text instead of the last chat message.',
        'Output exactly one label from the allowed list.',
        '',
        `Text: ${text}`
    ].join('\n');
}

function parseLlmResponse(emotionResponse, labels) {
    try {
        const parsedEmotion = JSON.parse(emotionResponse);
        const response = parsedEmotion?.emotion?.trim()?.toLowerCase();

        if (response && labels.includes(response)) {
            return response;
        }
    } catch {
        // Fall through to the fuzzy parse below.
    }

    const cleanedResponse = removeReasoningFromString(String(emotionResponse || ''));
    const lowerCaseResponse = cleanedResponse.toLowerCase();

    for (const label of labels) {
        if (lowerCaseResponse.includes(label.toLowerCase())) {
            return label;
        }
    }

    const fuse = new Fuse(labels, { includeScore: true });
    const match = fuse.search(cleanedResponse)[0];
    if (match?.item) {
        return match.item;
    }

    throw new Error('Could not parse expression label from response');
}

async function resolveExpressionsList() {
    const settings = getNormalizedExpressionsSettings();

    try {
        if (settings.api === EXPRESSION_API.extras && modules.includes('classify')) {
            const url = new URL(getApiUrl());
            url.pathname = '/api/classify/labels';

            const response = await doExtrasFetch(url, {
                method: 'GET',
                headers: { 'Bypass-Tunnel-Reminder': 'bypass' }
            });

            if (response.ok) {
                const data = await response.json();
                return Array.isArray(data?.labels)
                    ? data.labels.map(normalizeExpressionLabel).filter(Boolean)
                    : DEFAULT_EXPRESSIONS.slice();
            }
        }

        if (settings.api === EXPRESSION_API.local) {
            const response = await fetch('/api/extra/classify/labels', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true })
            });

            if (response.ok) {
                const data = await response.json();
                return Array.isArray(data?.labels)
                    ? data.labels.map(normalizeExpressionLabel).filter(Boolean)
                    : DEFAULT_EXPRESSIONS.slice();
            }
        }
    } catch {
        // Fall back to the built-in labels below.
    }

    return DEFAULT_EXPRESSIONS.slice();
}

async function getAvailableExpressionLabelsForCharacter(characterName) {
    const spriteFolderName = resolveSpriteFolderNameForCharacter(characterName);
    if (!spriteFolderName) {
        return [];
    }

    const expressions = await getSpritesList(spriteFolderName);
    return expressions
        .filter(expression => Array.isArray(expression?.files) && expression.files.length > 0)
        .map(expression => String(expression.label || '').trim().toLowerCase())
        .filter(Boolean);
}

export async function getExpressionsList({ characterName = '', filterAvailable = false } = {}) {
    if (!Array.isArray(expressionsListCache)) {
        expressionsListCache = await resolveExpressionsList();
    }

    const settings = getNormalizedExpressionsSettings();
    const expressions = uniqueValues([...expressionsListCache, ...settings.custom.map(value => String(value).trim().toLowerCase())])
        .filter(Boolean);

    if (!filterAvailable || ![EXPRESSION_API.llm, EXPRESSION_API.webllm].includes(settings.api)) {
        return expressions;
    }

    const availableExpressions = await getAvailableExpressionLabelsForCharacter(characterName);
    if (!availableExpressions.length) {
        return expressions;
    }

    return expressions.filter(expression => availableExpressions.includes(expression));
}

async function getSpritesList(spriteFolderName) {
    if (!spriteFolderName) {
        return [];
    }

    if (spriteCache.has(spriteFolderName)) {
        return spriteCache.get(spriteFolderName);
    }

    try {
        const response = await fetch(`/api/sprites/get?name=${encodeURIComponent(spriteFolderName)}`);
        const sprites = response.ok ? await response.json() : [];
        const grouped = [];

        for (const sprite of Array.isArray(sprites) ? sprites : []) {
            const fileName = String(sprite?.path || '').split('/').pop()?.split('?')[0] || '';
            const imageData = {
                expression: normalizeExpressionLabel(sprite?.label),
                fileName,
                title: stripExtension(fileName),
                imageSrc: String(sprite?.path || ''),
                type: 'success',
                isCustom: getNormalizedExpressionsSettings().custom.includes(normalizeExpressionLabel(sprite?.label))
            };

            let existing = grouped.find(entry => entry.label === imageData.expression);
            if (!existing) {
                existing = { label: imageData.expression, files: [] };
                grouped.push(existing);
            }

            existing.files.push(imageData);
        }

        for (const expression of grouped) {
            expression.files.sort((left, right) => {
                if (left.title === expression.label) return -1;
                if (right.title === expression.label) return 1;
                return left.title.localeCompare(right.title);
            });
        }

        spriteCache.set(spriteFolderName, grouped);
        return grouped;
    } catch {
        spriteCache.set(spriteFolderName, []);
        return [];
    }
}

function chooseSpriteForExpression(expressions, expression, { previousSrc = null } = {}) {
    const settings = getNormalizedExpressionsSettings();
    let sprite = expressions.find(entry => entry.label === expression);

    if (!(sprite?.files?.length > 0) && settings.fallbackExpression) {
        sprite = expressions.find(entry => entry.label === settings.fallbackExpression);
    }

    if (!(sprite?.files?.length > 0)) {
        return null;
    }

    let candidates = sprite.files;
    if (settings.allowMultiple && sprite.files.length > 1) {
        if (settings.rerollIfSame) {
            const filtered = sprite.files.filter(file => !previousSrc || file.imageSrc !== previousSrc);
            if (filtered.length > 0) {
                candidates = filtered;
            }
        }

        return candidates[Math.floor(Math.random() * candidates.length)] || null;
    }

    return candidates[0] || null;
}

function getDefaultExpressionImage(expression, customExpressions) {
    let normalizedExpression = String(expression || '').trim().toLowerCase();

    if (!normalizedExpression) {
        return '';
    }

    if (customExpressions.includes(normalizedExpression)) {
        normalizedExpression = DEFAULT_FALLBACK_EXPRESSION;
    }

    return `/img/default-expressions/${normalizedExpression}.png`;
}

export async function classifyExpressionText(text, { characterName = '' } = {}) {
    if (!isExpressionsExtensionEnabled()) {
        return null;
    }

    const settings = getNormalizedExpressionsSettings();
    if (!text) {
        return settings.fallbackExpression || '';
    }

    if (settings.api === EXPRESSION_API.none) {
        return settings.fallbackExpression || '';
    }

    let processedText = text;
    if (settings.translate && typeof globalThis.translate === 'function') {
        processedText = await globalThis.translate(processedText, 'en');
    }

    processedText = sampleClassifyText(processedText, settings.api);
    if (!processedText) {
        return settings.fallbackExpression || '';
    }

    const labels = await getExpressionsList({
        characterName,
        filterAvailable: settings.filterAvailable === true
    });
    const fallbackLabels = labels.length > 0 ? labels : await getExpressionsList();

    try {
        switch (settings.api) {
            case EXPRESSION_API.local: {
                const response = await fetch('/api/extra/classify', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ text: processedText })
                });

                if (response.ok) {
                    const data = await response.json();
                    return String(data?.classification?.[0]?.label || settings.fallbackExpression || '').trim().toLowerCase();
                }
                break;
            }
            case EXPRESSION_API.extras: {
                if (!modules.includes('classify')) {
                    return settings.fallbackExpression || '';
                }

                const url = new URL(getApiUrl());
                url.pathname = '/api/classify';

                const response = await doExtrasFetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Bypass-Tunnel-Reminder': 'bypass'
                    },
                    body: JSON.stringify({ text: processedText })
                });

                if (response.ok) {
                    const data = await response.json();
                    return String(data?.classification?.[0]?.label || settings.fallbackExpression || '').trim().toLowerCase();
                }
                break;
            }
            case EXPRESSION_API.llm: {
                await waitUntilCondition(() => online_status !== 'no_connection', 3000, 250);

                const labelsString = fallbackLabels.map(label => `"${label}"`).join(', ');
                const basePrompt = substituteParamsExtended(settings.llmPrompt, { labels: labelsString });
                const prompt = settings.promptType === PROMPT_TYPE.full
                    ? buildFullContextThoughtPrompt(basePrompt, processedText)
                    : basePrompt;
                const onReady = (args) => {
                    if (isJsonSchemaSupported()) {
                        Object.assign(args, {
                            top_k: 1,
                            stop: [],
                            stopping_strings: [],
                            custom_token_bans: [],
                            json_schema: getJsonSchema(fallbackLabels)
                        });
                    }
                };

                eventSource.once(event_types.TEXT_COMPLETION_SETTINGS_READY, onReady);

                const responseText = settings.promptType === PROMPT_TYPE.full
                    ? await generateQuietPrompt({ quietPrompt: prompt })
                    : await generateRaw({ prompt: processedText, systemPrompt: prompt });

                return parseLlmResponse(responseText, fallbackLabels);
            }
            case EXPRESSION_API.webllm: {
                if (!isWebLlmSupported()) {
                    return settings.fallbackExpression || '';
                }

                const labelsString = fallbackLabels.map(label => `"${label}"`).join(', ');
                const prompt = substituteParamsExtended(settings.llmPrompt, { labels: labelsString });
                const responseText = await generateWebLlmChatPrompt([
                    {
                        role: 'user',
                        content: `${processedText}\n\n${prompt}`
                    }
                ]);

                return parseLlmResponse(responseText, fallbackLabels);
            }
            default:
                break;
        }
    } catch {
        return settings.fallbackExpression || '';
    }

    return settings.fallbackExpression || '';
}

export async function resolveExpressionPortraitForCharacter(characterName, expression, { previousSrc = null } = {}) {
    if (!isExpressionsExtensionEnabled()) {
        return null;
    }

    const settings = getNormalizedExpressionsSettings();
    const normalizedExpression = String(expression || '').trim().toLowerCase();
    const spriteFolderName = resolveSpriteFolderNameForCharacter(characterName);

    if (spriteFolderName) {
        const expressions = await getSpritesList(spriteFolderName);
        const spriteFile = chooseSpriteForExpression(expressions, normalizedExpression, { previousSrc });
        const spriteSrc = normalizeImageSrc(spriteFile?.imageSrc || '');
        if (spriteSrc) {
            return spriteSrc;
        }
    }

    if (settings.showDefault) {
        const defaultExpression = normalizedExpression || settings.fallbackExpression;
        const defaultImage = normalizeImageSrc(getDefaultExpressionImage(defaultExpression, settings.custom));
        if (defaultImage) {
            return defaultImage;
        }
    }

    return null;
}
