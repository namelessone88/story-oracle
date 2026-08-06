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
const { buildCardHtml, bindHover, showCardFor } = await import('../tooltip.js');

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

/* ---------------- highlighting (rendering off — pure underline pass) ---------------- */
{
    toggles = { ...DEFAULT_TOGGLES, renderNames: false };
    runtime.refresh();
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
    toggles = { ...DEFAULT_TOGGLES };
    runtime.refresh();
}
{
    // 红 (single hanzi) untouched; 苍玄界 renders (renderMap) but is not
    // underlined — the underline test lives in the rendering section.
    const mes = message('<p>她穿着红色的衣服。</p>');
    runtime.passMessage(mes);
    check('single-hanzi name untouched',
        mes.querySelector('.mes_text').innerHTML, '<p>她穿着红色的衣服。</p>');
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
    // Both toggles off → refresh strips everything and stays clean.
    const source = '<p>传送阵在东海。</p>';
    const mes = message(source);
    runtime.passMessage(mes);
    ok('decorated while on', mes.querySelectorAll('.lb-span').length > 0);

    toggles = { ...DEFAULT_TOGGLES, highlight: false, renderNames: false };
    runtime.refresh();
    check('toggles off restore the source', document.querySelector('.mes_text').innerHTML, source);

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

/* ---------------- name rendering ---------------- */
{
    toggles = { ...DEFAULT_TOGGLES };
    runtime.refresh();
    const mes = message('<p>沈慕微用传送阵抵达东海海域。</p>');
    runtime.passMessage(mes);
    const host = mes.querySelector('.mes_text');
    check('names render as English, triggers stay Chinese',
        host.textContent, 'Shen Muwei用传送阵抵达East Sea Waters。');
    const muwei = [...host.querySelectorAll('.lb-span')].find((s) => s.dataset.lbOrig === '沈慕微');
    ok('renamed span keeps its trigger underline', muwei.classList.contains('lb-hl') && muwei.classList.contains('lb-name'));
    check('original preserved for strip/hover', muwei.dataset.lbOrig, '沈慕微');

    stripIn(host);
    check('strip restores the Chinese exactly', host.innerHTML, '<p>沈慕微用传送阵抵达东海海域。</p>');
}
{
    // Longest-first protects longer names from partial renames: 归墟潮眼 has no
    // render pair, so it must NOT become "Guixu潮眼".
    const mes = message('<p>归墟潮眼在归墟之南。</p>');
    runtime.passMessage(mes);
    check('no partial rename inside a longer name',
        mes.querySelector('.mes_text').textContent, '归墟潮眼在Guixu之南。');
}
{
    // A blue entry's name renders even though it never highlights.
    const mes = message('<p>这里是苍玄界。</p>');
    runtime.passMessage(mes);
    const host = mes.querySelector('.mes_text');
    check('blue-entry name renders', host.textContent, '这里是Cangxuan Realm。');
    const span = host.querySelector('.lb-span');
    ok('…without a trigger underline', span.classList.contains('lb-name') && !span.classList.contains('lb-hl'));
}
{
    // renderNames off → Chinese everywhere, triggers still underlined.
    toggles = { ...DEFAULT_TOGGLES, renderNames: false };
    runtime.refresh();
    const mes = message('<p>沈慕微在东海。</p>');
    runtime.passMessage(mes);
    check('toggle off keeps Chinese', mes.querySelector('.mes_text').textContent, '沈慕微在东海。');
    ok('triggers still underlined', mes.querySelectorAll('.lb-hl').length > 0);
    toggles = { ...DEFAULT_TOGGLES };
    runtime.refresh();
}
{
    // User messages are never renamed even with rendering on.
    toggles = { ...DEFAULT_TOGGLES, highlightUserMessages: true };
    runtime.refresh();
    const mes = message('<p>沈慕微在哪？</p>', { isUser: true });
    runtime.passMessage(mes);
    check('user text never renamed', mes.querySelector('.mes_text').textContent, '沈慕微在哪？');
    toggles = { ...DEFAULT_TOGGLES };
    runtime.refresh();
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
    {
        // Card for a RENAMED span leads with the Chinese original.
        const mes2 = message('<p>沈慕微。</p>');
        runtime.passMessage(mes2);
        const renamed = mes2.querySelector('.lb-span');
        const cardHtml = buildCardHtml(REG, renamed);
        ok('renamed card shows the Chinese original', cardHtml.includes('沈慕微'));
        ok('…and the English form', cardHtml.includes('Shen Muwei'));
    }
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

/* ---------------- in-card 中文/English switch ---------------- */
{
    toggles = { ...DEFAULT_TOGGLES };
    runtime.refresh();
    const mes = message('<p>沈慕微。</p>');
    runtime.passMessage(mes);
    const span = mes.querySelector('.lb-span');
    const html = buildCardHtml(REG, span);
    ok('card offers both concrete forms as a switch',
        html.includes('lb-tt-sw') && html.includes('>沈慕微</button>') && html.includes('>Shen Muwei</button>'));
    ok('active side is the English one (pair is on)',
        /data-lb-sw-on="1"[^>]*>Shen Muwei/.test(html.replace(/class="[^"]*lb-on[^"]*" data-lb-sw-on="1"/, 'data-lb-sw-on="1"'))
        && html.includes('lb-on'));

    // A plain concept word gets no switch — concepts are never renamed.
    const mes2 = message('<p>传送阵。</p>');
    runtime.passMessage(mes2);
    ok('concept card has no switch', !buildCardHtml(REG, mes2.querySelector('.lb-span')).includes('lb-tt-sw'));
}
{
    // Full click-through: show the card, click the 中文 side, and the persist
    // callback must receive (zh, false).
    const calls = [];
    const mes = message('<p>沈慕微。</p>');
    runtime.passMessage(mes);
    bindHover(mes.querySelector('.mes_text'), () => REG, {
        onSetRenderOn: (zh, on) => calls.push([zh, on]),
    });
    showCardFor(REG, mes.querySelector('.lb-span'));
    const card = document.getElementById('lb-tooltip-host');
    ok('card is visible', card && !card.hidden);
    const zhButton = card.querySelector('.lb-tt-sw-btn[data-lb-sw-on="0"]');
    zhButton.dispatchEvent(new window.Event('click', { bubbles: true }));
    check('clicking 中文 persists on:false', calls, [['沈慕微', false]]);
    ok('card closes after the flip (the prose flipping is the feedback)', card.hidden);
}
{
    // Off pair shows 中文 as the active side.
    const offReg = normalizeRegistry({
        ...REG, renderMap: { ...REG.renderMap, 沈慕微: { en: 'Shen Muwei', on: false } },
    }, 'B');
    const mes = message('<p>沈慕微。</p>');
    // With the pair off, the name still highlights (it is a trigger key) so a
    // span exists to hover — that is what makes flipping BACK possible in chat.
    const offRuntime = new DisplayRuntime({ getRegistry: () => offReg, getToggles: () => ({ ...DEFAULT_TOGGLES }) });
    offRuntime.passMessage(mes);
    const span = mes.querySelector('.lb-span');
    ok('off pair still leaves a hoverable span', !!span);
    check('…showing Chinese', span.textContent, '沈慕微');
    const html = buildCardHtml(offReg, span);
    ok('switch marks 中文 as active when pair is off',
        /lb-on[^>]*data-lb-sw-on="0"|data-lb-sw-on="0"[^>]*lb-on/.test(html) || html.includes('lb-on" data-lb-sw-on="0"'));
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
