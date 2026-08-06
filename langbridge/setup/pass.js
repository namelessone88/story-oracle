/**
 * LangBridge — Setup Pass orchestration (spec §4).
 *
 * Runs ONCE per card. Everything here is setup-time; nothing in this file is
 * ever reachable from a chat turn (invariant I2).
 *
 * Shape of a run:
 *   collectEntries → classify in batches (LLM) → mergeClassifications →
 *   planKeyEmission (collision-screened) → USER REVIEWS → applyPlan (writes)
 *
 * The planning half is pure and unit-tested. Only runSetupPass and applyPlan
 * touch host.js, and the worldbook is not written until the user approves.
 */

import { setupCompletion, appendKeysToBook, fingerprintBook } from '../host.js';
import { normalizeRegistry, emptyRegistry, isSingleHanzi } from '../registry.js';
import {
    parseClassificationBatch, planBatches, entryHash, nameVariants, screenKeys,
    batchSizeForBudget, DEFAULT_OUTPUT_BUDGET,
} from './analysis.js';
import { buildBatchMessages, FIXED_JARGON } from './prompts.js';

/* ------------------------------------------------------------------ *
 * PURE: input preparation
 * ------------------------------------------------------------------ */

/** Flatten a loaded worldbook into classifiable rows. */
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
            // Blue-light entries fire every turn regardless of keywords, so an
            // English trigger word buys them nothing. Disabled entries never
            // fire at all. Both are excluded from key emission (spec §4 Step 1).
            constant: entry.constant === true,
            disabled: entry.disable === true,
            hash: entryHash(entry),
        });
    }
    return out.sort((a, b) => a.uid - b.uid);
}

/**
 * Text the collision screen tests candidates against: the card's own machinery.
 *
 * Sources, in order of value:
 *   · worldbook entries that LOOK like machinery (status-bar templates, variable
 *     lists, script blocks) — these are what the scanner sees every turn
 *   · a real sample AI reply, when the caller can supply one
 *
 * An English key appearing anywhere in here would fire constantly.
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
 * PURE: merge classifications into a registry
 * ------------------------------------------------------------------ */

/**
 * Fold LLM classifications into the registry.
 *
 * OVERRIDE SAFETY (risk R8): entities marked `provisional` came from the
 * non-LLM 扫描 skeleton and carry placeholder values, so the classifier may
 * replace them wholesale. Anything NOT provisional was set by the setup pass
 * previously or edited by the user — those keep their category, displayPolicy
 * and display_en, and only gain new aliases. Re-running never clobbers a
 * decision someone made on purpose.
 */
export function mergeClassifications(registry, bookData, classifications) {
    const base = normalizeRegistry(registry, registry?.bookName || '');
    const byUid = new Map((classifications || []).map((c) => [c.uid, c]));
    const next = { ...base, entities: [], conceptKeys: [], entryIndex: { ...base.entryIndex } };

    // Refresh the entry index (titles + author keys) — the hover cards read it.
    for (const [uid, entry] of Object.entries(bookData?.entries || {})) {
        next.entryIndex[String(uid)] = {
            title: String(entry?.comment || '').trim() || `条目 #${uid}`,
            keys: (Array.isArray(entry?.key) ? entry.key : []).map((k) => String(k).trim()).filter(Boolean),
        };
    }

    // Per-entry key translations apply to every category: a character entry's
    // 无情道首座 deserves an English sibling just as much as a concept's 灵石价格.
    next.keyTranslations = { ...base.keyTranslations };
    for (const verdict of (classifications || [])) {
        if (verdict.key_en?.length) {
            next.keyTranslations[String(verdict.uid)] =
                mergeUnique(next.keyTranslations[String(verdict.uid)], verdict.key_en);
        }
    }

    const conceptByZh = new Map(base.conceptKeys.map((c) => [c.zh, { ...c }]));

    for (const entity of base.entities) {
        const uid = entity.sourceEntryUids[0];
        const verdict = byUid.get(uid);

        if (!verdict) { next.entities.push(entity); continue; }

        if (verdict.category === 'concept') {
            // Reclassified as a concept: it stops being a renderable name and
            // becomes a highlight-only concept key.
            if (entity.provisional) {
                const existing = conceptByZh.get(entity.canonical);
                const en = mergeUnique(existing?.en, verdict.key_en);
                conceptByZh.set(entity.canonical, {
                    zh: entity.canonical,
                    en,
                    entryUids: mergeUniqueNumbers(existing?.entryUids, entity.sourceEntryUids),
                });
                continue;
            }
            next.entities.push(entity);
            continue;
        }

        if (entity.provisional) {
            next.entities.push({
                ...entity,
                category: verdict.category,
                display_en: verdict.display_en || '',
                // Single-hanzi names are pinned to Chinese display regardless of
                // what the classifier says (see registry.js).
                displayPolicy: isSingleHanzi(entity.canonical) ? 'zh' : verdict.displayPolicy,
                aliases_en: mergeUnique(entity.aliases_en, verdict.aliases_en),
                provisional: false,
                // Single-hanzi names are pinned regardless, so there is nothing
                // to ask about; likewise anything the user already decided.
                policyUncertain: !isSingleHanzi(entity.canonical)
                    && !entity.policyDecided && verdict.policyUncertain === true,
            });
        } else {
            next.entities.push({
                ...entity,
                display_en: entity.display_en || verdict.display_en || '',
                aliases_en: mergeUnique(entity.aliases_en, verdict.aliases_en),
                // A name the user settled is never raised again.
                policyUncertain: entity.policyDecided
                    ? false
                    : (entity.policyUncertain || verdict.policyUncertain === true),
            });
        }
    }

    // Concepts the classifier found on entries that had no entity at all.
    for (const verdict of byUid.values()) {
        if (verdict.category !== 'concept' || !verdict.key_en.length) continue;
        const entry = bookData?.entries?.[verdict.uid] ?? bookData?.entries?.[String(verdict.uid)];
        const zh = String(entry?.comment || '').replace(/^[【\[（(]{1}[^】\]）)]*[】\]）)]\s*/, '').trim();
        if (!zh || conceptByZh.has(zh)) continue;
        conceptByZh.set(zh, { zh, en: verdict.key_en.slice(), entryUids: [verdict.uid] });
    }

    // Pinned jargon renderings win over anything the model improvised.
    for (const [zh, en] of Object.entries(FIXED_JARGON)) {
        const existing = conceptByZh.get(zh);
        if (existing) existing.en = mergeUnique(en, existing.en);
    }

    next.conceptKeys = [...conceptByZh.values()];
    return normalizeRegistry(next, next.bookName);
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

