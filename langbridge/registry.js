/**
 * LangBridge — registry (PURE: no DOM, no SillyTavern).
 *
 * One registry per worldbook, and it holds exactly what the two features need:
 *
 *   entryIndex       uid → { title, keys[], gated }   what's in the book
 *   keyTranslations  uid → [english trigger words]    how you type it
 *   addedKeys        uid → [keys we actually wrote]   the idempotency ledger
 *
 * `gated` = the entry is keyword-triggered (green light): not constant, not
 * disabled. Only gated entries participate in anything — a blue (constant)
 * entry fires every turn regardless of keywords, so English triggers buy it
 * nothing and highlighting its keys is noise.
 *
 * This module also compiles the registry into matcher tokens. It never touches
 * storage — that is host.js — so it stays unit-testable.
 */

import { buildMatcher, looksChinese } from './matcher.js';

export const REGISTRY_VERSION = 2;

export const DEFAULT_TOGGLES = {
    highlight: true,              // underline trigger words in AI replies
    highlightUserMessages: false, // also scan what YOU type (drift detection:
                                  // an English phrase that lights nothing up
                                  // means no key covers it yet)
};

/** A single hanzi substring-matches ordinary prose (红 hits 红色/脸红/红衣),
 *  so single-hanzi keys are excluded from HIGHLIGHTING. They are still fine to
 *  TRANSLATE — "Hong" has word boundaries on the English side. */
export function isSingleHanzi(text) {
    const s = String(text || '');
    return [...s].length === 1 && looksChinese(s);
}

export function emptyRegistry(bookName = '') {
    return {
        version: REGISTRY_VERSION,
        bookName: String(bookName || ''),
        bookFingerprint: '',
        entryIndex: {},
        keyTranslations: {},
        addedKeys: {},
    };
}

/**
 * Coerce anything loaded from storage into a valid registry, dropping junk
 * rather than throwing — a corrupt registry must degrade to "fewer tokens",
 * never to a broken chat. Old v1 registries (which carried an entity model for
 * name rendering) load cleanly: the three fields above existed there too, and
 * everything else is simply ignored.
 */
export function normalizeRegistry(raw, bookName = '') {
    const base = emptyRegistry(bookName);
    if (!raw || typeof raw !== 'object') return base;

    base.bookName = String(raw.bookName || bookName || '');
    base.bookFingerprint = String(raw.bookFingerprint || '');

    if (raw.entryIndex && typeof raw.entryIndex === 'object') {
        for (const [uid, meta] of Object.entries(raw.entryIndex)) {
            if (!meta || typeof meta !== 'object') continue;
            base.entryIndex[String(uid)] = {
                title: String(meta.title || '').trim() || `条目 #${uid}`,
                keys: uniqueStrings(meta.keys),
                // v1 had no gated flag; default true so old data keeps working
                // until the next 扫描 refreshes it from the book.
                gated: meta.gated !== false,
            };
        }
    }

    if (raw.keyTranslations && typeof raw.keyTranslations === 'object') {
        for (const [uid, keys] of Object.entries(raw.keyTranslations)) {
            const list = uniqueStrings(keys);
            if (list.length) base.keyTranslations[String(uid)] = list;
        }
    }

    if (raw.addedKeys && typeof raw.addedKeys === 'object') {
        for (const [uid, keys] of Object.entries(raw.addedKeys)) {
            const list = uniqueStrings(keys);
            if (list.length) base.addedKeys[String(uid)] = list;
        }
    }

    return base;
}

function uniqueStrings(value) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(value) ? value : []) {
        const text = String(item == null ? '' : item).trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

/** Cheap revision stamp — changes when content or toggles change, so the
 *  display pass knows a processed message needs re-rendering. */
export function registryRevision(registry, toggles) {
    const r = registry || emptyRegistry();
    const t = { ...DEFAULT_TOGGLES, ...(toggles || {}) };
    const stamp = JSON.stringify([
        r.bookName,
        Object.entries(r.entryIndex).map(([uid, m]) => uid + m.gated + m.keys.join(',')),
        r.keyTranslations,
        t.highlight, t.highlightUserMessages,
    ]);
    let hash = 5381;
    for (let i = 0; i < stamp.length; i++) hash = (((hash << 5) + hash) + stamp.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
}

/**
 * Compile the registry into matcher tokens.
 *
 * AI replies are Chinese, so their scan uses only the Chinese keys of gated
 * entries. With includeEnglish (user messages), the English side joins in:
 * ASCII keys already in the book (including ones we wrote) plus the planned
 * translations — that is what makes typed English light up.
 */
export function buildTokens(registry, toggles, opts = {}) {
    const r = normalizeRegistry(registry);
    const t = { ...DEFAULT_TOGGLES, ...(toggles || {}) };
    if (!t.highlight) return [];

    const tokens = [];
    const push = (text, kind) => tokens.push({ text, kind });

    for (const [uid, meta] of Object.entries(r.entryIndex)) {
        if (!meta.gated) continue;
        for (const key of meta.keys) {
            if (looksChinese(key)) {
                if (!isSingleHanzi(key)) push(key, 'zh');
            } else if (opts.includeEnglish && key.length >= 3) {
                push(key, 'en');
            }
        }
        if (opts.includeEnglish) {
            for (const key of r.keyTranslations[uid] || []) {
                if (key.length >= 3) push(key, 'en');
            }
        }
    }

    return tokens;
}

/** Compiled matcher for a registry + toggles. buildMatcher dedupes texts. */
export function compile(registry, toggles, opts = {}) {
    return buildMatcher(buildTokens(registry, toggles, opts));
}

/**
 * Which entries a matched word belongs to. A key can belong to several entries
 * (沈慕微 keys her 人设 entry AND her CG触发 entry) — always returns all.
 * Case-insensitive so English hits resolve regardless of typed casing.
 */
export function entriesForText(registry, text) {
    const needle = String(text || '').trim().toLowerCase();
    if (!needle) return [];
    const r = registry || emptyRegistry();
    const uids = [];
    for (const [uid, meta] of Object.entries(r.entryIndex || {})) {
        const inKeys = (meta.keys || []).some((k) => k.toLowerCase() === needle);
        const inTranslations = (r.keyTranslations?.[uid] || []).some((k) => k.toLowerCase() === needle);
        if (inKeys || inTranslations) uids.push(uid);
    }
    return uids;
}

/** Hover-card data for one entry: title, Chinese keys, English ways to type it. */
export function describeEntry(registry, uid) {
    const r = registry || emptyRegistry();
    const meta = r.entryIndex?.[String(uid)] || {};
    const keys = Array.isArray(meta.keys) ? meta.keys : [];
    const translations = r.keyTranslations?.[String(uid)] || [];
    const en = uniqueStrings([...keys.filter((k) => !looksChinese(k)), ...translations]);
    return {
        uid: String(uid),
        title: meta.title || `条目 #${uid}`,
        zhKeys: keys.filter((k) => looksChinese(k)),
        enKeys: en,
        gated: meta.gated !== false,
    };
}
