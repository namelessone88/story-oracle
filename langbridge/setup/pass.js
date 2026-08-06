/**
 * LangBridge — translation pass orchestration.
 *
 * Runs once per card, on demand. Nothing here is reachable from a chat turn.
 *
 * Shape of a run:
 *   collectEntries → split (green / blue / disabled / AND-logic) →
 *   translate in batches (LLM, self-healing) → planWrites (collision-screened)
 *   → USER REVIEWS → applyPlan (single write + ledger)
 *
 * The planning halves are pure and unit-tested. Only the two exported async
 * runners touch host.js, and the worldbook is not written until approval.
 */

import { setupCompletion, appendKeysToBook, fingerprintBook } from '../host.js';
import { normalizeRegistry, emptyRegistry } from '../registry.js';
import {
    parseTranslationBatch, planBatches, entryHash, screenKeys,
    batchSizeForBudget, DEFAULT_OUTPUT_BUDGET,
} from './analysis.js';
import { buildBatchMessages } from './prompts.js';
import { looksChinese } from '../matcher.js';

/* ------------------------------------------------------------------ *
 * PURE: input preparation
 * ------------------------------------------------------------------ */

/** Flatten a loaded worldbook into rows. */
export function collectEntries(bookData) {
    const out = [];
    for (const [uid, entry] of Object.entries(bookData?.entries || {})) {
        if (!entry) continue;
        out.push({
            uid: Number(uid),
            comment: String(entry.comment || '').trim(),
            content: String(entry.content || ''),
            keys: (Array.isArray(entry.key) ? entry.key : []).map((k) => String(k).trim()).filter(Boolean),
            hasSecondary: Array.isArray(entry.keysecondary) && entry.keysecondary.length > 0,
            constant: entry.constant === true,
            disabled: entry.disable === true,
            hash: entryHash(entry),
        });
    }
    return out.sort((a, b) => a.uid - b.uid);
}

/**
 * Sort entries into what gets translated and what gets reported.
 *
 *   translatable — has Chinese trigger words and no AND logic. This INCLUDES
 *                  blue (constant) and disabled entries: appending an English
 *                  key to them changes nothing today (blue ignores keys,
 *                  disabled never fires) and simply works the moment the
 *                  author flips the entry green — the key list stays complete.
 *   flagged      — uses keysecondary (AND): auto-adding an English primary
 *                  could shift activation timing (now or once re-enabled);
 *                  listed for a manual decision.
 *   inert        — nothing to translate (no Chinese keys).
 */
export function splitEntries(entries) {
    const translatable = [];
    const flagged = [];
    const inert = [];

    for (const entry of entries || []) {
        const zhKeys = entry.keys.filter((k) => looksChinese(k));
        if (!zhKeys.length) { inert.push(entry.uid); continue; }
        if (entry.hasSecondary) {
            flagged.push({
                uid: entry.uid,
                title: entry.comment || `条目 #${entry.uid}`,
                zhKeys,
                reason: '这个条目用了「次要关键词」(AND 逻辑)，自动加英文词可能改变它的触发时机——请手动决定。',
            });
            continue;
        }
        translatable.push(entry);
    }

    return { translatable, flagged, inert };
}

/**
 * Text the collision screen tests candidates against: the card's own machinery
 * (status-bar templates, variable lists, script blocks — what the WI scanner
 * sees every turn) plus a real sample AI reply when available.
 */
export function gatherMachineryText(bookData, sampleReply = '') {
    const chunks = [];
    for (const entry of Object.values(bookData?.entries || {})) {
        const content = String(entry?.content || '');
        if (!content) continue;
        if (looksLikeMachinery(content) || looksLikeMachinery(String(entry?.comment || ''))) {
            chunks.push(content);
        }
    }
    if (sampleReply) chunks.push(String(sampleReply));
    return chunks.join('\n').slice(0, 200000);
}

function looksLikeMachinery(text) {
    return /<\s*(div|span|style|script|table|img)\b|_\.set\(|<UpdateVariable|变量列表|状态栏|stat_data|\{\{[^}]*\}\}|:\s*\d+\s*\//i.test(text);
}

