/**
 * LangBridge — matcher (PURE: no DOM, no SillyTavern, no side effects).
 *
 * Compiles every literal token (canonical names, zh aliases, concept zh keys,
 * and optionally en keys) into ONE longest-first alternation regex, then scans
 * a string for non-overlapping hits.
 *
 * Two rules this file exists to enforce (spec §5 "Matcher"):
 *
 *   1. LONGEST-FIRST. 东海海域 contains 东海; 归墟潮眼 contains 归墟. The longer
 *      token must win and spans must never nest. JS alternation picks the first
 *      alternative that matches at a given position, so ordering the alternation
 *      by descending length gives longest-match-at-position for free.
 *
 *   2. MIXED BOUNDARY RULES. CJK text has no word boundaries — 传送阵 must match
 *      inside 用传送阵去. English tokens must NOT match inside a larger word
 *      ("teleport" must not fire on "teleporting"). Boundaries are checked in JS
 *      after the match rather than with regex lookbehind, because lookbehind is
 *      unavailable on older Safari/iOS and an ST user on such a device would
 *      silently get a broken matcher.
 */

/** Escape a literal string for safe inclusion in a RegExp. */
export function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if ch is an ASCII word character (letter/digit) — the English boundary alphabet. */
function isAsciiWord(ch) {
    if (!ch) return false;
    const c = ch.charCodeAt(0);
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/**
 * True if [start,end) in text is bounded by non-word characters on both sides.
 * Only applied to `en` tokens; CJK tokens always pass.
 */
export function hasAsciiBoundary(text, start, end) {
    return !isAsciiWord(text[start - 1]) && !isAsciiWord(text[end]);
}

/**
 * True if the token contains any CJK ideograph. Such tokens are matched without
 * word-boundary constraints. A token like "Shen Muwei" is treated as `en`.
 */
export function looksChinese(text) {
    return /[㐀-䶿一-鿿豈-﫿]/.test(String(text));
}

/**
 * Compile tokens into a matcher.
 *
 * @param {Array<{text:string, kind?:'zh'|'en'}>} tokens  extra fields are carried
 *        through untouched onto each hit (entityId, conceptIndex, type, …).
 * @returns {{regex: RegExp|null, lookup: Map<string, object>, size: number}}
 *
 * Duplicate texts collapse to the FIRST token supplied for that text, so callers
 * should push higher-priority tokens (names) before lower-priority ones (concepts).
 * Lookup is keyed by lowercased text so case-insensitive English hits resolve.
 */
export function buildMatcher(tokens) {
    const lookup = new Map();
    const ordered = [];

    for (const token of Array.isArray(tokens) ? tokens : []) {
        const text = String((token && token.text) || '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (lookup.has(key)) continue;                       // first writer wins
        const kind = token.kind || (looksChinese(text) ? 'zh' : 'en');
        const entry = { ...token, text, kind };
        lookup.set(key, entry);
        ordered.push(entry);
    }

    if (!ordered.length) return { regex: null, lookup, size: 0 };

    // Longest-first is load-bearing (see header). Ties broken alphabetically so
    // compilation is deterministic and unit tests are stable.
    ordered.sort((a, b) => b.text.length - a.text.length || (a.text < b.text ? -1 : 1));

    const source = ordered.map((entry) => escapeRegex(entry.text)).join('|');
    return { regex: new RegExp(source, 'gi'), lookup, size: ordered.length };
}

/**
 * Scan text for non-overlapping token hits, longest-first.
 *
 * @returns {Array<{start:number, end:number, text:string, token:object}>}
 *          in ascending positional order.
 *
 * When an English hit fails its word-boundary check the scan resumes at
 * start+1 rather than skipping the whole match, so a shorter valid token
 * overlapping the rejected one is still found.
 */
export function scan(text, matcher) {
    const out = [];
    const source = String(text == null ? '' : text);
    if (!source || !matcher || !matcher.regex) return out;

    const regex = matcher.regex;
    regex.lastIndex = 0;
    let match;

    while ((match = regex.exec(source)) !== null) {
        const raw = match[0];
        if (!raw) { regex.lastIndex += 1; continue; }        // defensive: never spin
        const start = match.index;
        const end = start + raw.length;
        const token = matcher.lookup.get(raw.toLowerCase());

        if (!token) { regex.lastIndex = start + 1; continue; }
        if (token.kind === 'en' && !hasAsciiBoundary(source, start, end)) {
            regex.lastIndex = start + 1;
            continue;
        }

        out.push({ start, end, text: raw, token });
        regex.lastIndex = end;                                // non-overlapping
    }

    return out;
}
