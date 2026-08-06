/**
 * LangBridge — display runtime: trigger-word highlighting + name rendering.
 *
 * Post-render DOM decoration. ZERO LLM calls. NEVER touches message.mes or the
 * chat file — every change is to rendered DOM only and fully reversible.
 *
 * Three properties this file must hold:
 *   · IDEMPOTENT — re-running over a processed message is a no-op. The pass
 *     stamps data-lb-pass="<revision>"; a matching stamp short-circuits.
 *   · REVERSIBLE — strip() restores the DOM byte-for-byte.
 *   · LOOP-FREE — the MutationObserver disconnects while we write, and ignores
 *     mutations originating inside our own spans.
 *
 * The MutationObserver exists because LangBridge cannot know when MVU /
 * LittleWhiteBox / JS-Slash-Runner finish mutating a message — manifest
 * loading_order does not govern render order. A debounced observer catches
 * late mutations regardless of extension ordering.
 */

import { scan } from './matcher.js';
import { compile, registryRevision, DEFAULT_TOGGLES } from './registry.js';

/** Containers whose text must never be decorated. Post-render, <插图> tags are
 *  already <img> and variable blocks collapsed, so this is defense in depth.
 *  VERIFY against the live chat's actual MVU / status-bar / LWB containers. */
export const DEFAULT_SKIP_SELECTORS = [
    'code', 'pre', 'script', 'style', 'textarea', 'input', 'select',
    '.lb-span',
    '.mes_edit_buttons', '.mes_buttons', '.name_text', '.timestamp',
    '.mes_img_container', '.mes_img',
    '[data-lb-skip]',
    '.mvu-status', '.status_bar', '.statusbar', '.variable-block',
    '.lwb-image', '.novel-draw', '.qr--buttons',
];

const MESSAGE_SELECTOR = '#chat .mes';
const TEXT_SELECTOR = '.mes_text';

export class DisplayRuntime {
    constructor(options = {}) {
        this.getRegistry = options.getRegistry || (() => null);
        this.getToggles = options.getToggles || (() => DEFAULT_TOGGLES);
        this.skipSelectors = options.skipSelectors || DEFAULT_SKIP_SELECTORS;
        this.onHoverBind = options.onHoverBind || null;

        this._observer = null;
        this._writing = false;
        this._timer = null;
        this._matcherCache = null;    // { revision, ai, user }
    }

    _matchers() {
        const registry = this.getRegistry();
        const toggles = { ...DEFAULT_TOGGLES, ...(this.getToggles() || {}) };
        const revision = registryRevision(registry, toggles);
        if (this._matcherCache && this._matcherCache.revision === revision) return this._matcherCache;

        this._matcherCache = {
            revision,
            toggles,
            // AI text is Chinese — English tokens there would only false-fire.
            ai: compile(registry, toggles, { includeEnglish: false }),
            // User text is English — lighting it up is the drift detector.
            user: compile(registry, toggles, { includeEnglish: true }),
        };
        return this._matcherCache;
    }

    get revision() { return this._matchers().revision; }

    /** Decorate every message currently in the DOM. */
    passAll() {
        for (const el of document.querySelectorAll(MESSAGE_SELECTOR)) this.passMessage(el);
    }

    /** Decorate one message element (or the message containing `el`). */
    passMessage(el) {
        const mes = el?.closest?.(MESSAGE_SELECTOR) || el;
        if (!mes || !mes.querySelector) return;

        const { revision, toggles, ai, user } = this._matchers();
        if (mes.dataset.lbPass === revision) return;               // idempotent

        const isUser = mes.getAttribute('is_user') === 'true';
        // AI replies: highlight and/or rename. User messages: highlight only,
        // and only when opted in — the user's own text is never renamed.
        const active = isUser
            ? (toggles.highlight && toggles.highlightUserMessages)
            : (toggles.highlight || toggles.renderNames);
        const matcher = isUser ? user : ai;

        this._withoutObserver(() => {
            for (const host of mes.querySelectorAll(TEXT_SELECTOR)) {
                stripIn(host);                                     // clean previous revision
                if (active && matcher.regex) this._decorate(host, matcher);
            }
            mes.dataset.lbPass = revision;
        });
    }

