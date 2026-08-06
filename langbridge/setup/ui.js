/**
 * LangBridge — Setup Pass + consistency report UI.
 *
 * A floating panel (appended to <body>, not into #chat) that runs the pass,
 * shows exactly what WOULD be written, and only writes when the user approves.
 * Nothing here mutates a worldbook before that click.
 */

import {
    getContext, listConnectionProfiles, hasSetupTransport, loadBook,
    fingerprintBook, toast, confirmPopup, LOG,
} from '../host.js';
import { runSetupPass, applyPlan } from './pass.js';
import { buildReport, extractCgNames } from './report.js';
import { pendingDecisions, decisionRowsHtml, bindDecisionRows, applyDecision } from '../decisions.js';

const PANEL_ID = 'lb-setup';
let panel = null;
let controller = null;
let state = null;      // { bookName, bookData, result }
let cache = {};        // entry-hash → classification, survives re-runs in this session

/* ------------------------------------------------------------------ *
 * Reading the draw library (defensive — its storage shape is unverified)
 * ------------------------------------------------------------------ */

/**
 * Best-effort read of a drawing extension's character library.
 * Returns [{name, prompt}]. Unknown shape → [] and the report says so rather
 * than guessing; LangBridge never writes here in this version.
 */
export function readDrawLibrary(extensionSettings) {
    const settings = extensionSettings || {};
    const found = [];

    const harvest = (value) => {
        if (!Array.isArray(value)) return;
        for (const item of value) {
            if (!item || typeof item !== 'object') continue;
            const name = String(item.name || item.char || item.character || '').trim();
            if (!name) continue;
            const prompt = String(item.prompt || item.tags || item.positive || item.desc || '');
            found.push({ name, prompt });
        }
    };

    for (const [key, value] of Object.entries(settings)) {
        if (!value || typeof value !== 'object') continue;
        if (!/white|draw|novel|image|画|绘/i.test(key)) continue;
        harvest(value);
        harvest(value.characters);
        harvest(value.characterList);
        harvest(value.library);
        harvest(value.list);
    }

    const seen = new Set();
    return found.filter((item) => {
        if (seen.has(item.name)) return false;
        seen.add(item.name);
        return true;
    });
}

/** Most recent AI message text — a real sample for the collision screen. */
function sampleAiReply() {
    const chat = getContext()?.chat;
    if (!Array.isArray(chat)) return '';
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message && !message.is_user && typeof message.mes === 'string' && message.mes.trim()) {
            return message.mes.slice(0, 20000);
        }
    }
    return '';
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

