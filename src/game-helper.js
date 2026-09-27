// ==UserScript==
// @name         RollRune 敕令等级汇总
// @namespace    local.rollrune.edict-summary
// @version      0.7.1
// @description  游戏内敕令等级汇总、掉落等级显示、装备词条收益计算与拍卖行一键查价。
// @match        https://rollrune.top/*
// @match        https://direct.rollrune.top/*
// @exclude      https://rollrune.top/wiki*
// @exclude      https://direct.rollrune.top/wiki*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (/^\/wiki(?:\/|$)/.test(location.pathname)) return;
  const MARK = 'data-rr-edict-summary';
  const SELECTOR = `[${MARK}]`;
  const IGNORED = `script,style,textarea,input,[contenteditable="true"],${SELECTOR},[data-rr-inline-calc]`;
  const summaries = new Map();
  let timer;
  let areas = null;
  let areaRequest = false;
  let areaRetryAt = 0;
  let battle = null;
  let probing = false;
  let calculatorOpen = false;
  const BAR = 'data-rr-drop-level';
  const probeStyle = document.createElement('style');
  probeStyle.textContent = 'html[data-rr-reading-edict] .rr-game-tooltip{opacity:0!important}';
  document.head.append(probeStyle);

  async function loadAreas() {
    if (areaRequest || areas || Date.now() < areaRetryAt) return;
    areaRequest = true;
    try {
      const entry = performance.getEntriesByType('resource').filter(e => {
        try { const u = new URL(e.name); return u.origin === location.origin && u.pathname === '/api/game/areas'; }
        catch { return false; }
      }).pop();
      const response = await fetch(entry?.name || '/api/game/areas', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Area data unavailable');
      const data = await response.json();
      if (!data.areas || typeof data.areas !== 'object') throw new Error('Unknown area format');
      areas = Object.values(data.areas);
    } catch {
      areaRetryAt = Date.now() + 30000;
    } finally {
      areaRequest = false;
      schedule();
    }
  }

  function battleParts() {
    // Verified game battle header; do not confuse backpack item levels with floors.
    const header = [...document.querySelectorAll('div[style*="areas/"]')]
      .find(e => /_header\.webp/.test(e.getAttribute('style')) && visible(e));
    if (!header) return null;
    const name = [...header.querySelectorAll('span.font-display')]
      .find(e => /[—–]\s*\d+\s*$/.test(e.parentElement.innerText));
    if (!name) return null;
    const level = Number(name.parentElement.innerText.match(/[—–]\s*(\d+)\s*$/)[1]);
    const background = header.getAttribute('style').match(/areas\/[^'"\s)]+_header\.webp/)?.[0];
    const next = name.parentElement.nextElementSibling;
    const icon = next?.querySelector('svg') ? next : null;
    return { header, level, background, icon, name: name.textContent.trim() };
  }

  function regionInfo(background) {
    const matches = areas?.filter(a => a.header_background === background) || [];
    if (!matches.length) return null;
    // Region contribution includes its base level as well as the item modifier.
    // Normal regions: 0, 30, 60, 90, ...; Chaos remains 0.
    const total = a => Number.isFinite(a.power_level) && Number.isFinite(a.item_level_modifier)
      ? a.power_level + a.item_level_modifier : NaN;
    const bonus = total(matches[0]);
    if (!Number.isFinite(bonus) || !matches.every(a => total(a) === bonus)) return null;
    return { bonus, training: matches.every(a => a.training) };
  }

  async function readCurrentEdict(state) {
    if (probing || calculatorOpen || !state.icon?.isConnected || document.hidden) return;
    // Never replace a tooltip the player is reading, nor interact through a modal.
    if ([...document.querySelectorAll('.rr-game-tooltip,[role="dialog"],dialog[open]')].some(visible)) return;
    probing = true;
    state.lastAttempt = Date.now();
    let entered = false;
    try {
      document.documentElement.setAttribute('data-rr-reading-edict', '');
      state.icon.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      entered = true;
      // Wait for the item itself, including its footer, rather than a fixed render delay.
      // A slow/partial tooltip must not be cached as an edict with zero bonus.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (battle !== state || !state.icon.isConnected || document.hidden) return;
        const tooltips = [...document.querySelectorAll('.rr-game-tooltip .rr-layered-tooltip')]
          .filter(e => visible(e) && [...e.querySelectorAll('li')].some(li => li.textContent.trim() === '敕令'));
        if (tooltips.length !== 1) continue;
        const text = tooltips[0].innerText;
        if (!/需求战力等级\s*[:：]\s*\d+/.test(text) || !/物品战力等级\s*[:：]\s*\d+/.test(text)) continue;
        state.edict = bonuses(text).reduce((sum, n) => sum + n, 0);
        state.edictName = tooltips[0].querySelector('li')?.textContent.trim() || '当前敕令';
        state.lastRead = Date.now();
        state.readFloor = state.level;
        return;
      }
    } finally {
      if (entered) state.icon.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
      await new Promise(resolve => setTimeout(resolve, 0));
      document.documentElement.removeAttribute('data-rr-reading-edict');
      probing = false;
      schedule();
    }
  }

  function refreshBattle() {
    const parts = battleParts();
    if (!parts) {
      battle?.bar.remove();
      battle = null;
      return;
    }
    if (!battle || battle.header !== parts.header || battle.icon !== parts.icon ||
        battle.background !== parts.background || battle.name !== parts.name) {
      battle?.bar.remove();
      const bar = document.createElement('div');
      bar.setAttribute(BAR, '');
      bar.style.cssText = 'position:relative;z-index:10;flex:0 0 auto;box-sizing:border-box;padding:5px 8px;background:linear-gradient(90deg,#201b16,#302619,#201b16);border-bottom:1px solid #6b5430;color:#d2c6ad;text-align:center;font-size:12px;line-height:1.6;white-space:normal;';
      battle = { ...parts, bar, edict: parts.icon ? null : 0, edictName: '', lastRead: 0, lastAttempt: 0 };
      bar.style.cursor = 'pointer';
      bar.addEventListener('click', () => {
        if (battle?.bar !== bar) return;
        battle.lastAttempt = 0;
        battle.lastRead = 0;
        schedule();
      });
      parts.header.after(bar);
    }
    const state = battle;
    state.level = parts.level;
    if (!state.bar.isConnected) parts.header.after(state.bar);
    void loadAreas();
    const region = regionInfo(parts.background);
    const edict = parts.icon ? state.edict : 0;
    const complete = Number.isFinite(edict) && region;
    const text = region?.training ? '训练场 · 不计算物品掉落等级' :
      `掉落等级：${parts.level} 层 + 敕令 ${edict ?? '读取中'} + 地区 ${region?.bonus ?? '读取中'} = ${complete ? parts.level + edict + region.bonus + ' 级' : '待确认'}`;
    if (state.bar.textContent !== text) {
      state.bar.replaceChildren();
      const label = document.createElement('span');
      const separator = text.lastIndexOf(' = ');
      if (separator >= 0) {
        label.textContent = text.slice(0, separator + 3);
        const result = document.createElement('strong');
        result.textContent = text.slice(separator + 3);
        result.style.cssText = 'color:#f9d57b;font-size:14px;';
        state.bar.append(label, result);
      } else { state.bar.textContent = text; }
    }
    state.bar.title = `地区：${parts.name}\n敕令：${state.edictName || (parts.icon ? '读取当前生效敕令' : '未使用')}\n按当前层数 + 敕令等级加成 + 地区掉落等级加成汇总。点击重试读取。`;
    // Refresh on each floor change and periodically for a newly started run.
    if (!region?.training && parts.icon && !probing && Date.now() - state.lastAttempt > 2000 &&
        (edict === null || state.readFloor !== parts.level || Date.now() - state.lastRead > 15000)) {
      void readCurrentEdict(state);
    }
  }

  // Only signed, flat level bonuses count: never the required/base item level.
  function bonuses(text) {
    return [...text.matchAll(/物品\s*战力\s*等级\s*[+＋]\s*(\d+)(?![\d.%％])/gu)]
      .map(match => Number(match[1]));
  }

  function visible(element) {
    return element.isConnected && element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden';
  }

  function headerNodes() {
    const result = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue.includes('敕令')) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest(IGNORED) || !visible(parent)) continue;
      // An isolated item-type label prevents matching general descriptions.
      if (node.nodeValue.trim() === '敕令') result.push(parent);
    }
    return result;
  }

  function findCard(header, headers) {
    let card = header;
    for (let depth = 0; card && depth < 14; depth++, card = card.parentElement) {
      if (card === document.body || card === document.documentElement || card.tagName === 'MAIN') break;
      if (headers.some(other => other !== header && card.contains(other))) break;
      const text = card.innerText;
      if (text.length > 12000) break;
      if (bonuses(text).length) return card;
    }
    return null;
  }

  function refresh() {
    timer = undefined;
    observer.disconnect();
    try {
      const headers = headerNodes();
      const active = new Set();
      for (const header of headers) {
        const card = findCard(header, headers);
        if (!card || active.has(card)) continue;
        const values = bonuses(card.innerText);
        if (!values.length) continue;
        active.add(card);
        let box = summaries.get(card);
        if (!box || !card.contains(box)) {
          box?.remove();
          box = document.createElement('div');
          box.setAttribute(MARK, '');
          box.style.cssText = 'display:block;flex:0 0 auto;grid-column:1/-1;box-sizing:border-box;margin:10px 0 2px;padding:8px 10px;border-top:1px solid #715a32;color:#f5d68a;text-align:center;font-size:14px;line-height:1.6;pointer-events:none;white-space:normal;';
          card.append(box);
          summaries.set(card, box);
        }
        const total = values.reduce((sum, value) => sum + value, 0);
        // Deliberately use a different label from the matched affix text.
        box.replaceChildren();
        const title = document.createElement('strong');
        title.textContent = `战力等级加成合计：+${total} 级`;
        const details = document.createElement('div');
        details.style.cssText = 'font-size:12px;color:#b9ad94;overflow-wrap:anywhere;';
        details.textContent = `${values.join(' + ')} = ${total}（${values.length} 条）`;
        box.append(title, details);
      }
      for (const [card, box] of summaries) {
        if (!active.has(card)) {
          box.remove();
          summaries.delete(card);
        }
      }
      refreshBattle();
    } finally {
      observer.observe(document.body, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style', 'hidden']
      });
    }
  }

  function schedule() {
    if (timer === undefined) timer = window.setTimeout(refresh, 160);
  }
  const observer = new MutationObserver(schedule);
  installCalculator();
  refresh();
  // Also covers tooltips revealed by CSS hover without DOM mutations.
  document.addEventListener('pointerover', schedule, { passive: true });
  document.addEventListener('pointerout', schedule, { passive: true });
  document.addEventListener('visibilitychange', schedule);
  setInterval(() => { if (!document.hidden) schedule(); }, 1000);

  function installCalculator() {
    const style = document.createElement('style');
    style.textContent = `
      html[data-rr-inline-active] .rr-game-tooltip:not([data-rr-inline-calc]){visibility:hidden!important}
      [data-rr-inline-calc]{pointer-events:auto!important;z-index:2147483647!important}
      [data-rr-inline-calc] .rr-calc-help{font:11px/1.5 system-ui,sans-serif;color:#c4b593;display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 5px}
      [data-rr-inline-calc] .rr-calc-exit{font:inherit;color:#e8c87f;background:none;border:0;padding:2px 4px;cursor:pointer}
      [data-rr-inline-calc] .rr-calc-pick{cursor:pointer}
      [data-rr-inline-calc] .rr-calc-check{appearance:auto!important;display:inline-block;width:13px;height:13px;vertical-align:middle;margin:0 5px 2px 0;padding:0;accent-color:#e7c573;cursor:pointer}
      [data-rr-inline-calc] .rr-calc-total{border-top:1px solid #6d5c3d;margin-top:8px;padding-top:7px;font:12px/1.6 system-ui,sans-serif;color:#e9cf92;text-align:center;overflow-wrap:anywhere}
      [data-rr-inline-calc] .rr-calc-total strong{font-size:14px;color:#ffdf86}
      [data-rr-inline-calc] .rr-calc-compare{font-size:11px;color:#c1b69d}
    `;
    document.head.append(style);
    let clones = [];
    let groups = [];
    let focusBefore;
    const number = n => Math.abs(n) >= 1e9 ? n.toExponential(4) : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(n);
    const signed = n => `${n >= 0 ? '+' : ''}${number(n)}`;
    function factor(text) {
      const skill = text.trim().match(/^\+\s*(\d+)\s*技能等级(?:\s*[（(]|\s*$)/);
      if (skill) {
        const levels = Number(skill[1]);
        const value = 1.3 ** levels;
        return Number.isFinite(value) ? { value, note: '技能等级：1.3^' + levels } : null;
      }
      const m = text.match(/(?:额外|独立)\s*(提高|提升|增加|降低|减少)\s*([\d.]+)\s*[%％]/);
      if (!m) return null;
      const gold = /金币/.test(text) && /额外\s*(?:提高|提升|增加)/.test(text);
      const percent = Number(m[2]);
      const cleaned = text.replace(/[（(]\s*[+-]?\d+(?:\.\d+)?\s*[%％]?\s*[~～–-]\s*[+-]?\d+(?:\.\d+)?\s*[%％]?\s*[）)]/g, '');
      const mergeKey = cleaned.replace(/((?:额外|独立)\s*(?:提高|提升|增加|降低|减少))\s*[\d.]+\s*[%％]/, '$1#')
        .replace(/提升|增加/g, '提高').replace(/减少/g, '降低').replace(/\s+/g, '').trim();
      const n = 1 + (/降低|减少/.test(m[1]) ? -1 : 1) * percent * (gold ? 0.3 : 1) / 100;
      return Number.isFinite(n) && n >= 0
        ? { value: Number(n.toFixed(10)), mergeKey, note: gold ? '金币折算：' + percent + '% → ' + number(percent * 0.3) + '% more（估算）' : '' }
        : null;
    }
    function combined(rows) {
      const buckets = new Map();
      rows.forEach((row, index) => {
        const key = row.mergeKey || Symbol(index);
        if (!buckets.has(key)) buckets.set(key, { key: row.mergeKey, factors: [] });
        buckets.get(key).factors.push(row.factor);
      });
      return [...buckets.values()].map(b => ({ ...b,
        factor: b.key ? Math.max(0, 1 + b.factors.reduce((sum, f) => sum + f - 1, 0)) : b.factors[0]
      }));
    }
    function close() {
      clones.forEach(e => e.remove()); clones = []; groups = [];
      calculatorOpen = false;
      document.documentElement.removeAttribute('data-rr-inline-active');
      if (focusBefore?.isConnected) focusBefore.focus({ preventScroll: true });
    }
    function update() {
      const values = groups.map(g => {
        const selected = g.rows.filter(r => r.checkbox.checked);
        g.output.replaceChildren();
        if (!selected.length) { g.output.textContent = g.rows.length ? '勾选词条，查看乘算合计' : '没有可换算的百分比或技能等级词条'; return null; }
        const merged = combined(selected);
        const total = merged.reduce((n, r) => n * r.factor, 1);
        if (!Number.isFinite(total)) { g.output.textContent = '所选倍率超出可计算范围'; return null; }
        const strong = document.createElement('strong');
        strong.textContent = `×${number(total)} · 合计 ${signed((total - 1) * 100)}%`;
        g.output.append(strong);
        g.output.title = merged.map(r => r.factors.length > 1
          ? r.key.replace('#', '') + '：1 + (' + r.factors.map(f => number((f - 1) * 100) + '%').join(' + ') + ') = ×' + number(r.factor)
          : '×' + number(r.factor)).join('\n') + '\n总计 ×' + number(total);
        if (merged.some(r => r.factors.length > 1)) {
          const hint = document.createElement('div'); hint.className = 'rr-calc-compare';
          hint.textContent = selected.length + ' 条已选 → ' + merged.length + ' 组（同名先加算）'; g.output.append(hint);
        }
        return total;
      });
      if (groups.length === 2 && values[0] !== null && values[1] !== null) {
        const line = document.createElement('div'); line.className = 'rr-calc-compare';
        line.textContent = values[0] > 0 ? `比左侧 ${signed((values[1] / values[0] - 1) * 100)}%（同类收益）` : '左侧为 0，无法计算相对变化';
        groups[1].output.append(line);
      }
      for (const clone of clones) {
        const rect = clone.getBoundingClientRect();
        clone.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - rect.height - 8))}px`;
      }
    }
    function open() {
      if (probing) return;
      const sources = [...document.querySelectorAll('.rr-game-tooltip:not([data-rr-inline-calc])')]
        .filter(e => visible(e) && e.querySelector('.rr-layered-tooltip li.text-blue-400'))
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      if (!sources.length) return;
      focusBefore = document.activeElement;
      // Snapshot only the visible tooltip. Keep the game's styling and its position.
      for (const source of sources) {
        const rect = source.getBoundingClientRect();
        const clone = source.cloneNode(true);
        clone.setAttribute('data-rr-inline-calc', '');
        clone.removeAttribute('role'); clone.removeAttribute('aria-live');
        clone.setAttribute('aria-label', '装备属性乘算');
        clone.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
        clone.style.position = 'fixed';
        clone.style.boxSizing = 'border-box';
        clone.style.left = `${Math.max(8, rect.left)}px`;
        clone.style.top = `${Math.max(8, rect.top)}px`;
        clone.style.width = `${rect.width}px`;
        clone.style.maxWidth = 'calc(100vw - 16px)';
        clone.style.maxHeight = 'calc(100vh - 16px)';
        clone.style.overflow = 'auto';
        clone.style.pointerEvents = 'auto';
        const originals = [...source.querySelectorAll('.rr-layered-tooltip')];
        [...clone.querySelectorAll('.rr-layered-tooltip')].forEach((section, index) => {
          const help = document.createElement('div'); help.className = 'rr-calc-help';
          const hint = document.createElement('span'); hint.textContent = '同名相加 · 异名相乘 · 反引号键 / Esc 退出';
          const exit = document.createElement('button'); exit.className = 'rr-calc-exit';
          exit.type = 'button'; exit.textContent = '×'; exit.setAttribute('aria-label', '退出属性计算');
          exit.addEventListener('click', close); help.append(hint, exit); section.prepend(help);
          const sourceRows = [...originals[index].querySelectorAll('li.text-blue-400')];
          const rows = [];
          [...section.querySelectorAll('li.text-blue-400')].forEach((li, rowIndex) => {
            const parsed = factor(sourceRows[rowIndex]?.innerText || '');
            if (parsed === null || !visible(sourceRows[rowIndex])) return;
            const value = parsed.value;
            const label = document.createElement('label'); label.className = 'rr-calc-pick';
            const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'rr-calc-check';
            checkbox.setAttribute('aria-label', li.textContent.trim());
            label.title = `${parsed.note ? parsed.note + "；" : ""}按 ×${number(value)} 参与乘算`;
            label.append(checkbox, ...li.childNodes); li.append(label);
            if (parsed.note) {
              const note = document.createElement('small');
              note.style.cssText = 'display:block;font-size:11px;color:#c4b593';
              note.textContent = parsed.note + ' · ×' + number(value);
              label.append(note);
            }
            checkbox.addEventListener('change', update); rows.push({ checkbox, factor: value, mergeKey: parsed.mergeKey });
          });
          const output = document.createElement('div'); output.className = 'rr-calc-total';
          output.setAttribute('aria-live', 'polite'); section.append(output);
          if (!rows.length) output.textContent = '没有可换算的百分比或技能等级词条';
          groups.push({ rows, output });
        });
        for (const event of ['pointerdown','pointerup','click','dblclick','contextmenu','wheel','keydown','keyup']) {
          clone.addEventListener(event, e => { e.stopPropagation(); if (event === 'contextmenu') e.preventDefault(); });
        }
        document.body.append(clone); clones.push(clone);
        // Extra summary space must remain on screen, including short viewports.
        const height = clone.getBoundingClientRect().height;
        clone.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - height - 8))}px`;
      }
      calculatorOpen = true;
      document.documentElement.setAttribute('data-rr-inline-active', '');
      update();
    }
    document.addEventListener('keydown', e => {
      const target = e.composedPath()[0];
      if (e.code === 'Backquote' && !e.repeat && (calculatorOpen || !target?.matches?.('input,textarea,select,[contenteditable="true"]'))) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (calculatorOpen) close(); else open();
      } else if (e.key === 'Escape' && calculatorOpen) {
        e.preventDefault(); e.stopImmediatePropagation(); close();
      }
    }, true);
  }

})();
