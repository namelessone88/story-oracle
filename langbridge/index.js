/**
 * LangBridge — entry point.
 *
 * Three features:
 *   1. TRANSLATE — every entry with Chinese trigger words gains English
 *      versions, appended to the worldbook once, so typed English fires them.
 *      LLM use is confined to that one on-demand pass.
 *   2. HIGHLIGHT — trigger words are underlined in the chat, with a hover card
 *      showing what they trigger and how to type them in English.
 *   3. RENDER — names in the 名称显示 list show as English in AI replies
 *      (DOM only; storage stays Chinese; per-name switchable).
 *
 * Invariants:
 *   I1 never modifies message.mes or the chat file — DOM only
 *   I2 zero per-turn LLM calls
 *   I3 never alters an author's original worldbook keys or per-entry flags
 *   I4 no runtime input transformation (English fires WI via pre-planted keys)
 *   I5 never breaks the host — every ST touchpoint degrades
 */

import {
    getContext, getSettings, saveSettings, getRegistryFor, putRegistryFor,
    onEvents, loadBook, getActiveBookNames, getAllBookNames,
    canEditWorldInfo, toast, LOG,
} from './host.js';
import { normalizeRegistry, emptyRegistry, isSingleHanzi, DEFAULT_TOGGLES } from './registry.js';
import { refreshEntryIndex } from './setup/pass.js';
import { fingerprintBook } from './host.js';
import { DisplayRuntime } from './runtime.js';
import { bindHover, hideCard } from './tooltip.js';
import { openSetupPanel } from './setup/ui.js';

const PANEL_ID = 'lb-panel';
let runtime = null;
let cachedRegistry = null;
let cachedBookName = '';

/* ------------------------------------------------------------------ *
 * Registry access
 * ------------------------------------------------------------------ */

function activeBookName() {
    return getSettings()?.activeBook || '';
}

function currentRegistry() {
    const book = activeBookName();
    if (!book) return null;
    if (cachedRegistry && cachedBookName === book) return cachedRegistry;
    const raw = getRegistryFor(book);
    cachedRegistry = raw ? normalizeRegistry(raw, book) : null;
    cachedBookName = book;
    return cachedRegistry;
}

function saveRegistry(registry) {
    const book = activeBookName();
    if (!book) return false;
    const normalized = normalizeRegistry(registry, book);
    putRegistryFor(book, normalized);
    cachedRegistry = normalized;
    cachedBookName = book;
    runtime?.refresh();
    return true;
}

function currentToggles() {
    return { ...DEFAULT_TOGGLES, ...(getSettings()?.toggles || {}) };
}

function setToggle(key, value) {
    const s = getSettings();
    if (!s) return;
    s.toggles[key] = value;
    saveSettings();
    runtime?.refresh();
    renderPanel();
}

/** Read the book and rebuild the entry index (titles, keys, green/blue flags).
 *  No LLM, and nothing is written to the worldbook. */
async function scanBook() {
    const book = activeBookName();
    if (!book) { toast('warning', '请先选择一本世界书。'); return false; }
    const data = await loadBook(book);
    if (!data || !data.entries) {
        toast('warning', `读不到世界书「${book}」——请确认它存在且已启用。`);
        return false;
    }
    const next = refreshEntryIndex(currentRegistry() || emptyRegistry(book), data);
    next.bookName = book;
    next.bookFingerprint = fingerprintBook(data);
    saveRegistry(next);
    return true;
}

/* ------------------------------------------------------------------ *
 * Settings panel
 * ------------------------------------------------------------------ */

