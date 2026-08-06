/**
 * LangBridge — entry point.
 *
 * Type English, read English names; storage stays canonical Chinese.
 * Standalone SillyTavern extension — no dependency on any other extension.
 *
 * Invariants (spec §0):
 *   I1 never modifies message.mes or the chat file — DOM only
 *   I2 zero per-turn LLM calls
 *   I3 never alters an author's original worldbook keys or per-entry flags
 *   I4 no runtime input transformation (English fires WI via pre-planted keys)
 *   I5 never breaks the host — every ST touchpoint degrades
 */

import {
    getContext, getSettings, saveSettings, getRegistryFor, putRegistryFor,
    onEvents, loadBook, fingerprintBook, getActiveBookNames, getAllBookNames,
    canEditWorldInfo, toast, LOG,
} from './host.js';
import {
    normalizeRegistry, emptyRegistry, DEFAULT_TOGGLES, CATEGORIES, isSingleHanzi,
} from './registry.js';
import { DisplayRuntime } from './runtime.js';
import { bindHover, hideCard } from './tooltip.js';

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

/* ------------------------------------------------------------------ *
 * Non-LLM book scan — the mechanical half of Setup Pass steps 1-2.
 *
 * Populates entryIndex (which the hover card needs) and seeds one entity per
 * entry from its `comment` + existing `key[]` (this is where titles like
 * 无情道首座 / 谷主 / 长公主 already live). It deliberately does NOT guess
 * categories or romanize — that is the LLM Setup Pass. Everything it creates is
 * zh-policy, so nothing renders in English until the user (or the Setup Pass)
 * fills display_en. Read-only: writes nothing to the worldbook.
 * ------------------------------------------------------------------ */

async function scanBookSkeleton(bookName) {
    const data = await loadBook(bookName);
    if (!data || !data.entries) {
        toast('warning', `读不到世界书「${bookName}」——请确认它存在且已启用。`);
        return null;
    }

    const previous = currentRegistry() || emptyRegistry(bookName);
    const byCanonical = new Map(previous.entities.map((e) => [e.canonical, e]));
    const registry = emptyRegistry(bookName);
    registry.bookFingerprint = fingerprintBook(data);
    registry.addedKeys = { ...previous.addedKeys };      // never lose the ledger
    registry.conceptKeys = previous.conceptKeys.slice(); // concepts are LLM/user work

    for (const [uid, entry] of Object.entries(data.entries)) {
        if (!entry) continue;
        const keys = (Array.isArray(entry.key) ? entry.key : []).map((k) => String(k).trim()).filter(Boolean);
        const title = String(entry.comment || '').trim() || `条目 #${uid}`;
        registry.entryIndex[String(uid)] = { title, keys };

        // Canonical = the entry's comment with common decorations stripped.
        const canonical = title.replace(/^[【\[（(]{1}[^】\]）)]*[】\]）)]\s*/, '').trim();
        if (!canonical) continue;

        const existing = byCanonical.get(canonical);
        if (existing) {
            // Preserve every user/LLM decision; only refresh the uid linkage.
            const uids = new Set([...existing.sourceEntryUids, Number(uid)]);
            registry.entities.push({ ...existing, sourceEntryUids: [...uids] });
            byCanonical.delete(canonical);
            continue;
        }

        registry.entities.push({
            id: slug(canonical, registry.entities.length),
            canonical,
            display_en: '',
            category: 'character',              // placeholder — the Setup Pass classifies
            aliases_zh: keys.filter((k) => k !== canonical && !isAscii(k)),
            aliases_en: keys.filter(isAscii),
            displayPolicy: 'zh',                // nothing renders until display_en exists
            singleChar: isSingleHanzi(canonical),
            sourceEntryUids: [Number(uid)],
        });
    }

    // Entities the user created by hand that no longer match an entry: keep them.
    for (const orphan of byCanonical.values()) registry.entities.push(orphan);

    return normalizeRegistry(registry, bookName);
}

function isAscii(text) { return /^[\x20-\x7E]+$/.test(String(text || '')); }

