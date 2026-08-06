/**
 * LangBridge — display-runtime DOM tests (jsdom).
 *
 * Covers the invariants that only exist once there is a DOM:
 *   I1  the rendered text changes but the SOURCE string never does
 *   idempotency — a second pass is a no-op, spans never nest
 *   reversibility — strip() restores the DOM byte-for-byte
 *   skip-list — code/structured containers are never rewritten
 *
 * Requires jsdom. Run:
 *   NODE_PATH=<scratchpad>/node_modules node langbridge/test/dom.test.mjs
 * (see run-tests.sh)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// jsdom is a dev-only dependency and is not vendored. Resolve it normally when
// installed; otherwise accept an explicit path via LB_JSDOM (ESM ignores
// NODE_PATH). Missing entirely → skip rather than fail, so the DOM suite never
// blocks the pure suites in an environment without it.
let JSDOM = null;
try {
    ({ JSDOM } = await import('jsdom'));
} catch {
    const override = process.env.LB_JSDOM;
    if (override) {
        try {
            ({ JSDOM } = await import(pathToFileURL(join(override, 'jsdom/lib/api.js')).href));
        } catch (e) { /* reported below */ }
    }
}
if (!JSDOM) {
    console.log('  skip  DOM suite — jsdom not available (npm i jsdom, or set LB_JSDOM=<node_modules path>)');
    process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));

