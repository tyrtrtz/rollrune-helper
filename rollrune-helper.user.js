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

// Price checks use only the game's own auction filter controls.
(() => {
  'use strict';
  if (/^\/wiki(?:\/|$)/.test(location.pathname) || document.querySelector('[data-rr-price-style]')) return;
  const templates = ['最大生命提高 #%','+# 最大生命','每秒生命恢复 +.#%（按最大生命计算）','最大法力提高 #%','+# 最大法力','每秒法力恢复 +.#%（按最大法力计算）','+# 火焰防御','+# 毒素防御','+# 雷电防御','防御提高 #%','+#% 持续伤害闪避率','伤害额外提高 #%','攻击技能的伤害额外提高 #%','法术技能的伤害额外提高 #%','物理伤害额外提高 #%','火焰伤害额外提高 #%','毒素伤害额外提高 #%','雷电伤害额外提高 #%','暴击伤害额外提高 #%','暴击率提高 #%','法术技能的暴击率提高 #%','持续伤害额外提高 #%','诅咒技能的状态效果提高 #%','负面状态持续时间提高 #%','正面状态持续时间提高 #%','施加负面状态成功率提高 #%','生命恢复效果提高 #%','技能速度提高 #%','攻击技能的技能速度提高 #%','法术技能的技能速度提高 #%','移动速度提高 #%','金币获取量额外提高 #%','每次攻击技能命中恢复 # 生命','每次攻击技能命中恢复 # 法力','+# 技能等级','物品稀有度提高 #%','物品战力等级 +#','宝石获取量提高 #%'];
  const categories = ['不限','全部装备','全部武器','全部护甲','全部饰品','攻击武器','法术武器','近战武器','单手近战武器','双手近战武器','远程武器','盾牌','法器','护身符','胸甲','靴子','披风','手套','头盔','戒指','敕令','符文'];
  const rarities = ['不限','普通','魔法','稀有','大师杰作','暗金'];
  const style = document.createElement('style');
  style.dataset.rrPriceStyle = '';
  style.textContent = `
    [data-rr-price-form]{border-top:1px solid #715a32;margin-top:12px;padding-top:12px;color:#d8cfbc;text-align:left;font:13px/1.6 system-ui;white-space:normal;pointer-events:auto}
    [data-rr-price-form] h3{color:#f5d68a;font-weight:bold;margin:0 0 8px}
    [data-rr-price-form] label{display:flex;align-items:center;gap:6px;margin:7px 0}
    [data-rr-price-form] input:not([type=checkbox]),[data-rr-price-form] select{min-width:0;background:#19191c;border:1px solid #6c5329;color:#eee2c4;border-radius:4px;padding:5px;box-sizing:border-box}
    [data-rr-price-form] input[type=checkbox]{appearance:auto;width:14px;height:14px;flex:none;accent-color:#d5b16d}
    [data-rr-price-form] input[type=text]{flex:1;width:100%}
    [data-rr-price-form] select{flex:1}
    [data-rr-price-form] .rr-price-row{border-bottom:1px solid #38332b;padding:5px 0}
    [data-rr-price-form] .rr-price-row span{flex:1;color:#60a5fa}
    [data-rr-price-form] .rr-price-row input[type=number]{width:78px}
    [data-rr-price-form] .rr-price-note{font-size:11px;color:#aaa18d;margin:5px 0}
    [data-rr-price-form] button{padding:7px 10px;border:1px solid #806438;border-radius:4px;background:#30271b;color:#f5d68a;margin:6px 6px 0 0;cursor:pointer}
    [data-rr-price-form] button:disabled{opacity:.5;cursor:wait}
    [data-rr-price-form] [role=status]{color:#f2bb8b;font-size:12px}
    [data-rr-price-notice]{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:90vw;padding:12px 18px;border:1px solid #806438;border-radius:6px;background:#211e19;color:#f5d68a;font:14px/1.5 system-ui}
  `;
  document.head.append(style);
  // The game handles outside clicks before events reach the portalled item panel.
  // Keep native control defaults (focus, checkbox toggles, select and submit),
  // but do not let these interactions reach the game's dismissal handlers.
  for (const type of ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','touchstart','touchend']) {
    window.addEventListener(type, event => {
      const target = event.target instanceof Element ? event.target : null;
      const form = target?.closest('[data-rr-price-form]');
      if (!form) return;
      event.stopImmediatePropagation();
      if (type === 'click' && target.closest('[data-rr-price-close]')) form.remove();
    }, { capture: true });
  }
  const visible = e => e?.isConnected && e.getClientRects().length && !e.closest('[aria-hidden="true"]') && getComputedStyle(e).visibility !== 'hidden';
  const buttons = (root = document) => [...root.querySelectorAll('button')].filter(visible);
  const exact = (text, root = document) => buttons(root).find(b => b.textContent.trim() === text);
  const pause = ms => new Promise(r => setTimeout(r, ms));
  async function wait(get, message) {
    const end = Date.now() + 4000;
    while (Date.now() < end) { const result = get(); if (result) return result; await pause(60); }
    throw new Error(message);
  }
  function notice(message) {
    document.querySelector('[data-rr-price-notice]')?.remove();
    const box = document.createElement('div');box.dataset.rrPriceNotice='';box.textContent=message;box.setAttribute('role','status');document.body.append(box);setTimeout(()=>box.remove(),10000);
  }
  const normalized = text => text.replace(/[（(]\s*[+-]?\d+(?:\.\d+)?\s*[%％]?\s*[~～–-]\s*[+-]?\d+(?:\.\d+)?\s*[%％]?\s*[）)]/g,'').replace(/\d+(?:\.\d+)?/g,'#').replace(/\.#/g,'#').replace(/\s/g,'').replace(/％/g,'%');
  function readItem(tip) {
    const header = tip.firstElementChild;
    const name = header?.querySelector('strong li')?.textContent.trim();
    const type = [...(header?.querySelectorAll('li') || [])].map(e=>e.textContent.trim()).find(t=>/^(大师杰作|普通|魔法|稀有|暗金)\s/.test(t)) || '';
    const rarity = type.match(/^(大师杰作|普通|魔法|稀有|暗金)/)?.[0] || '不限';
    let category = categories.filter(c=>c!=='不限'&&type.includes(c)).sort((a,b)=>b.length-a.length)[0];
    if (!category) category = /双手武器/.test(type)?'全部武器':/单手武器/.test(type)?'全部武器':/副手/.test(type)?'不限':'不限';
    const rows = [];
    for (const li of tip.querySelectorAll('li.text-blue-400')) {
      // Nested triggered effects are not unconditional auction affixes.
      if (li.parentElement.closest('li')) continue;
      const text = li.textContent.trim();
      const template = templates.find(t=>normalized(t)===normalized(text));
      if (template && rows.some(r=>r.template===template)) continue;
      // Matched templates contain one numeric affix value; roll ranges follow it.
      const value = template ? text.match(/[+-]?\d+(?:\.\d+)?/)?.[0] : null;
      rows.push({text, template, value: value == null ? '' : String(Number(value))});
    }
    return { name, rarity, category, rows };
  }
  function field(tag, props = {}) { const e=document.createElement(tag);Object.assign(e,props);return e; }
  function showForm(tip, cancel) {
    if (tip.querySelector('[data-rr-price-form]')) return;
    const item = readItem(tip);
    if (!item.name) { notice('没有读到装备名称，请重新点击装备后查价。');return; }
    const form=field('form');form.dataset.rrPriceForm='';
    form.append(field('h3',{textContent:'查价 · '+item.name}));
    const useName=field('input',{type:'checkbox',checked:item.rarity==='暗金'});
    const name=field('input',{type:'text',value:item.name});name.setAttribute('aria-label','查价物品名称');
    const nameLabel=field('label');nameLabel.append(useName,field('span',{textContent:'名称'}),name);form.append(nameLabel);
    form.append(field('p',{className:'rr-price-note',textContent:'中文名称搜索仅适用于暗金。其他装备可取消名称，按属性查价。'}));
    function select(label,options,value) {const row=field('label');const input=field('select');input.setAttribute('aria-label',label);options.forEach(t=>input.append(field('option',{value:t,textContent:t})));input.value=value;row.append(field('span',{textContent:label}),input);form.append(row);return input;}
    const rarity=select('稀有度',rarities,item.rarity), category=select('部位',categories,item.category);
    form.append(field('p',{className:'rr-price-note',textContent:'勾选属性（最多 5 条），默认带入当前实际值作为最低值，可修改或清空。按价格从低到高显示。'}));
    const picks=item.rows.map(row=>{
      const label=field('label',{className:'rr-price-row'}),check=field('input',{type:'checkbox',disabled:!row.template}),min=field('input',{type:'number',placeholder:'最低值',step:'any',value:row.value,disabled:true});
      min.setAttribute('aria-label',row.text+' 最低值');
      const text=field('span',{textContent:row.text+(row.template?'':'（拍卖行不支持）')});label.append(check,text);if(row.template)label.append(min);form.append(label);
      check.addEventListener('change',()=>{min.disabled=!check.checked;});return {...row,check,min};
    });
    if (!item.rows.length) form.append(field('p',{className:'rr-price-note',textContent:'当前说明中没有可选词条，可按名称、稀有度和部位搜索。'}));
    const status=field('div');status.setAttribute('role','status');form.append(status);
    const go=field('button',{type:'submit',textContent:'去拍卖行搜索'}),close=field('button',{type:'button',textContent:'收起'});close.dataset.rrPriceClose='';form.append(go,close);
    for(const event of ['pointerdown','pointerup','click','keydown','keyup'])form.addEventListener(event,e=>e.stopPropagation());
    form.addEventListener('submit',async e=>{
      e.preventDefault();e.stopPropagation();const selected=picks.filter(r=>r.check.checked);
      if(selected.length>5){status.textContent='拍卖行最多支持 5 条属性，请减少勾选。';return;}
      if(selected.some(r=>r.min.value!==''&&!Number.isFinite(Number(r.min.value)))){status.textContent='请填写有效的最低值。';return;}
      const query={name:useName.checked?name.value.trim():'',rarity:rarity.value,category:category.value,rows:selected.map(r=>({template:r.template,min:r.min.value}))};
      go.disabled=true;status.textContent='正在填写拍卖行筛选…';
      try{await search(query,cancel);form.remove();}catch(error){status.textContent=error.message;notice('查价未完成：'+error.message);go.disabled=false;}
    });
    tip.append(form);form.scrollIntoView({block:'nearest'});
  }
  function setInput(input,value) { if(!input)throw new Error('找不到拍卖行输入框');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true})); }
  async function choose(button,value) {
    if(!button)throw new Error('拍卖行筛选布局已变化');
    if(button.getAttribute('aria-expanded')!=='true')button.click();
    await pause(80);
    const option=await wait(()=>[...button.parentElement.querySelectorAll('[role=option]')].find(e=>e.textContent.trim()===value),'拍卖行不支持筛选：'+value);
    option.click();
    await wait(()=>button.textContent.replace(/▼/g,'').trim()===value,'筛选未生效：'+value);
  }
  async function search(query,cancel) {
    if(cancel.isConnected)cancel.click();
    const auction=exact('拍卖行');if(!auction)throw new Error('当前页面没有拍卖行入口');auction.click();
    (await wait(()=>exact('筛选'),'拍卖行未打开，请稍后重试')).click();
    await wait(()=>visible(document.querySelector('#item_name')),'拍卖行筛选未加载');
    let root=document.querySelector('#item_name').parentElement;
    while(root && !(root.querySelectorAll('[aria-haspopup=listbox]').length>=8 && exact('重置',root)))root=root.parentElement;
    if(!root||root===document.body)throw new Error('无法确定拍卖行筛选区域');
    exact('重置',root).click();
    await wait(()=>[...root.querySelectorAll('input[id]')].filter(e=>!e.id.startsWith('stat_value_')).every(e=>e.value===''),'基础筛选未清空，请重试');
    // Native Reset leaves affix rows intact. Remove them through their own controls.
    for (let remaining = 5; root.querySelector('input[id^="stat_value_"]') && remaining > 0; remaining--) {
      const count = root.querySelectorAll('input[id^="stat_value_"]').length;
      const remove = exact('❌', root);
      if (!remove) throw new Error('无法删除旧属性筛选，已停止搜索');
      remove.click();
      await wait(()=>root.querySelectorAll('input[id^="stat_value_"]').length < count,'旧属性筛选未删除，请重试');
    }
    if (root.querySelector('input[id^="stat_value_"]')) throw new Error('旧属性条件未清空，已停止搜索');
    await pause(100);
    setInput(root.querySelector('#item_name'),query.name);
    await pause(300);
    const dropdown=label=>[...root.querySelectorAll('[aria-haspopup=listbox]')].find(b=>[...b.parentElement.parentElement.children].some(e=>e.tagName==='SPAN'&&e.textContent.trim()===label));
    await choose(dropdown('物品类别：'),query.category);
    await choose(dropdown('物品稀有度：'),query.rarity);
    await choose(dropdown('排序方式：'),'价格最低');
    for(let i=0;i<query.rows.length;i++){
      const row=query.rows[i];
      await choose([...root.querySelectorAll('[aria-haspopup=listbox]')].find(b=>b.textContent.includes('+ 添加属性筛选')),row.template);
      const input=await wait(()=>root.querySelectorAll('input[id^="stat_value_"]')[i],'属性数值输入框未加载');setInput(input,row.min);
    }
    const applied = [...root.querySelectorAll('input[id^="stat_value_"]')];
    if (applied.length !== query.rows.length || applied.some((input,i)=>input.value !== query.rows[i].min)) {
      throw new Error('属性条件与本次选择不一致，已停止搜索');
    }
    // The native purchase tab runs the search; never click the purchase-item action.
    (await wait(()=>exact('购买'),'找不到拍卖行结果页')).click();
    notice('已按所选条件查价，价格从低到高排列。');
  }
  let scheduled=false;
  function scan(){
    scheduled=false;
    for(const cancel of buttons().filter(b=>b.textContent.trim()==='取消'&&!b.disabled)){
      const menu=cancel.parentElement;
      if(menu.querySelector('[data-rr-price-button]') || !buttons(menu).some(b=>['装备','卸下','锁定','解锁','丢弃'].includes(b.textContent.trim())))continue;
      const button=field('button',{type:'button',textContent:'查价',className:cancel.className});button.dataset.rrPriceButton='';button.style.color='#f5d68a';
      button.addEventListener('pointerdown',e=>e.stopPropagation());
      button.addEventListener('click',e=>{
        e.preventDefault();e.stopPropagation();
        const card=menu.parentElement.parentElement.querySelector('.rr-item-card');
        const name=card?.getAttribute('aria-label');
        const selected=[...document.querySelectorAll('.selected-item-details .rr-layered-tooltip')].filter(visible);
        const tips=selected.length ? selected : [...document.querySelectorAll('.rr-game-tooltip .rr-layered-tooltip')].filter(visible).filter(t=>!name||t.firstElementChild?.querySelector('strong li')?.textContent.trim()===name);
        if(tips.length!==1){notice('请保持当前装备详情打开，再点击查价。');return;}
        showForm(tips[0],cancel);
      });menu.insertBefore(button,cancel);
    }
  }
  new MutationObserver(()=>{if(!scheduled){scheduled=true;setTimeout(scan,100);}}).observe(document.body,{childList:true,subtree:true});
  scan();
})();
