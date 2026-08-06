/**
 * LangBridge — name display decisions.
 *
 * Some names genuinely go either way: 归墟 is a place name (so "Guixu" reads
 * fine) but literally means "where all things return to the void" (so a
 * translation reads fine too). The Setup Pass marks those `policyUncertain`
 * instead of quietly picking one, and this is where the human picks — during
 * setup, or any time afterwards.
 *
 * A choice made here sets `policyDecided`, which no later Setup Pass will
 * overwrite and which stops the name being raised again.
 */

import { RENDERABLE } from './registry.js';

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-testable)
 * ------------------------------------------------------------------ */

/** Entities that own a display decision: renderable, not single-hanzi (those
 *  are pinned to Chinese), and actually having an English form to switch to. */
export function decidableEntities(registry) {
    return (registry?.entities || []).filter((entity) =>
        RENDERABLE.has(entity.category) && !entity.singleChar && entity.display_en);
}

/** The ones still awaiting a human answer. */
export function pendingDecisions(registry) {
    return decidableEntities(registry).filter((entity) => entity.policyUncertain && !entity.policyDecided);
}

/**
 * Record a decision. Returns a NEW registry — callers persist it.
 * Setting a policy by hand latches policyDecided so re-runs leave it alone.
 */
export function applyDecision(registry, entityId, policy) {
    const next = { ...registry, entities: (registry?.entities || []).map((entity) => {
        if (entity.id !== entityId) return entity;
        return {
            ...entity,
            displayPolicy: policy === 'zh' ? 'zh' : 'en',
            policyDecided: true,
            policyUncertain: false,
        };
    }) };
    return next;
}

/** Edit the English form shown for a name. */
export function applyDisplayName(registry, entityId, displayEn) {
    return { ...registry, entities: (registry?.entities || []).map((entity) =>
        entity.id === entityId ? { ...entity, display_en: String(displayEn || '').trim() } : entity) };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const CATEGORY_LABEL = { character: '角色', location: '地点', faction: '势力' };

export function escapeHtml(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * One row per name: what it looks like either way, and a two-way switch.
 * Shows the ACTUAL rendered forms so the choice is concrete rather than abstract.
 */
export function decisionRowsHtml(entities, opts = {}) {
    if (!entities.length) {
        return `<div class="lb-hint">${opts.emptyText || '没有需要决定的名字。'}</div>`;
    }
    return `<div class="lb-decide">${entities.map((entity) => {
        const zhActive = entity.displayPolicy === 'zh';
        const pending = entity.policyUncertain && !entity.policyDecided;
        return `
        <div class="lb-decide-row${pending ? ' lb-decide-pending' : ''}" data-lb-id="${escapeHtml(entity.id)}">
          <div class="lb-decide-name">
            <span class="lb-decide-zh">${escapeHtml(entity.canonical)}</span>
            <span class="lb-decide-cat">${CATEGORY_LABEL[entity.category] || entity.category}</span>
            ${pending ? '<span class="lb-decide-flag">待定</span>' : ''}
          </div>
          <div class="lb-decide-choice">
            <button type="button" class="lb-decide-btn${zhActive ? ' lb-on' : ''}"
                    data-lb-policy="zh" title="屏幕上显示中文原名">${escapeHtml(entity.canonical)}</button>
            <button type="button" class="lb-decide-btn${zhActive ? '' : ' lb-on'}"
                    data-lb-policy="en" title="屏幕上显示英文">${escapeHtml(entity.display_en)}</button>
          </div>
        </div>`;
    }).join('')}</div>`;
}

/**
 * Wire a container rendered by decisionRowsHtml.
 * onChoose(entityId, policy) should persist and re-render.
 */
export function bindDecisionRows(container, onChoose) {
    if (!container || container.dataset.lbBound === '1') return;
    container.dataset.lbBound = '1';
    container.addEventListener('click', (event) => {
        const button = event.target?.closest?.('.lb-decide-btn');
        if (!button) return;
        const row = button.closest('.lb-decide-row');
        if (!row) return;
        onChoose(row.dataset.lbId, button.dataset.lbPolicy);
    });
}

/* ------------------------------------------------------------------ *
 * Standalone panel — reachable any time, not just during setup
 * ------------------------------------------------------------------ */

const PANEL_ID = 'lb-decisions';
let panel = null;

export function openDecisionsPanel(deps) {
    if (!panel || !panel.isConnected) {
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'lb-modal';
        panel.innerHTML = `
          <div class="lb-modal-card">
            <div class="lb-modal-head">
              <span class="lb-modal-title">🈳 名称显示 · 中文还是英文</span>
              <div class="lb-modal-x" title="关闭">✕</div>
            </div>
            <div class="lb-modal-body">
              <div class="lb-hint">
                点一下就切换：左边＝屏幕上显示中文原名，右边＝显示英文。
                <b>不管选哪边，存进聊天记录的永远是中文</b>，世界书触发也不受影响。
                标着「待定」的是 AI 觉得两种都说得通、留给你拿主意的。
              </div>
              <div class="lb-row">
                <label class="lb-check"><input type="checkbox" id="lb-dec-pending"><span>只看待定的</span></label>
                <span id="lb-dec-count" class="lb-hint"></span>
              </div>
              <div id="lb-dec-list"></div>
            </div>
          </div>`;
        document.body.appendChild(panel);
        panel.querySelector('.lb-modal-x').addEventListener('click', () => panel.classList.remove('open'));
        panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('open'); });
        panel.querySelector('#lb-dec-pending').addEventListener('change', () => render(deps));
    }
    render(deps);
    panel.classList.add('open');
}

function render(deps) {
    const registry = deps.getRegistry();
    const list = panel.querySelector('#lb-dec-list');
    const onlyPending = panel.querySelector('#lb-dec-pending').checked;

    const all = decidableEntities(registry);
    const pending = pendingDecisions(registry);
    const shown = onlyPending ? pending : all;

    panel.querySelector('#lb-dec-count').textContent =
        `${all.length} 个名字可切换${pending.length ? `，其中 ${pending.length} 个待定` : ''}`;

    list.innerHTML = decisionRowsHtml(shown, {
        emptyText: onlyPending ? '没有待定的名字了。' : '还没有可切换的名字——先跑一次「扫描」或「自动设置」。',
    });

    bindDecisionRows(list, (entityId, policy) => {
        deps.saveRegistry(applyDecision(deps.getRegistry(), entityId, policy));
        render(deps);
    });
}
