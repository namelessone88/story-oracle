/**
 * LangBridge core tests — matcher + registry (pure, no DOM, no SillyTavern).
 * Run:  node langbridge/test/core.test.mjs
 */
import { buildMatcher, scan, hasAsciiBoundary, looksChinese } from '../matcher.js';
import {
    normalizeRegistry, emptyRegistry, buildTokens, compile, isSingleHanzi,
    registryRevision, entriesForText, describeEntry, DEFAULT_TOGGLES,
} from '../registry.js';

let pass = 0, fail = 0;
const lines = [];
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; lines.push(`  ok   ${name}`); }
    else { fail++; lines.push(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

/* Fixture — mirrors sample-registry.json's shapes. */
const REG = normalizeRegistry({
    bookName: 'B',
    entryIndex: {
        1:  { title: '苍玄界·总览', keys: ['苍玄界'], gated: false },          // blue
        8:  { title: '【人设】沈慕微', keys: ['沈慕微', '无情道首座'], gated: true },
        32: { title: '传送阵开销与购买力', keys: ['传送阵', '灵石价格'], gated: true },
        40: { title: '东海', keys: ['东海'], gated: true },
        41: { title: '东海海域', keys: ['东海海域'], gated: true },
        90: { title: '【人设】红', keys: ['红'], gated: true },                // single hanzi
        136:{ title: '[mvu_plot]沈慕微CG触发', keys: ['沈慕微', '温泉'], gated: true },
    },
    keyTranslations: {
        8: ['Shen Muwei', 'Muwei'],
        32: ['teleport array', 'teleportation'],
    },
    renderMap: {
        沈慕微: { en: 'Shen Muwei', on: true },
        东海: { en: 'East Sea', on: true },
        东海海域: { en: 'East Sea Waters', on: true },
        苍玄界: { en: 'Cangxuan Realm', on: true },   // blue entry's name
        温泉: { en: 'Hot Spring', on: false },        // switched off by the user
    },
}, 'B');

/* ---------------- matcher ---------------- */
ok('looksChinese detects hanzi', looksChinese('沈慕微'));
ok('looksChinese rejects latin', !looksChinese('Shen Muwei'));

{   // LONGEST-FIRST: 东海海域 must beat 东海; spans must not nest.
    const m = compile(REG, DEFAULT_TOGGLES);
    check('longest key wins', scan('他们穿过东海海域。', m).map((h) => h.text), ['东海海域']);
    check('short form still matches alone', scan('东海之上。', m).map((h) => h.text), ['东海']);
}
{   // CJK has no word boundary — must match mid-sentence.
    const m = compile(REG, DEFAULT_TOGGLES);
    check('zh key matches inside prose', scan('用传送阵去。', m).map((h) => h.text), ['传送阵']);
}
{   // English boundaries, user-message matcher.
    const m = compile(REG, DEFAULT_TOGGLES, { includeEnglish: true });
    check('en key rejects substring of larger word', scan('he was teleportationing', m).map((h) => h.text), []);
    check('en key matches standalone', scan('use the teleport array now', m).map((h) => h.text), ['teleport array']);
    check('en key is case-insensitive', scan('TELEPORT ARRAY', m).map((h) => h.text), ['TELEPORT ARRAY']);
}
{   // English tokens absent from the AI-message matcher.
    const m = compile(REG, DEFAULT_TOGGLES);
    check('en keys excluded from AI scan', scan('teleport array', m).map((h) => h.text), []);
}
ok('boundary helper: left edge', hasAsciiBoundary('teleport now', 0, 8));
ok('boundary helper: rejects inner', !hasAsciiBoundary('teleporting', 0, 8));
{
    const m = compile(REG, DEFAULT_TOGGLES);
    check('offsets exact and ordered', scan('沈慕微在东海。', m).map((h) => [h.text, h.start, h.end]),
        [['沈慕微', 0, 3], ['东海', 4, 6]]);
}
{
    const m = buildMatcher([{ text: 'a.b(c)', kind: 'en' }]);
    check('regex metachars are escaped', scan('x a.b(c) y', m).map((h) => h.text), ['a.b(c)']);
    check('escaped key does not match wildcard', scan('axbxcx', m).map((h) => h.text), []);
}
check('empty token list compiles to null regex', buildMatcher([]).regex, null);
check('scan tolerates empty text', scan('', compile(REG, DEFAULT_TOGGLES)), []);

/* ---------------- token derivation rules ---------------- */
{
    const tokens = buildTokens(REG, DEFAULT_TOGGLES);
    const texts = tokens.map((t) => t.text);
    ok('gated zh keys are tokens', texts.includes('传送阵') && texts.includes('无情道座') === false && texts.includes('无情道首座'));
    // 苍玄界 is a blue entry's key — it may appear ONLY as a render token
    // (its name can display in English) and never as a trigger highlight.
    ok('blue entry keys never highlight', !tokens.some((t) => t.text === '苍玄界' && t.highlight));
    ok('single-hanzi keys are NOT highlight tokens', !texts.includes('红'));
    ok('en translations absent without includeEnglish', !texts.includes('teleport array'));
}
{
    const texts = buildTokens(REG, DEFAULT_TOGGLES, { includeEnglish: true }).map((t) => t.text);
    ok('translations join the user-message tokens', texts.includes('teleport array') && texts.includes('Muwei'));
    ok('blue entries still excluded on the en side', !texts.includes('苍玄界'));
}
ok('highlight off still leaves render tokens',
    buildTokens(REG, { ...DEFAULT_TOGGLES, highlight: false }).every((t) => t.render));

/* ---------------- reverse lookup + entry description ---------------- */
check('a key maps to every entry that carries it', entriesForText(REG, '沈慕微'), ['8', '136']);
check('an english translation resolves too', entriesForText(REG, 'TELEPORT ARRAY'), ['32']);
check('unknown text maps to nothing', entriesForText(REG, '不存在'), []);
{
    const entry = describeEntry(REG, 32);
    check('entry title', entry.title, '传送阵开销与购买力');
    check('zh keys listed', entry.zhKeys, ['传送阵', '灵石价格']);
    check('english ways to type it listed', entry.enKeys, ['teleport array', 'teleportation']);
}
{
    const entry = describeEntry(REG, 40);
    check('entry without translations reports none', entry.enKeys, []);
}

/* ---------------- misc rules ---------------- */
ok('isSingleHanzi(红)', isSingleHanzi('红'));
ok('isSingleHanzi rejects 2 chars', !isSingleHanzi('东海'));
ok('isSingleHanzi rejects latin char', !isSingleHanzi('a'));
{
    const a = registryRevision(REG, DEFAULT_TOGGLES);
    ok('revision changes with toggles', a !== registryRevision(REG, { ...DEFAULT_TOGGLES, highlight: false }));
    ok('revision stable for same input', a === registryRevision(REG, DEFAULT_TOGGLES));
    const withMore = normalizeRegistry({ ...REG, keyTranslations: { ...REG.keyTranslations, 40: ['east sea'] } }, 'B');
    ok('revision changes with new translations', a !== registryRevision(withMore, DEFAULT_TOGGLES));
}

/* ---------------- normalization hardening ---------------- */
check('null registry normalizes to empty', normalizeRegistry(null).entryIndex, {});
{
    const junk = normalizeRegistry({ entryIndex: { 5: null, 6: 'x', 7: { title: ' T ', keys: ['k', 'k', ''] } } });
    check('junk index rows dropped, valid kept', Object.keys(junk.entryIndex), ['7']);
    check('keys deduped and trimmed', junk.entryIndex['7'].keys, ['k']);
    ok('gated defaults to true for old data', junk.entryIndex['7'].gated);
}
check('addedKeys ledger preserved',
    normalizeRegistry({ addedKeys: { 32: ['teleport array', 'teleport array', ''] } }).addedKeys,
    { 32: ['teleport array'] });
{
    // A v1 registry (entity model era) loads without complaint.
    const v1 = normalizeRegistry({
        version: 1,
        entities: [{ id: 'x', canonical: '沈慕微', display_en: 'Shen Muwei' }],
        entryIndex: { 8: { title: 'T', keys: ['沈慕微'] } },
        keyTranslations: { 8: ['Shen Muwei'] },
        addedKeys: { 8: ['Shen Muwei'] },
    }, 'B');
    ok('v1 data salvages the three live fields', v1.entryIndex['8'] && v1.keyTranslations['8'] && v1.addedKeys['8']);
    ok('entity junk is simply ignored', !('entities' in emptyRegistry()));
}

/* ---------------- render tokens ---------------- */
{
    const tokens = buildTokens(REG, DEFAULT_TOGGLES);
    const muwei = tokens.find((t) => t.text === '沈慕微');
    ok('render token carries the english form', muwei && muwei.render === 'Shen Muwei');
    ok('name that is also a trigger key highlights too', muwei && muwei.highlight === true);
    const realm = tokens.find((t) => t.text === '苍玄界');
    ok('blue-entry name renders', realm && realm.render === 'Cangxuan Realm');
    ok('…but does not highlight (not a live trigger)', realm && realm.highlight === false);
    ok('switched-off pair produces no render token', !tokens.some((t) => t.text === '温泉' && t.render));
}
{
    const tokens = buildTokens(REG, { ...DEFAULT_TOGGLES, renderNames: false });
    ok('renderNames off removes render tokens', !tokens.some((t) => t.render));
    ok('…but trigger highlighting is unaffected', tokens.some((t) => t.text === '沈慕微' && t.highlight));
}
{
    const tokens = buildTokens(REG, { ...DEFAULT_TOGGLES, highlight: false });
    const muwei = tokens.find((t) => t.text === '沈慕微');
    ok('highlight off keeps rendering', muwei && muwei.render === 'Shen Muwei');
    ok('…with the highlight flag down', muwei && muwei.highlight === false);
    ok('plain trigger words disappear', !tokens.some((t) => t.text === '灵石价格'));
}
{
    const tokens = buildTokens(REG, DEFAULT_TOGGLES, { includeEnglish: true });
    ok('user-message matcher never renders', !tokens.some((t) => t.render));
}
check('both features off yields no tokens',
    buildTokens(REG, { ...DEFAULT_TOGGLES, highlight: false, renderNames: false }), []);

/* ---------------- renderMap normalization rules ---------------- */
{
    const reg = normalizeRegistry({ renderMap: {
        红: { en: 'Hong', on: true },              // single hanzi — refused
        Muwei: { en: 'Muwei', on: true },          // not Chinese — refused
        沈慕微: { en: '  Shen Muwei  ', on: true },
        空的: { en: '', on: true },                // empty en — refused
        归墟: 'Guixu',                             // string shorthand accepted
        关的: { en: 'Off', on: false },
    } });
    check('surviving pairs', Object.keys(reg.renderMap).sort(), ['关的', '沈慕微', '归墟'].sort());
    check('en is trimmed', reg.renderMap['沈慕微'].en, 'Shen Muwei');
    ok('string shorthand defaults on', reg.renderMap['归墟'].on === true);
    ok('off state survives normalization', reg.renderMap['关的'].on === false);
}
{
    const a = registryRevision(REG, DEFAULT_TOGGLES);
    const flipped = normalizeRegistry({ ...REG, renderMap: { ...REG.renderMap, 沈慕微: { en: 'Shen Muwei', on: false } } }, 'B');
    ok('revision changes when a pair is switched', a !== registryRevision(flipped, DEFAULT_TOGGLES));
    ok('revision changes with renderNames toggle',
        a !== registryRevision(REG, { ...DEFAULT_TOGGLES, renderNames: false }));
}

console.log(lines.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
