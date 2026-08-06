/**
 * LangBridge — Setup Pass analysis + consistency report tests (pure logic).
 * Run:  node langbridge/test/setup.test.mjs
 */
import {
    screenKey, screenKeys, containsPhrase, nameVariants, hyphenateSyllables,
    extractJson, repairJson, parseClassificationBatch, normalizeClassification,
    planBatches, entryHash, CODE_VOCAB,
} from '../setup/analysis.js';
import {
    editDistance, similarity, findNearMisses, findDeadWeights, buildReport, extractCgNames,
} from '../setup/report.js';

let pass = 0, fail = 0;
const lines = [];
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; lines.push(`  ok   ${name}`); }
    else { fail++; lines.push(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

/* ================================================================== *
 * Collision screen
 * ================================================================== */

// The card's machinery: status bar template + variable list + a sample reply.
const MACHINERY = `
<div class="status_bar"><span>Level: 12</span><span>HP: 80/100</span></div>
_.set('好感度', 5); _.set('time', '午后');
<UpdateVariable>状态 status update</UpdateVariable>
`;

check('bare "level" is rejected as code vocabulary',
    screenKey('level', { machineryText: MACHINERY }).reason, 'code-vocabulary');
ok('lengthened "cultivation level" survives',
    screenKey('cultivation level', { machineryText: MACHINERY }).ok);
check('a phrase present verbatim in machinery is rejected',
    screenKey('status update', { machineryText: MACHINERY }).reason, 'appears-in-machinery');
check('short bare word rejected', screenKey('qi', {}).reason, 'too-short');
check('markup characters rejected', screenKey('<think>', {}).reason, 'markup-characters');
check('non-letters rejected', screenKey('1.4', {}).reason, 'no-letters');
ok('normal multiword key passes', screenKey('teleport array', { machineryText: MACHINERY }).ok);
ok('bare word not in blocklist passes', screenKey('tribulation', { machineryText: MACHINERY }).ok);
ok('"hp" is blocklisted', CODE_VOCAB.has('hp'));

{   // Word-boundary discipline: "level" inside "cultivation level" must not
    // cause the phrase to be rejected merely because the word appears.
    ok('containsPhrase respects word boundaries', containsPhrase('Level: 12', 'level'));
    ok('containsPhrase does not match inside a word', !containsPhrase('levelling up', 'level'));
    ok('containsPhrase is case-insensitive', containsPhrase('LEVEL: 12', 'level'));
}
{
    const { accepted, rejected } = screenKeys(
        ['teleport array', 'level', 'teleport array', 'spirit stones', 'id'],
        { machineryText: MACHINERY });
    check('screenKeys dedupes and filters', accepted, ['teleport array', 'spirit stones']);
    check('screenKeys reports rejects', rejected.map((r) => r.key), ['level', 'id']);
}
{
    const custom = screenKey('sanctuary', { extraBlocklist: ['sanctuary'] });
    check('caller-supplied blocklist works', custom.reason, 'blocklisted');
}

/* ================================================================== *
 * English variant generation
 * ================================================================== */

{
    const v = nameVariants('Shen Muwei');
    ok('full name present', v.includes('Shen Muwei'));
    ok('given-name-only present (what users actually type)', v.includes('Muwei'));
    ok('joined spelling present', v.includes('ShenMuwei'));
    ok('surname-only NOT generated (too collision-prone)', !v.includes('Shen'));
}
check('hyphenated variant is derived', nameVariants('Shen Muwei').includes('Shen Mu-wei'), true);
check('single-token name yields just itself', nameVariants('Guixu'), ['Guixu']);
check('empty input yields nothing', nameVariants(''), []);
{
    const v = nameVariants('Ai Erwen Youzedier');
    ok('multi-token given name is joined', v.includes('Erwen Youzedier'));
}
{
    const v = nameVariants('Mu Haitang', { extraAliases: ['Tang'] });
    ok('extra aliases are appended', v.includes('Tang'));
    check('no duplicates after dedupe', v.length, new Set(v.map((x) => x.toLowerCase())).size);
}
check('hyphenateSyllables splits Muwei', hyphenateSyllables('Muwei'), 'Mu-wei');
check('hyphenateSyllables declines short tokens', hyphenateSyllables('Li'), '');

/* ================================================================== *
 * Response parsing (what cheap models actually return)
 * ================================================================== */

check('clean JSON array parses',
    extractJson('[{"uid":1}]'), [{ uid: 1 }]);
check('fenced JSON parses',
    extractJson('好的：\n```json\n[{"uid":2}]\n```\n以上。'), [{ uid: 2 }]);
check('prose-wrapped JSON parses',
    extractJson('Here you go: [{"uid":3}] hope this helps'), [{ uid: 3 }]);
check('trailing commas are repaired',
    extractJson('[{"uid":4,},]'), [{ uid: 4 }]);
check('smart quotes are repaired',
    extractJson('[{“uid”: 5}]'), [{ uid: 5 }]);
check('line comments are stripped',
    extractJson('[\n{"uid":6} // the sect\n]'), [{ uid: 6 }]);
check('garbage yields null', extractJson('sorry, I cannot do that'), null);
check('empty yields null', extractJson(''), null);
ok('repairJson is a no-op on clean input', repairJson('[{"a":1}]') === '[{"a":1}]');

{
    const batch = parseClassificationBatch(`\`\`\`json
    [
      {"uid": 8, "category": "character", "display_en": "Shen Muwei", "aliases_en": ["Muwei"], "displayPolicy": "en"},
      {"uid": 32, "category": "concept", "key_en": ["teleport array", "teleportation"]},
      {"uid": 99, "category": "nonsense"},
      {"uid": "bad"},
      null
    ]\`\`\``);
    check('valid rows survive, junk is dropped', batch.map((b) => b.uid), [8, 32, 99]);
    check('unknown category falls back to concept (never renames)',
        batch.find((b) => b.uid === 99).category, 'concept');
    check('character row keeps its romanization',
        batch.find((b) => b.uid === 8).display_en, 'Shen Muwei');
    check('concept row keeps its english keys',
        batch.find((b) => b.uid === 32).key_en, ['teleport array', 'teleportation']);
}
check('unparseable batch yields empty array (fails alone)', parseClassificationBatch('nope'), []);
check('normalizeClassification rejects rows without uid', normalizeClassification({ category: 'character' }), null);

/* ================================================================== *
 * Batching / caching
 * ================================================================== */

check('planBatches splits evenly', planBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
check('planBatches handles empty', planBatches([], 5), []);
{
    const a = entryHash({ comment: 'X', content: 'body', key: ['k'] });
    const b = entryHash({ comment: 'X', content: 'body', key: ['k'] });
    const c = entryHash({ comment: 'X', content: 'body2', key: ['k'] });
    ok('entryHash is stable', a === b);
    ok('entryHash changes with content', a !== c);
}

/* ================================================================== *
 * Consistency report — the known live findings
 * ================================================================== */

check('edit distance: one substitution', editDistance('幕海棠', '慕海棠'), 1);
check('edit distance: adjacent transposition counts as one', editDistance('林鹿雪', '林雪鹿'), 1);
check('identical strings have distance 0', editDistance('沈慕微', '沈慕微'), 0);
ok('similarity of a 1-edit 3-char name clears the bar', similarity('幕海棠', '慕海棠') > 0.6);

{
    // THE two known live findings from the 苍玄界 pair.
    const misses = findNearMisses(
        [{ name: '幕海棠', source: 'draw-library' }, { name: '林鹿雪', source: 'draw-library' }],
        [{ name: '慕海棠', source: 'worldbook' }, { name: '林雪鹿', source: 'worldbook' }],
    );
    check('both known mismatches are found',
        misses.map((m) => [m.a, m.b]).sort(),
        [['幕海棠', '慕海棠'], ['林鹿雪', '林雪鹿']].sort());
}
{
    const misses = findNearMisses([{ name: '沈慕微' }], [{ name: '沈慕微' }]);
    check('identical spellings are not a finding', misses, []);
}
{
    // Two genuinely different characters must not be paired up.
    const misses = findNearMisses([{ name: '沈慕微' }], [{ name: '林雪鹿' }]);
    check('unrelated names are not paired', misses, []);
}

check('dead A1111 weights are detected',
    findDeadWeights('masterpiece, (best quality:1.4), (detailed:1.2), girl'),
    ['(best quality:1.4)', '(detailed:1.2)']);
check('clean prompt has no dead weights', findDeadWeights('masterpiece, best quality'), []);

{
    const registry = {
        entities: [
            { canonical: '慕海棠', category: 'character' },
            { canonical: '沈慕微', category: 'character' },
            { canonical: '天剑宗', category: 'faction' },
        ],
    };
    const report = buildReport({
        registry,
        libraryNames: [
            { name: '幕海棠', prompt: '1girl, (best quality:1.4)' },
            { name: '沈慕微', prompt: '1girl, masterpiece' },
        ],
        cgNames: ['慕海棠', '沈慕微', '林雪鹿'],
    });

    const kinds = report.findings.map((f) => f.kind);
    ok('reports the library/worldbook mismatch', kinds.includes('name-mismatch'));
    ok('reports a CG character absent from the library', kinds.includes('cg-without-library'));
    ok('reports dead weight syntax', kinds.includes('dead-weight-syntax'));
    ok('factions are not treated as cast', !report.findings.some((f) => f.detail?.name === '天剑宗'));

    const mismatch = report.findings.find((f) => f.kind === 'name-mismatch');
    check('mismatch names the right pair', [mismatch.detail.library, mismatch.detail.worldbook], ['幕海棠', '慕海棠']);
    ok('mismatch offers an unambiguous fix', mismatch.fix?.action === 'rename-library-entry');
    check('mismatch is high severity', mismatch.severity, 'high');

    const missing = report.findings.filter((f) => f.kind === 'cg-without-library');
    check('only 林雪鹿 is missing from the library', missing.map((f) => f.detail.name), ['林雪鹿']);
    ok('counts are tallied', report.counts.total === report.findings.length && report.counts.high >= 1);
}

check('extractCgNames reads [mvu_plot] titles',
    extractCgNames({ entries: {
        1: { comment: '[mvu_plot]沈慕微CG触发', key: ['沈慕微'] },
        2: { comment: '【人设】沈慕微', key: ['沈慕微'] },
        3: { comment: '[mvu_plot]慕海棠CG触发', key: ['慕海棠'] },
    } }),
    ['沈慕微', '慕海棠']);

/* ================================================================== *
 * Uncertain display policy — asked, not guessed
 * ================================================================== */
{
    const batch = parseClassificationBatch(`[
      {"uid": 41, "category": "location", "display_en": "Guixu", "displayPolicy": "en", "policy_uncertain": true},
      {"uid": 8,  "category": "character", "display_en": "Shen Muwei", "displayPolicy": "en", "policy_uncertain": false},
      {"uid": 12, "category": "faction", "display_en": "Heavenly Sword Sect", "displayPolicy": "zh"}
    ]`);
    ok('归墟-class name is flagged uncertain', batch.find((b) => b.uid === 41).policyUncertain);
    ok('a clear phonetic name is not flagged', !batch.find((b) => b.uid === 8).policyUncertain);
    ok('a missing flag defaults to certain', !batch.find((b) => b.uid === 12).policyUncertain);
}
check('the older concept_en field name still parses',
    normalizeClassification({ uid: 1, concept_en: ['legacy phrase'] }).key_en, ['legacy phrase']);
ok('camelCase spelling of the flag is also accepted',
    normalizeClassification({ uid: 1, policyUncertain: true }).policyUncertain);

console.log(lines.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
