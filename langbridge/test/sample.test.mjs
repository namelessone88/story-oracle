/**
 * LangBridge — sample-registry tests.
 * Exercises the shipped hand-seeded 苍玄界 slice against the spec's acceptance
 * criteria that can be checked without a live SillyTavern (§8: 4, 5, 6).
 * Run:  node langbridge/test/sample.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../matcher.js';
import {
    normalizeRegistry, compile, describeEntries, tokenEntryRefs,
    findEntity, shouldRenderEnglish, DEFAULT_TOGGLES,
} from '../registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '..', 'sample-registry.json'), 'utf8'));
const REG = normalizeRegistry(raw);

let pass = 0, fail = 0;
const lines = [];
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; lines.push(`  ok   ${name}`); }
    else { fail++; lines.push(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

ok('sample registry parses', REG.entities.length === 10);
ok('entry index present', Object.keys(REG.entryIndex).length === 16);

/* §8.2 — a reply containing 沈慕微 renders "Shen Muwei" under characters=EN */
{
    const entity = findEntity(REG, 'shen-muwei');
    ok('沈慕微 renders EN by default', shouldRenderEnglish(entity, DEFAULT_TOGGLES));
    check('display form', entity.display_en, 'Shen Muwei');
    ok('flips to ZH when toggled off',
        !shouldRenderEnglish(entity, { ...DEFAULT_TOGGLES, renderCharacters: false }));
}

/* §8.4 — hovering 传送阵 shows entry 传送阵开销与购买力 + its sibling keys */
{
    const m = compile(REG, DEFAULT_TOGGLES);
    const hit = scan('他问起传送阵的价钱。', m)[0];
    ok('传送阵 is matched', hit && hit.text === '传送阵');
    const entries = describeEntries(REG, tokenEntryRefs(REG, hit.token));
    check('entry title', entries.map((e) => e.title), ['传送阵开销与购买力']);
    check('sibling trigger keys', entries[0].keys,
        ['传送阵', '传送费用', '购买力', '灵石价格', '跨域传送', '路费']);
}

/* §8.5 — hovering Shen Muwei shows 沈慕微, aliases, and ALL entries she keys */
{
    const m = compile(REG, DEFAULT_TOGGLES);
    const hit = scan('沈慕微抬起头。', m)[0];
    const entity = findEntity(REG, hit.token.entityId);
    check('canonical', entity.canonical, '沈慕微');
    ok('zh alias 无情道首座 present', entity.aliases_zh.includes('无情道首座'));
    ok('en alias Muwei present', entity.aliases_en.includes('Muwei'));
    const entries = describeEntries(REG, tokenEntryRefs(REG, hit.token));
    check('keys both her 人设 and her CG entry',
        entries.map((e) => e.title), ['【人设】沈慕微', '[mvu_plot]沈慕微CG触发']);
}

/* §8.6 — 红 is neither renamed nor highlighted by default */
{
    const m = compile(REG, DEFAULT_TOGGLES);
    check('红 not matched in ordinary prose', scan('她换上红色的外袍，脸红了。', m).map((h) => h.text), []);
    const hong = findEntity(REG, 'hong');
    ok('红 forced to zh policy', hong.displayPolicy === 'zh');
    ok('红 never renders EN', !shouldRenderEnglish(hong, DEFAULT_TOGGLES));
}

/* Longest-first over the real slice */
{
    const m = compile(REG, DEFAULT_TOGGLES);
    check('东海海域 / 归墟潮眼 win over their prefixes',
        scan('自东海海域向归墟潮眼。', m).map((h) => h.text), ['东海海域', '归墟潮眼']);
}

/* User-message scanning lights up typed English (drift detection) */
{
    const m = compile(REG, DEFAULT_TOGGLES, { includeEnglish: true });
    const hits = scan('How much does the teleport array to the East Sea cost?', m);
    check('typed English is recognised', hits.map((h) => h.text), ['teleport array', 'East Sea']);
}

/* An English phrase with no key lights nothing up — that IS the drift signal */
{
    const m = compile(REG, DEFAULT_TOGGLES, { includeEnglish: true });
    check('unanticipated phrasing matches nothing',
        scan('how much for a warp gate?', m).map((h) => h.text), []);
}

console.log(lines.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
