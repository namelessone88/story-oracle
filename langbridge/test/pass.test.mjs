/**
 * LangBridge — Setup Pass planning tests (pure halves of setup/pass.js).
 * Run:  node langbridge/test/pass.test.mjs
 */
import {
    collectEntries, gatherMachineryText, mergeClassifications, planKeyEmission, classifyBook,
} from '../setup/pass.js';
import { batchSizeForBudget, estimateOutputTokens, DEFAULT_BATCH_SIZE } from '../setup/analysis.js';
import { normalizeRegistry, emptyRegistry } from '../registry.js';
import {
    decidableEntities, pendingDecisions, applyDecision, applyDisplayName, decisionRowsHtml,
} from '../decisions.js';

let pass = 0, fail = 0;
const lines = [];
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; lines.push(`  ok   ${name}`); }
    else { fail++; lines.push(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

/* A small book with the shapes that matter: a person, a sect, a concept,
 * a machinery entry, and an AND-logic entry. */
const BOOK = {
    entries: {
        8:  { uid: 8,  comment: '【人设】沈慕微', key: ['沈慕微', '无情道首座'], content: '无情道首座，性冷。' },
        12: { uid: 12, comment: '天剑宗', key: ['天剑宗'], content: '东域第一剑宗。' },
        32: { uid: 32, comment: '传送阵开销与购买力', key: ['传送阵', '灵石价格'], content: '跨域传送需灵石。' },
        70: { uid: 70, comment: '变量列表', key: [], content: '<div class="status_bar">Level: 12 HP: 80</div> _.set("好感度", 5);' },
        80: { uid: 80, comment: '密室事件', key: ['密室'], keysecondary: ['夜晚'], content: '仅夜间触发。' },
        136:{ uid: 136, comment: '[mvu_plot]沈慕微CG触发', key: ['沈慕微', '温泉'], content: 'CG。' },
    },
};

/* ================================================================== *
 * collectEntries / gatherMachineryText
 * ================================================================== */
{
    const entries = collectEntries(BOOK);
    check('all entries collected in uid order', entries.map((e) => e.uid), [8, 12, 32, 70, 80, 136]);
    ok('AND-logic entry is flagged at collection', entries.find((e) => e.uid === 80).hasSecondary);
    ok('normal entry is not flagged', !entries.find((e) => e.uid === 8).hasSecondary);
    ok('每条都有内容哈希', entries.every((e) => typeof e.hash === 'string' && e.hash.length));
}
{
    const machinery = gatherMachineryText(BOOK, 'AI reply with status: ok');
    ok('status-bar entry is picked up as machinery', machinery.includes('status_bar'));
    ok('sample reply is included', machinery.includes('AI reply with status: ok'));
    ok('ordinary prose entries are not swept in', !machinery.includes('东域第一剑宗'));
}

/* ================================================================== *
 * mergeClassifications — override safety (risk R8)
 * ================================================================== */

const SKELETON = normalizeRegistry({
    bookName: 'B',
    entities: [
        { id: 'a', canonical: '沈慕微', category: 'character', displayPolicy: 'zh', display_en: '',
          aliases_zh: ['无情道首座'], provisional: true, sourceEntryUids: [8] },
        { id: 'b', canonical: '天剑宗', category: 'character', displayPolicy: 'zh', display_en: '',
          provisional: true, sourceEntryUids: [12] },
        { id: 'c', canonical: '传送阵开销与购买力', category: 'character', displayPolicy: 'zh',
          provisional: true, sourceEntryUids: [32] },
    ],
}, 'B');

const CLASSIFICATIONS = [
    { uid: 8,  category: 'character', display_en: 'Shen Muwei', aliases_en: ['Muwei'], key_en: [], displayPolicy: 'en' },
    { uid: 12, category: 'faction',   display_en: 'Heavenly Sword Sect', aliases_en: [], key_en: [], displayPolicy: 'zh' },
    { uid: 32, category: 'concept',   display_en: '', aliases_en: [], key_en: ['teleport array', 'spirit stone price'], displayPolicy: 'en' },
];

{
    const merged = mergeClassifications(SKELETON, BOOK, CLASSIFICATIONS);
    const muwei = merged.entities.find((e) => e.canonical === '沈慕微');
    check('provisional entity takes the classifier romanization', muwei.display_en, 'Shen Muwei');
    check('…and its policy', muwei.displayPolicy, 'en');
    check('…and its category', muwei.category, 'character');
    ok('provisional flag is cleared once classified', muwei.provisional === false);
    ok('existing zh aliases survive', muwei.aliases_zh.includes('无情道首座'));
    ok('english aliases are merged in', muwei.aliases_en.includes('Muwei'));

    const sect = merged.entities.find((e) => e.canonical === '天剑宗');
    check('semantically meaningful name is kept in Chinese', sect.displayPolicy, 'zh');
    check('…but still gets its english form recorded', sect.display_en, 'Heavenly Sword Sect');
    check('…and is reclassified as a faction', sect.category, 'faction');

    ok('entry reclassified as concept leaves the name list',
        !merged.entities.some((e) => e.canonical === '传送阵开销与购买力'));
    const concept = merged.conceptKeys.find((c) => c.zh === '传送阵开销与购买力');
    ok('…and becomes a concept key', !!concept);
    check('…carrying its english phrases', concept.en, ['teleport array', 'spirit stone price']);
    check('…linked to its entry', concept.entryUids, [32]);

    ok('entry index is refreshed from the book', merged.entryIndex['32'].title === '传送阵开销与购买力');
    check('…including the author keys for the hover card',
        merged.entryIndex['32'].keys, ['传送阵', '灵石价格']);
}

{
    // A user decision must survive a re-run untouched.
    const edited = normalizeRegistry({
        bookName: 'B',
        entities: [{
            id: 'a', canonical: '沈慕微', category: 'character', display_en: 'Lady Shen',
            displayPolicy: 'zh', provisional: false, sourceEntryUids: [8],
        }],
    }, 'B');
    const merged = mergeClassifications(edited, BOOK, CLASSIFICATIONS);
    const muwei = merged.entities.find((e) => e.canonical === '沈慕微');
    check('user display_en is not overwritten', muwei.display_en, 'Lady Shen');
    check('user displayPolicy is not overwritten', muwei.displayPolicy, 'zh');
    ok('but new aliases are still added', muwei.aliases_en.includes('Muwei'));
}

{
    // Fixed jargon must win over anything the model improvised.
    const reg = normalizeRegistry({
        bookName: 'B',
        conceptKeys: [{ zh: '筑基', en: ['foundation building'], entryUids: [50] }],
    }, 'B');
    const merged = mergeClassifications(reg, BOOK, []);
    const zhuji = merged.conceptKeys.find((c) => c.zh === '筑基');
    check('pinned rendering is placed first', zhuji.en[0], 'foundation establishment');
    ok('the improvised one is kept as an extra alias', zhuji.en.includes('foundation building'));
}

{
    const merged = mergeClassifications(emptyRegistry('B'), BOOK, []);
    check('no classifications leaves no entities', merged.entities, []);
    ok('but the entry index is still built', Object.keys(merged.entryIndex).length === 6);
}

/* ================================================================== *
 * planKeyEmission — what actually gets written
 * ================================================================== */
{
    const merged = mergeClassifications(SKELETON, BOOK, CLASSIFICATIONS);
    const machinery = gatherMachineryText(BOOK);
    const plan = planKeyEmission(merged, BOOK, machinery);

    ok('her 人设 entry gets english keys', (plan.writes['8'] || []).includes('Shen Muwei'));
    ok('…including the given-name-only form users type', (plan.writes['8'] || []).includes('Muwei'));
    ok('the concept entry gets its phrases', (plan.writes['32'] || []).includes('teleport array'));

    check('AND-logic entry is never auto-augmented', plan.writes['80'], undefined);

    // The sect is zh-policy but still gets English keys — display policy governs
    // what is SHOWN; trigger keys are about what the user can TYPE.
    ok('zh-policy faction still gets typing keys', !!plan.writes['12']);

    ok('stats are tallied', plan.stats.keys > 0 && plan.stats.entries > 0);
}
{
    // A key already present in the entry must not be re-proposed.
    const book = { entries: { 8: { uid: 8, comment: 'X', key: ['沈慕微', 'Shen Muwei'] } } };
    const reg = normalizeRegistry({ entities: [{
        id: 'a', canonical: '沈慕微', category: 'character', display_en: 'Shen Muwei',
        displayPolicy: 'en', provisional: false, sourceEntryUids: [8],
    }] }, 'B');
    const plan = planKeyEmission(reg, book, '');
    ok('existing key is not proposed again', !(plan.writes['8'] || []).includes('Shen Muwei'));
    ok('but the missing variant still is', (plan.writes['8'] || []).includes('Muwei'));
}
{
    // Collision screen must bite during planning, not just in the abstract.
    const book = { entries: { 5: { uid: 5, comment: '状态', key: [] } } };
    const reg = normalizeRegistry({ conceptKeys: [
        { zh: '等级', en: ['level', 'cultivation level'], entryUids: [5] },
    ] }, 'B');
    const plan = planKeyEmission(reg, book, '<div>Level: 12</div>');
    check('bare colliding word is dropped', plan.writes['5'], ['cultivation level']);
    ok('and reported with a reason', plan.rejected.some((r) => r.key === 'level'));
}
{
    // An AND-logic entry surfaces for manual review with its proposal intact.
    const merged = mergeClassifications(normalizeRegistry({ entities: [{
        id: 'x', canonical: '密室', category: 'character', display_en: 'Secret Chamber',
        displayPolicy: 'en', provisional: false, sourceEntryUids: [80],
    }] }, 'B'), BOOK, []);
    const plan = planKeyEmission(merged, BOOK, '');
    check('flagged for manual review', plan.flagged.map((f) => f.uid), [80]);
    ok('flag carries the proposed keys', plan.flagged[0].proposed.includes('Secret Chamber'));
    ok('flag explains why', plan.flagged[0].reason.includes('次要关键词'));
}

/* ================================================================== *
 * Batch sizing + self-healing classification
 *
 * Batch size is bounded by OUTPUT tokens, not input: this pass emits one JSON
 * row per entry, so the reply grows linearly with the batch and an overrun is
 * truncated mid-array. (A conversational worldbook call has no such limit —
 * its answer is short no matter how many entries went in.)
 * ================================================================== */

ok('default batch is far larger than a token-timid guess', DEFAULT_BATCH_SIZE >= 60);
check('sizing respects a small budget', batchSizeForBudget(2000, 80), 17);
check('sizing scales with the budget', batchSizeForBudget(16384, 80), 143);
ok('a full 176-entry book fits a couple of calls at default size',
    Math.ceil(176 / DEFAULT_BATCH_SIZE) <= 3);
ok('estimate is linear in entry count', estimateOutputTokens(10, 80) === 800);
ok('a 176-row reply would blow a 4096 cap (why batching exists at all)',
    estimateOutputTokens(176, 80) > 4096);

const rows = (entries) => JSON.stringify(entries.map((e) => ({
    uid: e.uid, category: 'concept', display_en: '', displayPolicy: 'en',
    aliases_en: [], key_en: [],
})));

const fakeEntries = Array.from({ length: 24 }, (_, i) => ({
    uid: i + 1, comment: `E${i + 1}`, content: '', keys: [], hash: `h${i + 1}`,
}));

{
    const calls = [];
    const result = await classifyBook(fakeEntries, {
        batchSize: 24, cache: {},
        complete: async (messages) => { calls.push(messages); return rows(fakeEntries); },
    });
    check('one good call classifies the whole book', calls.length, 1);
    check('every entry is classified', result.classifications.length, 24);
    check('nothing is reported failed', result.failedBatches.length, 0);
}
{
    // A truncated reply: the model returns only the first 10 of 24 rows.
    // The missing 14 must be requeued at half size, not lost with the batch.
    let call = 0;
    const result = await classifyBook(fakeEntries, {
        batchSize: 24, cache: {},
        complete: async (messages) => {
            call += 1;
            const uids = [...String(messages[1].content).matchAll(/uid:\s*(\d+)/g)].map((m) => Number(m[1]));
            const subset = fakeEntries.filter((e) => uids.includes(e.uid));
            return call === 1 ? rows(subset.slice(0, 10)) : rows(subset);
        },
    });
    check('every entry still ends up classified', result.classifications.length, 24);
    check('and none are reported failed', result.failedBatches.length, 0);
    ok('the retry was split, not a blind repeat', call > 2);
}
{
    // A model that never returns usable JSON: entries must be REPORTED, not
    // silently dropped, and the retry ladder must terminate.
    let call = 0;
    const result = await classifyBook(fakeEntries.slice(0, 4), {
        batchSize: 4, cache: {}, maxAttempts: 2,
        complete: async () => { call += 1; return 'sorry, I cannot help with that'; },
    });
    check('nothing is classified', result.classifications.length, 0);
    ok('the failures are reported', result.failedBatches.length > 0);
    const reported = result.failedBatches.flatMap((f) => f.uids).sort((a, b) => a - b);
    check('every entry is accounted for', reported, [1, 2, 3, 4]);
    ok('retries terminate', call <= 8);
}
{
    // Cache means a re-run costs nothing.
    const cache = {};
    await classifyBook(fakeEntries, {
        batchSize: 24, cache, complete: async () => rows(fakeEntries),
    });
    let calls = 0;
    const second = await classifyBook(fakeEntries, {
        batchSize: 24, cache,
        complete: async () => { calls += 1; return rows(fakeEntries); },
    });
    check('a cached re-run makes no calls', calls, 0);
    check('…and still returns every classification', second.classifications.length, 24);
}
{
    // Abort must propagate out, not be swallowed as a batch failure.
    const controller = new AbortController();
    controller.abort();
    let threw = '';
    try {
        await classifyBook(fakeEntries, {
            batchSize: 24, cache: {}, signal: controller.signal,
            complete: async () => rows(fakeEntries),
        });
    } catch (e) { threw = e?.name || 'error'; }
    check('abort propagates', threw, 'AbortError');
}

/* ================================================================== *
 * Display decisions — 归墟-class names are asked about, then latched
 * ================================================================== */
{
    const reg = normalizeRegistry({ entities: [
        { id: 'guixu', canonical: '归墟', display_en: 'Guixu', category: 'location',
          displayPolicy: 'en', policyUncertain: true, sourceEntryUids: [42] },
        { id: 'muwei', canonical: '沈慕微', display_en: 'Shen Muwei', category: 'character',
          displayPolicy: 'en', sourceEntryUids: [8] },
        { id: 'hong', canonical: '红', display_en: 'Hong', category: 'character', sourceEntryUids: [90] },
        { id: 'jian', canonical: '传送阵', display_en: '', category: 'concept', sourceEntryUids: [32] },
    ] }, 'B');

    check('only renderable names with an english form are decidable',
        decidableEntities(reg).map((e) => e.id), ['guixu', 'muwei']);
    ok('single-hanzi names are never offered (pinned to Chinese)',
        !decidableEntities(reg).some((e) => e.id === 'hong'));
    check('only the uncertain one is pending', pendingDecisions(reg).map((e) => e.id), ['guixu']);

    const decided = applyDecision(reg, 'guixu', 'zh');
    const guixu = decided.entities.find((e) => e.id === 'guixu');
    check('the choice is recorded', guixu.displayPolicy, 'zh');
    ok('and latched as decided', guixu.policyDecided);
    ok('so it stops being pending', pendingDecisions(decided).length === 0);

    // A later Setup Pass must not raise it again, even if the model still says
    // it is unsure.
    const reRun = mergeClassifications(decided, { entries: { 42: { comment: '归墟' } } },
        [{ uid: 42, category: 'location', display_en: 'The Return to Void', displayPolicy: 'en',
           aliases_en: [], key_en: [], policyUncertain: true }]);
    const after = reRun.entities.find((e) => e.canonical === '归墟');
    check('a decided policy survives a re-run', after.displayPolicy, 'zh');
    ok('and is not re-asked', !after.policyUncertain);

    ok('the decision is reversible', applyDecision(decided, 'guixu', 'en')
        .entities.find((e) => e.id === 'guixu').displayPolicy === 'en');
    check('display names are editable',
        applyDisplayName(reg, 'guixu', 'Return-to-Void').entities.find((e) => e.id === 'guixu').display_en,
        'Return-to-Void');
}
{
    const rows = decisionRowsHtml([{ id: 'guixu', canonical: '归墟', display_en: 'Guixu',
        category: 'location', displayPolicy: 'en', policyUncertain: true }]);
    ok('row offers both concrete forms', rows.includes('归墟') && rows.includes('Guixu'));
    ok('pending rows are marked', rows.includes('lb-decide-pending'));
    ok('the active side is highlighted', rows.includes('lb-on'));
    check('empty list renders a message', decisionRowsHtml([]).includes('没有需要决定的名字'), true);
}

/* ================================================================== *
 * Gating: entries that cannot benefit from an English trigger word
 * ================================================================== */
{
    const book = { entries: {
        1: { uid: 1, comment: '世界观总纲', key: ['苍玄界'], constant: true },
        2: { uid: 2, comment: '废弃条目', key: ['旧设定'], disable: true },
        3: { uid: 3, comment: '普通条目', key: ['密林'] },
    } };
    const reg = normalizeRegistry({ keyTranslations: {
        1: ['cangxuan realm'], 2: ['old setting'], 3: ['dense forest'],
    } }, 'B');
    const plan = planKeyEmission(reg, book, '');

    check('blue-light (constant) entry gets no keys', plan.writes['1'], undefined);
    check('disabled entry gets no keys', plan.writes['2'], undefined);
    check('keyword-gated entry does get them', plan.writes['3'], ['dense forest']);
    check('both skips are reported', plan.skipped.map((s2) => s2.uid).sort(), [1, 2]);
    ok('and each says why',
        plan.skipped.find((s2) => s2.uid === 1).reason.includes('蓝灯')
        && plan.skipped.find((s2) => s2.uid === 2).reason.includes('禁用'));
}
{
    const entries = collectEntries({ entries: {
        1: { uid: 1, comment: 'A', key: [], constant: true },
        2: { uid: 2, comment: 'B', key: [], disable: true },
        3: { uid: 3, comment: 'C', key: [] },
    } });
    ok('constant status is recorded', entries.find((e) => e.uid === 1).constant);
    ok('disabled status is recorded', entries.find((e) => e.uid === 2).disabled);
    ok('an ordinary entry is neither', !entries.find((e) => e.uid === 3).constant
        && !entries.find((e) => e.uid === 3).disabled);
}

/* ================================================================== *
 * Author's own trigger words get English siblings
 * ================================================================== */
{
    const merged = mergeClassifications(emptyRegistry('B'), BOOK, [{
        uid: 32, category: 'concept', display_en: '', displayPolicy: 'en',
        aliases_en: [],
        key_en: ['teleport array', 'teleport fee', 'purchasing power',
                 'spirit stone price', 'cross-region teleport', 'travel cost'],
    }]);
    check('translations are stored against the entry',
        merged.keyTranslations['32'].length, 6);

    const plan = planKeyEmission(merged, BOOK, '');
    const written = plan.writes['32'] || [];
    ok('every author key gains an english sibling', written.length >= 6);
    ok('including the ones a phrase-inventing pass would have missed',
        written.includes('travel cost') && written.includes('cross-region teleport'));
}
{
    // A character's title keys are translated too, alongside the name variants.
    const reg = normalizeRegistry({
        entities: [{ id: 'a', canonical: '沈慕微', category: 'character',
            display_en: 'Shen Muwei', displayPolicy: 'en', sourceEntryUids: [8] }],
        keyTranslations: { 8: ['Merciless Path First Seat'] },
    }, 'B');
    const plan = planKeyEmission(reg, BOOK, '');
    ok('name variants are present', plan.writes['8'].includes('Muwei'));
    ok('and the title translation too', plan.writes['8'].includes('Merciless Path First Seat'));
}
{
    // Translations still go through the collision screen.
    const book = { entries: { 5: { uid: 5, comment: '状态', key: ['等级'] } } };
    const reg = normalizeRegistry({ keyTranslations: { 5: ['level', 'cultivation level'] } }, 'B');
    const plan = planKeyEmission(reg, book, '<div>Level: 12</div>');
    check('a colliding translation is dropped', plan.writes['5'], ['cultivation level']);
}

console.log(lines.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
