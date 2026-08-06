/**
 * LangBridge — translation-pass analysis (PURE: no DOM, no SillyTavern, no network).
 *
 * Two jobs, both unit-testable:
 *   · COLLISION SCREEN — reject English keys that would fire on machinery text
 *   · RESPONSE PARSING — tolerate the JSON a cheap model actually returns,
 *     plus output-budget-driven batch sizing
 */

/* ------------------------------------------------------------------ *
 * 1. Collision screen   (spec §4 Step 3)
 *
 * AI replies are NOT pure Chinese: they carry MVU update blocks, status-bar
 * HTML/CSS and JS-Slash-Runner output, and the World Info scanner reads the raw
 * string including all of it. An English key that appears in that machinery
 * fires CONSTANTLY, not occasionally — so every candidate is screened against
 * (a) a static code/UI vocabulary blocklist, (b) the card's own status-bar
 * template and 变量列表 content, and (c) a real sample AI reply when available.
 * ------------------------------------------------------------------ */

/** Code/UI vocabulary that shows up in status bars, CSS, and variable blocks. */
export const CODE_VOCAB = new Set([
    'level', 'status', 'state', 'value', 'name', 'time', 'date', 'type', 'set', 'get',
    'class', 'id', 'width', 'height', 'color', 'colour', 'background', 'display', 'text',
    'data', 'key', 'index', 'item', 'list', 'title', 'label', 'style', 'font', 'size',
    'src', 'href', 'div', 'span', 'img', 'true', 'false', 'null', 'none', 'auto',
    'update', 'variable', 'var', 'const', 'let', 'function', 'return', 'if', 'else',
    'max', 'min', 'top', 'left', 'right', 'bottom', 'center', 'flex', 'grid', 'block',
    'hp', 'mp', 'exp', 'lv', 'stat', 'stats', 'info', 'panel', 'bar', 'box', 'card',
    'user', 'char', 'system', 'assistant', 'role', 'content', 'message', 'chat',
    'plot', 'event', 'flag', 'count', 'total', 'current', 'target', 'source', 'result',
]);

/** Minimum length for a bare single-word key. Shorter words collide with everything. */
const MIN_BARE_WORD = 4;

/**
 * Screen one candidate English key.
 *
 * @param {string} candidate
 * @param {{machineryText?: string, extraBlocklist?: string[]}} context
 *        machineryText = status-bar template + 变量列表 content + a sample AI
 *        reply, concatenated. Screened case-insensitively with ASCII word
 *        boundaries so "level" hits `level: 3` but "cultivation level" does not
 *        hit merely because "level" appears.
 * @returns {{ok: boolean, key: string, reason?: string}}
 */
export function screenKey(candidate, context = {}) {
    const key = String(candidate == null ? '' : candidate).trim();
    if (!key) return { ok: false, key, reason: 'empty' };
    if (!/[A-Za-z]/.test(key)) return { ok: false, key, reason: 'no-letters' };
    if (/[<>{}[\]|\\]/.test(key)) return { ok: false, key, reason: 'markup-characters' };

    const lower = key.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    const isPhrase = words.length > 1;

    if (!isPhrase) {
        if (key.length < MIN_BARE_WORD) return { ok: false, key, reason: 'too-short' };
        // Bare single words are the dangerous class — a phrase containing a
        // blocked word ("cultivation level") is fine, the bare word is not.
        if (CODE_VOCAB.has(lower)) return { ok: false, key, reason: 'code-vocabulary' };
        const extra = (context.extraBlocklist || []).map((w) => String(w).toLowerCase());
        if (extra.includes(lower)) return { ok: false, key, reason: 'blocklisted' };
    }

    const machinery = String(context.machineryText || '');
    if (machinery && containsPhrase(machinery, key)) {
        return { ok: false, key, reason: 'appears-in-machinery' };
    }

    return { ok: true, key };
}

/** Case-insensitive, ASCII-word-bounded containment (no regex lookbehind). */
export function containsPhrase(haystack, needle) {
    const hay = String(haystack).toLowerCase();
    const pin = String(needle).toLowerCase();
    if (!pin) return false;
    let from = 0;
    for (;;) {
        const at = hay.indexOf(pin, from);
        if (at < 0) return false;
        const before = hay[at - 1];
        const after = hay[at + pin.length];
        const wordy = (ch) => ch !== undefined && /[a-z0-9]/.test(ch);
        if (!wordy(before) && !wordy(after)) return true;
        from = at + 1;
    }
}

/** Screen a list, returning what survives and why the rest died. */
export function screenKeys(candidates, context = {}) {
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const verdict = screenKey(candidate, context);
        const dedupe = verdict.key.toLowerCase();
        if (!verdict.ok) { rejected.push(verdict); continue; }
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        accepted.push(verdict.key);
    }
    return { accepted, rejected };
}

/* ------------------------------------------------------------------ *
 * 2. Response parsing   (spec §4 Step 1/2)
 *
 * Cheap models wrap JSON in prose, fence it, add trailing commas, and use smart
 * quotes. Parse defensively; a batch that cannot be read must fail ALONE and
 * leave the rest of the pass intact.
 * ------------------------------------------------------------------ */