    /** Remove all decoration (toggle-off / shutdown). */
    stripAll() {
        this._withoutObserver(() => {
            for (const host of document.querySelectorAll(`${MESSAGE_SELECTOR} ${TEXT_SELECTOR}`)) stripIn(host);
            for (const mes of document.querySelectorAll(MESSAGE_SELECTOR)) delete mes.dataset.lbPass;
        });
    }

    /** Toggle/registry change: drop cached matchers, strip, re-render. */
    refresh() {
        this._matcherCache = null;
        this.stripAll();
        this.passAll();
    }

    startObserver(delayMs = 120) {
        if (this._observer || typeof MutationObserver === 'undefined') return;
        const chat = document.getElementById('chat');
        if (!chat) return;

        this._observer = new MutationObserver((records) => {
            if (this._writing) return;
            let relevant = false;
            for (const record of records) {
                const target = record.target;
                const node = target?.nodeType === 1 ? target : target?.parentElement;
                if (!node) continue;
                if (node.closest?.('.lb-span') || node.closest?.('.lb-tooltip')) continue;
                relevant = true;
                break;
            }
            if (!relevant) return;
            clearTimeout(this._timer);
            this._timer = setTimeout(() => this.passAll(), delayMs);
        });

        this._observer.observe(chat, { childList: true, subtree: true, characterData: true });
    }

    stopObserver() {
        clearTimeout(this._timer);
        this._observer?.disconnect();
        this._observer = null;
    }

    /** Run fn with the observer detached so our own writes cannot retrigger it. */
    _withoutObserver(fn) {
        const wasObserving = !!this._observer;
        this._writing = true;
        if (wasObserving) this._observer.disconnect();
        try {
            fn();
        } catch (e) {
            console.warn('[LangBridge] display pass failed (chat is unaffected):', e);
        } finally {
            this._writing = false;
            if (wasObserving) {
                const chat = document.getElementById('chat');
                if (chat) this._observer.observe(chat, { childList: true, subtree: true, characterData: true });
            }
        }
    }

    _decorate(host, matcher) {
        // Collect text nodes BEFORE mutating — replacing a node invalidates an
        // in-flight TreeWalker.
        const targets = collectTextNodes(host, this.skipSelectors);

        for (const node of targets) {
            const text = node.nodeValue;
            if (!text || !text.trim()) continue;
            const hits = scan(text, matcher);
            if (!hits.length) continue;

            const frag = document.createDocumentFragment();
            let cursor = 0;
            for (const hit of hits) {
                if (hit.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, hit.start)));
                // Token flags were decided at build time from the toggles:
                // render = English display form (AI matcher only), highlight =
                // this text is a live trigger key. Every token has at least one.
                const renderEn = hit.token.render || '';
                const highlight = !!hit.token.highlight;
                const span = document.createElement('span');
                span.className = 'lb-span' + (renderEn ? ' lb-name' : '') + (highlight ? ' lb-hl' : '');
                span.dataset.lbOrig = hit.text;                    // exact restore on strip
                span.textContent = renderEn || hit.text;
                frag.appendChild(span);
                cursor = hit.end;
            }
            if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
            node.parentNode?.replaceChild(frag, node);
        }

        if (this.onHoverBind) this.onHoverBind(host);
    }
}

/** Collect decoratable text nodes under root, skipping configured subtrees. */
export function collectTextNodes(root, skipSelectors = DEFAULT_SKIP_SELECTORS) {
    const out = [];
    if (!root || typeof document === 'undefined') return out;
    const selector = skipSelectors.join(',');

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (selector && parent.closest(selector)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    let node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
}

/** Restore every LangBridge span under host to plain text. */
export function stripIn(host) {
    if (!host || !host.querySelectorAll) return;
    const spans = host.querySelectorAll('.lb-span');
    for (const span of spans) {
        const original = span.dataset.lbOrig ?? span.textContent ?? '';
        span.parentNode?.replaceChild(document.createTextNode(original), span);
    }
    if (spans.length) host.normalize();      // re-merge split text nodes
}
