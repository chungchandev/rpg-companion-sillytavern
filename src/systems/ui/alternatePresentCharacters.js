import { extensionSettings } from '../../core/state.js';
import { i18n } from '../../core/i18n.js';
import { getThoughtBasedExpressionPortraitForCharacter } from '../../utils/thoughtBasedExpressionPortraits.js';
import { getSafeImageSrc } from '../../utils/imageUrls.js';
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

function hexToRgba(hex, opacity = 100) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const a = opacity / 100;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function handlePortraitLoadError() {
    this.style.opacity = '0.5';
    $(this).off('error', handlePortraitLoadError);
}

function createAlternatePresentCharacterCard(character) {
    const rawPortrait = (extensionSettings.enableThoughtBasedExpressions
        ? getThoughtBasedExpressionPortraitForCharacter(character.name)
        : null) || resolvePresentCharacterPortrait(character.name);
    const portrait = getSafeImageSrc(rawPortrait);
    const name = String(character.name || '');

    const $card = $('<div class="rpg-alt-present-character"></div>')
        .attr('data-character-name', name)
        .attr('title', name);

    const $portrait = $('<div class="rpg-alt-present-character__portrait"></div>');
    const $image = $('<img />')
        .attr({
            alt: name,
            loading: 'lazy'
        })
        .on('error', handlePortraitLoadError);

    if (portrait) {
        $image.attr('src', portrait);
    }

    const $meta = $('<div class="rpg-alt-present-character__meta"></div>');
    const $name = $('<div class="rpg-alt-present-character__name"></div>').text(name);

    $portrait.append($image);
    $meta.append($name);
    $card.append($portrait, $meta);

    return $card;
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

    const $panel = ensureAlternatePresentCharactersPanel();
    const $header = $('<div class="rpg-alt-present-characters__header"></div>');
    const $headerTitle = $('<div class="rpg-alt-present-characters__title"></div>');
    const $scroll = $('<div class="rpg-alt-present-characters__scroll"></div>');
    const $track = $('<div class="rpg-alt-present-characters__track"></div>');

    $headerTitle.append(
        $('<i class="fa-solid fa-users" aria-hidden="true"></i>'),
        $('<span></span>').text(title)
    );

    $header.append(
        $headerTitle,
        $('<div class="rpg-alt-present-characters__count"></div>').text(String(presentCharacters.length))
    );

    for (const character of presentCharacters) {
        $track.append(createAlternatePresentCharacterCard(character));
    }

    $scroll.append($track);

    $panel.empty().append($header, $scroll).show();
    syncAlternatePresentCharactersTheme();
}
