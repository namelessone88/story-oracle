/**
 * LangBridge — Setup Pass analysis (PURE: no DOM, no SillyTavern, no network).
 *
 * Three jobs, all unit-testable:
 *   · COLLISION SCREEN — reject English keys that would fire on machinery text
 *   · VARIANT GENERATION — derive the English forms a user actually types
 *   · RESPONSE PARSING — tolerate the JSON a cheap model actually returns
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
 * 2. English variant generation   (spec §4 Step 2/3)
 *
 * The user types "Muwei", not "Shen Muwei". Chinese names are surname-first, so
 * the given name is everything after the first token.
 *
 * DEVIATION FROM SPEC §4 Step 2 (deliberate, see README): the spec called for a
 * bundled JS pinyin library for mechanical romanization. That would mean
 * vendoring a large character table for something the setup LLM already does
 * accurately in the same call it is making anyway — and §10 R7 forbids fetching
 * one from a CDN. So the LLM supplies the base romanization and this function
 * derives the mechanical VARIANTS from it. Same recall, no 200KB table.
 *
 * Surname-only is deliberately NOT generated: single common surnames (Shen, Lin,
 * Mu) collide with ordinary English text far too easily.
 * ------------------------------------------------------------------ */

export function nameVariants(displayEn, opts = {}) {
    const full = String(displayEn == null ? '' : displayEn).trim().replace(/\s+/g, ' ');
    if (!full) return [];

    const out = [full];
    const tokens = full.split(' ');

    if (tokens.length > 1) {
        const given = tokens.slice(1).join(' ');            // 沈慕微 → "Muwei"
        if (given.length >= 3) out.push(given);
        // "Shen Mu-wei" / "ShenMuwei" spellings people actually type.
        if (tokens.length === 2) {
            out.push(tokens.join(''));
            const hyphenated = hyphenateSyllables(tokens[1]);
            if (hyphenated && hyphenated !== tokens[1]) out.push(`${tokens[0]} ${hyphenated}`);
        }
    }

    for (const alias of Array.isArray(opts.extraAliases) ? opts.extraAliases : []) {
        const text = String(alias || '').trim();
        if (text) out.push(text);
    }

    // Dedupe case-insensitively, keep first spelling, drop anything too short.
    const seen = new Set();
    return out.filter((value) => {
        const lower = value.toLowerCase();
        if (value.length < 3 || seen.has(lower)) return false;
        seen.add(lower);
        return true;
    });
}

/**
 * Split a two-syllable pinyin given name for the hyphenated spelling
 * ("Muwei" → "Mu-wei"). Heuristic and intentionally conservative: it only fires
 * on a clean vowel-consonant-vowel shape, and a wrong guess costs nothing
 * because it is an EXTRA alias, never a replacement.
 */
export function hyphenateSyllables(token) {
    const word = String(token || '');
    if (word.length < 4 || !/^[A-Za-z]+$/.test(word)) return '';
    const match = word.match(/^([A-Za-z]*?[aeiouAEIOU]+(?:ng|n|r)?)([bcdfghjklmnpqrstwxyz][A-Za-z]*)$/);
    if (!match) return '';
    const [, head, tail] = match;
    if (head.length < 2 || tail.length < 2) return '';
    return `${head}-${tail}`;
}

/* ------------------------------------------------------------------ *
 * 3. Response parsing   (spec §4 Step 1/2)
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
 * Normalize one classified entry from the model into the shape the pass uses.
 * Unknown categories fall back to 'concept' — the conservative choice, since
 * concepts are highlight-only and never rename anything.
 */
export function normalizeClassification(item) {
    if (!item || typeof item !== 'object') return null;
    const uid = Number(item.uid);
    if (!Number.isFinite(uid)) return null;

    const category = ['character', 'location', 'faction', 'concept'].includes(item.category)
        ? item.category : 'concept';

    return {
        uid,
        category,
        display_en: String(item.display_en || '').trim(),
        aliases_en: (Array.isArray(item.aliases_en) ? item.aliases_en : [])
            .map((a) => String(a || '').trim()).filter(Boolean),
        // English equivalents of the entry's EXISTING Chinese trigger words.
        // concept_en is the older field name and is still accepted.
        key_en: (Array.isArray(item.key_en) ? item.key_en
            : (Array.isArray(item.concept_en) ? item.concept_en : []))
            .map((a) => String(a || '').trim()).filter(Boolean),
        // 'zh' when the Chinese form is semantically meaningful (圣所 "Sanctuary"),
        // 'en' when it is phonetic (阿德森帝国). Wrong guesses are expected; the
        // per-entity override in the registry editor is the fix.
        displayPolicy: item.displayPolicy === 'zh' ? 'zh' : 'en',
        // The model says this one could legitimately go either way — the user
        // decides rather than living with a coin flip.
        policyUncertain: item.policy_uncertain === true || item.policyUncertain === true,
    };
}

/** Parse a whole classification batch reply. Always returns an array. */
export function parseClassificationBatch(raw) {
    const parsed = extractJson(raw);
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : null);
    if (!list) return [];
    return list.map(normalizeClassification).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 4. Batching   (spec §3.0)
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
