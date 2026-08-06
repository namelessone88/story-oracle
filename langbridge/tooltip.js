/**
 * LangBridge — hover card (spec §5 "Hover card").
 *
 * SEMANTICS: STATIC LOOKUP, NOT ACTIVATION STATE. The card says "keys entry
 * 传送阵开销与购买力" — never "entry is active". A keyword's presence means the
 * entry is TRIGGERABLE while the message sits in scan depth; probability rolls,
 * cooldowns, token budget, and recursion decide actual injection. A "confirmed
 * fired last turn" tier via WORLD_INFO_ACTIVATED is v2.
 *
 * The card is appended to <body>, not to the message: chat containers have
 * overflow/transform contexts that would clip it.
 */

import { findEntity, tokenEntryRefs, describeEntries } from './registry.js';

const HOST_ID = 'lb-tooltip-host';
let hostEl = null;
let hideTimer = null;
let boundGlobals = false;

function host() {
    if (hostEl && hostEl.isConnected) return hostEl;
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.className = 'lb-tooltip';
    hostEl.setAttribute('role', 'tooltip');
    hostEl.hidden = true;
    document.body.appendChild(hostEl);
    return hostEl;
}

function esc(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Build the card's markup for one decorated span. */
export function buildCardHtml(registry, span) {
    if (!registry || !span) return '';
    const entityId = span.dataset.lbEntity || '';
    const conceptIndex = span.dataset.lbConcept;
    const original = span.dataset.lbOrig || span.textContent || '';

    let title = '';
    let subtitle = '';
    let aliasRows = '';
    let uids = [];

    if (entityId) {
        const entity = findEntity(registry, entityId);
        if (!entity) return '';
        title = `${esc(entity.canonical)}${entity.display_en ? ` <span class="lb-tt-en">${esc(entity.display_en)}</span>` : ''}`;
        subtitle = CATEGORY_LABEL[entity.category] || entity.category;
        // Both languages always — the card exists to answer "I forgot the name
        // in the other language", whichever form is currently on screen.
        if (entity.aliases_zh.length) aliasRows += row('中文别名', entity.aliases_zh);
        if (entity.aliases_en.length) aliasRows += row('English', entity.aliases_en);
        uids = tokenEntryRefs(registry, { type: 'name', entityId });
    } else if (conceptIndex != null) {
        const concept = (registry.conceptKeys || [])[Number(conceptIndex)];
        if (!concept) return '';
        title = esc(concept.zh);
        subtitle = CATEGORY_LABEL.concept;
        if (concept.en.length) aliasRows += row('English', concept.en);
        uids = tokenEntryRefs(registry, { type: 'concept', conceptIndex: Number(conceptIndex) });
    } else {
        return '';
    }

    // One key can belong to several entries (沈慕微 keys her own entry, her
    // CG触发 entry, and 天剑宗's member list) — always show all of them.
    const entries = describeEntries(registry, uids);
    const entryRows = entries.length
        ? entries.map((entry) => `
            <div class="lb-tt-entry">
              <div class="lb-tt-entry-title">${esc(entry.title)}</div>
              ${entry.keys.length
                ? `<div class="lb-tt-keys">${entry.keys.map((k) => `<span class="lb-tt-key">${esc(k)}</span>`).join('')}</div>`
                : '<div class="lb-tt-none">（未记录其它触发词）</div>'}
            </div>`).join('')
        : '<div class="lb-tt-none">（未记录所属条目）</div>';

    return `
      <div class="lb-tt-head">
        <div class="lb-tt-title">${title}</div>
        <div class="lb-tt-cat">${esc(subtitle)}</div>
      </div>
      ${aliasRows}
      <div class="lb-tt-section">触发以下条目</div>
      ${entryRows}
      <div class="lb-tt-foot">
        <button type="button" class="lb-tt-copy" data-lb-copy="${esc(original)}">复制中文「${esc(original)}」</button>
        <span class="lb-tt-note">可触发 ≠ 已注入</span>
      </div>`;
}

const CATEGORY_LABEL = {
    character: '角色', location: '地点', faction: '势力', concept: '概念 / 规则',
};

function row(label, values) {
    return `<div class="lb-tt-row"><span class="lb-tt-label">${esc(label)}</span>` +
        values.map((v) => `<span class="lb-tt-alias">${esc(v)}</span>`).join('') + '</div>';
}

function place(el, anchor) {
    const rect = anchor.getBoundingClientRect();
    el.hidden = false;
    el.style.visibility = 'hidden';
    el.style.left = '0px';
    el.style.top = '0px';
    const box = el.getBoundingClientRect();

    let left = rect.left + (rect.width / 2) - (box.width / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    // Prefer above; flip below when there is not enough headroom.
    let top = rect.top - box.height - 8;
    if (top < 8) top = rect.bottom + 8;

    el.style.left = `${Math.round(left + window.scrollX)}px`;
    el.style.top = `${Math.round(top + window.scrollY)}px`;
    el.style.visibility = '';
}

export function hideCard() {
    clearTimeout(hideTimer);
    if (hostEl) { hostEl.hidden = true; hostEl.innerHTML = ''; }
}

export function showCardFor(registry, span) {
    const html = buildCardHtml(registry, span);
    if (!html) return;
    const el = host();
    clearTimeout(hideTimer);
    el.innerHTML = html;
    place(el, span);
}

/**
 * Attach delegated hover handling. Idempotent per root; global dismissal
 * (scroll / chat change / escape) is bound once.
 */
export function bindHover(root, getRegistry) {
    if (!root || root.dataset?.lbHover === '1') return;
    if (root.dataset) root.dataset.lbHover = '1';

    const show = (event) => {
        const span = event.target?.closest?.('.lb-span');
        if (!span) return;
        showCardFor(getRegistry(), span);
    };
    const scheduleHide = () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideCard, 120);   // grace period to reach the card
    };

    root.addEventListener('mouseover', show);
    root.addEventListener('mouseout', (event) => {
        if (event.target?.closest?.('.lb-span')) scheduleHide();
    });
    // Touch devices have no hover: tapping a span opens the card.
    root.addEventListener('click', (event) => {
        const span = event.target?.closest?.('.lb-span');
        if (span) { event.stopPropagation(); showCardFor(getRegistry(), span); }
    });

    if (boundGlobals) return;
    boundGlobals = true;

    const el = host();
    el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    el.addEventListener('mouseleave', hideCard);
    el.addEventListener('click', async (event) => {
        const button = event.target?.closest?.('[data-lb-copy]');
        if (!button) return;
        const text = button.dataset.lbCopy || '';
        try {
            await navigator.clipboard.writeText(text);
            button.textContent = '已复制';
        } catch (e) {
            // Clipboard API needs a secure context; fall back to selection.
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); button.textContent = '已复制'; } catch (err) { /* ignore */ }
            ta.remove();
        }
    });

    window.addEventListener('scroll', hideCard, true);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideCard(); });
    document.addEventListener('click', (event) => {
        if (!event.target?.closest?.('.lb-span, .lb-tooltip')) hideCard();
    });
}
