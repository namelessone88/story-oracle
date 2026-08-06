/**
 * LangBridge — Name Registry (PURE: no DOM, no SillyTavern).
 *
 * One registry per worldbook. Backs the setup pass output, the name renderer,
 * and the tooltip. Schema and field semantics: spec §3.
 *
 * This module owns normalization/validation and the compilation of a registry
 * into matcher tokens under the current display toggles. It never touches
 * storage — that is host.js — so it stays unit-testable.
 */

import { buildMatcher, looksChinese } from './matcher.js';

export const REGISTRY_VERSION = 1;

export const CATEGORIES = ['character', 'location', 'faction', 'concept'];

/** Categories that participate in NAME RENDERING. Concepts are highlight-only. */
export const RENDERABLE = new Set(['character', 'location', 'faction']);

export const DEFAULT_TOGGLES = {
    renderCharacters: true,      // zh → display_en for category 'character'
    renderPlaces: true,          // …for 'location' + 'faction'
    highlight: true,             // trigger-key underline
    highlightUserMessages: false, // also scan user messages (doubles as drift detection)
};

/** A single hanzi substring-matches ordinary prose (红 hits 红色/脸红/红衣). */
export function isSingleHanzi(text) {
    const s = String(text || '');
    return [...s].length === 1 && looksChinese(s);
}

/** Empty registry for a book. */
export function emptyRegistry(bookName = '') {
    return {
        version: REGISTRY_VERSION,
        bookName: String(bookName || ''),
        bookFingerprint: '',
        entities: [],
        conceptKeys: [],
        addedKeys: {},
        // uid → { title, keys[] }, captured at setup time.
        //
        // ADDITION TO THE HANDOFF SPEC §3: the spec's schema stored only
        // sourceEntryUids / entryUids, but acceptance test 4 requires the hover
        // card to name the entry ("传送阵开销与购买力") and list its sibling
        // trigger keys. Resolving that from the live book at hover time would
        // need an async world-info read per hover; snapshotting it here keeps
        // the tooltip synchronous and keeps the runtime free of ST coupling.
        entryIndex: {},
    };
}

/**
 * Coerce anything loaded from storage into a valid registry, dropping junk
 * rather than throwing — a corrupt registry must degrade to "fewer tokens",
 * never to a broken chat (invariant I5).
 */
export function normalizeRegistry(raw, bookName = '') {
    const base = emptyRegistry(bookName);
    if (!raw || typeof raw !== 'object') return base;

    base.version = Number(raw.version) || REGISTRY_VERSION;
    base.bookName = String(raw.bookName || bookName || '');
    base.bookFingerprint = String(raw.bookFingerprint || '');

    const seenIds = new Set();
    for (const item of Array.isArray(raw.entities) ? raw.entities : []) {
        if (!item || typeof item !== 'object') continue;
        const canonical = String(item.canonical || '').trim();
        if (!canonical) continue;

        let id = String(item.id || '').trim() || canonical;
        while (seenIds.has(id)) id += '_';                   // ids must be unique
        seenIds.add(id);

        const category = CATEGORIES.includes(item.category) ? item.category : 'character';
        const singleChar = (item.singleChar === true) || isSingleHanzi(canonical);
        // Single-hanzi names are forced to zh display regardless of what the
        // setup pass guessed; the per-entity override lives in displayPolicy
        // but cannot make a single hanzi render as English by accident.
        const policy = singleChar ? 'zh' : (item.displayPolicy === 'zh' ? 'zh' : 'en');

        base.entities.push({
            id,
            canonical,
            display_en: String(item.display_en || '').trim(),
            category,
            aliases_zh: uniqueStrings(item.aliases_zh),
            aliases_en: uniqueStrings(item.aliases_en),
            displayPolicy: policy,
            singleChar,
            // opt-in: allow a single-hanzi entity to be highlighted anyway
            allowSingleCharHighlight: item.allowSingleCharHighlight === true,
            sourceEntryUids: uniqueNumbers(item.sourceEntryUids),
        });
    }

    for (const item of Array.isArray(raw.conceptKeys) ? raw.conceptKeys : []) {
        if (!item || typeof item !== 'object') continue;
        const zh = String(item.zh || '').trim();
        if (!zh) continue;
        base.conceptKeys.push({
            zh,
            en: uniqueStrings(item.en),
            entryUids: uniqueNumbers(item.entryUids),
        });
    }

    if (raw.addedKeys && typeof raw.addedKeys === 'object') {
        for (const [uid, keys] of Object.entries(raw.addedKeys)) {
            const list = uniqueStrings(keys);
            if (list.length) base.addedKeys[String(uid)] = list;
        }
    }

    if (raw.entryIndex && typeof raw.entryIndex === 'object') {
        for (const [uid, meta] of Object.entries(raw.entryIndex)) {
            if (!meta || typeof meta !== 'object') continue;
            base.entryIndex[String(uid)] = {
                title: String(meta.title || '').trim(),
                keys: uniqueStrings(meta.keys),
            };
        }
    }

    return base;
}

