/**
 * LangBridge — consistency report (PURE: no DOM, no SillyTavern).
 *
 * Cross-references the registry against the illustration/draw library and the
 * CG trigger entries, looking for the silent failures where two lists spell the
 * same character differently and neither side ever errors — the illustration
 * simply never fires.
 *
 * Known live findings this must catch (spec §4 Step 4):
 *   · draw library 幕海棠  vs worldbook 慕海棠   (one-character difference)
 *   · draw library 林鹿雪  vs worldbook 林雪鹿   (transposed characters)
 *
 * NEVER auto-fixes. Reports, and offers one-click fixes only where the pairing
 * is unambiguous — the user decides which spelling is canonical.
 */

/**
 * Damerau-Levenshtein distance (adjacent transposition counts as ONE edit).
 * Plain Levenshtein would score 林鹿雪/林雪鹿 as distance 2 and let it slip
 * under the threshold; transposition is exactly the typo class we are hunting.
 */
export function editDistance(a, b) {
    const s = [...String(a || '')];
    const t = [...String(b || '')];
    if (!s.length) return t.length;
    if (!t.length) return s.length;

    const d = Array.from({ length: s.length + 1 }, (_, i) => {
        const row = new Array(t.length + 1).fill(0);
        row[0] = i;
        return row;
    });
    for (let j = 0; j <= t.length; j++) d[0][j] = j;

    for (let i = 1; i <= s.length; i++) {
        for (let j = 1; j <= t.length; j++) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);   // transposition
            }
        }
    }
    return d[s.length][t.length];
}

/** 0..1 similarity. 1 = identical. */
export function similarity(a, b) {
    const len = Math.max([...String(a || '')].length, [...String(b || '')].length);
    if (!len) return 0;
    return 1 - (editDistance(a, b) / len);
}

/**
 * Near-miss pairs between two name lists: similar enough to be the same person,
 * not identical. Exact matches are excluded (they are fine, not findings).
 *
 * Guards against false positives: names must share a character, be within one
 * character in length, and clear the similarity threshold. Two-character names
 * are held to a stricter bar because at that length a single edit is half the
 * name and legitimately different names look "similar".
 */
export function findNearMisses(listA, listB, opts = {}) {
    const threshold = Number(opts.threshold) || 0.6;
    const a = uniqueNames(listA);
    const b = uniqueNames(listB);
    const exact = new Set(b.map((n) => n.name));
    const out = [];

    for (const left of a) {
        if (exact.has(left.name)) continue;                  // spelled the same — fine
        for (const right of b) {
            if (left.name === right.name) continue;
            const lenA = [...left.name].length;
            const lenB = [...right.name].length;
            if (Math.abs(lenA - lenB) > 1) continue;
            if (Math.min(lenA, lenB) < 2) continue;
            if (!sharesCharacter(left.name, right.name)) continue;

            const score = similarity(left.name, right.name);
            const bar = Math.min(lenA, lenB) <= 2 ? 0.75 : threshold;
            if (score < bar || score === 1) continue;

            out.push({
                a: left.name, aSource: left.source,
                b: right.name, bSource: right.source,
                similarity: Number(score.toFixed(3)),
            });
        }
    }

    // Strongest match first, and only the best partner per left-hand name.
    out.sort((x, y) => y.similarity - x.similarity);
    const claimed = new Set();
    return out.filter((pair) => {
        if (claimed.has(pair.a)) return false;
        claimed.add(pair.a);
        return true;
    });
}

function sharesCharacter(a, b) {
    const set = new Set([...String(a)]);
    return [...String(b)].some((ch) => set.has(ch));
}

function uniqueNames(list) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
        const name = String(typeof item === 'string' ? item : item?.name || '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({ name, source: (typeof item === 'object' && item?.source) || '' });
    }
    return out;
}

/** A1111-style prompt weights, e.g. "(masterpiece:1.4)" — dead syntax on most
 *  current draw backends and worth queueing for cleanup. */
export function findDeadWeights(text) {
    const matches = String(text || '').match(/\([^()]*:\s*\d+(?:\.\d+)?\s*\)/g);
    return matches ? [...new Set(matches)] : [];
}