/* ------------------------------------------------------------------ *
 * PURE: plan what gets written
 * ------------------------------------------------------------------ */

/**
 * Screen the translations and diff them against the book.
 * @param {Record<string, string[]>} translations  uid → English keys
 * @returns {{writes, rejected, stats}} — writes is uid → keys to append.
 */
export function planWrites(translations, bookData, machineryText = '') {
    const entries = bookData?.entries || {};
    const writes = {};
    const rejected = [];

    for (const [uid, candidates] of Object.entries(translations || {})) {
        const entry = entries[uid] ?? entries[String(uid)];
        if (!entry) continue;
        const { accepted, rejected: bad } = screenKeys(candidates, { machineryText });
        const title = String(entry.comment || `条目 #${uid}`);
        for (const item of bad) rejected.push({ ...item, owner: title });

        const existing = new Set((Array.isArray(entry.key) ? entry.key : [])
            .map((k) => String(k).toLowerCase()));
        const fresh = accepted.filter((k) => !existing.has(k.toLowerCase()));
        if (fresh.length) writes[String(uid)] = fresh;
    }

    const keyCount = Object.values(writes).reduce((n, list) => n + list.length, 0);
    return {
        writes,
        rejected,
        stats: { entries: Object.keys(writes).length, keys: keyCount, rejected: rejected.length },
    };
}

/** Refresh the registry's entry index from the live book (gated flags included). */
export function refreshEntryIndex(registry, bookData) {
    const next = normalizeRegistry(registry, registry?.bookName || '');
    next.entryIndex = {};
    for (const [uid, entry] of Object.entries(bookData?.entries || {})) {
        next.entryIndex[String(uid)] = {
            title: String(entry?.comment || '').trim() || `条目 #${uid}`,
            keys: (Array.isArray(entry?.key) ? entry.key : []).map((k) => String(k).trim()).filter(Boolean),
            gated: entry?.constant !== true && entry?.disable !== true,
        };
    }
    return next;
}