function ensurePanel(deps) {
    if (panel && panel.isConnected) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'lb-modal';
    panel.innerHTML = `
      <div class="lb-modal-card">
        <div class="lb-modal-head">
          <span class="lb-modal-title">⚙️ 自动设置 · <span class="lb-setup-book"></span></span>
          <div class="lb-modal-x" title="关闭">✕</div>
        </div>
        <div class="lb-modal-body">
          <div class="lb-hint">
            读一遍世界书，判断每个条目是人物 / 地点 / 势力 / 概念，给名字生成拼音，
            并为条目<b>补上英文触发词</b>（只新增，绝不改动作者原有的词和设置）。
            <b>写入前会先让你看清楚要写什么。</b>
          </div>
          <div class="lb-row">
            <label class="lb-label" for="lb-setup-profile">生成通道</label>
            <select id="lb-setup-profile" class="text_pole"></select>
          </div>
          <div class="lb-row">
            <button type="button" id="lb-setup-run" class="menu_button">开始分析</button>
            <button type="button" id="lb-setup-stop" class="menu_button" hidden>停止</button>
            <button type="button" id="lb-setup-report" class="menu_button">只看一致性报告</button>
          </div>
          <div id="lb-setup-progress" class="lb-status"></div>
          <div id="lb-setup-result"></div>
        </div>
        <div class="lb-modal-foot">
          <button type="button" id="lb-setup-apply" class="menu_button" disabled>写入世界书</button>
          <span class="lb-hint">写入 = 只往条目的触发词列表里<b>追加</b>英文词</span>
        </div>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector('.lb-modal-x').addEventListener('click', close);
    panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
    panel.querySelector('#lb-setup-run').addEventListener('click', () => run(deps));
    panel.querySelector('#lb-setup-stop').addEventListener('click', () => controller?.abort());
    panel.querySelector('#lb-setup-report').addEventListener('click', () => showReportOnly(deps));
    panel.querySelector('#lb-setup-apply').addEventListener('click', () => apply(deps));

    return panel;
}

export function openSetupPanel(deps) {
    const bookName = deps.getBookName();
    if (!bookName) { toast('warning', '请先选择一本世界书。'); return; }

    ensurePanel(deps);
    panel.querySelector('.lb-setup-book').textContent = bookName;

    const select = panel.querySelector('#lb-setup-profile');
    const profiles = listConnectionProfiles();
    select.innerHTML = '<option value="">跟随主 API</option>' +
        profiles.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

    const progress = panel.querySelector('#lb-setup-progress');
    progress.textContent = hasSetupTransport()
        ? '' : '找不到可用的生成通道——请选一个连接配置档，或使用支持 generateRaw 的 SillyTavern。';
    panel.querySelector('#lb-setup-result').innerHTML = '';
    panel.querySelector('#lb-setup-apply').disabled = true;
    state = null;
    panel.classList.add('open');
}

function close() {
    controller?.abort();
    panel?.classList.remove('open');
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

async function run(deps) {
    const bookName = deps.getBookName();
    const runBtn = panel.querySelector('#lb-setup-run');
    const stopBtn = panel.querySelector('#lb-setup-stop');
    const progress = panel.querySelector('#lb-setup-progress');
    const result = panel.querySelector('#lb-setup-result');

    const bookData = await loadBook(bookName);
    if (!bookData?.entries) { toast('error', '读不到世界书内容。'); return; }

    controller = new AbortController();
    runBtn.disabled = true;
    stopBtn.hidden = false;
    result.innerHTML = '';
    panel.querySelector('#lb-setup-apply').disabled = true;

    try {
        const outcome = await runSetupPass(bookName, bookData, deps.getRegistry(), {
            profileId: panel.querySelector('#lb-setup-profile').value,
            signal: controller.signal,
            sampleReply: sampleAiReply(),
            cache,
            onProgress: ({ done, total, cachedCount, batchSize }) => {
                progress.textContent = total
                    ? `分析中… ${done}/${total} 批（每批约 ${batchSize} 条）${cachedCount ? `，${cachedCount} 条走缓存` : ''}`
                    : '没有需要分析的新条目（全部命中缓存）。';
            },
        });

        cache = outcome.cache;
        state = { bookName, bookData, result: outcome };
        progress.textContent = `分析完成：${outcome.stats.entries} 个条目，识别 ${outcome.stats.classified} 个`
            + `（每批 ${outcome.stats.batchSize} 条）。`;
        renderResult(deps, outcome, bookData);
        panel.querySelector('#lb-setup-apply').disabled = outcome.stats.keys === 0;
    } catch (e) {
        if (e?.name === 'AbortError') {
            progress.textContent = '已停止——世界书未被修改。';
        } else {
            console.warn(LOG, 'setup pass failed', e);
            progress.textContent = '分析失败：' + (e?.message || e);
        }
    } finally {
        runBtn.disabled = false;
        stopBtn.hidden = true;
        controller = null;
    }
}

function renderResult(deps, outcome, bookData) {
    const { plan, stats, failedBatches } = outcome;
    const parts = [];

    // Names the classifier could not settle (归墟-class: a proper noun that also
    // means something). Asked, not guessed — and answerable right here.
    const pending = pendingDecisions(outcome.registry);
    if (pending.length) {
        parts.push(`<div class="lb-section">需要你决定（${pending.length}）</div>
          <div class="lb-hint">这些名字<b>两种显示方式都说得通</b>，AI 不替你拍板。
          点一下选中文或英文——之后随时可以在「🈳 名称显示」里改。</div>
          <div id="lb-setup-decide">${decisionRowsHtml(pending)}</div>`);
    }

    parts.push(`<div class="lb-section">将写入</div>
      <div class="lb-status">往 <b>${stats.entries}</b> 个条目追加 <b>${stats.keys}</b> 个英文触发词。
      作者原有的触发词、条目设置、正文一律不动。</div>`);

    const rows = Object.entries(plan.writes).slice(0, 40).map(([uid, keys]) => {
        const title = String(bookData.entries[uid]?.comment || `条目 #${uid}`);
        return `<div class="lb-plan-row"><span class="lb-plan-title">${escapeHtml(title)}</span>
          ${keys.map((k) => `<span class="lb-tt-key">${escapeHtml(k)}</span>`).join('')}</div>`;
    });
    if (rows.length) parts.push(`<div class="lb-plan">${rows.join('')}</div>`);
    if (Object.keys(plan.writes).length > 40) {
        parts.push(`<div class="lb-hint">（只列出前 40 个条目，其余同样会写入）</div>`);
    }

    if (plan.flagged.length) {
        parts.push(`<div class="lb-section">需要你手动决定（${plan.flagged.length}）</div>
          <div class="lb-hint">这些条目用了「次要关键词」(AND 逻辑)，自动加英文词可能改变触发时机，所以<b>跳过不写</b>：</div>
          <div class="lb-plan">${plan.flagged.slice(0, 20).map((f) =>
            `<div class="lb-plan-row"><span class="lb-plan-title">${escapeHtml(f.title)}</span>
             <span class="lb-hint">建议词：${f.proposed.map(escapeHtml).join('、')}</span></div>`).join('')}</div>`);
    }

    if (plan.skipped?.length) {
        parts.push(`<div class="lb-section">跳过的条目（${plan.skipped.length}）</div>
          <div class="lb-hint">这些条目加英文触发词没有意义，所以不写：</div>
          <div class="lb-plan">${plan.skipped.slice(0, 15).map((sk) =>
            `<div class="lb-plan-row"><span class="lb-plan-title">${escapeHtml(sk.title)}</span>
             <span class="lb-hint">${escapeHtml(sk.reason)}</span></div>`).join('')}</div>`);
    }

    if (plan.rejected.length) {
        const shown = plan.rejected.slice(0, 15);
        parts.push(`<div class="lb-section">已挡掉的词（${plan.rejected.length}）</div>
          <div class="lb-hint">这些英文词会撞上状态栏 / 变量块里的文字，留着会每回合乱触发：</div>
          <div class="lb-plan">${shown.map((r) =>
            `<div class="lb-plan-row"><span class="lb-tt-key">${escapeHtml(r.key)}</span>
             <span class="lb-hint">${escapeHtml(reasonText(r.reason))}</span></div>`).join('')}</div>`);
    }

    if (failedBatches.length) {
        parts.push(`<div class="lb-section">没读懂的批次（${failedBatches.length}）</div>
          <div class="lb-hint">这些条目没被识别，可以再跑一次（已识别的会走缓存，不重复花钱）：
          ${failedBatches.map((b) => escapeHtml(b.reason)).slice(0, 3).join('；')}</div>`);
    }

    parts.push(renderReportHtml(deps, outcome.registry, bookData));
    panel.querySelector('#lb-setup-result').innerHTML = parts.join('');

    // Decisions apply to the in-flight result immediately; they are persisted
    // with the rest of the registry when the plan is written.
    const decide = panel.querySelector('#lb-setup-decide');
    if (decide) {
        bindDecisionRows(decide, (entityId, policy) => {
            state.result.registry = applyDecision(state.result.registry, entityId, policy);
            renderResult(deps, state.result, bookData);
        });
    }
}