const dom = new JSDOM('<!doctype html><html><body><div id="chat"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.DocumentFragment = dom.window.DocumentFragment;

const { DisplayRuntime, stripIn, collectTextNodes } = await import('../runtime.js');
const { normalizeRegistry, DEFAULT_TOGGLES } = await import('../registry.js');

const REG = normalizeRegistry(JSON.parse(readFileSync(join(here, '..', 'sample-registry.json'), 'utf8')));

let pass = 0, fail = 0;
const lines = [];
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; lines.push(`  ok   ${name}`); }
    else { fail++; lines.push(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

const chat = document.getElementById('chat');
let toggles = { ...DEFAULT_TOGGLES };
const runtime = new DisplayRuntime({
    getRegistry: () => REG,
    getToggles: () => toggles,
});

/** Build a message element the way SillyTavern does. */
function message(html, { isUser = false, id = 0 } = {}) {
    chat.innerHTML = '';
    const mes = document.createElement('div');
    mes.className = 'mes';
    mes.setAttribute('mesid', String(id));
    mes.setAttribute('is_user', String(isUser));
    mes.innerHTML = `<div class="mes_block"><div class="mes_text">${html}</div></div>`;
    chat.appendChild(mes);
    return mes;
}

/* ---------------------------------------------------------------- *
 * Rendering
 * ---------------------------------------------------------------- */
{
    const source = '<p>沈慕微抬起头，望向东海海域。</p>';
    const mes = message(source);
    runtime.passMessage(mes);
    const text = mes.querySelector('.mes_text').textContent;
    check('zh name is rendered as English', text, 'Shen Muwei抬起头，望向East Sea Waters。');

    const span = mes.querySelector('.lb-name');
    check('canonical is preserved on the span', span.dataset.lbCanonical, '沈慕微');
    check('original text is preserved for strip', span.dataset.lbOrig, '沈慕微');
    ok('renamed span carries entity id', span.dataset.lbEntity === 'shen-muwei');
}
{
    // Concepts are highlighted but NEVER renamed.
    const mes = message('<p>他问起传送阵的价钱。</p>');
    runtime.passMessage(mes);
    check('concept text is unchanged', mes.querySelector('.mes_text').textContent, '他问起传送阵的价钱。');
    const span = mes.querySelector('.lb-span');
    ok('concept span is highlight-only', span.classList.contains('lb-hl') && !span.classList.contains('lb-name'));
    check('concept index recorded', span.dataset.lbConcept, '0');
}
{
    // zh-policy entity: highlighted, not renamed.
    const mes = message('<p>天剑宗的弟子。</p>');
    runtime.passMessage(mes);
    check('zh-policy name not renamed', mes.querySelector('.mes_text').textContent, '天剑宗的弟子。');
    ok('zh-policy name still highlighted', !!mes.querySelector('.lb-hl'));
}
{
    // 红 must be untouched by default (acceptance test 6).
    const mes = message('<p>她换上红色的外袍。</p>');
    runtime.passMessage(mes);
    check('单字名 leaves prose alone', mes.querySelector('.mes_text').innerHTML, '<p>她换上红色的外袍。</p>');
}

/* ---------------------------------------------------------------- *
 * Idempotency + reversibility  (risk R5)
 * ---------------------------------------------------------------- */
{
    const source = '<p>沈慕微与慕海棠在东海相遇，谈起传送阵。</p>';
    const mes = message(source);

    runtime.passMessage(mes);
    const afterFirst = mes.querySelector('.mes_text').innerHTML;
    const spanCount = mes.querySelectorAll('.lb-span').length;

    runtime.passMessage(mes);
    runtime.passMessage(mes);
    check('second and third passes change nothing', mes.querySelector('.mes_text').innerHTML, afterFirst);
    check('span count is stable', mes.querySelectorAll('.lb-span').length, spanCount);
    check('spans never nest', mes.querySelectorAll('.lb-span .lb-span').length, 0);

    stripIn(mes.querySelector('.mes_text'));
    check('strip restores the DOM exactly', mes.querySelector('.mes_text').innerHTML, '<p>沈慕微与慕海棠在东海相遇，谈起传送阵。</p>');
}
{
    // A forced re-pass after a toggle change must also round-trip cleanly.
    const source = '<p>沈慕微走向归墟潮眼。</p>';
    const mes = message(source);
    runtime.passMessage(mes);
    ok('rendered with characters=EN', mes.querySelector('.mes_text').textContent.startsWith('Shen Muwei'));

    toggles = { ...DEFAULT_TOGGLES, renderCharacters: false };
    runtime.refresh();
    const flipped = document.querySelector('.mes_text').textContent;
    check('toggling to ZH flips it back in place', flipped, '沈慕微走向Guixu Tide Eye。');

    toggles = { ...DEFAULT_TOGGLES };
    runtime.refresh();
    check('toggling back restores English', document.querySelector('.mes_text').textContent, 'Shen Muwei走向Guixu Tide Eye。');
}

/* ---------------------------------------------------------------- *
 * Skip list  (I1 defense in depth)
 * ---------------------------------------------------------------- */
{
    const mes = message('<p>沈慕微说：</p><code>沈慕微</code><pre>东海</pre>');
    runtime.passMessage(mes);
    check('code is untouched', mes.querySelector('code').textContent, '沈慕微');
    check('pre is untouched', mes.querySelector('pre').textContent, '东海');
    ok('prose outside code is still rendered', mes.querySelector('p').textContent.includes('Shen Muwei'));
}
{
    // Structured extension regions (MVU / status bar / draw images).
    const mes = message('<p>东海</p><div class="mvu-status">东海 HP:80</div>');
    runtime.passMessage(mes);
    check('structured region is untouched', mes.querySelector('.mvu-status').textContent, '东海 HP:80');
    ok('normal prose still decorated', !!mes.querySelector('p .lb-span'));
}
{
    // <插图> is already an <img> post-render; its attributes must not be touched.
    const mes = message('<p>沈慕微</p><img src="x.png" alt="沈慕微-温泉" class="mes_img">');
    runtime.passMessage(mes);
    check('image alt/src untouched', mes.querySelector('img').getAttribute('alt'), '沈慕微-温泉');
}

/* ---------------------------------------------------------------- *
 * User messages
 * ---------------------------------------------------------------- */
{
    toggles = { ...DEFAULT_TOGGLES, highlightUserMessages: false };
    const mes = message('<p>How much does the teleport array cost?</p>', { isUser: true });
    runtime.passMessage(mes);
    check('user message untouched by default', mes.querySelector('.mes_text').innerHTML,
        '<p>How much does the teleport array cost?</p>');

    toggles = { ...DEFAULT_TOGGLES, highlightUserMessages: true };
    runtime.refresh();
    const el = document.querySelector('.mes_text');
    ok('typed English lights up when enabled', !!el.querySelector('.lb-span'));
    check('typed English is highlighted, never renamed', el.textContent,
        'How much does the teleport array cost?');
}
{
    // Drift detection: unanticipated phrasing lights nothing up.
    toggles = { ...DEFAULT_TOGGLES, highlightUserMessages: true };
    const mes = message('<p>how much for a warp gate?</p>', { isUser: true });
    runtime.passMessage(mes);
    check('unknown phrasing produces no spans', mes.querySelectorAll('.lb-span').length, 0);
}

/* ---------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------- */
{
    toggles = { ...DEFAULT_TOGGLES };
    const mes = message('<p>沈慕微</p><code>x</code>');
    const nodes = collectTextNodes(mes.querySelector('.mes_text'));
    check('collectTextNodes skips code', nodes.map((n) => n.nodeValue), ['沈慕微']);
}
{
    const mes = message('<p>无名之辈走过。</p>');
    runtime.passMessage(mes);
    check('no matches leaves DOM identical', mes.querySelector('.mes_text').innerHTML, '<p>无名之辈走过。</p>');
}

console.log(lines.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