function mergeUniqueNumbers(a, b) {
    const out = [];
    for (const item of [...(a || []), ...(b || [])]) {
        const n = Number(item);
        if (Number.isFinite(n) && !out.includes(n)) out.push(n);
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * PURE: plan which English keys get written where
 * ------------------------------------------------------------------ */

/**
 * @returns {{
 *   writes: Record<string, string[]>,   // uid → keys to append
 *   flagged: Array<{uid, title, reason}>,
 *   rejected: Array<{key, reason, owner}>,
 *   stats: object
 * }}
 *
 * Nothing here mutates anything; the caller shows this to the user first.
 */
export function planKeyEmission(registry, bookData, machineryText = '') {
    const reg = normalizeRegistry(registry, registry?.bookName || '');
    const entries = bookData?.entries || {};
    const writes = {};
    const flagged = [];
    const rejected = [];

    const skipped = [];

    const addWrites = (uids, keys, owner) => {
        for (const uid of uids) {
            const entry = entries[uid] ?? entries[String(uid)];
            if (!entry) continue;

            // A blue-light (constant) entry is injected every turn no matter
            // what the message says — a trigger word cannot make it fire any
            // harder. A disabled entry never fires at all. Writing English keys
            // to either is pure noise in the author's key list.
            if (entry.constant === true || entry.disable === true) {
                skipped.push({
                    uid: Number(uid),
                    title: String(entry.comment || `条目 #${uid}`),
                    reason: entry.disable === true ? '条目被禁用' : '蓝灯常驻条目，本来就每回合注入，不需要触发词',
                });
                continue;
            }

            // AND-logic entries are never auto-augmented: an English primary
            // matching the user's message while the Chinese secondaries only
            // ever appear in AI text would shift activation timing.
            if (Array.isArray(entry.keysecondary) && entry.keysecondary.length) {
                flagged.push({
                    uid: Number(uid),
                    title: String(entry.comment || `条目 #${uid}`),
                    reason: '这个条目用了「次要关键词」(AND 逻辑)，自动加英文词可能改变它的触发时机——请手动决定。',
                    proposed: keys.slice(),
                });
                continue;
            }

            const existing = new Set((Array.isArray(entry.key) ? entry.key : [])
                .map((k) => String(k).toLowerCase()));
            const fresh = keys.filter((k) => !existing.has(k.toLowerCase()));
            if (!fresh.length) continue;
            writes[String(uid)] = mergeUnique(writes[String(uid)], fresh);
        }
    };

    for (const entity of reg.entities) {
        if (entity.category === 'concept' || !entity.display_en) continue;
        const candidates = nameVariants(entity.display_en, { extraAliases: entity.aliases_en });
        const { accepted, rejected: bad } = screenKeys(candidates, { machineryText });
        for (const item of bad) rejected.push({ ...item, owner: entity.canonical });
        if (accepted.length) addWrites(entity.sourceEntryUids, accepted, entity.canonical);
    }

    for (const concept of reg.conceptKeys) {
        if (!concept.en.length) continue;
        const { accepted, rejected: bad } = screenKeys(concept.en, { machineryText });
        for (const item of bad) rejected.push({ ...item, owner: concept.zh });
        if (accepted.length) addWrites(concept.entryUids, accepted, concept.zh);
    }

    // English equivalents of each entry's OWN Chinese trigger words. This is the
    // bulk of the recall: entry 32's 传送费用 / 购买力 / 灵石价格 / 跨域传送 / 路费
    // each gain an English sibling, instead of the entry getting a few invented
    // phrases that may not match how the user actually asks.
    for (const [uid, keys] of Object.entries(reg.keyTranslations || {})) {
        if (!keys.length) continue;
        const { accepted, rejected: bad } = screenKeys(keys, { machineryText });
        for (const item of bad) rejected.push({ ...item, owner: `条目 #${uid}` });
        if (accepted.length) addWrites([uid], accepted, `条目 #${uid}`);
    }

    const keyCount = Object.values(writes).reduce((n, list) => n + list.length, 0);
    const uniqueSkipped = [...new Map(skipped.map((s2) => [s2.uid, s2])).values()];
    return {
        writes,
        flagged,
        rejected,
        skipped: uniqueSkipped,
        stats: {
            entries: Object.keys(writes).length,
            keys: keyCount,
            flagged: flagged.length,
            rejected: rejected.length,
            skipped: uniqueSkipped.length,
        },
    };
}

/* ------------------------------------------------------------------ *
 * Orchestration (touches host.js)
 * ------------------------------------------------------------------ */

/**
 * Classify a whole book. Returns { classifications, failedBatches, cache }.
 *
 * Bounded concurrency, abortable, and cached by entry-content hash so a re-run
 * or a resumed run does not re-spend tokens on unchanged entries. A batch that
 * fails or returns unreadable JSON fails ALONE — its entries simply stay
 * unclassified and are reported.
 */
export async function classifyBook(entries, opts = {}) {
    const {
        profileId = '', signal, onProgress = () => {}, concurrency = 2, cache = {},
        outputBudget = DEFAULT_OUTPUT_BUDGET,
        batchSize = batchSizeForBudget(outputBudget),
        maxAttempts = 3,
        complete = setupCompletion,   // injectable for tests
    } = opts;

    const pending = entries.filter((entry) => !cache[entry.hash]);
    const cached = entries.filter((entry) => cache[entry.hash]).map((entry) => cache[entry.hash]);

    const classifications = [...cached];
    const failedBatches = [];

    // A dynamic work queue rather than a fixed list: a call that comes back
    // short (truncated array, model summarised instead of enumerating) requeues
    // ONLY THE MISSING ENTRIES at half size. Big batches therefore stay cheap
    // when they work and degrade gracefully when they don't, instead of losing
    // every entry in the batch to one bad reply.
    const queue = planBatches(pending, batchSize).map((batch) => ({ batch, attempt: 1 }));
    let issued = queue.length;
    let done = 0;

    const report = () => onProgress({ done, total: issued, cachedCount: cached.length, batchSize });

    const requeue = (missing, attempt, reason) => {
        if (!missing.length) return;
        if (attempt >= maxAttempts || missing.length === 0) {
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
                const parsed = parseClassificationBatch(raw);
                const byUid = new Map(parsed.map((p) => [p.uid, p]));
                const missing = [];
                for (const entry of batch) {
                    const verdict = byUid.get(entry.uid);
                    if (!verdict) { missing.push(entry); continue; }
                    cache[entry.hash] = verdict;
                    classifications.push(verdict);
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

    return { classifications, failedBatches, cache, batchSize };
}

/**
 * Full pass up to (but NOT including) the worldbook write.
 * Returns everything the review UI needs.
 */
export async function runSetupPass(bookName, bookData, registry, opts = {}) {
    const entries = collectEntries(bookData);
    const machineryText = gatherMachineryText(bookData, opts.sampleReply || '');

    const { classifications, failedBatches, cache, batchSize } = await classifyBook(entries, opts);

    const merged = mergeClassifications(
        registry || emptyRegistry(bookName),
        bookData,
        classifications,
    );
    merged.bookName = bookName;
    merged.bookFingerprint = fingerprintBook(bookData);

    const plan = planKeyEmission(merged, bookData, machineryText);

    return {
        registry: merged,
        plan,
        failedBatches,
        cache,
        stats: {
            entries: entries.length,
            classified: classifications.length,
            unclassified: entries.length - classifications.length,
            batchSize,
            ...plan.stats,
        },
    };
}

/**
 * Apply an approved plan: write the keys, then record the ledger.
 *
 * The ledger records only what was ACTUALLY appended (appendKeysToBook re-reads
 * the book and skips keys that already exist), so re-running produces no diff.
 */
export async function applyPlan(bookName, registry, plan, expectedFingerprint = '') {
    const result = await appendKeysToBook(bookName, plan.writes, expectedFingerprint);
    if (!result.ok) return { ok: false, reason: result.reason, registry };

    const next = normalizeRegistry(registry, bookName);
    for (const [uid, keys] of Object.entries(result.written)) {
        next.addedKeys[uid] = mergeUnique(next.addedKeys[uid], keys);
    }
    const written = Object.values(result.written).reduce((n, list) => n + list.length, 0);
    return { ok: true, registry: next, written, skipped: result.skipped };
}
