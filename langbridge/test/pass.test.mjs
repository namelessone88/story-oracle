/**
 * LangBridge — translation pass planning + self-healing batch runner (pure parts).
 * Run:  node langbridge/test/pass.test.mjs
 */
import {
    collectEntries, splitEntries, gatherMachineryText, planWrites,
    refreshEntryIndex, translateBook,
} from '../setup/pass.js';
import { normalizeRegistry, emptyRegistry } from '../registry.js';

let pass = 0, fail = 0;
const lines = [];
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; lines.push(`  ok   ${name}`); }
    else { fail++; lines.push(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

/* A book with every shape that matters: green, blue, disabled, AND-logic,
 * machinery, english-only keys. */
const BOOK = {
    entries: {
        1:  { uid: 1,  comment: '世界观总纲', key: ['苍玄界'], constant: true, content: '总纲。' },
        2:  { uid: 2,  comment: '废弃条目', key: ['旧设定'], disable: true, content: '' },
        8:  { uid: 8,  comment: '【人设】沈慕微', key: ['沈慕微', '无情道首座'], content: '无情道首座。' },
        32: { uid: 32, comment: '传送阵开销与购买力', key: ['传送阵', '传送费用', '灵石价格'], content: '跨域传送需灵石。' },
        70: { uid: 70, comment: '变量列表', key: [], content: '<div class="status_bar">Level: 12 HP: 80</div> _.set("好感度", 5);' },
        80: { uid: 80, comment: '密室事件', key: ['密室'], keysecondary: ['夜晚'], content: '仅夜间触发。' },
        95: { uid: 95, comment: '英文条目', key: ['already english'], content: '' },
    },
};

/* ---------------- collect + split ---------------- */
{
    const entries = collectEntries(BOOK);
    check('all entries collected in uid order', entries.map((e) => e.uid), [1, 2, 8, 32, 70, 80, 95]);
    ok('constant recorded', entries.find((e) => e.uid === 1).constant);
    ok('disabled recorded', entries.find((e) => e.uid === 2).disabled);
    ok('AND-logic recorded', entries.find((e) => e.uid === 80).hasSecondary);

    const { translatable, flagged, skipped, inert } = splitEntries(entries);
    check('green entries with zh keys are translatable', translatable.map((e) => e.uid), [8, 32]);
    check('AND-logic entry is flagged, not translated', flagged.map((f) => f.uid), [80]);
    ok('flag says why', flagged[0].reason.includes('次要关键词'));
    check('blue + disabled are skipped', skipped.map((s2) => s2.uid).sort(), [1, 2]);
    ok('skip reasons distinguish the two',
        skipped.find((s2) => s2.uid === 1).reason.includes('蓝灯')
        && skipped.find((s2) => s2.uid === 2).reason.includes('禁用'));
    check('no-chinese-keys entries are inert', inert.sort(), [70, 95]);
}
{
    const machinery = gatherMachineryText(BOOK, 'AI reply with status: ok');
    ok('status-bar entry picked up as machinery', machinery.includes('status_bar'));
    ok('sample reply included', machinery.includes('AI reply with status: ok'));
    ok('ordinary prose not swept in', !machinery.includes('跨域传送需灵石'));
}

/* ---------------- planWrites ---------------- */
{
    const plan = planWrites({
        8: ['Shen Muwei', 'Muwei', 'Merciless Path First Seat'],
        32: ['teleport array', 'teleport fee', 'spirit stone price', 'level'],
    }, BOOK, '<div>Level: 12</div>');

    check('name translations planned', plan.writes['8'], ['Shen Muwei', 'Muwei', 'Merciless Path First Seat']);
    ok('concept translations planned', plan.writes['32'].includes('teleport array'));
    ok('colliding word dropped', !plan.writes['32'].includes('level'));
    ok('and reported with a reason', plan.rejected.some((r) => r.key === 'level'));
    ok('stats tallied', plan.stats.keys > 0 && plan.stats.entries === 2);
}
{
    // Keys already on the entry are not proposed again (idempotency half 1).
    const book = { entries: { 8: { uid: 8, comment: 'X', key: ['沈慕微', 'Shen Muwei'] } } };
    const plan = planWrites({ 8: ['Shen Muwei', 'Muwei'] }, book, '');
    check('existing key not re-proposed', plan.writes['8'], ['Muwei']);
}
{
    const plan = planWrites({ 999: ['ghost'] }, BOOK, '');
    check('unknown uid ignored', plan.writes, {});
}

/* ---------------- refreshEntryIndex ---------------- */
{
    const next = refreshEntryIndex(emptyRegistry('B'), BOOK);
    check('every entry indexed', Object.keys(next.entryIndex).length, 7);
    ok('green flagged gated', next.entryIndex['8'].gated);
    ok('blue flagged not gated', !next.entryIndex['1'].gated);
    ok('disabled flagged not gated', !next.entryIndex['2'].gated);
    check('titles and keys captured', next.entryIndex['32'].keys, ['传送阵', '传送费用', '灵石价格']);
}
{
    // Refresh preserves translations and the ledger.
    const before = normalizeRegistry({
        keyTranslations: { 8: ['Shen Muwei'] }, addedKeys: { 8: ['Shen Muwei'] },
    }, 'B');
    const next = refreshEntryIndex(before, BOOK);
    check('translations survive a refresh', next.keyTranslations['8'], ['Shen Muwei']);
    check('ledger survives a refresh', next.addedKeys['8'], ['Shen Muwei']);
}

/* ---------------- translateBook: self-healing runner ---------------- */

const rows = (entries) => JSON.stringify(entries.map((e) => ({ uid: e.uid, key_en: [`en-${e.uid}`] })));
const fakeEntries = Array.from({ length: 24 }, (_, i) => ({
    uid: i + 1, comment: `E${i + 1}`, content: '', keys: ['键'], hash: `h${i + 1}`,
}));

{
    let calls = 0;
    const result = await translateBook(fakeEntries, {
        batchSize: 24, cache: {},
        complete: async () => { calls += 1; return rows(fakeEntries); },
    });
    check('one good call translates the whole set', calls, 1);
    check('every entry translated', Object.keys(result.translations).length, 24);
    check('nothing reported failed', result.failedBatches.length, 0);
}
{
    // Truncated reply: only 10 of 24 rows come back; the missing 14 must be
    // requeued at half size, not lost with the batch.
    let call = 0;
    const result = await translateBook(fakeEntries, {
        batchSize: 24, cache: {},
        complete: async (messages) => {
            call += 1;
            const uids = [...String(messages[1].content).matchAll(/uid:\s*(\d+)/g)].map((m) => Number(m[1]));
            const subset = fakeEntries.filter((e) => uids.includes(e.uid));
            return call === 1 ? rows(subset.slice(0, 10)) : rows(subset);
        },
    });
    check('every entry still translated', Object.keys(result.translations).length, 24);
    check('none reported failed', result.failedBatches.length, 0);
    ok('the retry was split, not a blind repeat', call > 2);
}
{
    // A model that never returns JSON: entries are REPORTED, retries terminate.
    let call = 0;
    const result = await translateBook(fakeEntries.slice(0, 4), {
        batchSize: 4, cache: {}, maxAttempts: 2,
        complete: async () => { call += 1; return 'sorry'; },
    });
    check('nothing translated', Object.keys(result.translations).length, 0);
    check('every entry accounted for in failures',
        result.failedBatches.flatMap((f) => f.uids).sort((a, b) => a - b), [1, 2, 3, 4]);
    ok('retries terminate', call <= 8);
}
{
    // Cache: a re-run costs zero calls.
    const cache = {};
    await translateBook(fakeEntries, { batchSize: 24, cache, complete: async () => rows(fakeEntries) });
    let calls = 0;
    const second = await translateBook(fakeEntries, {
        batchSize: 24, cache, complete: async () => { calls += 1; return rows(fakeEntries); },
    });
    check('a cached re-run makes no calls', calls, 0);
    check('and still returns every translation', Object.keys(second.translations).length, 24);
}
{
    // Rows with empty key_en are cached but produce no translations entry.
    const result = await translateBook(fakeEntries.slice(0, 2), {
        batchSize: 2, cache: {},
        complete: async () => JSON.stringify([{ uid: 1, key_en: [] }, { uid: 2, key_en: ['ok'] }]),
    });
    check('empty answers are not writes', Object.keys(result.translations), ['2']);
    check('and are not failures', result.failedBatches.length, 0);
}
{
    // Abort propagates out rather than being swallowed as a batch failure.
    const controller = new AbortController();
    controller.abort();
    let threw = '';
    try {
        await translateBook(fakeEntries, {
            batchSize: 24, cache: {}, signal: controller.signal,
            complete: async () => rows(fakeEntries),
        });
    } catch (e) { threw = e?.name || 'error'; }
    check('abort propagates', threw, 'AbortError');
}

console.log(lines.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