function reasonText(reason) {
    return {
        'code-vocabulary': '是通用代码/界面词',
        'appears-in-machinery': '这张卡的状态栏或变量块里就有这个词',
        'too-short': '太短，容易误撞',
        'markup-characters': '含有标记符号',
        'no-letters': '没有英文字母',
        blocklisted: '在你的屏蔽名单里',
        empty: '空的',
    }[reason] || reason;
}

/* ------------------------------------------------------------------ *
 * Consistency report
 * ------------------------------------------------------------------ */

function renderReportHtml(deps, registry, bookData) {
    const library = readDrawLibrary(getContext()?.extensionSettings);
    const report = buildReport({
        registry,
        libraryNames: library,
        cgNames: extractCgNames(bookData),
    });

    if (!report.findings.length) {
        return `<div class="lb-section">一致性检查</div><div class="lb-status">没发现问题${
            library.length ? '' : '（没找到绘图库，跳过了图片相关检查）'}。</div>`;
    }

    const order = { high: 0, medium: 1, low: 2 };
    const findings = report.findings.slice().sort((a, b) => order[a.severity] - order[b.severity]);
    const shown = findings.slice(0, 25);

    return `<div class="lb-section">一致性检查（${report.counts.high} 严重 / ${report.counts.medium} 中等 / ${report.counts.low} 提示）</div>
      ${library.length ? '' : '<div class="lb-hint">没识别到绘图库的存储格式，图片相关的检查已跳过。</div>'}
      <div class="lb-plan">${shown.map((f) =>
        `<div class="lb-plan-row lb-sev-${f.severity}">${escapeHtml(f.message)}</div>`).join('')}</div>
      ${findings.length > shown.length ? `<div class="lb-hint">（还有 ${findings.length - shown.length} 条未显示）</div>` : ''}
      <div class="lb-hint">这里只报告，不会自动改任何东西——名字该以哪边为准由你决定。</div>`;
}