function slug(text, index) {
    const base = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return base || `entity-${index + 1}`;
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

function panelHtml() {
    return `
<div class="lb-root">
  <div class="lb-row lb-book-row">
    <label class="lb-label" for="lb-book">世界书</label>
    <select id="lb-book" class="text_pole"></select>
    <button type="button" id="lb-rescan" class="menu_button" title="读取世界书，建立/更新条目索引与名称骨架（不调用 AI，不写入世界书）">扫描</button>
  </div>
  <div id="lb-status" class="lb-status"></div>

  <div class="lb-section">显示</div>
  <label class="lb-check"><input type="checkbox" id="lb-t-char"><span>角色名显示为英文</span></label>
  <label class="lb-check"><input type="checkbox" id="lb-t-place"><span>地点 / 势力显示为英文</span></label>
  <label class="lb-check"><input type="checkbox" id="lb-t-hl"><span>标出触发词（虚线下划线）</span></label>
  <label class="lb-check"><input type="checkbox" id="lb-t-hluser"><span>也标出我自己发的消息（用来发现漏掉的英文触发词）</span></label>

  <div class="lb-section">名称登记表</div>
  <div class="lb-hint">存储始终是中文；这里只决定<b>显示</b>成什么。单字名（红 / 陶 / 瓷）默认既不改写也不标注——中文没有词边界，单字会命中普通词句。</div>
  <div class="lb-row">
    <button type="button" id="lb-edit" class="menu_button">编辑登记表</button>
    <button type="button" id="lb-export" class="menu_button">导出</button>
    <button type="button" id="lb-import" class="menu_button">导入</button>
    <input type="file" id="lb-file" accept="application/json,.json" hidden>
  </div>
  <div id="lb-editor" class="lb-editor" hidden>
    <textarea id="lb-json" class="text_pole lb-json" spellcheck="false" rows="14"></textarea>
    <div class="lb-row">
      <button type="button" id="lb-save" class="menu_button">校验并保存</button>
      <button type="button" id="lb-cancel" class="menu_button">取消</button>
      <span id="lb-json-msg" class="lb-hint"></span>
    </div>
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
          <b>LangBridge · 中英名称桥</b>
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
        const book = activeBookName();
        if (!book) { toast('warning', '请先选择一本世界书。'); return; }
        const button = $('#lb-rescan');
        button.disabled = true;
        try {
            const registry = await scanBookSkeleton(book);
            if (registry) {
                saveRegistry(registry);
                toast('success', `已索引 ${Object.keys(registry.entryIndex).length} 个条目、${registry.entities.length} 个名称。`);
                renderPanel();
            }
        } catch (e) {
            console.warn(LOG, 'scan failed', e);
            toast('error', '扫描失败：' + (e?.message || e));
        } finally {
            button.disabled = false;
        }
    });

    const bindToggle = (sel, key) => $(sel).addEventListener('change', (e) => setToggle(key, e.target.checked));
    bindToggle('#lb-t-char', 'renderCharacters');
    bindToggle('#lb-t-place', 'renderPlaces');
    bindToggle('#lb-t-hl', 'highlight');
    bindToggle('#lb-t-hluser', 'highlightUserMessages');

    $('#lb-edit').addEventListener('click', () => {
        const editor = $('#lb-editor');
        const open = editor.hidden;
        editor.hidden = !open;
        if (open) {
            $('#lb-json').value = JSON.stringify(currentRegistry() || emptyRegistry(activeBookName()), null, 2);
            $('#lb-json-msg').textContent = '';
        }
    });
    $('#lb-cancel').addEventListener('click', () => { $('#lb-editor').hidden = true; });
    $('#lb-save').addEventListener('click', () => {
        const msg = $('#lb-json-msg');
        try {
            const parsed = JSON.parse($('#lb-json').value);
            saveRegistry(parsed);
            msg.textContent = '已保存。';
            renderPanel();
        } catch (e) {
            msg.textContent = 'JSON 有误：' + (e?.message || e);
        }
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
            toast('success', '登记表已导入。');
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

    $('#lb-t-char').checked = !!toggles.renderCharacters;
    $('#lb-t-place').checked = !!toggles.renderPlaces;
    $('#lb-t-hl').checked = !!toggles.highlight;
    $('#lb-t-hluser').checked = !!toggles.highlightUserMessages;

    // Book list: active books first, then everything else.
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
        status.innerHTML = '<span class="lb-warn">读不到 SillyTavern 的世界书模块——仅显示模式：登记表仍可导入/编辑，但无法扫描或写入世界书。</span>';
    } else if (!chosen) {
        status.textContent = '选择本卡使用的世界书，然后点「扫描」。';
    } else if (!registry) {
        status.textContent = '这本书还没有登记表——点「扫描」建立骨架，或导入一份。';
    } else {
        const named = registry.entities.filter((e) => e.display_en).length;
        status.innerHTML = `登记表：${registry.entities.length} 个名称（${named} 个已有英文）、` +
            `${registry.conceptKeys.length} 个概念词、${Object.keys(registry.entryIndex).length} 个条目索引。` +
            (named === 0 ? ' <span class="lb-warn">还没有任何英文名——填好 display_en 后才会改写显示。</span>' : '');
    }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function boot() {
    if (!getContext()) {
        console.warn(LOG, 'SillyTavern context unavailable — LangBridge idle.');
        return;
    }
    getSettings();   // materialize defaults

    runtime = new DisplayRuntime({
        getRegistry: () => currentRegistry(),
        getToggles: () => currentToggles(),
        onHoverBind: (host) => bindHover(host, () => currentRegistry()),
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
