/**
 * LangBridge — display-runtime DOM tests (jsdom).
 *
 * Covers the invariants that only exist once there is a DOM:
 *   I1  the source string never changes — spans wrap, text stays identical
 *   idempotency — a second pass is a no-op, spans never nest
 *   reversibility — strip() restores the DOM byte-for-byte
 *   skip-list — code/structured containers are never touched
 *
 * Requires jsdom (dev-only). Missing → suite skips rather than fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

let JSDOM = null;
try {
    ({ JSDOM } = await import('jsdom'));
} catch {
    const override = process.env.LB_JSDOM;
    if (override) {
        try { ({ JSDOM } = await import(pathToFileURL(join(override, 'jsdom/lib/api.js')).href)); } catch (e) { /* below */ }
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

const { DisplayRuntime, stripIn, collectTextNodes } = await import('../runtime.js');
const { normalizeRegistry, DEFAULT_TOGGLES } = await import('../registry.js');
const { buildCardHtml } = await import('../tooltip.js');

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

/* ---------------- highlighting ---------------- */
{
    const source = '<p>沈慕微用传送阵抵达东海海域。</p>';
    const mes = message(source);
    runtime.passMessage(mes);
    const host = mes.querySelector('.mes_text');
    check('visible text is UNCHANGED', host.textContent, '沈慕微用传送阵抵达东海海域。');
    check('trigger words are wrapped', [...host.querySelectorAll('.lb-span')].map((s) => s.textContent),
        ['沈慕微', '传送阵', '东海海域']);
    ok('every span carries the highlight class',
        [...host.querySelectorAll('.lb-span')].every((s) => s.classList.contains('lb-hl')));
    ok('originals preserved for strip',
        [...host.querySelectorAll('.lb-span')].every((s) => s.dataset.lbOrig === s.textContent));
}
{
    const mes = message('<p>这里是苍玄界，她穿着红色的衣服。</p>');
    runtime.passMessage(mes);
    check('blue-entry key and single-hanzi name untouched',
        mes.querySelector('.mes_text').innerHTML, '<p>这里是苍玄界，她穿着红色的衣服。</p>');
}

/* ---------------- idempotency + reversibility ---------------- */
{
    const source = '<p>沈慕微与慕海棠谈起传送阵与灵石价格。</p>';
    const mes = message(source);
    runtime.passMessage(mes);
    const afterFirst = mes.querySelector('.mes_text').innerHTML;
    const spanCount = mes.querySelectorAll('.lb-span').length;

    runtime.passMessage(mes);
    runtime.passMessage(mes);
    check('second and third passes change nothing', mes.querySelector('.mes_text').innerHTML, afterFirst);
    check('span count stable', mes.querySelectorAll('.lb-span').length, spanCount);
    check('spans never nest', mes.querySelectorAll('.lb-span .lb-span').length, 0);

    stripIn(mes.querySelector('.mes_text'));
    check('strip restores the DOM exactly', mes.querySelector('.mes_text').innerHTML, source);
}
{
    // Toggle off → refresh strips everything and stays clean.
    const source = '<p>传送阵在东海。</p>';
    const mes = message(source);
    runtime.passMessage(mes);
    ok('decorated while on', mes.querySelectorAll('.lb-span').length > 0);

    toggles = { ...DEFAULT_TOGGLES, highlight: false };
    runtime.refresh();
    check('toggle off restores the source', document.querySelector('.mes_text').innerHTML, source);

    toggles = { ...DEFAULT_TOGGLES };
    runtime.refresh();
    ok('toggle back on re-decorates', document.querySelectorAll('.lb-span').length > 0);
}

/* ---------------- skip list ---------------- */
{
    const mes = message('<p>传送阵说明：</p><code>传送阵</code><pre>东海</pre>');
    runtime.passMessage(mes);
    check('code untouched', mes.querySelector('code').innerHTML, '传送阵');
    check('pre untouched', mes.querySelector('pre').innerHTML, '东海');
    ok('prose outside code still decorated', !!mes.querySelector('p .lb-span'));
}
{
    const mes = message('<p>东海</p><div class="mvu-status">东海 HP:80</div>');
    runtime.passMessage(mes);
    check('structured region untouched', mes.querySelector('.mvu-status').innerHTML, '东海 HP:80');
}
{
    const mes = message('<p>沈慕微</p><img src="x.png" alt="沈慕微-温泉" class="mes_img">');
    runtime.passMessage(mes);
    check('image alt/src untouched', mes.querySelector('img').getAttribute('alt'), '沈慕微-温泉');
}

/* ---------------- user messages ---------------- */
{
    toggles = { ...DEFAULT_TOGGLES, highlightUserMessages: false };
    runtime.refresh();
    const mes = message('<p>How much does the teleport array cost?</p>', { isUser: true });
    runtime.passMessage(mes);
    check('user message untouched by default', mes.querySelector('.mes_text').innerHTML,
        '<p>How much does the teleport array cost?</p>');

    toggles = { ...DEFAULT_TOGGLES, highlightUserMessages: true };
    runtime.refresh();
    const host = document.querySelector('.mes_text');
    check('typed English lights up when enabled',
        [...host.querySelectorAll('.lb-span')].map((s) => s.textContent), ['teleport array']);
    check('text itself unchanged', host.textContent, 'How much does the teleport array cost?');
}
{
    toggles = { ...DEFAULT_TOGGLES, highlightUserMessages: true };
    const mes = message('<p>how much for a warp gate?</p>', { isUser: true });
    runtime.passMessage(mes);
    check('unknown phrasing produces no spans (drift signal)', mes.querySelectorAll('.lb-span').length, 0);
}

/* ---------------- hover card content ---------------- */
{
    toggles = { ...DEFAULT_TOGGLES };
    runtime.refresh();
    const mes = message('<p>传送阵。</p>');
    runtime.passMessage(mes);
    const span = mes.querySelector('.lb-span');
    const html = buildCardHtml(REG, span);
    ok('card names the entry', html.includes('传送阵开销与购买力'));
    ok('card lists sibling keys', html.includes('跨域传送') && html.includes('路费'));
    ok('card shows english ways to type it', html.includes('teleport array') && html.includes('travel cost'));
    ok('card states the honest semantics', html.includes('可触发 ≠ 已注入'));
}
{
    const mes = message('<p>沈慕微。</p>');
    runtime.passMessage(mes);
    const html = buildCardHtml(REG, mes.querySelector('.lb-span'));
    ok('a shared key shows ALL its entries', html.includes('【人设】沈慕微') && html.includes('CG触发'));
}
{
    check('card for unknown span is empty', buildCardHtml(REG, null), '');
}

/* ---------------- helpers ---------------- */
{
    const mes = message('<p>传送阵</p><code>x</code>');
    const nodes = collectTextNodes(mes.querySelector('.mes_text'));
    check('collectTextNodes skips code', nodes.map((n) => n.nodeValue), ['传送阵']);
}
{
    const mes = message('<p>无名之辈走过。</p>');
    runtime.passMessage(mes);
    check('no matches leaves DOM identical', mes.querySelector('.mes_text').innerHTML, '<p>无名之辈走过。</p>');
}

console.log(lines.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