function mergeUnique(a, b) {
    const out = [];
    const seen = new Set();
    for (const item of [...(a || []), ...(b || [])]) {
        const text = String(item || '').trim();
        if (!text || seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        out.push(text);
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * Orchestration (touches host.js)
 * ------------------------------------------------------------------ */

/**
 * Translate a set of entries. Bounded concurrency, abortable, cached by
 * entry-content hash so a re-run or resumed run does not re-spend tokens.
 *
 * Self-healing: a reply that comes back short (truncated array, or the model
 * summarising instead of enumerating) requeues ONLY the missing entries at half
 * batch size — a bad reply costs those rows, not the batch. Failures that
 * survive the retry ladder are reported by uid, never silently dropped.
 */
export async function translateBook(entries, opts = {}) {
    const {
        profileId = '', signal, onProgress = () => {}, concurrency = 2, cache = {},
        outputBudget = DEFAULT_OUTPUT_BUDGET,
        batchSize = batchSizeForBudget(outputBudget),
        maxAttempts = 3,
        complete = setupCompletion,   // injectable for tests
    } = opts;

    const pending = entries.filter((entry) => !cache[entry.hash]);
    const cached = entries.filter((entry) => cache[entry.hash]).map((entry) => cache[entry.hash]);

    const rows = [...cached];
    const failedBatches = [];

    const queue = planBatches(pending, batchSize).map((batch) => ({ batch, attempt: 1 }));
    let issued = queue.length;
    let done = 0;

    const report = () => onProgress({ done, total: issued, cachedCount: cached.length, batchSize });

    const requeue = (missing, attempt, reason) => {
        if (!missing.length) return;
        if (attempt >= maxAttempts) {
            failedBatches.push({ uids: missing.map((m) => m.uid), reason });
            return;
        }
        const half = Math.max(1, Math.ceil(missing.length / 2));
        for (const chunk of planBatches(missing, half)) {
            queue.push({ batch: chunk, attempt: attempt + 1 });
            issued += 1;
        }
    };

    const worker = async () => {
        for (;;) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const job = queue.shift();
            if (!job) return;
            const { batch, attempt } = job;
            try {
                const raw = await complete(buildBatchMessages(batch), {
                    profileId, signal, maxTokens: outputBudget,
                });
                const parsed = parseTranslationBatch(raw);
                const byUid = new Map(parsed.map((p) => [p.uid, p]));
                const missing = [];
                for (const entry of batch) {
                    const verdict = byUid.get(entry.uid);
                    if (!verdict) { missing.push(entry); continue; }
                    cache[entry.hash] = verdict;
                    rows.push(verdict);
                }
                requeue(missing, attempt, parsed.length ? '这些条目没出现在返回结果里（多半被截断了）' : '返回内容无法解析');
            } catch (e) {
                if (e?.name === 'AbortError') throw e;
                requeue(batch, attempt, String(e?.message || e));
            } finally {
                done += 1;
                report();
            }
        }
    };

    report();
    const lanes = Math.max(1, Math.min(concurrency, queue.length || 1));
    await Promise.all(Array.from({ length: lanes }, worker));

    const translations = {};
    const renders = [];
    for (const row of rows) {
        if (row.key_en.length) translations[String(row.uid)] = mergeUnique(translations[String(row.uid)], row.key_en);
        if (row.render) renders.push(row.render);
    }
    return { translations, renders, failedBatches, cache, batchSize };
}

/**
 * Full pass up to (but NOT including) the worldbook write.
 * Returns everything the review UI needs.
 */
export async function runSetupPass(bookName, bookData, registry, opts = {}) {
    const entries = collectEntries(bookData);
    const { translatable, flagged, inert } = splitEntries(entries);
    const machineryText = gatherMachineryText(bookData, opts.sampleReply || '');

    const { translations, renders, failedBatches, cache, batchSize } = await translateBook(translatable, opts);

    let next = refreshEntryIndex(registry || emptyRegistry(bookName), bookData);
    next.bookName = bookName;
    next.bookFingerprint = fingerprintBook(bookData);
    for (const [uid, keys] of Object.entries(translations)) {
        next.keyTranslations[uid] = mergeUnique(next.keyTranslations[uid], keys);
    }
    // Render pairs: model suggestions never overwrite an existing pair — the
    // user may have edited the spelling or switched it off, and both survive
    // re-runs. New pairs default to on; normalizeRegistry enforces the hard
    // rules (single-hanzi and non-Chinese names are refused).
    let newRenderPairs = 0;
    for (const pair of renders) {
        if (!next.renderMap[pair.zh]) {
            next.renderMap[pair.zh] = { en: pair.en, on: true };
            newRenderPairs += 1;
        }
    }
    next = normalizeRegistry(next, bookName);

    const plan = planWrites(translations, bookData, machineryText);

    return {
        registry: next,
        plan: { ...plan, flagged },
        failedBatches,
        cache,
        stats: {
            entries: entries.length,
            translatable: translatable.length,
            inert: inert.length,
            flagged: flagged.length,
            newRenderPairs,
            batchSize,
            ...plan.stats,
        },
    };
}

/**
 * Apply an approved plan: one write, then record the ledger. appendKeysToBook
 * re-reads the book first and returns the ACTUAL delta, so re-running the whole
 * pass afterwards produces an empty plan.
 */
export async function applyPlan(bookName, registry, plan, expectedFingerprint = '') {
    const result = await appendKeysToBook(bookName, plan.writes, expectedFingerprint);
    if (!result.ok) return { ok: false, reason: result.reason, registry };

    const next = normalizeRegistry(registry, bookName);
    for (const [uid, keys] of Object.entries(result.written)) {
        next.addedKeys[uid] = mergeUnique(next.addedKeys[uid], keys);
        // The written keys are now part of the entry — reflect them in the index
        // immediately so hover cards show them without waiting for a re-scan.
        if (next.entryIndex[uid]) {
            next.entryIndex[uid] = {
                ...next.entryIndex[uid],
                keys: mergeUnique(next.entryIndex[uid].keys, keys),
            };
        }
    }
    const written = Object.values(result.written).reduce((n, list) => n + list.length, 0);
    return { ok: true, registry: next, written, skipped: result.skipped };
}