/**
 * Build the full report.
 *
 * @param {object} input
 *   registry      — the LangBridge registry
 *   libraryNames  — character names from the draw library  [{name, prompt?}]
 *   cgNames       — character names referenced by CG trigger entries [string]
 * @returns {{findings: Array, counts: object}}
 *
 * Finding shape: { kind, severity, message, detail, fix? }
 *   fix is present only when the correction is unambiguous; it is a DESCRIPTION
 *   of the change, never an applied mutation.
 */
export function buildReport(input = {}) {
    const registry = input.registry || { entities: [] };
    const characters = (registry.entities || []).filter((e) => e.category === 'character');
    const bookNames = characters.map((e) => ({ name: e.canonical, source: 'worldbook' }));
    const library = (Array.isArray(input.libraryNames) ? input.libraryNames : [])
        .map((item) => (typeof item === 'string' ? { name: item } : item))
        .filter((item) => item && item.name);
    const libNames = library.map((item) => ({ name: item.name, source: 'draw-library' }));
    const cgNames = [...new Set((input.cgNames || []).map((n) => String(n || '').trim()).filter(Boolean))];

    const findings = [];

    // 1. Near-miss spellings between the draw library and the worldbook. This is
    //    the silent killer: neither side errors, the illustration just never fires.
    for (const pair of findNearMisses(libNames, bookNames)) {
        findings.push({
            kind: 'name-mismatch',
            severity: 'high',
            message: `绘图库的「${pair.a}」与世界书的「${pair.b}」拼写不一致——名字对不上，这个角色的图永远不会触发。`,
            detail: { library: pair.a, worldbook: pair.b, similarity: pair.similarity },
            fix: { action: 'rename-library-entry', from: pair.a, to: pair.b },
        });
    }

    // 2. CG trigger characters with no entry in the draw library.
    const libSet = new Set(library.map((item) => item.name));
    for (const name of cgNames) {
        if (libSet.has(name)) continue;
        const nearMiss = findings.some((f) => f.kind === 'name-mismatch' && f.detail.worldbook === name);
        if (nearMiss) continue;                              // already reported as a mismatch
        findings.push({
            kind: 'cg-without-library',
            severity: 'medium',
            message: `「${name}」有 CG 触发条目，但绘图库里没有这个角色——触发了也没有图可画。`,
            detail: { name },
        });
    }

    // 3. Cast members with no CG entry (informational — not every character needs one).
    const cgSet = new Set(cgNames);
    for (const entity of characters) {
        if (cgSet.has(entity.canonical)) continue;
        findings.push({
            kind: 'cast-without-cg',
            severity: 'low',
            message: `「${entity.canonical}」是登记在册的角色，但没有对应的 CG 触发条目。`,
            detail: { name: entity.canonical },
        });
    }

    // 4. Dead A1111 weight syntax in library prompts.
    let weightHits = 0;
    for (const item of library) {
        const dead = findDeadWeights(item.prompt || '');
        if (!dead.length) continue;
        weightHits += 1;
        findings.push({
            kind: 'dead-weight-syntax',
            severity: 'low',
            message: `绘图库「${item.name}」的提示词里有 A1111 式权重 ${dead.slice(0, 3).join(' ')}——多数后端已不认这种写法。`,
            detail: { name: item.name, weights: dead },
        });
    }

    return {
        findings,
        counts: {
            total: findings.length,
            high: findings.filter((f) => f.severity === 'high').length,
            medium: findings.filter((f) => f.severity === 'medium').length,
            low: findings.filter((f) => f.severity === 'low').length,
            characters: characters.length,
            library: library.length,
            cg: cgNames.length,
            deadWeights: weightHits,
        },
    };
}

/**
 * Character names referenced by CG trigger entries, read out of the worldbook.
 * Matches the card's convention of `[mvu_plot]XXXCG触发` titles and falls back
 * to any entry whose title mentions CG触发.
 */
export function extractCgNames(bookData) {
    const out = [];
    for (const entry of Object.values(bookData?.entries || {})) {
        const title = String(entry?.comment || '');
        if (!/CG\s*触发/i.test(title)) continue;
        const match = title.match(/([一-龥]{2,4})\s*CG\s*触发/i);
        if (match) { out.push(match[1]); continue; }
        // Fall back to the entry's first Chinese trigger key.
        const key = (Array.isArray(entry?.key) ? entry.key : []).find((k) => /[一-龥]/.test(String(k)));
        if (key) out.push(String(key).trim());
    }
    return [...new Set(out)];
}
