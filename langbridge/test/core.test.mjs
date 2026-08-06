/**
 * LangBridge core tests — pure logic only (no DOM, no SillyTavern).
 * Run:  node langbridge/test/core.test.mjs
 */
import { buildMatcher, scan, hasAsciiBoundary, looksChinese } from '../matcher.js';
import {
    normalizeRegistry, buildTokens, compile, shouldRenderEnglish,
    isSingleHanzi, registryRevision, tokenEntryRefs, DEFAULT_TOGGLES,
} from '../registry.js';

let pass = 0, fail = 0;
const results = [];

function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; results.push(`  ok   ${name}`); }
    else { fail++; results.push(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

/* ---------------------------------------------------------------- *
 * Fixture — hand-seeded slice of the 苍玄界 book (spec §9 build step 1)
 * ---------------------------------------------------------------- */
const REG = normalizeRegistry({
    bookName: '我的苍玄界（才不会这么跌宕起伏）',
    entities: [
        { id: 'shen-muwei', canonical: '沈慕微', display_en: 'Shen Muwei', category: 'character',
          aliases_zh: ['无情道首座'], aliases_en: ['Muwei', 'Shen Mu-wei'], displayPolicy: 'en',
          sourceEntryUids: [8, 136] },
        { id: 'tianjian-zong', canonical: '天剑宗', display_en: 'Heavenly Sword Sect', category: 'faction',
          aliases_zh: [], aliases_en: [], displayPolicy: 'zh', sourceEntryUids: [12] },
        { id: 'donghai', canonical: '东海', display_en: 'East Sea', category: 'location',
          displayPolicy: 'en', sourceEntryUids: [40] },
        { id: 'donghai-haiyu', canonical: '东海海域', display_en: 'East Sea Waters', category: 'location',
          displayPolicy: 'en', sourceEntryUids: [41] },
        { id: 'guixu', canonical: '归墟', display_en: 'Guixu', category: 'location',
          displayPolicy: 'en', sourceEntryUids: [42] },
        { id: 'guixu-chaoyan', canonical: '归墟潮眼', display_en: 'Guixu Tide Eye', category: 'location',
          displayPolicy: 'en', sourceEntryUids: [43] },
        { id: 'hong', canonical: '红', display_en: 'Hong', category: 'character', sourceEntryUids: [90] },
    ],
    conceptKeys: [
        { zh: '传送阵', en: ['teleport array', 'teleportation', 'teleport'], entryUids: [32] },
        { zh: '灵石', en: ['spirit stones'], entryUids: [33] },
    ],
});

/* ---------------------------------------------------------------- *
 * matcher
 * ---------------------------------------------------------------- */
ok('looksChinese detects hanzi', looksChinese('沈慕微'));
ok('looksChinese rejects latin', !looksChinese('Shen Muwei'));

{   // LONGEST-FIRST: the longer key must win and spans must not nest.
    const m = compile(REG, DEFAULT_TOGGLES);
    const hits = scan('他们穿过东海海域，直抵归墟潮眼。', m);
    check('longest-first picks 东海海域 and 归墟潮眼',
        hits.map((h) => h.text), ['东海海域', '归墟潮眼']);
}
{   // …but the short forms still match when they stand alone.
    const m = compile(REG, DEFAULT_TOGGLES);
    check('short forms still match alone',
        scan('东海之上，归墟之下。', m).map((h) => h.text), ['东海', '归墟']);
}
{   // CJK has no word boundary — must match mid-sentence.
    const m = compile(REG, DEFAULT_TOGGLES);
    check('zh token matches inside prose',
        scan('用传送阵去。', m).map((h) => h.text), ['传送阵']);
}
{   // English boundary: no match inside a longer word.
    const m = compile(REG, DEFAULT_TOGGLES, { includeEnglish: true });
    check('en token rejects substring of larger word',
        scan('he was teleporting away', m).map((h) => h.text), []);
    check('en token matches standalone', scan('use the teleport now', m).map((h) => h.text), ['teleport']);
    check('en token is case-insensitive', scan('Teleport Array here', m).map((h) => h.text), ['Teleport Array']);
    check('en multiword preferred over bare word',
        scan('the teleport array cost', m).map((h) => h.text), ['teleport array']);
}
{   // English tokens are absent unless explicitly scanning user messages.
    const m = compile(REG, DEFAULT_TOGGLES);
    check('en tokens excluded by default', scan('use the teleport now', m).map((h) => h.text), []);
}
ok('boundary helper: left edge', hasAsciiBoundary('teleport now', 0, 8));
ok('boundary helper: rejects inner', !hasAsciiBoundary('teleporting', 0, 8));
{   // Non-overlapping, ascending order, correct offsets.
    const m = compile(REG, DEFAULT_TOGGLES);
    const hits = scan('沈慕微在东海。', m);
    check('offsets are exact and ordered',
        hits.map((h) => [h.text, h.start, h.end]), [['沈慕微', 0, 3], ['东海', 4, 6]]);
}
{   // Regex metacharacters in a key must not break compilation.
    const m = buildMatcher([{ text: 'a.b(c)', kind: 'en' }]);
    check('regex metachars are escaped', scan('x a.b(c) y', m).map((h) => h.text), ['a.b(c)']);
    check('escaped key does not match wildcard text', scan('axbxcx', m).map((h) => h.text), []);
}
check('empty token list compiles to null regex', buildMatcher([]).regex, null);
check('scan tolerates empty text', scan('', compile(REG, DEFAULT_TOGGLES)), []);

/* ---------------------------------------------------------------- *
 * registry rules
 * ---------------------------------------------------------------- */
ok('isSingleHanzi(红)', isSingleHanzi('红'));
ok('isSingleHanzi rejects 2 chars', !isSingleHanzi('东海'));
{
    const hong = REG.entities.find((e) => e.id === 'hong');
    ok('single hanzi is flagged', hong.singleChar);
    check('single hanzi forced to zh policy', hong.displayPolicy, 'zh');
}
{   // 红 must be neither renamed nor highlighted by default (acceptance test 6).
    const m = compile(REG, DEFAULT_TOGGLES);
    check('单字名 not matched by default', scan('她穿着红色的衣服。', m).map((h) => h.text), []);
}
{   // …until the per-entity override is set.
    const withOverride = normalizeRegistry({
        ...REG,
        entities: REG.entities.map((e) => e.id === 'hong' ? { ...e, allowSingleCharHighlight: true } : e),
    });
    const m = compile(withOverride, DEFAULT_TOGGLES);
    check('单字名 matched after override', scan('她穿着红色的衣服。', m).map((h) => h.text), ['红']);
}
{
    const muwei = REG.entities.find((e) => e.id === 'shen-muwei');
    const sect = REG.entities.find((e) => e.id === 'tianjian-zong');
    ok('character renders EN when toggle on', shouldRenderEnglish(muwei, DEFAULT_TOGGLES));
    ok('character does not render when toggle off',
        !shouldRenderEnglish(muwei, { ...DEFAULT_TOGGLES, renderCharacters: false }));
    ok('zh-policy entity never renders', !shouldRenderEnglish(sect, DEFAULT_TOGGLES));
    ok('concept never renders',
        !shouldRenderEnglish({ category: 'concept', displayPolicy: 'en', display_en: 'X' }, DEFAULT_TOGGLES));
}
{   // Highlight off + render on: names still tokenized (needed for renaming),
    // concepts dropped entirely.
    const tokens = buildTokens(REG, { ...DEFAULT_TOGGLES, highlight: false });
    ok('concepts dropped when highlight off', !tokens.some((t) => t.type === 'concept'));
    ok('renderable names kept when highlight off', tokens.some((t) => t.text === '沈慕微'));
    ok('zh-policy faction dropped when highlight off', !tokens.some((t) => t.text === '天剑宗'));
}
{
    const tokens = buildTokens(REG, DEFAULT_TOGGLES);
    ok('zh aliases are tokenized', tokens.some((t) => t.text === '无情道首座'));
}
{   // Revision must change when a toggle or the content changes (drives re-render).
    const a = registryRevision(REG, DEFAULT_TOGGLES);
    const b = registryRevision(REG, { ...DEFAULT_TOGGLES, renderCharacters: false });
    ok('revision changes with toggles', a !== b);
    ok('revision is stable for same input', a === registryRevision(REG, DEFAULT_TOGGLES));
}
{
    const m = compile(REG, DEFAULT_TOGGLES);
    const hit = scan('沈慕微', m)[0];
    check('token resolves to her entries', tokenEntryRefs(REG, hit.token), [8, 136]);
    const c = scan('传送阵', m)[0];
    check('concept token resolves to its entry', tokenEntryRefs(REG, c.token), [32]);
}

/* ---------------------------------------------------------------- *
 * normalization hardening (corrupt input must degrade, never throw)
 * ---------------------------------------------------------------- */
check('null registry normalizes to empty', normalizeRegistry(null).entities, []);
check('junk entities are dropped', normalizeRegistry({ entities: [null, {}, 5, { canonical: '  ' }] }).entities, []);
{
    const dup = normalizeRegistry({ entities: [
        { id: 'x', canonical: 'A' }, { id: 'x', canonical: 'B' },
    ] });
    check('duplicate ids are disambiguated', dup.entities.map((e) => e.id), ['x', 'x_']);
}
check('addedKeys ledger is preserved',
    normalizeRegistry({ addedKeys: { 32: ['teleport array', 'teleport array', ''] } }).addedKeys,
    { 32: ['teleport array'] });

/* ---------------------------------------------------------------- */
console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
