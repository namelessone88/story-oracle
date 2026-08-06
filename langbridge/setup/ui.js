/**
 * LangBridge — translation pass UI.
 *
 * A floating panel that runs the pass, shows exactly what WOULD be written,
 * and only writes when the user approves. Nothing mutates a worldbook before
 * that click.
 */

import {
    getContext, listConnectionProfiles, hasSetupTransport, loadBook,
    fingerprintBook, toast, confirmPopup, LOG,
} from '../host.js';
import { runSetupPass, applyPlan } from './pass.js';

const PANEL_ID = 'lb-setup';
let panel = null;
let controller = null;
let state = null;      // { bookName, bookData, result }
let cache = {};        // entry-hash → translation, survives re-runs this session

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

function ensurePanel(deps) {
    if (panel && panel.isConnected) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'lb-modal';
    panel.innerHTML = `
      <div class="lb-modal-card">
        <div class="lb-modal-head">
          <span class="lb-modal-title">⚙️ 翻译触发词 · <span class="lb-setup-book"></span></span>
          <div class="lb-modal-x" title="关闭">✕</div>
        </div>
        <div class="lb-modal-body">
          <div class="lb-hint">
            把<b>绿灯条目</b>现有的中文触发词逐个翻成英文，作为额外触发词追加进世界书——
            以后打英文也能触发。原有中文词一个不删、一个不改；蓝灯常驻条目本来就每回合注入，自动跳过。
            <b>写入前会先让你看清楚要写什么。</b>
          </div>
          <div class="lb-row">
            <label class="lb-label" for="lb-setup-profile">生成通道</label>
            <select id="lb-setup-profile" class="text_pole"></select>
          </div>
          <div class="lb-row">
            <button type="button" id="lb-setup-run" class="menu_button">开始翻译</button>
            <button type="button" id="lb-setup-stop" class="menu_button" hidden>停止</button>
          </div>
          <div id="lb-setup-progress" class="lb-status"></div>
          <div id="lb-setup-result"></div>
        </div>
        <div class="lb-modal-foot">
          <button type="button" id="lb-setup-apply" class="menu_button" disabled>写入世界书</button>
          <span class="lb-hint">写入 = 只往触发词列表里<b>追加</b>英文词</span>
        </div>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector('.lb-modal-x').addEventListener('click', close);
    panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
    panel.querySelector('#lb-setup-run').addEventListener('click', () => run(deps));
    panel.querySelector('#lb-setup-stop').addEventListener('click', () => controller?.abort());
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

    panel.querySelector('#lb-setup-progress').textContent = hasSetupTransport()
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

async function run(deps) {
    const bookName = deps.getBookName();
    const runBtn = panel.querySelector('#lb-setup-run');
    const stopBtn = panel.querySelector('#lb-setup-stop');
    const progress = panel.querySelector('#lb-setup-progress');

    const bookData = await loadBook(bookName);
    if (!bookData?.entries) { toast('error', '读不到世界书内容。'); return; }

    controller = new AbortController();
    runBtn.disabled = true;
    stopBtn.hidden = false;
    panel.querySelector('#lb-setup-result').innerHTML = '';
    panel.querySelector('#lb-setup-apply').disabled = true;

    try {
        const outcome = await runSetupPass(bookName, bookData, deps.getRegistry(), {
            profileId: panel.querySelector('#lb-setup-profile').value,
            signal: controller.signal,
            sampleReply: sampleAiReply(),
            cache,
            onProgress: ({ done, total, cachedCount, batchSize }) => {
                progress.textContent = total
                    ? `翻译中… ${done}/${total} 批（每批约 ${batchSize} 条）${cachedCount ? `，${cachedCount} 条走缓存` : ''}`
                    : '没有需要翻译的新条目（全部命中缓存）。';
            },
        });

        cache = outcome.cache;
        state = { bookName, bookData, result: outcome };
        progress.textContent = `完成：${outcome.stats.entries} 个条目，其中绿灯可翻 ${outcome.stats.translatable} 个。`;
        renderResult(outcome, bookData);
        panel.querySelector('#lb-setup-apply').disabled = outcome.stats.keys === 0;
    } catch (e) {
        if (e?.name === 'AbortError') {
            progress.textContent = '已停止——世界书未被修改。';
        } else {
            console.warn(LOG, 'translation pass failed', e);
            progress.textContent = '翻译失败：' + (e?.message || e);
        }
    } finally {
        runBtn.disabled = false;
        stopBtn.hidden = true;
        controller = null;
    }
}

function renderResult(outcome, bookData) {
    const { plan, stats, failedBatches } = outcome;
    const parts = [];

    parts.push(`<div class="lb-section">将写入</div>
      <div class="lb-status">往 <b>${stats.entries}</b> 个条目追加 <b>${stats.keys}</b> 个英文触发词。</div>`);

    const rows = Object.entries(plan.writes).slice(0, 50).map(([uid, keys]) => {
        const title = String(bookData.entries[uid]?.comment || `条目 #${uid}`);
        return `<div class="lb-plan-row"><span class="lb-plan-title">${escapeHtml(title)}</span>
          ${keys.map((k) => `<span class="lb-tt-key">${escapeHtml(k)}</span>`).join('')}</div>`;
    });
    if (rows.length) parts.push(`<div class="lb-plan">${rows.join('')}</div>`);
    if (Object.keys(plan.writes).length > 50) {
        parts.push('<div class="lb-hint">（只列出前 50 个条目，其余同样会写入）</div>');
    }

    if (plan.flagged.length) {
        parts.push(`<div class="lb-section">需要手动处理（${plan.flagged.length}）</div>
          <div class="lb-hint">这些条目用了「次要关键词」(AND 逻辑)，自动加英文词可能改变触发时机，所以<b>跳过不写</b>：</div>
          <div class="lb-plan">${plan.flagged.slice(0, 20).map((f) =>
            `<div class="lb-plan-row"><span class="lb-plan-title">${escapeHtml(f.title)}</span></div>`).join('')}</div>`);
    }

    if (plan.skipped.length) {
        parts.push(`<div class="lb-section">自动跳过（${plan.skipped.length}）</div>
          <div class="lb-plan">${plan.skipped.slice(0, 15).map((sk) =>
            `<div class="lb-plan-row"><span class="lb-plan-title">${escapeHtml(sk.title)}</span>
             <span class="lb-hint">${escapeHtml(sk.reason)}</span></div>`).join('')}</div>`);
    }

    if (plan.rejected.length) {
        parts.push(`<div class="lb-section">已挡掉的词（${plan.rejected.length}）</div>
          <div class="lb-hint">这些英文词会撞上状态栏 / 变量块里的文字，留着会每回合乱触发：</div>
          <div class="lb-plan">${plan.rejected.slice(0, 15).map((r) =>
            `<div class="lb-plan-row"><span class="lb-tt-key">${escapeHtml(r.key)}</span>
             <span class="lb-hint">${escapeHtml(reasonText(r.reason))}</span></div>`).join('')}</div>`);
    }

    if (failedBatches.length) {
        parts.push(`<div class="lb-section">没翻成的条目</div>
          <div class="lb-hint">这些条目的调用失败或返回读不懂，可以再跑一次（成功的会走缓存，不重复花钱）：
          ${failedBatches.map((b) => escapeHtml(b.reason)).slice(0, 3).join('；')}</div>`);
    }

    panel.querySelector('#lb-setup-result').innerHTML = parts.join('');
}

function reasonText(reason) {
    return {
        'code-vocabulary': '是通用代码/界面词',
        'appears-in-machinery': '这张卡的状态栏或变量块里就有这个词',
        'too-short': '太短，容易误撞',
        'markup-characters': '含有标记符号',
        'no-letters': '没有英文字母',
        blocklisted: '在屏蔽名单里',
        empty: '空的',
    }[reason] || reason;
}

async function apply(deps) {
    if (!state?.result) return;
    const { bookName, bookData, result } = state;

    const okToWrite = await confirmPopup(
        `将往「${bookName}」的 ${result.stats.entries} 个条目追加 ${result.stats.keys} 个英文触发词。\n\n` +
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
            `已写入 <b>${outcome.written}</b> 个英文触发词。` +
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
