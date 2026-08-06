/**
 * LangBridge — collision screen + response parsing + batch sizing (pure).
 * Run:  node langbridge/test/setup.test.mjs
 */
import {
    screenKey, screenKeys, containsPhrase,
    extractJson, repairJson, parseTranslationBatch, normalizeTranslation,
    planBatches, entryHash, batchSizeForBudget, estimateOutputTokens,
    DEFAULT_BATCH_SIZE, CODE_VOCAB,
} from '../setup/analysis.js';

let pass = 0, fail = 0;
const lines = [];
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; lines.push(`  ok   ${name}`); }
    else { fail++; lines.push(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

/* ---------------- collision screen ---------------- */

const MACHINERY = `
<div class="status_bar"><span>Level: 12</span><span>HP: 80/100</span></div>
_.set('好感度', 5); _.set('time', '午后');
<UpdateVariable>状态 status update</UpdateVariable>
`;

check('bare "level" rejected as code vocabulary',
    screenKey('level', { machineryText: MACHINERY }).reason, 'code-vocabulary');
ok('lengthened "cultivation level" survives', screenKey('cultivation level', { machineryText: MACHINERY }).ok);
check('phrase present verbatim in machinery rejected',
    screenKey('status update', { machineryText: MACHINERY }).reason, 'appears-in-machinery');
check('short bare word rejected', screenKey('qi', {}).reason, 'too-short');
check('markup characters rejected', screenKey('<think>', {}).reason, 'markup-characters');
check('non-letters rejected', screenKey('1.4', {}).reason, 'no-letters');
ok('normal multiword key passes', screenKey('teleport array', { machineryText: MACHINERY }).ok);
ok('specific bare word passes', screenKey('tribulation', { machineryText: MACHINERY }).ok);
ok('"hp" is blocklisted', CODE_VOCAB.has('hp'));

ok('containsPhrase respects word boundaries', containsPhrase('Level: 12', 'level'));
ok('containsPhrase does not match inside a word', !containsPhrase('levelling up', 'level'));
ok('containsPhrase is case-insensitive', containsPhrase('LEVEL: 12', 'level'));

{
    const { accepted, rejected } = screenKeys(
        ['teleport array', 'level', 'teleport array', 'spirit stones', 'id'],
        { machineryText: MACHINERY });
    check('screenKeys dedupes and filters', accepted, ['teleport array', 'spirit stones']);
    check('screenKeys reports rejects', rejected.map((r) => r.key), ['level', 'id']);
}
check('caller-supplied blocklist works',
    screenKey('sanctuary', { extraBlocklist: ['sanctuary'] }).reason, 'blocklisted');

/* ---------------- response parsing ---------------- */

check('clean JSON array parses', extractJson('[{"uid":1}]'), [{ uid: 1 }]);
check('fenced JSON parses', extractJson('好的：\n```json\n[{"uid":2}]\n```\n以上。'), [{ uid: 2 }]);
check('prose-wrapped JSON parses', extractJson('Here: [{"uid":3}] hope this helps'), [{ uid: 3 }]);
check('trailing commas repaired', extractJson('[{"uid":4,},]'), [{ uid: 4 }]);
check('smart quotes repaired', extractJson('[{“uid”: 5}]'), [{ uid: 5 }]);
check('line comments stripped', extractJson('[\n{"uid":6} // sect\n]'), [{ uid: 6 }]);
check('garbage yields null', extractJson('sorry, I cannot do that'), null);
check('empty yields null', extractJson(''), null);
ok('repairJson is a no-op on clean input', repairJson('[{"a":1}]') === '[{"a":1}]');

{
    const batch = parseTranslationBatch(`\`\`\`json
    [
      {"uid": 8, "key_en": ["Shen Muwei", "Muwei", "  ", "Merciless Path First Seat"]},
      {"uid": 32, "keys_en": ["teleport array"]},
      {"uid": 70, "key_en": []},
      {"uid": "bad"},
      null
    ]\`\`\``);
    check('valid rows survive, junk is dropped', batch.map((b) => b.uid), [8, 32, 70]);
    check('blank strings inside key_en are dropped',
        batch.find((b) => b.uid === 8).key_en, ['Shen Muwei', 'Muwei', 'Merciless Path First Seat']);
    check('keys_en variant spelling accepted', batch.find((b) => b.uid === 32).key_en, ['teleport array']);
    check('empty key_en is a valid answer', batch.find((b) => b.uid === 70).key_en, []);
}
check('unparseable batch yields empty array', parseTranslationBatch('nope'), []);
check('row without uid rejected', normalizeTranslation({ key_en: ['x'] }), null);

/* ---------------- batching / caching ---------------- */

check('planBatches splits evenly', planBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
check('planBatches handles empty', planBatches([], 5), []);
{
    const a = entryHash({ comment: 'X', content: 'body', key: ['k'] });
    ok('entryHash is stable', a === entryHash({ comment: 'X', content: 'body', key: ['k'] }));
    ok('entryHash changes with content', a !== entryHash({ comment: 'X', content: 'body2', key: ['k'] }));
}
ok('default batch is output-budget-derived, not a timid guess', DEFAULT_BATCH_SIZE >= 60);
check('sizing respects a small budget', batchSizeForBudget(2000, 80), 17);
check('sizing scales with the budget', batchSizeForBudget(16384, 80), 143);
ok('a 176-row reply would blow a 4096 cap (why batching exists)', estimateOutputTokens(176, 80) > 4096);

console.log(lines.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
