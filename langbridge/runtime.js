/**
 * LangBridge — display runtime (Component B, spec §5).
 *
 * Post-render DOM decoration. ZERO LLM calls. NEVER touches message.mes or the
 * chat file (invariant I1) — every change here is to rendered DOM only, and is
 * fully reversible via strip().
 *
 * Three properties this file must hold:
 *   · IDEMPOTENT — re-running over a processed message is a no-op. The pass
 *     stamps data-lb-pass="<revision>"; a matching stamp short-circuits.
 *   · REVERSIBLE — every span records data-lb-orig (the exact original text),
 *     so strip() restores the DOM byte-for-byte before a re-render.
 *   · LOOP-FREE — the MutationObserver disconnects while we write, and ignores
 *     mutations that originate inside our own spans (risk R5).
 */

import { scan } from './matcher.js';
import { compile, registryRevision, findEntity, shouldRenderEnglish, DEFAULT_TOGGLES } from './registry.js';

/** Containers whose text must never be rewritten.
 *
 *  Operating post-render means <插图> tags are already <img> and MVU blocks are
 *  already collapsed, so this list is defense in depth rather than the primary
 *  mechanism. VERIFY (Phase 0 V5): extend with the real container selectors used
 *  by MVU / status-bar templates / LittleWhiteBox in the user's live chat. */
export const DEFAULT_SKIP_SELECTORS = [
    'code', 'pre', 'script', 'style', 'textarea', 'input', 'select',
    '.lb-span',                      // our own output
    '.mes_edit_buttons', '.mes_buttons', '.name_text', '.timestamp',
    '.mes_img_container', '.mes_img',
    '[data-lb-skip]',                // manual escape hatch
    // --- extension-rendered regions (verify + extend in Phase 0) ---
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
        this.onHoverBind = options.onHoverBind || null;   // tooltip attachment hook

        this._observer = null;
        this._writing = false;
        this._timer = null;
        this._matcherCache = null;    // { revision, ai, user }
    }

    /* -------------------------------------------------------------- *
     * Matchers (compiled per revision; toggles change the revision)
     * -------------------------------------------------------------- */

    _matchers() {
        const registry = this.getRegistry();
        const toggles = { ...DEFAULT_TOGGLES, ...(this.getToggles() || {}) };
        const revision = registryRevision(registry, toggles);
        if (this._matcherCache && this._matcherCache.revision === revision) return this._matcherCache;

        this._matcherCache = {
            revision,
            registry,
            toggles,
            // AI text is Chinese — English tokens would only add collision surface.
            ai: compile(registry, toggles, { includeEnglish: false }),
            // User text is English — including en tokens makes typed input light
            // up, which doubles as drift detection for missing setup keys.
            user: compile(registry, toggles, { includeEnglish: true }),
        };
        return this._matcherCache;
    }

    get revision() { return this._matchers().revision; }

    /* -------------------------------------------------------------- *
     * Public API
     * -------------------------------------------------------------- */

    /** Decorate every message currently in the DOM. */
    passAll() {
        const nodes = document.querySelectorAll(MESSAGE_SELECTOR);
        for (const el of nodes) this.passMessage(el);
    }

    /** Decorate one message element (or the message containing `el`). */
    passMessage(el) {
        const mes = el?.closest?.(MESSAGE_SELECTOR) || el;
        if (!mes || !mes.querySelector) return;

        const { revision, registry, toggles, ai, user } = this._matchers();
        if (mes.dataset.lbPass === revision) return;               // idempotent

        const isUser = mes.getAttribute('is_user') === 'true';
        if (isUser && !toggles.highlightUserMessages) {
            // Nothing to do for user messages unless the user opted in — but
            // still strip any spans left over from a previous toggle state.
            this._withoutObserver(() => {
                for (const host of mes.querySelectorAll(TEXT_SELECTOR)) stripIn(host);
                mes.dataset.lbPass = revision;
            });
            return;
        }

        const matcher = isUser ? user : ai;
        this._withoutObserver(() => {
            for (const host of mes.querySelectorAll(TEXT_SELECTOR)) {
                stripIn(host);                                     // clean previous revision
                if (matcher.regex) this._decorate(host, matcher, registry, toggles, isUser);
            }
            mes.dataset.lbPass = revision;
        });
    }

    /** Remove all LangBridge decoration from the chat (toggle-off / shutdown). */
    stripAll() {
        this._withoutObserver(() => {
            for (const host of document.querySelectorAll(`${MESSAGE_SELECTOR} ${TEXT_SELECTOR}`)) stripIn(host);
            for (const mes of document.querySelectorAll(MESSAGE_SELECTOR)) delete mes.dataset.lbPass;
        });
    }

    /** Toggle change: drop cached matchers, strip, re-render. */
    refresh() {
        this._matcherCache = null;
        this.stripAll();
        this.passAll();
    }

    /* -------------------------------------------------------------- *
     * Observer — the standalone safety net (spec §2.5)
     *
     * Events alone cannot be trusted: LangBridge has no control over when MVU /
     * LittleWhiteBox / JS-Slash-Runner finish mutating a message, and manifest
     * loading_order does not govern render order. A debounced observer catches
     * late mutations regardless of extension ordering.
     * -------------------------------------------------------------- */

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
                if (node.closest?.('.lb-span')) continue;          // our own output
                if (node.closest?.('.lb-tooltip')) continue;
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

    /* -------------------------------------------------------------- *
     * Decoration
     * -------------------------------------------------------------- */

    _decorate(host, matcher, registry, toggles, isUser) {
        // Text nodes are collected BEFORE mutating: replacing a node invalidates
        // an in-flight TreeWalker.
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

                const entity = hit.token.type === 'name' ? findEntity(registry, hit.token.entityId) : null;
                // A user's typed English is highlighted but never renamed.
                const renameToEnglish = !isUser && entity && shouldRenderEnglish(entity, toggles) && hit.token.kind === 'zh';
                const highlight = !!toggles.highlight && hit.token.highlightable !== false;

                if (!renameToEnglish && !highlight) {
                    frag.appendChild(document.createTextNode(hit.text));
                    cursor = hit.end;
                    continue;
                }

                const span = document.createElement('span');
                span.className = 'lb-span' + (renameToEnglish ? ' lb-name' : '') + (highlight ? ' lb-hl' : '');
                span.dataset.lbOrig = hit.text;                     // exact restore on strip
                if (entity) {
                    span.dataset.lbEntity = entity.id;
                    span.dataset.lbCanonical = entity.canonical;
                } else if (hit.token.type === 'concept') {
                    span.dataset.lbConcept = String(hit.token.conceptIndex);
                    span.dataset.lbCanonical = hit.text;
                }
                span.textContent = renameToEnglish ? entity.display_en : hit.text;
                frag.appendChild(span);
                cursor = hit.end;
            }

            if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
            node.parentNode?.replaceChild(frag, node);
        }

        if (this.onHoverBind) this.onHoverBind(host);
    }
}

/* ------------------------------------------------------------------ *
 * Helpers (exported for testing / reuse)
 * ------------------------------------------------------------------ */

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

/** Restore every LangBridge span under host to its original text. */
export function stripIn(host) {
    if (!host || !host.querySelectorAll) return;
    const spans = host.querySelectorAll('.lb-span');
    for (const span of spans) {
        const original = span.dataset.lbOrig ?? span.textContent ?? '';
        span.parentNode?.replaceChild(document.createTextNode(original), span);
    }
    if (spans.length) host.normalize();      // re-merge split text nodes
}