/** Extract the first JSON array/object from a model reply. Returns null on failure. */
export function extractJson(raw) {
    const text = String(raw == null ? '' : raw);
    if (!text.trim()) return null;

    // Prefer a fenced block when present, else scan the whole reply.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;

    const start = firstIndexOfAny(body, ['[', '{']);
    if (start < 0) return null;
    const openChar = body[start];
    const closeChar = openChar === '[' ? ']' : '}';
    const end = body.lastIndexOf(closeChar);
    if (end <= start) return null;

    const candidate = body.slice(start, end + 1);
    for (const attempt of [candidate, repairJson(candidate)]) {
        try {
            return JSON.parse(attempt);
        } catch (e) { /* try the repaired form next */ }
    }
    return null;
}

function firstIndexOfAny(text, chars) {
    let best = -1;
    for (const ch of chars) {
        const at = text.indexOf(ch);
        if (at >= 0 && (best < 0 || at < best)) best = at;
    }
    return best;
}

/** Minimal repairs for the mistakes cheap models actually make. */
export function repairJson(text) {
    return String(text)
        .replace(/[“”]/g, '"')      // smart double quotes
        .replace(/[‘’]/g, "'")      // smart single quotes
        .replace(/\/\/[^\n\r]*/g, '')         // line comments
        .replace(/,(\s*[}\]])/g, '$1');       // trailing commas
}

/**
 * Normalize one translated entry from the model: { uid, key_en[] }.
 * Anything unusable is dropped; a row with an empty key_en is kept (it is a
 * valid answer meaning "nothing here translates well").
 */
export function normalizeTranslation(item) {
    if (!item || typeof item !== 'object') return null;
    const uid = Number(item.uid);
    if (!Number.isFinite(uid)) return null;
    const list = Array.isArray(item.key_en) ? item.key_en
        : (Array.isArray(item.keys_en) ? item.keys_en : []);
    // Optional display pair: the entry is ABOUT a named person/place/faction
    // whose phonetic name reads better romanized (沈慕微 → "Shen Muwei").
    let render = null;
    if (item.render && typeof item.render === 'object') {
        const zh = String(item.render.zh || '').trim();
        const en = String(item.render.en || '').trim();
        if (zh && en) render = { zh, en };
    }
    return {
        uid,
        key_en: list.map((k) => String(k || '').trim()).filter(Boolean),
        render,
    };
}

/** Parse a whole translation batch reply. Always returns an array. */
export function parseTranslationBatch(raw) {
    const parsed = extractJson(raw);
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : null);
    if (!list) return [];
    return list.map(normalizeTranslation).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 3. Batching   (spec §3.0)
 * ------------------------------------------------------------------ */

/** Split entries into batches for the classification calls. */
export function planBatches(items, batchSize = DEFAULT_BATCH_SIZE) {
    const size = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);
    const batches = [];
    for (let i = 0; i < (items || []).length; i += size) batches.push(items.slice(i, i + size));
    return batches;
}

/**
 * Batch sizing is bounded by OUTPUT tokens, not input.
 *
 * A conversational worldbook call can put all 176 entries in one prompt because
 * its answer is short. This pass is the opposite shape: it must emit one JSON
 * row PER ENTRY, so the reply grows linearly with the batch. Overrun the output
 * cap and the array is truncated mid-row and the whole reply is unparseable.
 *
 * A row like
 *   {"uid":8,"category":"character","display_en":"Shen Muwei",
 *    "displayPolicy":"en","aliases_en":["Muwei"],"concept_en":[]}
 * costs roughly 55-75 tokens; concept rows with several Chinese-derived phrases
 * run higher. 80 is the conservative per-row figure used here.
 *
 * Input is not the binding constraint: each entry contributes only its title,
 * its keys and 300 characters of content (~150 tokens), so even a full book sits
 * inside an ordinary context window.
 */
export const OUTPUT_TOKENS_PER_ENTRY = 80;
export const DEFAULT_OUTPUT_BUDGET = 8192;
/** Leave headroom so a model that pads its rows still lands inside the cap. */
export const OUTPUT_SAFETY = 0.7;
export const DEFAULT_BATCH_SIZE = batchSizeForBudget(DEFAULT_OUTPUT_BUDGET);

/** Largest batch whose expected reply fits the output budget. */
export function batchSizeForBudget(outputBudget, perEntry = OUTPUT_TOKENS_PER_ENTRY) {
    const budget = Math.max(512, Number(outputBudget) || DEFAULT_OUTPUT_BUDGET);
    const per = Math.max(1, Number(perEntry) || OUTPUT_TOKENS_PER_ENTRY);
    return Math.max(1, Math.floor((budget * OUTPUT_SAFETY) / per));
}

/** Rough expected reply size for a batch — used for logging and sizing checks. */
export function estimateOutputTokens(count, perEntry = OUTPUT_TOKENS_PER_ENTRY) {
    return Math.max(0, Number(count) || 0) * (Number(perEntry) || OUTPUT_TOKENS_PER_ENTRY);
}

/** Stable hash of an entry's classifiable content — the result cache key, so a
 *  re-run or resumed run does not re-spend tokens on unchanged entries. */
export function entryHash(entry) {
    const stamp = [
        String(entry?.comment || ''),
        String(entry?.content || '').slice(0, 300),
        (Array.isArray(entry?.key) ? entry.key : []).join(','),
    ].join(' ');
    let hash = 5381;
    for (let i = 0; i < stamp.length; i++) hash = (((hash << 5) + hash) + stamp.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
}