function panelHtml() {
    return `
<div class="lb-root">
  <div class="lb-row lb-book-row">
    <label class="lb-label" for="lb-book">世界书</label>
    <select id="lb-book" class="text_pole"></select>
    <button type="button" id="lb-rescan" class="menu_button" title="读取世界书、更新条目索引（不调用 AI，不写入世界书）">扫描</button>
  </div>
  <div id="lb-status" class="lb-status"></div>
  <div class="lb-row">
    <button type="button" id="lb-setup-open" class="menu_button" title="把条目的中文触发词翻成英文并追加进世界书，顺带收集英文显示名（写入前先让你过目）">⚙️ 翻译触发词</button>
  </div>

  <div class="lb-section">高亮</div>
  <label class="lb-check"><input type="checkbox" id="lb-t-hl"><span>标出触发词（虚线下划线，悬停看它触发什么、英文怎么打）</span></label>
  <label class="lb-check"><input type="checkbox" id="lb-t-hluser"><span>也标出我自己发的消息——打的英文没亮，就说明还缺这个词的触发词</span></label>

  <div class="lb-section">名称显示</div>
  <label class="lb-check"><input type="checkbox" id="lb-t-render"><span>把下列名字显示为英文（只改屏幕；存档和触发始终是中文）</span></label>
  <div id="lb-names" class="lb-names"></div>
  <div class="lb-row">
    <input type="text" id="lb-name-zh" class="text_pole lb-name-input" placeholder="中文名">
    <input type="text" id="lb-name-en" class="text_pole lb-name-input" placeholder="英文显示">
    <button type="button" id="lb-name-add" class="menu_button">添加</button>
  </div>
  <div class="lb-hint">「翻译触发词」会自动把音译式名字（沈慕微、归墟）加进来；有含义的名字（天剑宗）不会。单字名（红）不允许——中文没有词边界，改了会毁掉普通句子。悬停聊天里的英文名可看中文原名。</div>

  <div class="lb-section">数据</div>
  <div class="lb-hint">索引和翻译存在扩展设置里，可导出备份 / 换设备导入。世界书本体只在「翻译触发词」写入时被追加过触发词，其余一概不动。</div>
  <div class="lb-row">
    <button type="button" id="lb-export" class="menu_button">导出</button>
    <button type="button" id="lb-import" class="menu_button">导入</button>
    <input type="file" id="lb-file" accept="application/json,.json" hidden>
  </div>
</div>`;
}

function mountPanel() {
    const anchor = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!anchor || document.getElementById(PANEL_ID)) return;

    const block = document.createElement('div');
    block.id = PANEL_ID;
    block.className = 'lb-block';
    block.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>LangBridge · 触发词桥</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">${panelHtml()}</div>
      </div>`;
    anchor.appendChild(block);
    wirePanel(block);
    renderPanel();
}

function wirePanel(root) {
    const $ = (id) => root.querySelector(id);

    $('#lb-book').addEventListener('change', (e) => {
        const s = getSettings();
        if (!s) return;
        s.activeBook = e.target.value;
        saveSettings();
        cachedRegistry = null;
        cachedBookName = '';
        runtime?.refresh();
        renderPanel();
    });

    $('#lb-rescan').addEventListener('click', async () => {
        const button = $('#lb-rescan');
        button.disabled = true;
        try {
            if (await scanBook()) {
                const registry = currentRegistry();
                toast('success', `已索引 ${Object.keys(registry.entryIndex).length} 个条目。`);
                renderPanel();
            }
        } catch (e) {
            console.warn(LOG, 'scan failed', e);
            toast('error', '扫描失败：' + (e?.message || e));
        } finally {
            button.disabled = false;
        }
    });

    $('#lb-setup-open').addEventListener('click', () => openSetupPanel({
        getBookName: activeBookName,
        getRegistry: () => currentRegistry(),
        saveRegistry: (registry) => { saveRegistry(registry); renderPanel(); },
    }));

    $('#lb-t-hl').addEventListener('change', (e) => setToggle('highlight', e.target.checked));
    $('#lb-t-hluser').addEventListener('change', (e) => setToggle('highlightUserMessages', e.target.checked));
    $('#lb-t-render').addEventListener('change', (e) => setToggle('renderNames', e.target.checked));

    // Names list: toggle a pair on/off, delete it, or add one by hand.
    $('#lb-names').addEventListener('click', (e) => {
        const row = e.target?.closest?.('[data-lb-zh]');
        if (!row) return;
        const zh = row.dataset.lbZh;
        const registry = currentRegistry();
        if (!registry || !registry.renderMap[zh]) return;
        if (e.target.closest('.lb-name-del')) {
            delete registry.renderMap[zh];
        } else if (e.target.closest('input[type="checkbox"]')) {
            registry.renderMap[zh].on = e.target.checked;
        } else {
            return;
        }
        saveRegistry(registry);
        renderPanel();
    });
    $('#lb-name-add').addEventListener('click', () => {
        const zh = $('#lb-name-zh').value.trim();
        const en = $('#lb-name-en').value.trim();
        if (!zh || !en) { toast('warning', '中文名和英文显示都要填。'); return; }
        if (isSingleHanzi(zh)) { toast('warning', '单字名不能改写显示——它会命中普通词句（如 红色）。'); return; }
        const registry = currentRegistry() || emptyRegistry(activeBookName());
        registry.renderMap[zh] = { en, on: true };
        const normalized = normalizeRegistry(registry, activeBookName());
        if (!normalized.renderMap[zh]) { toast('warning', '这个名字不能用作显示名（需要是中文、至少两个字）。'); return; }
        saveRegistry(normalized);
        $('#lb-name-zh').value = '';
        $('#lb-name-en').value = '';
        renderPanel();
    });

    $('#lb-export').addEventListener('click', () => {
        const registry = currentRegistry() || emptyRegistry(activeBookName());
        const blob = new Blob([JSON.stringify(registry, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `langbridge-${(activeBookName() || 'registry').replace(/[^\w一-龥-]+/g, '_')}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#lb-import').addEventListener('click', () => $('#lb-file').click());
    $('#lb-file').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            saveRegistry(JSON.parse(await file.text()));
            toast('success', '数据已导入。');
            renderPanel();
        } catch (err) {
            toast('error', '导入失败：' + (err?.message || err));
        } finally {
            e.target.value = '';
        }
    });
}