async function showReportOnly(deps) {
    const bookName = deps.getBookName();
    const bookData = await loadBook(bookName);
    if (!bookData?.entries) { toast('error', '读不到世界书内容。'); return; }
    panel.querySelector('#lb-setup-result').innerHTML =
        renderReportHtml(deps, deps.getRegistry() || { entities: [] }, bookData);
}

/* ------------------------------------------------------------------ *
 * Apply
 * ------------------------------------------------------------------ */

async function apply(deps) {
    if (!state?.result) return;
    const { bookName, bookData, result } = state;
    const count = result.stats.keys;

    const okToWrite = await confirmPopup(
        `将往「${bookName}」的 ${result.stats.entries} 个条目追加 ${count} 个英文触发词。\n\n` +
        '只新增，不会改动或删除作者原有的任何内容。确定吗？');
    if (!okToWrite) return;

    const button = panel.querySelector('#lb-setup-apply');
    button.disabled = true;
    try {
        const outcome = await applyPlan(bookName, result.registry, result.plan, fingerprintBook(bookData));
        if (!outcome.ok) {
            toast('error', '写入失败：' + outcome.reason);
            panel.querySelector('#lb-setup-progress').textContent = '写入失败：' + outcome.reason;
            button.disabled = false;
            return;
        }
        deps.saveRegistry(outcome.registry);
        panel.querySelector('#lb-setup-progress').innerHTML =
            `已写入 <b>${outcome.written}</b> 个英文触发词，名称登记表已更新。` +
            '<br><span class="lb-hint">若新词这一轮还不生效，切换一次聊天再回来即可。</span>';
        toast('success', `已写入 ${outcome.written} 个触发词。`);
    } catch (e) {
        console.warn(LOG, 'apply failed', e);
        toast('error', '写入失败：' + (e?.message || e));
        button.disabled = false;
    }
}

function escapeHtml(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
