import { extensionSettings } from '../../core/state.js';
import { i18n } from '../../core/i18n.js';
import { getExpressionPortraitForCharacter } from '../integration/expressionSync.js';
import {
    getPresentCharactersTrackerData,
    parsePresentCharacters,
    resolvePresentCharacterPortrait
} from '../../utils/presentCharacters.js';

const PANEL_ID = 'rpg-alt-present-characters';

function ensureAlternatePresentCharactersPanel() {
    let $panel = $(`#${PANEL_ID}`);
    if ($panel.length) {
        return $panel;
    }

    $panel = $(`<div id="${PANEL_ID}" class="rpg-alt-present-characters" style="display:none;"></div>`);

    const $sendForm = $('#send_form');
    const $sheld = $('#sheld');
    const $chat = $sheld.find('#chat');

    if ($sendForm.length) {
        $sendForm.before($panel);
    } else if ($chat.length) {
        $chat.after($panel);
    } else if ($sheld.length) {
        $sheld.append($panel);
    } else {
        $('body').append($panel);
    }

    return $panel;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function hexToRgba(hex, opacity = 100) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const a = opacity / 100;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function removeAlternatePresentCharactersPanel() {
    $(`#${PANEL_ID}`).remove();
}

export function syncAlternatePresentCharactersTheme() {
    const $panel = $(`#${PANEL_ID}`);
    if (!$panel.length) {
        return;
    }

    const theme = extensionSettings.theme || 'default';

    $panel.css({
        '--rpg-bg': '',
        '--rpg-accent': '',
        '--rpg-text': '',
        '--rpg-highlight': '',
        '--rpg-border': '',
        '--rpg-shadow': ''
    });

    if (theme === 'default') {
        $panel.removeAttr('data-theme');
        return;
    }

    $panel.attr('data-theme', theme);

    if (theme === 'custom') {
        const colors = extensionSettings.customColors || {};
        const bgColor = hexToRgba(colors.bg || '#1a1a2e', colors.bgOpacity ?? 100);
        const accentColor = hexToRgba(colors.accent || '#16213e', colors.accentOpacity ?? 100);
        const textColor = hexToRgba(colors.text || '#eaeaea', colors.textOpacity ?? 100);
        const highlightColor = hexToRgba(colors.highlight || '#e94560', colors.highlightOpacity ?? 100);
        const shadowColor = hexToRgba(colors.highlight || '#e94560', (colors.highlightOpacity ?? 100) * 0.5);

        $panel.css({
            '--rpg-bg': bgColor,
            '--rpg-accent': accentColor,
            '--rpg-text': textColor,
            '--rpg-highlight': highlightColor,
            '--rpg-border': highlightColor,
            '--rpg-shadow': shadowColor
        });
    }
}

export function renderAlternatePresentCharacters({ useCommittedFallback = true } = {}) {
    if (!extensionSettings.enabled || !extensionSettings.showAlternatePresentCharactersPanel) {
        removeAlternatePresentCharactersPanel();
        return;
    }

    const characterThoughtsData = getPresentCharactersTrackerData({ useCommittedFallback });
    if (!characterThoughtsData) {
        const $panel = ensureAlternatePresentCharactersPanel();
        $panel.empty().hide();
        return;
    }

    const presentCharacters = parsePresentCharacters(characterThoughtsData);
    if (presentCharacters.length === 0) {
        const $panel = ensureAlternatePresentCharactersPanel();
        $panel.empty().hide();
        return;
    }

    const title = i18n.getTranslation('template.trackerEditorModal.tabs.presentCharacters') || 'Present Characters';

    let html = `
        <div class="rpg-alt-present-characters__header">
            <div class="rpg-alt-present-characters__title">
                <i class="fa-solid fa-users" aria-hidden="true"></i>
                <span>${escapeHtml(title)}</span>
            </div>
            <div class="rpg-alt-present-characters__count">${presentCharacters.length}</div>
        </div>
        <div class="rpg-alt-present-characters__scroll">
            <div class="rpg-alt-present-characters__track">
    `;

    for (const character of presentCharacters) {
        const portrait = (extensionSettings.syncExpressionsToPresentCharacters
            ? getExpressionPortraitForCharacter(character.name)
            : null) || resolvePresentCharacterPortrait(character.name);
        const name = escapeHtml(character.name || '');

        html += `
            <div class="rpg-alt-present-character" data-character-name="${name}" title="${name}">
                <div class="rpg-alt-present-character__portrait">
                    <img src="${portrait}" alt="${name}" loading="lazy" onerror="this.style.opacity='0.5';this.onerror=null;" />
                </div>
                <div class="rpg-alt-present-character__meta">
                    <div class="rpg-alt-present-character__name">${name}</div>
                </div>
            </div>
        `;
    }

    html += `
            </div>
        </div>
    `;

    const $panel = ensureAlternatePresentCharactersPanel();
    $panel.html(html).show();
    syncAlternatePresentCharactersTheme();
}