async function renderPanel() {
    const root = document.getElementById(PANEL_ID);
    if (!root) return;
    const $ = (id) => root.querySelector(id);
    const toggles = currentToggles();

    $('#lb-t-hl').checked = !!toggles.highlight;
    $('#lb-t-hluser').checked = !!toggles.highlightUserMessages;
    $('#lb-t-render').checked = !!toggles.renderNames;

    const names = $('#lb-names');
    const pairs = Object.entries(currentRegistry()?.renderMap || {});
    names.innerHTML = pairs.length
        ? pairs.map(([zh, pair]) => `
            <div class="lb-name-row" data-lb-zh="${zh.replace(/"/g, '&quot;')}">
              <label class="lb-check"><input type="checkbox" ${pair.on ? 'checked' : ''}>
                <span class="lb-name-zh">${escapeText(zh)}</span>
                <span class="lb-name-arrow">→</span>
                <span class="lb-name-en">${escapeText(pair.en)}</span></label>
              <span class="lb-name-del" title="删除">✕</span>
            </div>`).join('')
        : '<div class="lb-hint">（空——跑一次「翻译触发词」自动收集，或在下方手动添加）</div>';

    const [active, all] = await Promise.all([getActiveBookNames(), getAllBookNames()]);
    const names = [...new Set([...active, ...all])];
    const select = $('#lb-book');
    const chosen = activeBookName();
    select.innerHTML = '<option value="">（未选择）</option>' +
        names.map((n) => `<option value="${n.replace(/"/g, '&quot;')}"${n === chosen ? ' selected' : ''}>${
            active.includes(n) ? '● ' : ''}${n}</option>`).join('');

    const registry = currentRegistry();
    const status = $('#lb-status');
    if (!(await canEditWorldInfo())) {
        status.innerHTML = '<span class="lb-warn">读不到 SillyTavern 的世界书模块——高亮仍可用（导入的数据），但无法扫描或写入。</span>';
    } else if (!chosen) {
        status.textContent = '选择本卡使用的世界书，然后点「扫描」。';
    } else if (!registry) {
        status.textContent = '这本书还没有索引——点「扫描」。';
    } else {
        const entries = Object.values(registry.entryIndex);
        const green = entries.filter((m) => m.gated).length;
        const translated = Object.keys(registry.keyTranslations).length;
        const written = Object.values(registry.addedKeys).reduce((n, list) => n + list.length, 0);
        status.textContent = `${entries.length} 个条目（绿灯 ${green}）· ${translated} 个条目已有英文翻译 · 已写入 ${written} 个英文触发词。`;
    }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function escapeText(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function boot() {
    if (!getContext()) {
        console.warn(LOG, 'SillyTavern context unavailable — LangBridge idle.');
        return;
    }
    getSettings();   // materialize defaults

    runtime = new DisplayRuntime({
        getRegistry: () => currentRegistry(),
        getToggles: () => currentToggles(),
        onHoverBind: (host) => bindHover(host, () => currentRegistry(), {
            onSetRenderOn: (zh, on) => {
                const registry = currentRegistry();
                if (!registry?.renderMap?.[zh]) return;
                registry.renderMap[zh].on = on;
                saveRegistry(registry);       // persists + refreshes the chat
                renderPanel();                // keep the settings list in sync
            },
        }),
    });

    onEvents({
        onMessageRendered: (id) => {
            const el = (id != null && document.querySelector(`#chat .mes[mesid="${id}"]`)) || null;
            if (el) runtime.passMessage(el); else runtime.passAll();
        },
        onGenerationEnded: () => runtime.passAll(),
        onChatChanged: () => {
            hideCard();
            cachedRegistry = null;
            cachedBookName = '';
            setTimeout(() => runtime.passAll(), 60);
        },
    });

    runtime.startObserver();
    mountPanel();
    setTimeout(() => runtime.passAll(), 300);   // decorate whatever is already on screen
    console.log(LOG, 'ready');
}

if (typeof globalThis.jQuery === 'function') {
    globalThis.jQuery(() => boot());
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
