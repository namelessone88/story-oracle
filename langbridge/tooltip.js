/**
 * LangBridge — hover card for highlighted trigger words.
 *
 * Hover (or tap) a highlighted word → which entries it can trigger, each with
 * its Chinese trigger words and the English ways to type it. That last part is
 * the point: "I want to bring this up — what do I type?"
 *
 * SEMANTICS: STATIC LOOKUP, NOT ACTIVATION STATE. The card says "can trigger
 * entry X" — never "entry X is active". Whether lore is actually injected
 * depends on scan depth, probability rolls, cooldowns and token budget, which
 * this extension cannot see. The card's footer says so.
 *
 * The card is appended to <body>, not to the message — chat containers have
 * overflow/transform contexts that would clip it.
 */

import { entriesForText, describeEntry } from './registry.js';

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

/** Build the card's markup for one highlighted span. Empty string = no card. */
export function buildCardHtml(registry, span) {
    if (!registry || !span) return '';
    const word = span.dataset.lbOrig || span.textContent || '';
    const uids = entriesForText(registry, word);
    const renderPair = registry.renderMap?.[word];
    if (!uids.length && !renderPair) return '';

    const entryBlocks = uids.map((uid) => {
        const entry = describeEntry(registry, uid);
        return `
          <div class="lb-tt-entry">
            <div class="lb-tt-entry-title">${esc(entry.title)}</div>
            ${entry.zhKeys.length
                ? `<div class="lb-tt-keys">${entry.zhKeys.map((k) => `<span class="lb-tt-key">${esc(k)}</span>`).join('')}</div>`
                : ''}
            ${entry.enKeys.length
                ? `<div class="lb-tt-row"><span class="lb-tt-label">英文打法</span>${
                    entry.enKeys.map((k) => `<span class="lb-tt-alias">${esc(k)}</span>`).join('')}</div>`
                : '<div class="lb-tt-none">（还没有英文触发词——跑一次「翻译触发词」）</div>'}
          </div>`;
    }).join('');

    // A renamed span shows English on screen; the card leads with the Chinese
    // original so "what was that actually called?" is answered at a glance.
    const en = renderPair ? ` <span class="lb-tt-en">${esc(renderPair.en)}</span>` : '';
    return `
      <div class="lb-tt-head">
        <div class="lb-tt-title">${esc(word)}${en}</div>
        <div class="lb-tt-cat">${uids.length ? '触发词' : '名称'}</div>
      </div>
      ${uids.length ? `<div class="lb-tt-section">可触发以下条目</div>${entryBlocks}` : ''}
      <div class="lb-tt-foot"><span class="lb-tt-note">${uids.length ? '可触发 ≠ 已注入' : '仅显示为英文，存储仍是中文'}</span></div>`;
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
    let top = rect.top - box.height - 8;              // prefer above; flip below
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
 * Attach delegated hover handling to a message container. Idempotent per root;
 * global dismissal (scroll / escape / click-away) is bound once.
 */
export function bindHover(root, getRegistry) {
    if (!root || root.dataset?.lbHover === '1') return;
    if (root.dataset) root.dataset.lbHover = '1';

    root.addEventListener('mouseover', (event) => {
        const span = event.target?.closest?.('.lb-span');
        if (span) showCardFor(getRegistry(), span);
    });
    root.addEventListener('mouseout', (event) => {
        if (!event.target?.closest?.('.lb-span')) return;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideCard, 120);        // grace period to reach the card
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
    window.addEventListener('scroll', hideCard, true);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideCard(); });
    document.addEventListener('click', (event) => {
        if (!event.target?.closest?.('.lb-span, .lb-tooltip')) hideCard();
    });
}
