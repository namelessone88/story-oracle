/**
 * LangBridge — sample-registry tests: the shipped 苍玄界 slice must exercise
 * both features end to end (pure logic; DOM behaviour is dom.test.mjs).
 * Run:  node langbridge/test/sample.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../matcher.js';
import {
    normalizeRegistry, compile, entriesForText, describeEntry, DEFAULT_TOGGLES,
} from '../registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const REG = normalizeRegistry(JSON.parse(readFileSync(join(here, '..', 'sample-registry.json'), 'utf8')));

let pass = 0, fail = 0;
const lines = [];
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; lines.push(`  ok   ${name}`); }
    else { fail++; lines.push(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

ok('sample registry parses', Object.keys(REG.entryIndex).length === 12);

/* Highlighting an AI reply */
{
    const m = compile(REG, DEFAULT_TOGGLES);
    const hits = scan('沈慕微用传送阵抵达东海海域，随后前往归墟潮眼。', m).map((h) => h.text);
    check('trigger words light up', hits, ['沈慕微', '传送阵', '东海海域', '归墟潮眼']);
}
{
    const m = compile(REG, DEFAULT_TOGGLES);
    check('blue entry key does not light up', scan('这里是苍玄界。', m).map((h) => h.text), []);
    check('single-hanzi name does not light up', scan('她穿着红色的衣服。', m).map((h) => h.text), []);
}

/* Hover card data */
{
    const uids = entriesForText(REG, '沈慕微');
    check('沈慕微 keys her 人设 AND her CG entry', uids, ['8', '136']);
    const cg = describeEntry(REG, '136');
    check('CG entry shows its sibling keys', cg.zhKeys, ['沈慕微', '温泉']);
    ok('and its english ways to type', cg.enKeys.includes('hot spring'));
}
{
    const entry = describeEntry(REG, '32');
    check('传送阵 entry lists all six author keys',
        entry.zhKeys, ['传送阵', '传送费用', '购买力', '灵石价格', '跨域传送', '路费']);
    ok('every one has an english sibling available', entry.enKeys.length >= 6);
}

/* Typing English (drift detection matcher) */
{
    const m = compile(REG, DEFAULT_TOGGLES, { includeEnglish: true });
    const hits = scan('How much does the teleport array to Guixu cost?', m).map((h) => h.text);
    check('typed English is recognised', hits, ['teleport array', 'Guixu']);
    check('unanticipated phrasing lights nothing (the drift signal)',
        scan('how much for a warp gate?', m).map((h) => h.text), []);
}

console.log(lines.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