/** Entry metadata for the hover card: [{ uid, title, keys[] }]. */
export function describeEntries(registry, uids) {
    const index = (registry && registry.entryIndex) || {};
    return (Array.isArray(uids) ? uids : []).map((uid) => {
        const meta = index[String(uid)] || {};
        return {
            uid,
            title: meta.title || `条目 #${uid}`,
            keys: Array.isArray(meta.keys) ? meta.keys : [],
        };
    });
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

function uniqueNumbers(value) {
    const out = [];
    for (const item of Array.isArray(value) ? value : []) {
        const n = Number(item);
        if (Number.isFinite(n) && !out.includes(n)) out.push(n);
    }
    return out;
}

/** Cheap revision stamp — changes whenever content or toggles change, so the
 *  display pass knows a re-render is required (data-lb-pass marker). */
export function registryRevision(registry, toggles) {
    const r = registry || emptyRegistry();
    const t = { ...DEFAULT_TOGGLES, ...(toggles || {}) };
    let hash = 5381;
    const stamp = JSON.stringify([
        r.bookName, r.entities.length, r.conceptKeys.length,
        r.entities.map((e) => e.id + e.displayPolicy + e.display_en).join(','),
        t.renderCharacters, t.renderPlaces, t.highlight, t.highlightUserMessages,
    ]);
    for (let i = 0; i < stamp.length; i++) hash = (((hash << 5) + hash) + stamp.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
}

/** Should this entity's name be rendered in English under these toggles? */
export function shouldRenderEnglish(entity, toggles) {
    if (!entity || entity.displayPolicy !== 'en' || !entity.display_en) return false;
    const t = { ...DEFAULT_TOGGLES, ...(toggles || {}) };
    if (entity.category === 'character') return !!t.renderCharacters;
    if (entity.category === 'location' || entity.category === 'faction') return !!t.renderPlaces;
    return false;                                            // concepts never rename
}

/**
 * Compile the registry into matcher tokens under the current toggles.
 *
 * @param {object} registry
 * @param {object} toggles
 * @param {{includeEnglish?: boolean}} opts  includeEnglish is set when scanning
 *        USER messages, where the user's typed English should light up (drift
 *        detection). AI text is Chinese, so English tokens are pointless there
 *        and only add collision surface.
 *
 * Token order matters: names are pushed before concepts so that when a string is
 * both (e.g. a sect name that is also a concept key) the name wins in buildMatcher.
 */
export function buildTokens(registry, toggles, opts = {}) {
    const r = normalizeRegistry(registry);
    const t = { ...DEFAULT_TOGGLES, ...(toggles || {}) };
    const includeEnglish = !!opts.includeEnglish;
    const tokens = [];

    for (const entity of r.entities) {
        const renders = shouldRenderEnglish(entity, t);
        // A single-hanzi entity is excluded from highlighting by default because
        // it substring-matches ordinary prose; the per-entity override re-enables it.
        const highlightable = t.highlight && (!entity.singleChar || entity.allowSingleCharHighlight);
        if (!renders && !highlightable) continue;

        const push = (text, kind) => tokens.push({
            text, kind, type: 'name', entityId: entity.id, renders, highlightable,
        });

        push(entity.canonical, 'zh');
        for (const alias of entity.aliases_zh) push(alias, 'zh');
        if (includeEnglish && highlightable) {
            // English forms only ever HIGHLIGHT — rewriting "Shen Muwei" to
            // "Shen Muwei" is a no-op, and the user's own typing is never renamed.
            if (entity.display_en) tokens.push({ text: entity.display_en, kind: 'en', type: 'name', entityId: entity.id, renders: false, highlightable: true });
            for (const alias of entity.aliases_en) tokens.push({ text: alias, kind: 'en', type: 'name', entityId: entity.id, renders: false, highlightable: true });
        }
    }

    if (t.highlight) {
        r.conceptKeys.forEach((concept, index) => {
            if (isSingleHanzi(concept.zh)) return;           // same prose-collision rule
            tokens.push({ text: concept.zh, kind: 'zh', type: 'concept', conceptIndex: index, renders: false, highlightable: true });
            if (includeEnglish) {
                for (const en of concept.en) {
                    tokens.push({ text: en, kind: 'en', type: 'concept', conceptIndex: index, renders: false, highlightable: true });
                }
            }
        });
    }

    return tokens;
}

/** Convenience: compiled matcher for a registry + toggles. */
export function compile(registry, toggles, opts = {}) {
    return buildMatcher(buildTokens(registry, toggles, opts));
}

/** Look up an entity by id. */
export function findEntity(registry, entityId) {
    if (!registry || !entityId) return null;
    return (registry.entities || []).find((e) => e.id === entityId) || null;
}

/**
 * Every worldbook entry uid a token belongs to, plus the sibling trigger keys
 * of those entries — the tooltip's "keys entry X, whose other keys are …".
 * A key can belong to several entries (沈慕微 keys her own entry, her CG触发
 * entry, and 天剑宗's member list), so this always returns a list.
 */
export function tokenEntryRefs(registry, token) {
    if (!registry || !token) return [];
    if (token.type === 'concept') {
        const concept = (registry.conceptKeys || [])[token.conceptIndex];
        return concept ? concept.entryUids.slice() : [];
    }
    const entity = findEntity(registry, token.entityId);
    return entity ? entity.sourceEntryUids.slice() : [];
}
