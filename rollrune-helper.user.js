// ==UserScript==
// @name         RollRune 敕令等级汇总
// @namespace    local.rollrune.edict-summary
// @version      0.7.6
// @description  游戏内敕令等级汇总、掉落等级显示、装备词条计算、一键查价、排行榜实时资料与自动制作装备。
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
          .filter(e => visible(e) && [...e.querySelectorAll('li')].some(li => /^(?:普通|魔法|稀有|大师杰作|暗金)?\s*(?:次级)?敕令$/.test(li.textContent.trim())));
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

// 在游戏原生“挂机中”列表中按角色名或 UUID 打开公开资料。
(() => {
  'use strict';
  if (/^\/wiki(?:\/|$)/.test(location.pathname)) return;

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const style = document.createElement('style');
  style.setAttribute('data-rr-character-style', '');
  style.textContent = `
    [data-rr-character-form]{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px;margin-bottom:4px;background:#18181b;border-bottom:1px solid #52525b;cursor:default}
    [data-rr-character-form] label{color:#e4c78f;white-space:nowrap}
    [data-rr-character-form] input{flex:1;min-width:140px;padding:5px 7px;color:#f4f4f5;background:#27272a;border:1px solid #71717a;border-radius:4px;user-select:text}
    [data-rr-character-form] button{padding:5px 9px;color:#f5d68a;background:#3b2c19;border:1px solid #8b6b3b;border-radius:4px;cursor:pointer}
    [data-rr-character-error]{width:100%;color:#fca5a5;text-align:left}
    [data-rr-live-profile]{flex:none;white-space:nowrap;color:#fcd34d;font-size:12px;font-weight:600;line-height:1.5;cursor:pointer}
    [data-rr-live-profile]:hover{color:#fef3c7}
  `;
  document.head.append(style);

  function findPopup() {
    for (const label of document.querySelectorAll('span')) {
      if (label.textContent.trim() !== '挂机中') continue;
      const indicator = label.parentElement?.parentElement;
      if (!indicator?.classList.contains('fixed') || !indicator.classList.contains('bottom-2')) continue;
      const popup = [...indicator.children].find(child => child.classList.contains('absolute') && child.classList.contains('bottom-full'));
      if (popup) return popup;
    }
    return null;
  }

  function mount() {
    mountLeaderboard();
    const popup = findPopup();
    if (!popup || popup.querySelector('[data-rr-character-form]')) return;
    const form = document.createElement('form');
    form.setAttribute('data-rr-character-form', '');
    form.innerHTML = '<label for="rr-character-id">查角色</label><input id="rr-character-id" name="character-id" type="text" autocomplete="off" spellcheck="false" placeholder="输入角色名或 UUID" aria-label="角色名或 ID"><button type="submit">查看资料</button><span data-rr-character-error role="status" hidden></span>';
    // 原生列表的外层点击会切换弹窗；表单内部交互不应触发它。
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']) {
      form.addEventListener(type, event => event.stopPropagation());
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      event.stopPropagation();
      const input = form.elements.namedItem('character-id');
      let value = input.value.trim();
      const error = form.querySelector('[data-rr-character-error]');
      if (/^https?:\/\//i.test(value)) {
        try {
          const link = new URL(value);
          if (!['rollrune.top', 'direct.rollrune.top'].includes(link.hostname) || !/^\/view-character\//.test(link.pathname)) throw new Error('invalid profile link');
          value = decodeURIComponent(link.pathname.slice('/view-character/'.length));
        } catch {
          error.textContent = '请输入角色名、完整 UUID 或游戏资料链接';
          error.hidden = false;
          return;
        }
      }
      const id = value.startsWith('id/') ? value.slice(3) : value;
      const isId = uuid.test(id);
      const name = isId ? '' : value;
      if (!isId && (!name || name.length > 80 || /[\x00-\x1f/\\]/.test(name) || name.startsWith('id/'))) {
        error.textContent = '请输入角色名、完整 UUID 或游戏资料链接';
        error.hidden = false;
        return;
      }
      location.assign(isId
        ? `${location.origin}/view-character/id/${id.toLowerCase()}`
        : `${location.origin}/view-character/${encodeURIComponent(name)}`);
    });
    popup.prepend(form);
  }

  function mountLeaderboard() {
    for (const dialog of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
      if (!dialog.querySelector('aside[aria-label="地图列表"]')) continue;
      const rows = new Set([...dialog.querySelectorAll('button[aria-label$="· 查看配装与天赋 →"]')]
        .map(button => button.closest('div.grid')).filter(Boolean));
      for (const row of rows) {
        const nameLine = row.children[1]?.firstElementChild;
        const currentName = () => nameLine?.querySelector('span[title]')?.getAttribute('title')?.trim();
        const name = currentName();
        if (!name) continue;
        let button = nameLine.querySelector('[data-rr-live-profile]');
        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('data-rr-live-profile', '');
          button.textContent = '查看实时信息';
          button.addEventListener('click', event => {
            event.stopPropagation();
            const liveName = currentName();
            if (liveName) location.assign(`${location.origin}/view-character/${encodeURIComponent(liveName)}`);
          });
          nameLine.append(button);
        }
        const label = `${name} · 查看实时信息`;
        const title = `查看 ${name} 的实时资料`;
        if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
        if (button.title !== title) button.title = title;
      }
    }
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; mount(); }, 50);
  }).observe(document.body, { childList: true, characterData: true, attributes: true, attributeFilter: ['title'], subtree: true });
  mount();
})();

// Pure crafting rules. No requests or game state mutations.
(function (root) {
  'use strict';
  const number = '([+-]?\\d+(?:\\.\\d+)?)';
  const clean = text => text.replace(/[（(][^）)]*[）)]/g, '').replace(/\s/g, '').replace(/％/g, '%').replace(/本装备的?/g, '').replace(/敌人的?/g, '');
  function readStat(label, text) {
    const fixed = /（固定/.test(label);
    let key = label.replace(/（[^）]*）/g, '').replace(/^敌人/, '');
    const value = clean(text);
    const aliases = {
      '法术伤害额外提高': ['法术技能的伤害额外提高'],
      '伤害提高': ['物理伤害提高'],
      '物理防御提高': ['防御提高'], '物理防御': ['防御'],
      '掉落物品稀有度提高': ['物品稀有度提高'],
      '掉落物品战力等级提高': ['物品战力等级'],
      '精英怪物宝石奖励提高': ['宝石获取量提高'],
      '诅咒技能的持续效果抗性': ['诅咒抗性'],
    };
    const keys = [key, ...(aliases[key] || [])];
    let patterns = [];
    if (key === '法力恢复' || key === '生命恢复') {
      patterns = [`^每秒${key}\\+?${number}%$`, `^${key}\\+?${number}%$`];
    } else if (/攻击技能命中恢复/.test(key)) {
      const resource = key.endsWith('法力') ? '法力' : '生命';
      patterns = [`^每次攻击技能命中恢复${number}${resource}$`, `^攻击技能命中恢复${resource}\\+?${number}$`];
    } else if (/^(最低|最高).+伤害$/.test(key)) {
      const element = key.match(/^(?:最低|最高)(.+)伤害$/)[1];
      const pair = value.match(new RegExp(`^(?:附加|添加)?${number}[～~–-]${number}${element}伤害$`));
      if (pair) return Number(pair[key.startsWith('最低') ? 1 : 2]);
      patterns = [`^${key}[:：]?\\+?${number}$`, `^\\+?${number}${key}$`];
    } else if (key === '掉落物品战力等级提高') {
      patterns = keys.map(k => `^${k}\\+?${number}$`);
    } else if (key.endsWith('提高') || key.endsWith('降低')) {
      patterns = keys.map(k => `^${k}${number}%$`);
    } else if (fixed || /^(最大生命|最大法力|技能等级)$/.test(key)) {
      patterns = keys.flatMap(k => [`^\\+${number}%?${k}$`, `^${k}[:：]?\\+?${number}%?$`]);
    }
    for (const pattern of patterns) {
      const match = value.match(new RegExp(pattern));
      if (match) return Number(match[1]);
    }
    return null;
  }
  function families(category) {
    return ['prefixes', 'suffixes'].flatMap(side => category[side].map(label => ({
      id: `${side}:${encodeURIComponent(label)}`, side, label, stats: label.split(' / '),
      supported: !label.includes('额外获得等同于基础命中伤害'),
    })));
  }
  function readFamily(family, affix) {
    if (family.side !== affix.side) return null;
    const covered = new Set();
    const values = family.stats.map(stat => {
      for (let i = 0; i < affix.lines.length; i++) {
        const n = readStat(stat, affix.lines[i]);
        if (n !== null) { covered.add(i); return n; }
      }
      return null;
    });
    // A hybrid affix must not also count as its single-stat relative.
    return values.every(n => n !== null) && covered.size === affix.lines.length ? values : null;
  }
  function evaluate(affixes, targets) {
    const matched = targets.filter(target => affixes.some(affix => {
      const values = readFamily(target, affix);
      return values && values.every((n, i) => target.minimums[i] === null || n >= target.minimums[i]);
    }));
    return { total: matched.length, prefixes: matched.filter(t => t.side === 'prefixes').length,
      suffixes: matched.filter(t => t.side === 'suffixes').length, matched };
  }
  function allocations(targets, required, tier = 'auto') {
    if (!Number.isInteger(required) || required < 1 || required > 5 || required > targets.length) {
      throw new Error('停止条数必须是 1～5，且不能超过勾选的目标数量');
    }
    const np = targets.filter(t => t.side === 'prefixes').length;
    const ns = targets.filter(t => t.side === 'suffixes').length;
    const options = [];
    for (let p = 0; p <= Math.min(3, np); p++) {
      const s = required - p;
      if (s < 0 || s > Math.min(3, ns)) continue;
      const k = Math.max(Math.min(p, s), Math.max(p, s) - 1);
      const base = tier === 'auto' ? k : Number(tier);
      if (!Number.isInteger(base) || base < k || base > 2) continue;
      options.push({ prefixes: p, suffixes: s, base, peak: 2 * base + 1 });
    }
    if (!options.length) throw new Error('该档位无法满足目标：每栏最多 3 条，换用更高档位或减少目标');
    const minBase = Math.min(...options.map(o => o.base));
    return options.filter(o => o.base === minBase);
  }
  function plan(state, targets, required, options, pendingRemoval = false) {
    const score = evaluate(state.affixes, targets);
    if (score.total >= required) return { action: 'stop', reason: `已满足 ${score.total}/${required} 条目标`, score };
    const p = state.affixes.filter(a => a.side === 'prefixes').length;
    const s = state.affixes.length - p;
    if (p > 3 || s > 3 || p + s > 5 || Math.abs(p - s) > 1) {
      throw new Error('当前前后缀数量不符合已核对的锻造规则，已暂停');
    }
    if (state.affixes.some(a => !a.lines.length)) throw new Error('词缀说明尚未读完整，已暂停');
    const base = options[0].base;
    if (pendingRemoval || p + s > 2 * base) return { action: 'remove', score, reason: p === s ? '降低到循环档位（随机移除可能影响任一栏）' : `剥离较多的${p > s ? '前缀' : '后缀'}` };
    if (p !== s) return { action: 'add', score, reason: `补齐较少的${p < s ? '前缀' : '后缀'}` };
    const candidates = options.flatMap(o => ['prefixes', 'suffixes'].filter(finalSide => o[finalSide] <= base + 1 && o[finalSide] > 0 && o[finalSide === 'prefixes' ? 'suffixes' : 'prefixes'] <= base)
      .map(finalSide => {
        const other = finalSide === 'prefixes' ? 'suffixes' : 'prefixes';
        const protectedColumn = score[other] >= o[other];
        const side = protectedColumn ? finalSide : other;
        return { side, goal: o, protected: protectedColumn, deficit: o[side] - score[side] };
      }));
    // Once the other column has enough targets, keep it and reroll this column.
    candidates.sort((a, b) => Number(b.protected) - Number(a.protected) || b.deficit - a.deficit || a.goal[a.side] - b.goal[b.side]);
    const chosen = candidates[0];
    if (!chosen) throw new Error('没有可执行的前后缀组合');
    if (new Set(candidates.map(c => c.side)).size === 2) return { action: 'add', score, reason: '两栏都有可接受目标，使用随机添加' };
    return { action: chosen.side === 'prefixes' ? 'prefix' : 'suffix', score,
      reason: p < base ? '建立循环底板' : `${chosen.protected ? '保留另一栏，' : ''}尝试目标${chosen.side === 'prefixes' ? '前缀' : '后缀'}` };
  }
  function readAffixes(tooltip) {
    const affixes = [];
    for (const ul of tooltip.querySelectorAll('ul')) {
      if (ul.closest('li')) continue;
      let current = null;
      for (const li of ul.children) {
        if (li.tagName !== 'LI') continue;
        const header = li.textContent.trim().match(/^(前缀|后缀)\s*[‘'「]/);
        if (header) {
          current = { side: header[1] === '前缀' ? 'prefixes' : 'suffixes', header: li.textContent.trim(), lines: [] };
          affixes.push(current);
        } else if (current && li.classList.contains('text-blue-400')) {
          current.lines.push(li.textContent.trim());
        } else current = null;
      }
    }
    return affixes;
  }
  const api = { readStat, families, readFamily, evaluate, allocations, plan, readAffixes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RollRuneCraftingCore = api;
})(typeof window === 'undefined' ? globalThis : window);

// Craft only through the currently selected item's native forge buttons.
(() => {
  'use strict';
  if (/^\/wiki(?:\/|$)/.test(location.pathname) || document.querySelector('[data-rr-craft-style]')) return;
  const core = window.RollRuneCraftingCore;
  const catalog = {"source":"https://direct.rollrune.top:34569/wiki/affixes","observedAt":"2026-10-01","categories":[{"name":"披风","prefixes":["攻击技能的技能速度提高","毒素伤害额外提高","法术技能的技能速度提高","火焰伤害额外提高","物理伤害额外提高","雷电伤害额外提高"],"suffixes":["持续伤害闪避率（固定调整）","毒素防御（固定调整）","法力恢复（固定调整）","火焰防御（固定调整）","生命恢复（固定调整）","金币获取量额外提高","雷电防御（固定调整）"],"tiers":{"prefixes:攻击技能的技能速度提高":[{"name":"Nimble","tier":1,"level":1,"variant":"","ranges":["4～6%"]},{"name":"Quick","tier":2,"level":50,"variant":"","ranges":["7～9%"]},{"name":"Swift","tier":3,"level":100,"variant":"","ranges":["10～12%"]},{"name":"Brisk","tier":4,"level":150,"variant":"","ranges":["13～15%"]},{"name":"Sudden","tier":5,"level":200,"variant":"","ranges":["16～18%"]},{"name":"Impulsive","tier":6,"level":260,"variant":"","ranges":["19～21%"]},{"name":"Precipitate","tier":7,"level":330,"variant":"","ranges":["22～24%"]},{"name":"Abrupt","tier":8,"level":410,"variant":"","ranges":["25～27%"]},{"name":"Immediate","tier":9,"level":500,"variant":"","ranges":["28～30%"]},{"name":"Unforeseen","tier":10,"level":600,"variant":"","ranges":["31～33%"]}],"prefixes:毒素伤害额外提高":[{"name":"Sick","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Ill","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Diseased","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Plagued","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Pestiferous","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Septic","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Cancerous","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Putrid","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Necrotic","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Pandemic","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:法术技能的技能速度提高":[{"name":"Spiraling","tier":1,"level":1,"variant":"","ranges":["4～6%"]},{"name":"Veering","tier":2,"level":50,"variant":"","ranges":["7～9%"]},{"name":"Surging","tier":3,"level":100,"variant":"","ranges":["10～12%"]},{"name":"Soaring","tier":4,"level":150,"variant":"","ranges":["13～15%"]},{"name":"Warping","tier":5,"level":200,"variant":"","ranges":["16～18%"]},{"name":"Distorting","tier":6,"level":260,"variant":"","ranges":["19～21%"]},{"name":"Skewed","tier":7,"level":330,"variant":"","ranges":["22～24%"]},{"name":"Displaced","tier":8,"level":410,"variant":"","ranges":["25～27%"]},{"name":"Anomalous","tier":9,"level":500,"variant":"","ranges":["28～30%"]},{"name":"Paradoxical","tier":10,"level":600,"variant":"","ranges":["31～33%"]}],"prefixes:火焰伤害额外提高":[{"name":"Tepid","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Warm","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Heated","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Hot","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Torrid","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Fiery","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Molten","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Igneous","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Sulfurous","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Infernal","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:物理伤害额外提高":[{"name":"Striking","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Lashing","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Pummeling","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Breaking","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Crushing","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Smashing","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Fracturing","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Shattering","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Destroying","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Ravaging","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:雷电伤害额外提高":[{"name":"Charged","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Foaming","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Conductive","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Swirling","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Voltaic","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Turbulent","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Uproaring","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Fulminating","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Hazardous","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Maelstromic","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:持续伤害闪避率（固定调整）":[{"name":"of Dodging","tier":1,"level":1,"variant":"","ranges":["1～2%"]},{"name":"of Evasion","tier":2,"level":50,"variant":"","ranges":["3～4%"]},{"name":"of Footwork","tier":3,"level":100,"variant":"","ranges":["5～6%"]},{"name":"of Agility","tier":4,"level":150,"variant":"","ranges":["7～8%"]},{"name":"of Elusion","tier":5,"level":200,"variant":"","ranges":["9～10%"]},{"name":"of Fleetness","tier":6,"level":260,"variant":"","ranges":["11～12%"]},{"name":"of Phasing","tier":7,"level":330,"variant":"","ranges":["13～14%"]},{"name":"of Ghosting","tier":8,"level":410,"variant":"","ranges":["15～16%"]},{"name":"of Intangibility","tier":9,"level":500,"variant":"","ranges":["17～18%"]},{"name":"of Untouchability","tier":10,"level":600,"variant":"","ranges":["19～20%"]}],"suffixes:毒素防御（固定调整）":[{"name":"of Venomscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Venomfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Venomguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Venomshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Venomveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Venomward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Venommantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Venomscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Venommail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Venomplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:法力恢复（固定调整）":[{"name":"of Flow","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Stream","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Current","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Progress","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Growth","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Cogitation","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Meditation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Tranquility","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Enlightenment","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Nirvana","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:火焰防御（固定调整）":[{"name":"of Emberscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Emberfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Emberguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Embershield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Emberveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Emberward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Embermantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Emberscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Embermail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Emberplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:生命恢复（固定调整）":[{"name":"of Regeneration","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Vigor","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Restoration","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Endurance","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Vitality","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Renewal","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Rejuvenation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Invigoration","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Perpetuity","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Immortality","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:金币获取量额外提高":[{"name":"of Greed","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Cupidity","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Avarice","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Covetousness","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Rapacity","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Plunder","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Pillage","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Looting","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Hoarding","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Gluttony","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:雷电防御（固定调整）":[{"name":"of Tempestscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Tempestfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Tempestguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Tempestshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Tempestveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Tempestward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Tempestmantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Tempestscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Tempestmail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Tempestplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}]}},{"name":"头盔","prefixes":["威胁值获取降低","最大法力提高","最大生命提高","最大生命（固定调整）","物理防御提高（本地）","物理防御（固定调整）（本地）"],"suffixes":["毒素防御（固定调整）","法力恢复（固定调整）","火焰防御（固定调整）","生命恢复（固定调整）","金币获取量额外提高","雷电防御（固定调整）"],"tiers":{"prefixes:威胁值获取降低":[{"name":"Sneaky","tier":1,"level":1,"variant":"","ranges":["10～15%"]},{"name":"Furtive","tier":2,"level":50,"variant":"","ranges":["20～25%"]},{"name":"Stealthy","tier":3,"level":100,"variant":"","ranges":["30～35%"]},{"name":"Hidden","tier":4,"level":150,"variant":"","ranges":["40～45%"]},{"name":"Veiled","tier":5,"level":200,"variant":"","ranges":["50～55%"]},{"name":"Masked","tier":6,"level":260,"variant":"","ranges":["60～65%"]},{"name":"Cloaked","tier":7,"level":330,"variant":"","ranges":["70～75%"]},{"name":"Shadowed","tier":8,"level":410,"variant":"","ranges":["80～85%"]},{"name":"Obscured","tier":9,"level":500,"variant":"","ranges":["90～95%"]},{"name":"Invisible","tier":10,"level":600,"variant":"","ranges":["100～120%"]}],"prefixes:最大法力提高":[{"name":"Thoughtful","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"Cognitive","tier":2,"level":50,"variant":"","ranges":["5～7%"]},{"name":"Analytical","tier":3,"level":100,"variant":"","ranges":["8～10%"]},{"name":"Knowing","tier":4,"level":150,"variant":"","ranges":["11～13%"]},{"name":"Sagacious","tier":5,"level":200,"variant":"","ranges":["14～16%"]},{"name":"Insightful","tier":6,"level":260,"variant":"","ranges":["17～19%"]},{"name":"Intelligent","tier":7,"level":330,"variant":"","ranges":["20～22%"]},{"name":"Intuitive","tier":8,"level":410,"variant":"","ranges":["23～25%"]},{"name":"Gifted","tier":9,"level":500,"variant":"","ranges":["26～28%"]},{"name":"Genius","tier":10,"level":600,"variant":"","ranges":["29～32%"]}],"prefixes:最大生命提高":[{"name":"Hefty","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"Robust","tier":2,"level":50,"variant":"","ranges":["5～6%"]},{"name":"Stout","tier":3,"level":100,"variant":"","ranges":["7～8%"]},{"name":"Beefy","tier":4,"level":150,"variant":"","ranges":["9～10%"]},{"name":"Endurant","tier":5,"level":200,"variant":"","ranges":["11～12%"]},{"name":"Hulking","tier":6,"level":260,"variant":"","ranges":["13～14%"]},{"name":"Resistant","tier":7,"level":330,"variant":"","ranges":["15～16%"]},{"name":"Tenacious","tier":8,"level":410,"variant":"","ranges":["17～18%"]},{"name":"Resilient","tier":9,"level":500,"variant":"","ranges":["19～20%"]},{"name":"Stalwart","tier":10,"level":600,"variant":"","ranges":["21～22%"]}],"prefixes:最大生命（固定调整）":[{"name":"Lively","tier":1,"level":1,"variant":"","ranges":["10～15"]},{"name":"Healthy","tier":2,"level":50,"variant":"","ranges":["20～25"]},{"name":"Hearty","tier":3,"level":100,"variant":"","ranges":["30～35"]},{"name":"Enduring","tier":4,"level":150,"variant":"","ranges":["40～45"]},{"name":"Vigorous","tier":5,"level":200,"variant":"","ranges":["50～55"]},{"name":"Burly","tier":6,"level":260,"variant":"","ranges":["60～65"]},{"name":"Brawny","tier":7,"level":330,"variant":"","ranges":["70～75"]},{"name":"Solid","tier":8,"level":410,"variant":"","ranges":["80～85"]},{"name":"Imposing","tier":9,"level":500,"variant":"","ranges":["90～95"]},{"name":"Formidable","tier":10,"level":600,"variant":"","ranges":["100～120"]}],"prefixes:物理防御提高（本地）":[{"name":"Tough","tier":1,"level":1,"variant":"","ranges":["20～35%"]},{"name":"Sturdy","tier":2,"level":50,"variant":"","ranges":["45～55%"]},{"name":"Reinforcing","tier":3,"level":100,"variant":"","ranges":["65～75%"]},{"name":"Bulwarked","tier":4,"level":150,"variant":"","ranges":["85～95%"]},{"name":"Protective","tier":5,"level":200,"variant":"","ranges":["105～115%"]},{"name":"Defensive","tier":6,"level":260,"variant":"","ranges":["125～135%"]},{"name":"Guardian","tier":7,"level":330,"variant":"","ranges":["145～155%"]},{"name":"Sentinel","tier":8,"level":410,"variant":"","ranges":["165～175%"]},{"name":"Bastion","tier":9,"level":500,"variant":"","ranges":["185～195%"]},{"name":"Fortress","tier":10,"level":600,"variant":"","ranges":["205～220%"]}],"prefixes:物理防御（固定调整）（本地）":[{"name":"Patched","tier":1,"level":1,"variant":"","ranges":["5～10"]},{"name":"Reinforced","tier":2,"level":50,"variant":"","ranges":["15～20"]},{"name":"Fortified","tier":3,"level":100,"variant":"","ranges":["25～30"]},{"name":"Bolstered","tier":4,"level":150,"variant":"","ranges":["35～40"]},{"name":"Hardened","tier":5,"level":200,"variant":"","ranges":["45～50"]},{"name":"Adamant","tier":6,"level":260,"variant":"","ranges":["55～60"]},{"name":"Impenetrable","tier":7,"level":330,"variant":"","ranges":["65～70"]},{"name":"Unyielding","tier":8,"level":410,"variant":"","ranges":["75～80"]},{"name":"Unassailable","tier":9,"level":500,"variant":"","ranges":["85～90"]},{"name":"Invincible","tier":10,"level":600,"variant":"","ranges":["95～100"]}],"suffixes:毒素防御（固定调整）":[{"name":"of Venomscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Venomfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Venomguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Venomshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Venomveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Venomward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Venommantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Venomscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Venommail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Venomplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:法力恢复（固定调整）":[{"name":"of Flow","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Stream","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Current","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Progress","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Growth","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Cogitation","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Meditation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Tranquility","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Enlightenment","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Nirvana","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:火焰防御（固定调整）":[{"name":"of Emberscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Emberfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Emberguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Embershield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Emberveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Emberward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Embermantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Emberscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Embermail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Emberplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:生命恢复（固定调整）":[{"name":"of Regeneration","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Vigor","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Restoration","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Endurance","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Vitality","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Renewal","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Rejuvenation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Invigoration","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Perpetuity","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Immortality","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:金币获取量额外提高":[{"name":"of Greed","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Cupidity","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Avarice","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Covetousness","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Rapacity","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Plunder","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Pillage","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Looting","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Hoarding","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Gluttony","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:雷电防御（固定调整）":[{"name":"of Tempestscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Tempestfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Tempestguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Tempestshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Tempestveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Tempestward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Tempestmantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Tempestscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Tempestmail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Tempestplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}]}},{"name":"护身符","prefixes":["暴击伤害提高","最大法力提高","毒素伤害额外提高","火焰伤害额外提高","物理伤害额外提高","金币获取量额外提高","雷电伤害额外提高"],"suffixes":["技能等级（固定调整）","攻击技能的伤害额外提高","攻击技能的伤害额外提高 / 攻击技能的技能速度降低","毒素防御（固定调整）","法术伤害额外提高","法术伤害额外提高 / 法术技能的法力消耗提高","火焰防御（固定调整）","金币获取量额外提高","雷电防御（固定调整）"],"tiers":{"prefixes:暴击伤害提高":[{"name":"Harmful","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Dangerous","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Grievous","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Lethal","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Mortal","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Deadly","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Fatal","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Grim","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Terrible","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Terminal","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:最大法力提高":[{"name":"Thoughtful","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"Cognitive","tier":2,"level":50,"variant":"","ranges":["5～7%"]},{"name":"Analytical","tier":3,"level":100,"variant":"","ranges":["8～10%"]},{"name":"Knowing","tier":4,"level":150,"variant":"","ranges":["11～13%"]},{"name":"Sagacious","tier":5,"level":200,"variant":"","ranges":["14～16%"]},{"name":"Insightful","tier":6,"level":260,"variant":"","ranges":["17～19%"]},{"name":"Intelligent","tier":7,"level":330,"variant":"","ranges":["20～22%"]},{"name":"Intuitive","tier":8,"level":410,"variant":"","ranges":["23～25%"]},{"name":"Gifted","tier":9,"level":500,"variant":"","ranges":["26～28%"]},{"name":"Genius","tier":10,"level":600,"variant":"","ranges":["29～32%"]}],"prefixes:毒素伤害额外提高":[{"name":"Sick","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Ill","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Diseased","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Plagued","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Pestiferous","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Septic","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Cancerous","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Putrid","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Necrotic","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Pandemic","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:火焰伤害额外提高":[{"name":"Tepid","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Warm","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Heated","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Hot","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Torrid","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Fiery","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Molten","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Igneous","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Sulfurous","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Infernal","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:物理伤害额外提高":[{"name":"Striking","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Lashing","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Pummeling","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Breaking","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Crushing","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Smashing","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Fracturing","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Shattering","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Destroying","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Ravaging","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:金币获取量额外提高":[{"name":"Shiny","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Gleaming","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Glistening","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Lustrous","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Radiant","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Polished","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Brilliant","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Resplendent","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Gilded","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Opulent","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:雷电伤害额外提高":[{"name":"Charged","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Foaming","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Conductive","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Swirling","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Voltaic","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Turbulent","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Uproaring","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Fulminating","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Hazardous","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Maelstromic","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:技能等级（固定调整）":[{"name":"of Talent","tier":1,"level":1,"variant":"","ranges":["2～2"]},{"name":"of Proficiency","tier":2,"level":100,"variant":"","ranges":["3～3"]},{"name":"of Expertise","tier":3,"level":200,"variant":"","ranges":["4～4"]},{"name":"of Mastery","tier":4,"level":300,"variant":"","ranges":["5～5"]},{"name":"of Omniscience","tier":5,"level":400,"variant":"","ranges":["6～6"]},{"name":"of Transcendence","tier":6,"level":500,"variant":"","ranges":["7～7"]},{"name":"of Godhood","tier":7,"level":600,"variant":"","ranges":["8～8"]}],"suffixes:攻击技能的伤害额外提高":[{"name":"of Ire","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Temper","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Wrath","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Belligerence","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Ferocity","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Aggression","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Rage","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Hatred","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Fury","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Bloodlust","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:攻击技能的伤害额外提高 / 攻击技能的技能速度降低":[{"name":"of Caution","tier":1,"level":1,"variant":"","ranges":["50～90%","5～5%"]},{"name":"of Carefulness","tier":2,"level":50,"variant":"","ranges":["110～140%","10～10%"]},{"name":"of Attention","tier":3,"level":100,"variant":"","ranges":["160～190%","15～15%"]},{"name":"of Watchfulness","tier":4,"level":150,"variant":"","ranges":["210～240%","20～20%"]},{"name":"of Deliberation","tier":5,"level":200,"variant":"","ranges":["260～290%","25～25%"]},{"name":"of Focus","tier":6,"level":260,"variant":"","ranges":["320～360%","30～30%"]},{"name":"of Calculation","tier":7,"level":330,"variant":"","ranges":["390～440%","35～35%"]},{"name":"of Discipline","tier":8,"level":410,"variant":"","ranges":["470～530%","40～40%"]},{"name":"of Control","tier":9,"level":500,"variant":"","ranges":["560～640%","45～45%"]},{"name":"of Reckoning","tier":10,"level":600,"variant":"","ranges":["700～800%","50～50%"]}],"suffixes:毒素防御（固定调整）":[{"name":"of Venomscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Venomfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Venomguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Venomshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Venomveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Venomward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Venommantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Venomscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Venommail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Venomplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:法术伤害额外提高":[{"name":"of Spellcasting","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Wizardry","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Sorcery","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Thaumaturgy","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Arcanum","tier":5,"level":200,"variant":"","ranges":["120～145%"]},{"name":"of Theurgy","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Enchantment","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Incantation","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Conjuration","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Invocation","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:法术伤害额外提高 / 法术技能的法力消耗提高":[{"name":"of Confidence","tier":1,"level":1,"variant":"","ranges":["40～65%","25～25%"]},{"name":"of Presumption","tier":2,"level":50,"variant":"","ranges":["75～105%","50～50%"]},{"name":"of Vanity","tier":3,"level":100,"variant":"","ranges":["120～145%","75～75%"]},{"name":"of Arrogance","tier":4,"level":150,"variant":"","ranges":["155～180%","100～100%"]},{"name":"of Conceit","tier":5,"level":200,"variant":"","ranges":["190～215%","125～125%"]},{"name":"of Audacity","tier":6,"level":260,"variant":"","ranges":["240～270%","150～150%"]},{"name":"of Insolence","tier":7,"level":330,"variant":"","ranges":["290～330%","175～175%"]},{"name":"of Pride","tier":8,"level":410,"variant":"","ranges":["350～400%","200～200%"]},{"name":"of Ego","tier":9,"level":500,"variant":"","ranges":["420～480%","225～225%"]},{"name":"of Hubris","tier":10,"level":600,"variant":"","ranges":["525～600%","250～250%"]}],"suffixes:火焰防御（固定调整）":[{"name":"of Emberscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Emberfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Emberguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Embershield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Emberveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Emberward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Embermantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Emberscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Embermail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Emberplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:金币获取量额外提高":[{"name":"of Greed","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Cupidity","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Avarice","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Covetousness","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Rapacity","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Plunder","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Pillage","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Looting","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Hoarding","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Gluttony","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:雷电防御（固定调整）":[{"name":"of Tempestscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Tempestfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Tempestguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Tempestshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Tempestveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Tempestward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Tempestmantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Tempestscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Tempestmail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Tempestplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}]}},{"name":"攻击武器","prefixes":["伤害提高（本地）","最低毒素伤害（固定调整）（本地） / 最高毒素伤害（固定调整）（本地）","最低火焰伤害（固定调整）（本地） / 最高火焰伤害（固定调整）（本地）","最低物理伤害（固定调整）（本地） / 最高物理伤害（固定调整）（本地）","最高雷电伤害（固定调整）（本地）"],"suffixes":["持续伤害额外提高","攻击技能命中恢复法力（固定调整）","攻击技能命中恢复生命（固定调整）","攻击技能的技能速度提高（本地）","暴击伤害提高（本地）","暴击率提高（本地）"],"tiers":{"prefixes:伤害提高（本地）":[{"name":"Vicious","tier":1,"level":1,"variant":"","ranges":["20～35%"]},{"name":"Brutal","tier":2,"level":50,"variant":"","ranges":["45～55%"]},{"name":"Severe","tier":3,"level":100,"variant":"","ranges":["65～75%"]},{"name":"Ruthless","tier":4,"level":150,"variant":"","ranges":["85～95%"]},{"name":"Savage","tier":5,"level":200,"variant":"","ranges":["105～115%"]},{"name":"Ferocious","tier":6,"level":260,"variant":"","ranges":["130～145%"]},{"name":"Merciless","tier":7,"level":330,"variant":"","ranges":["160～180%"]},{"name":"Relentless","tier":8,"level":410,"variant":"","ranges":["195～220%"]},{"name":"Unstoppable","tier":9,"level":500,"variant":"","ranges":["235～270%"]},{"name":"Dominating","tier":10,"level":600,"variant":"","ranges":["300～350%"]}],"prefixes:最低毒素伤害（固定调整）（本地） / 最高毒素伤害（固定调整）（本地）":[{"name":"Nauseous","tier":1,"level":1,"variant":"单手近战","ranges":["1～1","2～3"]},{"name":"Nauseous","tier":1,"level":1,"variant":"双手近战／远程武器","ranges":["1～2","3～5"]},{"name":"Noxious","tier":2,"level":50,"variant":"单手近战","ranges":["3～3","4～6"]},{"name":"Noxious","tier":2,"level":50,"variant":"双手近战／远程武器","ranges":["4～5","6～9"]},{"name":"Foul","tier":3,"level":100,"variant":"单手近战","ranges":["4～5","6～8"]},{"name":"Foul","tier":3,"level":100,"variant":"双手近战／远程武器","ranges":["6～8","9～12"]},{"name":"Toxic","tier":4,"level":150,"variant":"单手近战","ranges":["6～6","7～9"]},{"name":"Toxic","tier":4,"level":150,"variant":"双手近战／远程武器","ranges":["9～9","10～14"]},{"name":"Venomous","tier":5,"level":200,"variant":"单手近战","ranges":["7～8","9～11"]},{"name":"Venomous","tier":5,"level":200,"variant":"双手近战／远程武器","ranges":["10～12","13～17"]},{"name":"Virulent","tier":6,"level":260,"variant":"单手近战","ranges":["9～9","10～12"]},{"name":"Virulent","tier":6,"level":260,"variant":"双手近战／远程武器","ranges":["13～14","15～18"]},{"name":"Corrosive","tier":7,"level":330,"variant":"单手近战","ranges":["10～11","12～14"]},{"name":"Corrosive","tier":7,"level":330,"variant":"双手近战／远程武器","ranges":["15～17","18～21"]},{"name":"Caustic","tier":8,"level":410,"variant":"单手近战","ranges":["12～12","13～15"]},{"name":"Caustic","tier":8,"level":410,"variant":"双手近战／远程武器","ranges":["18～18","19～23"]},{"name":"Acid","tier":9,"level":500,"variant":"单手近战","ranges":["13～14","15～17"]},{"name":"Acid","tier":9,"level":500,"variant":"双手近战／远程武器","ranges":["19～21","22～26"]},{"name":"Malignant","tier":10,"level":600,"variant":"单手近战","ranges":["15～15","16～18"]},{"name":"Malignant","tier":10,"level":600,"variant":"双手近战／远程武器","ranges":["22～23","24～27"]}],"prefixes:最低火焰伤害（固定调整）（本地） / 最高火焰伤害（固定调整）（本地）":[{"name":"Smouldering","tier":1,"level":1,"variant":"单手近战","ranges":["1～2","3～5"]},{"name":"Smouldering","tier":1,"level":1,"variant":"双手近战／远程武器","ranges":["1～3","4～8"]},{"name":"Searing","tier":2,"level":50,"variant":"单手近战","ranges":["2～5","6～8"]},{"name":"Searing","tier":2,"level":50,"variant":"双手近战／远程武器","ranges":["3～8","9～12"]},{"name":"Burning","tier":3,"level":100,"variant":"单手近战","ranges":["5～7","9～11"]},{"name":"Burning","tier":3,"level":100,"variant":"双手近战／远程武器","ranges":["7～11","13～17"]},{"name":"Blistering","tier":4,"level":150,"variant":"单手近战","ranges":["8～10","11～13"]},{"name":"Blistering","tier":4,"level":150,"variant":"双手近战／远程武器","ranges":["12～15","16～20"]},{"name":"Flaming","tier":5,"level":200,"variant":"单手近战","ranges":["10～13","14～16"]},{"name":"Flaming","tier":5,"level":200,"variant":"双手近战／远程武器","ranges":["15～20","21～24"]},{"name":"Scorching","tier":6,"level":260,"variant":"单手近战","ranges":["14～16","18～21"]},{"name":"Scorching","tier":6,"level":260,"variant":"双手近战／远程武器","ranges":["21～24","27～32"]},{"name":"Blazing","tier":7,"level":330,"variant":"单手近战","ranges":["17～19","21～23"]},{"name":"Blazing","tier":7,"level":330,"variant":"双手近战／远程武器","ranges":["25～29","31～35"]},{"name":"Combusting","tier":8,"level":410,"variant":"单手近战","ranges":["19～22","24～26"]},{"name":"Combusting","tier":8,"level":410,"variant":"双手近战／远程武器","ranges":["28～33","36～39"]},{"name":"Incinerating","tier":9,"level":500,"variant":"单手近战","ranges":["23～25","26～28"]},{"name":"Incinerating","tier":9,"level":500,"variant":"双手近战／远程武器","ranges":["34～38","39～43"]},{"name":"Immolating","tier":10,"level":600,"variant":"单手近战","ranges":["25～27","29～31"]},{"name":"Immolating","tier":10,"level":600,"variant":"双手近战／远程武器","ranges":["37～41","43～47"]}],"prefixes:最低物理伤害（固定调整）（本地） / 最高物理伤害（固定调整）（本地）":[{"name":"Sharp","tier":1,"level":1,"variant":"","ranges":["1～2","2～3"]},{"name":"Strong","tier":2,"level":50,"variant":"","ranges":["2～4","4～6"]},{"name":"Mighty","tier":3,"level":100,"variant":"","ranges":["4～6","7～9"]},{"name":"Overwhelming","tier":4,"level":150,"variant":"","ranges":["7～9","10～12"]},{"name":"Colossal","tier":5,"level":200,"variant":"","ranges":["10～12","13～15"]},{"name":"Monstrous","tier":6,"level":260,"variant":"","ranges":["13～15","16～18"]},{"name":"Enormous","tier":7,"level":330,"variant":"","ranges":["16～18","19～21"]},{"name":"Gargantuan","tier":8,"level":410,"variant":"","ranges":["19～21","22～24"]},{"name":"Titanic","tier":9,"level":500,"variant":"","ranges":["22～24","25～27"]},{"name":"Almighty","tier":10,"level":600,"variant":"","ranges":["25～27","28～30"]}],"prefixes:最高雷电伤害（固定调整）（本地）":[{"name":"Crackling","tier":1,"level":1,"variant":"单手近战","ranges":["4～7"]},{"name":"Crackling","tier":1,"level":1,"variant":"双手近战／远程武器","ranges":["6～11"]},{"name":"Shocking","tier":2,"level":50,"variant":"单手近战","ranges":["8～12"]},{"name":"Shocking","tier":2,"level":50,"variant":"双手近战／远程武器","ranges":["12～18"]},{"name":"Electrifying","tier":3,"level":100,"variant":"单手近战","ranges":["13～18"]},{"name":"Electrifying","tier":3,"level":100,"variant":"双手近战／远程武器","ranges":["19～27"]},{"name":"Tumultuous","tier":4,"level":150,"variant":"单手近战","ranges":["19～24"]},{"name":"Tumultuous","tier":4,"level":150,"variant":"双手近战／远程武器","ranges":["28～36"]},{"name":"Thunderous","tier":5,"level":200,"variant":"单手近战","ranges":["25～30"]},{"name":"Thunderous","tier":5,"level":200,"variant":"双手近战／远程武器","ranges":["37～45"]},{"name":"Tempestuous","tier":6,"level":260,"variant":"单手近战","ranges":["31～36"]},{"name":"Tempestuous","tier":6,"level":260,"variant":"双手近战／远程武器","ranges":["46～54"]},{"name":"Storming","tier":7,"level":330,"variant":"单手近战","ranges":["37～42"]},{"name":"Storming","tier":7,"level":330,"variant":"双手近战／远程武器","ranges":["55～63"]},{"name":"Catastrophic","tier":8,"level":410,"variant":"单手近战","ranges":["43～48"]},{"name":"Catastrophic","tier":8,"level":410,"variant":"双手近战／远程武器","ranges":["64～72"]},{"name":"Cataclysmic","tier":9,"level":500,"variant":"单手近战","ranges":["49～54"]},{"name":"Cataclysmic","tier":9,"level":500,"variant":"双手近战／远程武器","ranges":["73～81"]},{"name":"Apocalyptic","tier":10,"level":600,"variant":"单手近战","ranges":["55～60"]},{"name":"Apocalyptic","tier":10,"level":600,"variant":"双手近战／远程武器","ranges":["82～90"]}],"suffixes:持续伤害额外提高":[{"name":"of Torment","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Agony","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Cruelty","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Affliction","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Suffering","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Sadism","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Torture","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Excruciation","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Vivisection","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Atrocity","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:攻击技能命中恢复法力（固定调整）":[{"name":"of the Carp","tier":1,"level":1,"variant":"","ranges":["1～1"]},{"name":"of the Eel","tier":2,"level":50,"variant":"","ranges":["2～2"]},{"name":"of the Tuna","tier":3,"level":100,"variant":"","ranges":["3～3"]},{"name":"of the Octopus","tier":4,"level":150,"variant":"","ranges":["4～4"]},{"name":"of the Dolphin","tier":5,"level":200,"variant":"","ranges":["5～5"]},{"name":"of the Moray","tier":6,"level":260,"variant":"","ranges":["6～6"]},{"name":"of the Barracuda","tier":7,"level":330,"variant":"","ranges":["7～7"]},{"name":"of the Shark","tier":8,"level":410,"variant":"","ranges":["8～8"]},{"name":"of the Kraken","tier":9,"level":500,"variant":"","ranges":["9～9"]},{"name":"of the Leviathan","tier":10,"level":600,"variant":"","ranges":["10～10"]}],"suffixes:攻击技能命中恢复生命（固定调整）":[{"name":"of the Flea","tier":1,"level":1,"variant":"","ranges":["1～1"]},{"name":"of the Tick","tier":2,"level":50,"variant":"","ranges":["2～2"]},{"name":"of the Mosquito","tier":3,"level":100,"variant":"","ranges":["3～3"]},{"name":"of the Bat","tier":4,"level":150,"variant":"","ranges":["4～4"]},{"name":"of the Leech","tier":5,"level":200,"variant":"","ranges":["5～5"]},{"name":"of the Finch","tier":6,"level":260,"variant":"","ranges":["6～6"]},{"name":"of the Candiru","tier":7,"level":330,"variant":"","ranges":["7～7"]},{"name":"of the Oxpecker","tier":8,"level":410,"variant":"","ranges":["8～8"]},{"name":"of the Lamprey","tier":9,"level":500,"variant":"","ranges":["9～9"]},{"name":"of the Vampire","tier":10,"level":600,"variant":"","ranges":["10～10"]}],"suffixes:攻击技能的技能速度提高（本地）":[{"name":"of Hurry","tier":1,"level":1,"variant":"","ranges":["5～7%"]},{"name":"of Velocity","tier":2,"level":50,"variant":"","ranges":["8～10%"]},{"name":"of Urgency","tier":3,"level":100,"variant":"","ranges":["11～13%"]},{"name":"of Acceleration","tier":4,"level":150,"variant":"","ranges":["14～16%"]},{"name":"of Haste","tier":5,"level":200,"variant":"","ranges":["17～19%"]},{"name":"of Frenzy","tier":6,"level":260,"variant":"","ranges":["20～22%"]},{"name":"of Tantrum","tier":7,"level":330,"variant":"","ranges":["23～25%"]},{"name":"of Craze","tier":8,"level":410,"variant":"","ranges":["26～28%"]},{"name":"of Madness","tier":9,"level":500,"variant":"","ranges":["29～31%"]},{"name":"of Hysteria","tier":10,"level":600,"variant":"","ranges":["32～34%"]}],"suffixes:暴击伤害提高（本地）":[{"name":"of Destruction","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Havoc","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Demolition","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Annihilation","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Obliteration","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Rampage","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Ruination","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Devastation","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Extermination","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Oblivion","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:暴击率提高（本地）":[{"name":"of Aim","tier":1,"level":1,"variant":"","ranges":["15～20%"]},{"name":"of Rigor","tier":2,"level":50,"variant":"","ranges":["25～30%"]},{"name":"of Accuracy","tier":3,"level":100,"variant":"","ranges":["35～40%"]},{"name":"of Efficiency","tier":4,"level":150,"variant":"","ranges":["45～50%"]},{"name":"of Precision","tier":5,"level":200,"variant":"","ranges":["55～60%"]},{"name":"of Incisiveness","tier":6,"level":260,"variant":"","ranges":["65～70%"]},{"name":"of Exactitude","tier":7,"level":330,"variant":"","ranges":["75～85%"]},{"name":"of Meticulousness","tier":8,"level":410,"variant":"","ranges":["95～105%"]},{"name":"of Certainty","tier":9,"level":500,"variant":"","ranges":["115～125%"]},{"name":"of Perfection","tier":10,"level":600,"variant":"","ranges":["135～150%"]}]}},{"name":"法术武器","prefixes":["最大法力提高","最大法力（固定）","毒素伤害额外提高","火焰伤害额外提高","物理伤害额外提高","雷电伤害额外提高"],"suffixes":["法力恢复（固定调整）","法术伤害额外提高","法术技能的技能速度提高","法术技能的暴击率提高"],"tiers":{"prefixes:最大法力提高":[{"name":"Thoughtful","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"Cognitive","tier":2,"level":50,"variant":"","ranges":["5～7%"]},{"name":"Analytical","tier":3,"level":100,"variant":"","ranges":["8～10%"]},{"name":"Knowing","tier":4,"level":150,"variant":"","ranges":["11～13%"]},{"name":"Sagacious","tier":5,"level":200,"variant":"","ranges":["14～16%"]},{"name":"Insightful","tier":6,"level":260,"variant":"","ranges":["17～19%"]},{"name":"Intelligent","tier":7,"level":330,"variant":"","ranges":["20～22%"]},{"name":"Intuitive","tier":8,"level":410,"variant":"","ranges":["23～25%"]},{"name":"Gifted","tier":9,"level":500,"variant":"","ranges":["26～28%"]},{"name":"Genius","tier":10,"level":600,"variant":"","ranges":["29～32%"]}],"prefixes:最大法力（固定）":[{"name":"Novice","tier":1,"level":1,"variant":"","ranges":["10～15"]},{"name":"Studious","tier":2,"level":50,"variant":"","ranges":["20～25"]},{"name":"Learned","tier":3,"level":100,"variant":"","ranges":["30～35"]},{"name":"Scholastic","tier":4,"level":150,"variant":"","ranges":["40～45"]},{"name":"Cultivated","tier":5,"level":200,"variant":"","ranges":["50～55"]},{"name":"Academic","tier":6,"level":260,"variant":"","ranges":["60～65"]},{"name":"Sage","tier":7,"level":330,"variant":"","ranges":["70～75"]},{"name":"Erudite","tier":8,"level":410,"variant":"","ranges":["80～85"]},{"name":"Magisterial","tier":9,"level":500,"variant":"","ranges":["90～95"]},{"name":"Illuminated","tier":10,"level":600,"variant":"","ranges":["100～120"]}],"prefixes:毒素伤害额外提高":[{"name":"Sick","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Ill","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Diseased","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Plagued","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Pestiferous","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Septic","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Cancerous","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Putrid","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Necrotic","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Pandemic","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:火焰伤害额外提高":[{"name":"Tepid","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Warm","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Heated","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Hot","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Torrid","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Fiery","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Molten","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Igneous","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Sulfurous","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Infernal","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:物理伤害额外提高":[{"name":"Striking","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Lashing","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Pummeling","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Breaking","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Crushing","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Smashing","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Fracturing","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Shattering","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Destroying","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Ravaging","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:雷电伤害额外提高":[{"name":"Charged","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Foaming","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Conductive","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Swirling","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Voltaic","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Turbulent","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Uproaring","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Fulminating","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Hazardous","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Maelstromic","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:法力恢复（固定调整）":[{"name":"of Flow","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Stream","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Current","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Progress","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Growth","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Cogitation","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Meditation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Tranquility","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Enlightenment","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Nirvana","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:法术伤害额外提高":[{"name":"of Spellcasting","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Wizardry","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Sorcery","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Thaumaturgy","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Arcanum","tier":5,"level":200,"variant":"","ranges":["120～145%"]},{"name":"of Theurgy","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Enchantment","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Incantation","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Conjuration","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Invocation","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:法术技能的技能速度提高":[{"name":"of the Vocalist","tier":1,"level":1,"variant":"","ranges":["5～7%"]},{"name":"of the Caroler","tier":2,"level":50,"variant":"","ranges":["8～10%"]},{"name":"of the Singer","tier":3,"level":100,"variant":"","ranges":["11～13%"]},{"name":"of the Chantress","tier":4,"level":150,"variant":"","ranges":["14～16%"]},{"name":"of the Maestro","tier":5,"level":200,"variant":"","ranges":["17～19%"]},{"name":"of the Virtuoso","tier":6,"level":260,"variant":"","ranges":["20～22%"]},{"name":"of the Conductor","tier":7,"level":330,"variant":"","ranges":["23～25%"]},{"name":"of the Sinfonietta","tier":8,"level":410,"variant":"","ranges":["26～28%"]},{"name":"of the Orchestra","tier":9,"level":500,"variant":"","ranges":["29～31%"]},{"name":"of the Symphony","tier":10,"level":600,"variant":"","ranges":["32～34%"]}],"suffixes:法术技能的暴击率提高":[{"name":"of Fluctuation","tier":1,"level":1,"variant":"","ranges":["20～25%"]},{"name":"of Mutability","tier":2,"level":50,"variant":"","ranges":["30～35%"]},{"name":"of Flux","tier":3,"level":100,"variant":"","ranges":["40～45%"]},{"name":"of Instability","tier":4,"level":150,"variant":"","ranges":["50～55%"]},{"name":"of Chaos","tier":5,"level":200,"variant":"","ranges":["60～65%"]},{"name":"of Turbulence","tier":6,"level":260,"variant":"","ranges":["70～75%"]},{"name":"of Aberration","tier":7,"level":330,"variant":"","ranges":["80～85%"]},{"name":"of Uncertainty","tier":8,"level":410,"variant":"","ranges":["90～95%"]},{"name":"of Anomaly","tier":9,"level":500,"variant":"","ranges":["100～105%"]},{"name":"of Pandemonium","tier":10,"level":600,"variant":"","ranges":["110～120%"]}]}},{"name":"胸甲","prefixes":["最大生命提高","最大生命（固定调整）","物理防御提高（本地）","物理防御（固定调整）（本地）","生命恢复效果提高"],"suffixes":["正面状态持续时间提高","毒素防御（固定调整）","法力恢复（固定调整）","火焰防御（固定调整）","生命恢复（固定调整）","金币获取量额外提高","雷电防御（固定调整）"],"tiers":{"prefixes:最大生命提高":[{"name":"Hefty","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"Robust","tier":2,"level":50,"variant":"","ranges":["5～6%"]},{"name":"Stout","tier":3,"level":100,"variant":"","ranges":["7～8%"]},{"name":"Beefy","tier":4,"level":150,"variant":"","ranges":["9～10%"]},{"name":"Endurant","tier":5,"level":200,"variant":"","ranges":["11～12%"]},{"name":"Hulking","tier":6,"level":260,"variant":"","ranges":["13～14%"]},{"name":"Resistant","tier":7,"level":330,"variant":"","ranges":["15～16%"]},{"name":"Tenacious","tier":8,"level":410,"variant":"","ranges":["17～18%"]},{"name":"Resilient","tier":9,"level":500,"variant":"","ranges":["19～20%"]},{"name":"Stalwart","tier":10,"level":600,"variant":"","ranges":["21～22%"]}],"prefixes:最大生命（固定调整）":[{"name":"Lively","tier":1,"level":1,"variant":"","ranges":["10～15"]},{"name":"Healthy","tier":2,"level":50,"variant":"","ranges":["20～25"]},{"name":"Hearty","tier":3,"level":100,"variant":"","ranges":["30～35"]},{"name":"Enduring","tier":4,"level":150,"variant":"","ranges":["40～45"]},{"name":"Vigorous","tier":5,"level":200,"variant":"","ranges":["50～55"]},{"name":"Burly","tier":6,"level":260,"variant":"","ranges":["60～65"]},{"name":"Brawny","tier":7,"level":330,"variant":"","ranges":["70～75"]},{"name":"Solid","tier":8,"level":410,"variant":"","ranges":["80～85"]},{"name":"Imposing","tier":9,"level":500,"variant":"","ranges":["90～95"]},{"name":"Formidable","tier":10,"level":600,"variant":"","ranges":["100～120"]}],"prefixes:物理防御提高（本地）":[{"name":"Tough","tier":1,"level":1,"variant":"","ranges":["20～35%"]},{"name":"Sturdy","tier":2,"level":50,"variant":"","ranges":["45～55%"]},{"name":"Reinforcing","tier":3,"level":100,"variant":"","ranges":["65～75%"]},{"name":"Bulwarked","tier":4,"level":150,"variant":"","ranges":["85～95%"]},{"name":"Protective","tier":5,"level":200,"variant":"","ranges":["105～115%"]},{"name":"Defensive","tier":6,"level":260,"variant":"","ranges":["125～135%"]},{"name":"Guardian","tier":7,"level":330,"variant":"","ranges":["145～155%"]},{"name":"Sentinel","tier":8,"level":410,"variant":"","ranges":["165～175%"]},{"name":"Bastion","tier":9,"level":500,"variant":"","ranges":["185～195%"]},{"name":"Fortress","tier":10,"level":600,"variant":"","ranges":["205～220%"]}],"prefixes:物理防御（固定调整）（本地）":[{"name":"Patched","tier":1,"level":1,"variant":"","ranges":["5～10"]},{"name":"Reinforced","tier":2,"level":50,"variant":"","ranges":["15～20"]},{"name":"Fortified","tier":3,"level":100,"variant":"","ranges":["25～30"]},{"name":"Bolstered","tier":4,"level":150,"variant":"","ranges":["35～40"]},{"name":"Hardened","tier":5,"level":200,"variant":"","ranges":["45～50"]},{"name":"Adamant","tier":6,"level":260,"variant":"","ranges":["55～60"]},{"name":"Impenetrable","tier":7,"level":330,"variant":"","ranges":["65～70"]},{"name":"Unyielding","tier":8,"level":410,"variant":"","ranges":["75～80"]},{"name":"Unassailable","tier":9,"level":500,"variant":"","ranges":["85～90"]},{"name":"Invincible","tier":10,"level":600,"variant":"","ranges":["95～100"]}],"prefixes:生命恢复效果提高":[{"name":"Tonic","tier":1,"level":1,"variant":"","ranges":["5～10%"]},{"name":"Soothing","tier":2,"level":50,"variant":"","ranges":["15～20%"]},{"name":"Allaying","tier":3,"level":100,"variant":"","ranges":["25～30%"]},{"name":"Beneficial","tier":4,"level":150,"variant":"","ranges":["35～40%"]},{"name":"Analeptic","tier":5,"level":200,"variant":"","ranges":["45～50%"]},{"name":"Therapeutic","tier":6,"level":260,"variant":"","ranges":["55～60%"]},{"name":"Remedial","tier":7,"level":330,"variant":"","ranges":["65～70%"]},{"name":"Curative","tier":8,"level":410,"variant":"","ranges":["75～80%"]},{"name":"Restorative","tier":9,"level":500,"variant":"","ranges":["85～90%"]},{"name":"Salutary","tier":10,"level":600,"variant":"","ranges":["95～100%"]}],"suffixes:正面状态持续时间提高":[{"name":"of Prayer","tier":1,"level":1,"variant":"","ranges":["10～15%"]},{"name":"of Worship","tier":2,"level":50,"variant":"","ranges":["20～25%"]},{"name":"of Devotion","tier":3,"level":100,"variant":"","ranges":["30～35%"]},{"name":"of Faith","tier":4,"level":150,"variant":"","ranges":["40～45%"]},{"name":"of Grace","tier":5,"level":200,"variant":"","ranges":["50～55%"]},{"name":"of Blessing","tier":6,"level":260,"variant":"","ranges":["60～65%"]},{"name":"of Benediction","tier":7,"level":330,"variant":"","ranges":["70～75%"]},{"name":"of Consecration","tier":8,"level":410,"variant":"","ranges":["80～85%"]},{"name":"of Divinity","tier":9,"level":500,"variant":"","ranges":["90～95%"]},{"name":"of Apotheosis","tier":10,"level":600,"variant":"","ranges":["100～120%"]}],"suffixes:毒素防御（固定调整）":[{"name":"of Venomscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Venomfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Venomguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Venomshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Venomveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Venomward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Venommantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Venomscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Venommail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Venomplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:法力恢复（固定调整）":[{"name":"of Flow","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Stream","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Current","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Progress","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Growth","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Cogitation","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Meditation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Tranquility","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Enlightenment","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Nirvana","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:火焰防御（固定调整）":[{"name":"of Emberscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Emberfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Emberguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Embershield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Emberveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Emberward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Embermantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Emberscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Embermail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Emberplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:生命恢复（固定调整）":[{"name":"of Regeneration","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Vigor","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Restoration","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Endurance","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Vitality","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Renewal","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Rejuvenation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Invigoration","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Perpetuity","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Immortality","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:金币获取量额外提高":[{"name":"of Greed","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Cupidity","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Avarice","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Covetousness","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Rapacity","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Plunder","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Pillage","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Looting","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Hoarding","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Gluttony","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:雷电防御（固定调整）":[{"name":"of Tempestscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Tempestfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Tempestguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Tempestshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Tempestveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Tempestward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Tempestmantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Tempestscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Tempestmail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Tempestplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}]}},{"name":"盾牌","prefixes":["威胁值获取提高","最大生命提高","最大生命（固定调整）","物理防御提高（本地）","物理防御（固定调整）（本地）"],"suffixes":["攻击技能的伤害额外提高","格挡率提高（本地）","格挡率（固定调整）（本地）","毒素防御（固定调整）","火焰防御（固定调整）","生命恢复（固定调整）","雷电防御（固定调整）"],"tiers":{"prefixes:威胁值获取提高":[{"name":"Menacing","tier":1,"level":1,"variant":"","ranges":["10～15%"]},{"name":"Dreadful","tier":2,"level":50,"variant":"","ranges":["20～25%"]},{"name":"Threatening","tier":3,"level":100,"variant":"","ranges":["30～35%"]},{"name":"Hostile","tier":4,"level":150,"variant":"","ranges":["40～45%"]},{"name":"Intimidating","tier":5,"level":200,"variant":"","ranges":["50～55%"]},{"name":"Formidable","tier":6,"level":260,"variant":"","ranges":["60～65%"]},{"name":"Terrifying","tier":7,"level":330,"variant":"","ranges":["70～75%"]},{"name":"Fearsome","tier":8,"level":410,"variant":"","ranges":["80～85%"]},{"name":"Daunting","tier":9,"level":500,"variant":"","ranges":["90～95%"]},{"name":"Terrorizing","tier":10,"level":600,"variant":"","ranges":["100～105%"]}],"prefixes:最大生命提高":[{"name":"Hefty","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"Robust","tier":2,"level":50,"variant":"","ranges":["5～6%"]},{"name":"Stout","tier":3,"level":100,"variant":"","ranges":["7～8%"]},{"name":"Beefy","tier":4,"level":150,"variant":"","ranges":["9～10%"]},{"name":"Endurant","tier":5,"level":200,"variant":"","ranges":["11～12%"]},{"name":"Hulking","tier":6,"level":260,"variant":"","ranges":["13～14%"]},{"name":"Resistant","tier":7,"level":330,"variant":"","ranges":["15～16%"]},{"name":"Tenacious","tier":8,"level":410,"variant":"","ranges":["17～18%"]},{"name":"Resilient","tier":9,"level":500,"variant":"","ranges":["19～20%"]},{"name":"Stalwart","tier":10,"level":600,"variant":"","ranges":["21～22%"]}],"prefixes:最大生命（固定调整）":[{"name":"Lively","tier":1,"level":1,"variant":"","ranges":["10～15"]},{"name":"Healthy","tier":2,"level":50,"variant":"","ranges":["20～25"]},{"name":"Hearty","tier":3,"level":100,"variant":"","ranges":["30～35"]},{"name":"Enduring","tier":4,"level":150,"variant":"","ranges":["40～45"]},{"name":"Vigorous","tier":5,"level":200,"variant":"","ranges":["50～55"]},{"name":"Burly","tier":6,"level":260,"variant":"","ranges":["60～65"]},{"name":"Brawny","tier":7,"level":330,"variant":"","ranges":["70～75"]},{"name":"Solid","tier":8,"level":410,"variant":"","ranges":["80～85"]},{"name":"Imposing","tier":9,"level":500,"variant":"","ranges":["90～95"]},{"name":"Formidable","tier":10,"level":600,"variant":"","ranges":["100～120"]}],"prefixes:物理防御提高（本地）":[{"name":"Tough","tier":1,"level":1,"variant":"","ranges":["20～35%"]},{"name":"Sturdy","tier":2,"level":50,"variant":"","ranges":["45～55%"]},{"name":"Reinforcing","tier":3,"level":100,"variant":"","ranges":["65～75%"]},{"name":"Bulwarked","tier":4,"level":150,"variant":"","ranges":["85～95%"]},{"name":"Protective","tier":5,"level":200,"variant":"","ranges":["105～115%"]},{"name":"Defensive","tier":6,"level":260,"variant":"","ranges":["125～135%"]},{"name":"Guardian","tier":7,"level":330,"variant":"","ranges":["145～155%"]},{"name":"Sentinel","tier":8,"level":410,"variant":"","ranges":["165～175%"]},{"name":"Bastion","tier":9,"level":500,"variant":"","ranges":["185～195%"]},{"name":"Fortress","tier":10,"level":600,"variant":"","ranges":["205～220%"]}],"prefixes:物理防御（固定调整）（本地）":[{"name":"Patched","tier":1,"level":1,"variant":"","ranges":["5～10"]},{"name":"Reinforced","tier":2,"level":50,"variant":"","ranges":["15～20"]},{"name":"Fortified","tier":3,"level":100,"variant":"","ranges":["25～30"]},{"name":"Bolstered","tier":4,"level":150,"variant":"","ranges":["35～40"]},{"name":"Hardened","tier":5,"level":200,"variant":"","ranges":["45～50"]},{"name":"Adamant","tier":6,"level":260,"variant":"","ranges":["55～60"]},{"name":"Impenetrable","tier":7,"level":330,"variant":"","ranges":["65～70"]},{"name":"Unyielding","tier":8,"level":410,"variant":"","ranges":["75～80"]},{"name":"Unassailable","tier":9,"level":500,"variant":"","ranges":["85～90"]},{"name":"Invincible","tier":10,"level":600,"variant":"","ranges":["95～100"]}],"suffixes:攻击技能的伤害额外提高":[{"name":"of Ire","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Temper","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Wrath","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Belligerence","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Ferocity","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Aggression","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Rage","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Hatred","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Fury","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Bloodlust","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:格挡率提高（本地）":[{"name":"of Film","tier":1,"level":1,"variant":"","ranges":["10～13%"]},{"name":"of Oil","tier":2,"level":50,"variant":"","ranges":["16～18%"]},{"name":"of Grease","tier":3,"level":100,"variant":"","ranges":["21～23%"]},{"name":"of Coating","tier":4,"level":150,"variant":"","ranges":["26～28%"]},{"name":"of Sheen","tier":5,"level":200,"variant":"","ranges":["31～33%"]},{"name":"of Polish","tier":6,"level":260,"variant":"","ranges":["36～38%"]},{"name":"of Lacquer","tier":7,"level":330,"variant":"","ranges":["41～43%"]},{"name":"of Glaze","tier":8,"level":410,"variant":"","ranges":["46～48%"]},{"name":"of Varnish","tier":9,"level":500,"variant":"","ranges":["51～53%"]},{"name":"of Enamel","tier":10,"level":600,"variant":"","ranges":["56～60%"]}],"suffixes:格挡率（固定调整）（本地）":[{"name":"of Deflection","tier":1,"level":1,"variant":"","ranges":["1～1%"]},{"name":"of Interception","tier":2,"level":50,"variant":"","ranges":["2～2%"]},{"name":"of Protection","tier":3,"level":100,"variant":"","ranges":["3～3%"]},{"name":"of Guarding","tier":4,"level":150,"variant":"","ranges":["4～4%"]},{"name":"of Shielding","tier":5,"level":200,"variant":"","ranges":["5～5%"]},{"name":"of Fortitude","tier":6,"level":260,"variant":"","ranges":["6～6%"]},{"name":"of Vigilance","tier":7,"level":330,"variant":"","ranges":["7～7%"]},{"name":"of Preservation","tier":8,"level":410,"variant":"","ranges":["8～8%"]},{"name":"of Safeguarding","tier":9,"level":500,"variant":"","ranges":["9～9%"]},{"name":"of Impregnability","tier":10,"level":600,"variant":"","ranges":["10～10%"]}],"suffixes:毒素防御（固定调整）":[{"name":"of Venomscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Venomfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Venomguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Venomshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Venomveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Venomward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Venommantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Venomscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Venommail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Venomplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:火焰防御（固定调整）":[{"name":"of Emberscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Emberfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Emberguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Embershield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Emberveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Emberward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Embermantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Emberscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Embermail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Emberplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:生命恢复（固定调整）":[{"name":"of Regeneration","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Vigor","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Restoration","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Endurance","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Vitality","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Renewal","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Rejuvenation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Invigoration","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Perpetuity","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Immortality","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:雷电防御（固定调整）":[{"name":"of Tempestscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Tempestfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Tempestguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Tempestshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Tempestveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Tempestward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Tempestmantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Tempestscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Tempestmail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Tempestplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}]}},{"name":"法器","prefixes":["威胁值获取提高","最大法力提高","最大法力（固定）","毒素伤害额外提高","火焰伤害额外提高","诅咒技能的状态效果提高","雷电伤害额外提高"],"suffixes":["毒素防御（固定调整）","法力恢复（固定调整）","法术伤害额外提高","法术技能的技能速度提高","法术技能的暴击率提高","火焰防御（固定调整）","负面状态持续时间提高","雷电防御（固定调整）"],"tiers":{"prefixes:威胁值获取提高":[{"name":"Menacing","tier":1,"level":1,"variant":"","ranges":["10～15%"]},{"name":"Dreadful","tier":2,"level":50,"variant":"","ranges":["20～25%"]},{"name":"Threatening","tier":3,"level":100,"variant":"","ranges":["30～35%"]},{"name":"Hostile","tier":4,"level":150,"variant":"","ranges":["40～45%"]},{"name":"Intimidating","tier":5,"level":200,"variant":"","ranges":["50～55%"]},{"name":"Formidable","tier":6,"level":260,"variant":"","ranges":["60～65%"]},{"name":"Terrifying","tier":7,"level":330,"variant":"","ranges":["70～75%"]},{"name":"Fearsome","tier":8,"level":410,"variant":"","ranges":["80～85%"]},{"name":"Daunting","tier":9,"level":500,"variant":"","ranges":["90～95%"]},{"name":"Terrorizing","tier":10,"level":600,"variant":"","ranges":["100～105%"]}],"prefixes:最大法力提高":[{"name":"Thoughtful","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"Cognitive","tier":2,"level":50,"variant":"","ranges":["5～7%"]},{"name":"Analytical","tier":3,"level":100,"variant":"","ranges":["8～10%"]},{"name":"Knowing","tier":4,"level":150,"variant":"","ranges":["11～13%"]},{"name":"Sagacious","tier":5,"level":200,"variant":"","ranges":["14～16%"]},{"name":"Insightful","tier":6,"level":260,"variant":"","ranges":["17～19%"]},{"name":"Intelligent","tier":7,"level":330,"variant":"","ranges":["20～22%"]},{"name":"Intuitive","tier":8,"level":410,"variant":"","ranges":["23～25%"]},{"name":"Gifted","tier":9,"level":500,"variant":"","ranges":["26～28%"]},{"name":"Genius","tier":10,"level":600,"variant":"","ranges":["29～32%"]}],"prefixes:最大法力（固定）":[{"name":"Novice","tier":1,"level":1,"variant":"","ranges":["10～15"]},{"name":"Studious","tier":2,"level":50,"variant":"","ranges":["20～25"]},{"name":"Learned","tier":3,"level":100,"variant":"","ranges":["30～35"]},{"name":"Scholastic","tier":4,"level":150,"variant":"","ranges":["40～45"]},{"name":"Cultivated","tier":5,"level":200,"variant":"","ranges":["50～55"]},{"name":"Academic","tier":6,"level":260,"variant":"","ranges":["60～65"]},{"name":"Sage","tier":7,"level":330,"variant":"","ranges":["70～75"]},{"name":"Erudite","tier":8,"level":410,"variant":"","ranges":["80～85"]},{"name":"Magisterial","tier":9,"level":500,"variant":"","ranges":["90～95"]},{"name":"Illuminated","tier":10,"level":600,"variant":"","ranges":["100～120"]}],"prefixes:毒素伤害额外提高":[{"name":"Sick","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Ill","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Diseased","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Plagued","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Pestiferous","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Septic","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Cancerous","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Putrid","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Necrotic","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Pandemic","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:火焰伤害额外提高":[{"name":"Tepid","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Warm","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Heated","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Hot","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Torrid","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Fiery","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Molten","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Igneous","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Sulfurous","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Infernal","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:诅咒技能的状态效果提高":[{"name":"Odd","tier":1,"level":1,"variant":"","ranges":["10～15%"]},{"name":"Weird","tier":2,"level":50,"variant":"","ranges":["20～25%"]},{"name":"Curious","tier":3,"level":100,"variant":"","ranges":["30～35%"]},{"name":"Freaky","tier":4,"level":150,"variant":"","ranges":["40～45%"]},{"name":"Eerie","tier":5,"level":200,"variant":"","ranges":["50～55%"]},{"name":"Uncanny","tier":6,"level":260,"variant":"","ranges":["60～65%"]},{"name":"Quirky","tier":7,"level":330,"variant":"","ranges":["70～75%"]},{"name":"Bizarre","tier":8,"level":410,"variant":"","ranges":["80～85%"]},{"name":"Unusual","tier":9,"level":500,"variant":"","ranges":["90～95%"]},{"name":"Fantastic","tier":10,"level":600,"variant":"","ranges":["100～120%"]}],"prefixes:雷电伤害额外提高":[{"name":"Charged","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Foaming","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Conductive","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Swirling","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Voltaic","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Turbulent","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Uproaring","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Fulminating","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Hazardous","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Maelstromic","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:毒素防御（固定调整）":[{"name":"of Venomscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Venomfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Venomguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Venomshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Venomveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Venomward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Venommantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Venomscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Venommail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Venomplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:法力恢复（固定调整）":[{"name":"of Flow","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Stream","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Current","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Progress","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Growth","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Cogitation","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Meditation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Tranquility","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Enlightenment","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Nirvana","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:法术伤害额外提高":[{"name":"of Spellcasting","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Wizardry","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Sorcery","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Thaumaturgy","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Arcanum","tier":5,"level":200,"variant":"","ranges":["120～145%"]},{"name":"of Theurgy","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Enchantment","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Incantation","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Conjuration","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Invocation","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:法术技能的技能速度提高":[{"name":"of the Vocalist","tier":1,"level":1,"variant":"","ranges":["5～7%"]},{"name":"of the Caroler","tier":2,"level":50,"variant":"","ranges":["8～10%"]},{"name":"of the Singer","tier":3,"level":100,"variant":"","ranges":["11～13%"]},{"name":"of the Chantress","tier":4,"level":150,"variant":"","ranges":["14～16%"]},{"name":"of the Maestro","tier":5,"level":200,"variant":"","ranges":["17～19%"]},{"name":"of the Virtuoso","tier":6,"level":260,"variant":"","ranges":["20～22%"]},{"name":"of the Conductor","tier":7,"level":330,"variant":"","ranges":["23～25%"]},{"name":"of the Sinfonietta","tier":8,"level":410,"variant":"","ranges":["26～28%"]},{"name":"of the Orchestra","tier":9,"level":500,"variant":"","ranges":["29～31%"]},{"name":"of the Symphony","tier":10,"level":600,"variant":"","ranges":["32～34%"]}],"suffixes:法术技能的暴击率提高":[{"name":"of Fluctuation","tier":1,"level":1,"variant":"","ranges":["20～25%"]},{"name":"of Mutability","tier":2,"level":50,"variant":"","ranges":["30～35%"]},{"name":"of Flux","tier":3,"level":100,"variant":"","ranges":["40～45%"]},{"name":"of Instability","tier":4,"level":150,"variant":"","ranges":["50～55%"]},{"name":"of Chaos","tier":5,"level":200,"variant":"","ranges":["60～65%"]},{"name":"of Turbulence","tier":6,"level":260,"variant":"","ranges":["70～75%"]},{"name":"of Aberration","tier":7,"level":330,"variant":"","ranges":["80～85%"]},{"name":"of Uncertainty","tier":8,"level":410,"variant":"","ranges":["90～95%"]},{"name":"of Anomaly","tier":9,"level":500,"variant":"","ranges":["100～105%"]},{"name":"of Pandemonium","tier":10,"level":600,"variant":"","ranges":["110～120%"]}],"suffixes:火焰防御（固定调整）":[{"name":"of Emberscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Emberfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Emberguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Embershield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Emberveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Emberward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Embermantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Emberscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Embermail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Emberplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:负面状态持续时间提高":[{"name":"of Whispers","tier":1,"level":1,"variant":"","ranges":["10～15%"]},{"name":"of Murmurs","tier":2,"level":50,"variant":"","ranges":["20～25%"]},{"name":"of Oddities","tier":3,"level":100,"variant":"","ranges":["30～35%"]},{"name":"of Curiosities","tier":4,"level":150,"variant":"","ranges":["40～45%"]},{"name":"of Enigmas","tier":5,"level":200,"variant":"","ranges":["50～55%"]},{"name":"of Mysteries","tier":6,"level":260,"variant":"","ranges":["60～65%"]},{"name":"of Puzzles","tier":7,"level":330,"variant":"","ranges":["70～75%"]},{"name":"of Enchantments","tier":8,"level":410,"variant":"","ranges":["80～85%"]},{"name":"of Phantasms","tier":9,"level":500,"variant":"","ranges":["90～95%"]},{"name":"of Wonders","tier":10,"level":600,"variant":"","ranges":["100～120%"]}],"suffixes:雷电防御（固定调整）":[{"name":"of Tempestscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Tempestfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Tempestguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Tempestshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Tempestveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Tempestward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Tempestmantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Tempestscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Tempestmail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Tempestplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}]}},{"name":"手套","prefixes":["施加负面状态成功率提高","最大生命提高","最大生命（固定调整）","物理防御提高（本地）","物理防御（固定调整）（本地）"],"suffixes":["技能速度提高","暴击率提高","毒素防御（固定调整）","法力恢复（固定调整）","火焰防御（固定调整）","生命恢复（固定调整）","金币获取量额外提高","雷电防御（固定调整）"],"tiers":{"prefixes:施加负面状态成功率提高":[{"name":"Tactile","tier":1,"level":1,"variant":"","ranges":["5～10%"]},{"name":"Grasping","tier":2,"level":50,"variant":"","ranges":["15～20%"]},{"name":"Clutching","tier":3,"level":100,"variant":"","ranges":["25～30%"]},{"name":"Stamping","tier":4,"level":150,"variant":"","ranges":["35～40%"]},{"name":"Marking","tier":5,"level":200,"variant":"","ranges":["45～50%"]},{"name":"Etching","tier":6,"level":260,"variant":"","ranges":["55～60%"]},{"name":"Engraving","tier":7,"level":330,"variant":"","ranges":["65～70%"]},{"name":"Branding","tier":8,"level":410,"variant":"","ranges":["75～80%"]},{"name":"Constraining","tier":9,"level":500,"variant":"","ranges":["85～90%"]},{"name":"Afflicting","tier":10,"level":600,"variant":"","ranges":["95～100%"]}],"prefixes:最大生命提高":[{"name":"Hefty","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"Robust","tier":2,"level":50,"variant":"","ranges":["5～6%"]},{"name":"Stout","tier":3,"level":100,"variant":"","ranges":["7～8%"]},{"name":"Beefy","tier":4,"level":150,"variant":"","ranges":["9～10%"]},{"name":"Endurant","tier":5,"level":200,"variant":"","ranges":["11～12%"]},{"name":"Hulking","tier":6,"level":260,"variant":"","ranges":["13～14%"]},{"name":"Resistant","tier":7,"level":330,"variant":"","ranges":["15～16%"]},{"name":"Tenacious","tier":8,"level":410,"variant":"","ranges":["17～18%"]},{"name":"Resilient","tier":9,"level":500,"variant":"","ranges":["19～20%"]},{"name":"Stalwart","tier":10,"level":600,"variant":"","ranges":["21～22%"]}],"prefixes:最大生命（固定调整）":[{"name":"Lively","tier":1,"level":1,"variant":"","ranges":["10～15"]},{"name":"Healthy","tier":2,"level":50,"variant":"","ranges":["20～25"]},{"name":"Hearty","tier":3,"level":100,"variant":"","ranges":["30～35"]},{"name":"Enduring","tier":4,"level":150,"variant":"","ranges":["40～45"]},{"name":"Vigorous","tier":5,"level":200,"variant":"","ranges":["50～55"]},{"name":"Burly","tier":6,"level":260,"variant":"","ranges":["60～65"]},{"name":"Brawny","tier":7,"level":330,"variant":"","ranges":["70～75"]},{"name":"Solid","tier":8,"level":410,"variant":"","ranges":["80～85"]},{"name":"Imposing","tier":9,"level":500,"variant":"","ranges":["90～95"]},{"name":"Formidable","tier":10,"level":600,"variant":"","ranges":["100～120"]}],"prefixes:物理防御提高（本地）":[{"name":"Tough","tier":1,"level":1,"variant":"","ranges":["20～35%"]},{"name":"Sturdy","tier":2,"level":50,"variant":"","ranges":["45～55%"]},{"name":"Reinforcing","tier":3,"level":100,"variant":"","ranges":["65～75%"]},{"name":"Bulwarked","tier":4,"level":150,"variant":"","ranges":["85～95%"]},{"name":"Protective","tier":5,"level":200,"variant":"","ranges":["105～115%"]},{"name":"Defensive","tier":6,"level":260,"variant":"","ranges":["125～135%"]},{"name":"Guardian","tier":7,"level":330,"variant":"","ranges":["145～155%"]},{"name":"Sentinel","tier":8,"level":410,"variant":"","ranges":["165～175%"]},{"name":"Bastion","tier":9,"level":500,"variant":"","ranges":["185～195%"]},{"name":"Fortress","tier":10,"level":600,"variant":"","ranges":["205～220%"]}],"prefixes:物理防御（固定调整）（本地）":[{"name":"Patched","tier":1,"level":1,"variant":"","ranges":["5～10"]},{"name":"Reinforced","tier":2,"level":50,"variant":"","ranges":["15～20"]},{"name":"Fortified","tier":3,"level":100,"variant":"","ranges":["25～30"]},{"name":"Bolstered","tier":4,"level":150,"variant":"","ranges":["35～40"]},{"name":"Hardened","tier":5,"level":200,"variant":"","ranges":["45～50"]},{"name":"Adamant","tier":6,"level":260,"variant":"","ranges":["55～60"]},{"name":"Impenetrable","tier":7,"level":330,"variant":"","ranges":["65～70"]},{"name":"Unyielding","tier":8,"level":410,"variant":"","ranges":["75～80"]},{"name":"Unassailable","tier":9,"level":500,"variant":"","ranges":["85～90"]},{"name":"Invincible","tier":10,"level":600,"variant":"","ranges":["95～100"]}],"suffixes:技能速度提高":[{"name":"of Dexterity","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"of Gesticulation","tier":2,"level":50,"variant":"","ranges":["5～6%"]},{"name":"of Action","tier":3,"level":100,"variant":"","ranges":["7～8%"]},{"name":"of Alacrity","tier":4,"level":150,"variant":"","ranges":["9～10%"]},{"name":"of Coordination","tier":5,"level":200,"variant":"","ranges":["11～12%"]},{"name":"of Reflexes","tier":6,"level":260,"variant":"","ranges":["13～14%"]},{"name":"of Motion","tier":7,"level":330,"variant":"","ranges":["15～16%"]},{"name":"of Execution","tier":8,"level":410,"variant":"","ranges":["17～18%"]},{"name":"of Reaction","tier":9,"level":500,"variant":"","ranges":["19～20%"]},{"name":"of Premonition","tier":10,"level":600,"variant":"","ranges":["21～22%"]}],"suffixes:暴击率提高":[{"name":"of Aim","tier":1,"level":1,"variant":"","ranges":["15～25%"]},{"name":"of Rigor","tier":2,"level":50,"variant":"","ranges":["30～40%"]},{"name":"of Accuracy","tier":3,"level":100,"variant":"","ranges":["45～55%"]},{"name":"of Efficiency","tier":4,"level":150,"variant":"","ranges":["60～70%"]},{"name":"of Precision","tier":5,"level":200,"variant":"","ranges":["75～85%"]},{"name":"of Incisiveness","tier":6,"level":260,"variant":"","ranges":["90～100%"]},{"name":"of Exactitude","tier":7,"level":330,"variant":"","ranges":["105～115%"]},{"name":"of Meticulousness","tier":8,"level":410,"variant":"","ranges":["120～130%"]},{"name":"of Certainty","tier":9,"level":500,"variant":"","ranges":["135～150%"]},{"name":"of Perfection","tier":10,"level":600,"variant":"","ranges":["155～175%"]}],"suffixes:毒素防御（固定调整）":[{"name":"of Venomscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Venomfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Venomguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Venomshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Venomveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Venomward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Venommantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Venomscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Venommail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Venomplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:法力恢复（固定调整）":[{"name":"of Flow","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Stream","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Current","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Progress","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Growth","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Cogitation","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Meditation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Tranquility","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Enlightenment","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Nirvana","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:火焰防御（固定调整）":[{"name":"of Emberscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Emberfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Emberguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Embershield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Emberveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Emberward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Embermantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Emberscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Embermail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Emberplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:生命恢复（固定调整）":[{"name":"of Regeneration","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Vigor","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Restoration","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Endurance","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Vitality","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Renewal","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Rejuvenation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Invigoration","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Perpetuity","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Immortality","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:金币获取量额外提高":[{"name":"of Greed","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Cupidity","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Avarice","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Covetousness","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Rapacity","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Plunder","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Pillage","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Looting","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Hoarding","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Gluttony","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:雷电防御（固定调整）":[{"name":"of Tempestscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Tempestfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Tempestguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Tempestshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Tempestveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Tempestward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Tempestmantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Tempestscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Tempestmail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Tempestplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}]}},{"name":"靴子","prefixes":["最大生命提高","最大生命（固定调整）","物理防御提高（本地）","物理防御（固定调整）（本地）","移动速度提高"],"suffixes":["持续伤害闪避率（固定调整）","毒素防御（固定调整）","法力恢复（固定调整）","火焰防御（固定调整）","生命恢复（固定调整）","金币获取量额外提高","雷电防御（固定调整）"],"tiers":{"prefixes:最大生命提高":[{"name":"Hefty","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"Robust","tier":2,"level":50,"variant":"","ranges":["5～6%"]},{"name":"Stout","tier":3,"level":100,"variant":"","ranges":["7～8%"]},{"name":"Beefy","tier":4,"level":150,"variant":"","ranges":["9～10%"]},{"name":"Endurant","tier":5,"level":200,"variant":"","ranges":["11～12%"]},{"name":"Hulking","tier":6,"level":260,"variant":"","ranges":["13～14%"]},{"name":"Resistant","tier":7,"level":330,"variant":"","ranges":["15～16%"]},{"name":"Tenacious","tier":8,"level":410,"variant":"","ranges":["17～18%"]},{"name":"Resilient","tier":9,"level":500,"variant":"","ranges":["19～20%"]},{"name":"Stalwart","tier":10,"level":600,"variant":"","ranges":["21～22%"]}],"prefixes:最大生命（固定调整）":[{"name":"Lively","tier":1,"level":1,"variant":"","ranges":["10～15"]},{"name":"Healthy","tier":2,"level":50,"variant":"","ranges":["20～25"]},{"name":"Hearty","tier":3,"level":100,"variant":"","ranges":["30～35"]},{"name":"Enduring","tier":4,"level":150,"variant":"","ranges":["40～45"]},{"name":"Vigorous","tier":5,"level":200,"variant":"","ranges":["50～55"]},{"name":"Burly","tier":6,"level":260,"variant":"","ranges":["60～65"]},{"name":"Brawny","tier":7,"level":330,"variant":"","ranges":["70～75"]},{"name":"Solid","tier":8,"level":410,"variant":"","ranges":["80～85"]},{"name":"Imposing","tier":9,"level":500,"variant":"","ranges":["90～95"]},{"name":"Formidable","tier":10,"level":600,"variant":"","ranges":["100～120"]}],"prefixes:物理防御提高（本地）":[{"name":"Tough","tier":1,"level":1,"variant":"","ranges":["20～35%"]},{"name":"Sturdy","tier":2,"level":50,"variant":"","ranges":["45～55%"]},{"name":"Reinforcing","tier":3,"level":100,"variant":"","ranges":["65～75%"]},{"name":"Bulwarked","tier":4,"level":150,"variant":"","ranges":["85～95%"]},{"name":"Protective","tier":5,"level":200,"variant":"","ranges":["105～115%"]},{"name":"Defensive","tier":6,"level":260,"variant":"","ranges":["125～135%"]},{"name":"Guardian","tier":7,"level":330,"variant":"","ranges":["145～155%"]},{"name":"Sentinel","tier":8,"level":410,"variant":"","ranges":["165～175%"]},{"name":"Bastion","tier":9,"level":500,"variant":"","ranges":["185～195%"]},{"name":"Fortress","tier":10,"level":600,"variant":"","ranges":["205～220%"]}],"prefixes:物理防御（固定调整）（本地）":[{"name":"Patched","tier":1,"level":1,"variant":"","ranges":["5～10"]},{"name":"Reinforced","tier":2,"level":50,"variant":"","ranges":["15～20"]},{"name":"Fortified","tier":3,"level":100,"variant":"","ranges":["25～30"]},{"name":"Bolstered","tier":4,"level":150,"variant":"","ranges":["35～40"]},{"name":"Hardened","tier":5,"level":200,"variant":"","ranges":["45～50"]},{"name":"Adamant","tier":6,"level":260,"variant":"","ranges":["55～60"]},{"name":"Impenetrable","tier":7,"level":330,"variant":"","ranges":["65～70"]},{"name":"Unyielding","tier":8,"level":410,"variant":"","ranges":["75～80"]},{"name":"Unassailable","tier":9,"level":500,"variant":"","ranges":["85～90"]},{"name":"Invincible","tier":10,"level":600,"variant":"","ranges":["95～100"]}],"prefixes:移动速度提高":[{"name":"Sprightly","tier":1,"level":1,"variant":"","ranges":["10～14%"]},{"name":"Vivacious","tier":2,"level":50,"variant":"","ranges":["15～19%"]},{"name":"Adroit","tier":3,"level":100,"variant":"","ranges":["20～24%"]},{"name":"Lithe","tier":4,"level":150,"variant":"","ranges":["25～29%"]},{"name":"Supple","tier":5,"level":200,"variant":"","ranges":["30～34%"]},{"name":"Energetic","tier":6,"level":260,"variant":"","ranges":["35～39%"]},{"name":"Athletic","tier":7,"level":330,"variant":"","ranges":["40～44%"]},{"name":"Impetuous","tier":8,"level":410,"variant":"","ranges":["45～49%"]},{"name":"Precipitous","tier":9,"level":500,"variant":"","ranges":["50～54%"]},{"name":"Expeditious","tier":10,"level":600,"variant":"","ranges":["55～59%"]}],"suffixes:持续伤害闪避率（固定调整）":[{"name":"of Dodging","tier":1,"level":1,"variant":"","ranges":["1～2%"]},{"name":"of Evasion","tier":2,"level":50,"variant":"","ranges":["3～4%"]},{"name":"of Footwork","tier":3,"level":100,"variant":"","ranges":["5～6%"]},{"name":"of Agility","tier":4,"level":150,"variant":"","ranges":["7～8%"]},{"name":"of Elusion","tier":5,"level":200,"variant":"","ranges":["9～10%"]},{"name":"of Fleetness","tier":6,"level":260,"variant":"","ranges":["11～12%"]},{"name":"of Phasing","tier":7,"level":330,"variant":"","ranges":["13～14%"]},{"name":"of Ghosting","tier":8,"level":410,"variant":"","ranges":["15～16%"]},{"name":"of Intangibility","tier":9,"level":500,"variant":"","ranges":["17～18%"]},{"name":"of Untouchability","tier":10,"level":600,"variant":"","ranges":["19～20%"]}],"suffixes:毒素防御（固定调整）":[{"name":"of Venomscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Venomfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Venomguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Venomshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Venomveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Venomward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Venommantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Venomscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Venommail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Venomplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:法力恢复（固定调整）":[{"name":"of Flow","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Stream","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Current","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Progress","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Growth","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Cogitation","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Meditation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Tranquility","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Enlightenment","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Nirvana","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:火焰防御（固定调整）":[{"name":"of Emberscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Emberfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Emberguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Embershield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Emberveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Emberward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Embermantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Emberscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Embermail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Emberplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:生命恢复（固定调整）":[{"name":"of Regeneration","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Vigor","tier":2,"level":50,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Restoration","tier":3,"level":100,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Endurance","tier":4,"level":150,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Vitality","tier":5,"level":200,"variant":"","ranges":["0.9～1%"]},{"name":"of Renewal","tier":6,"level":260,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Rejuvenation","tier":7,"level":330,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Invigoration","tier":8,"level":410,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Perpetuity","tier":9,"level":500,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Immortality","tier":10,"level":600,"variant":"","ranges":["1.9～2%"]}],"suffixes:金币获取量额外提高":[{"name":"of Greed","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Cupidity","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Avarice","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Covetousness","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Rapacity","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Plunder","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Pillage","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Looting","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Hoarding","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Gluttony","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:雷电防御（固定调整）":[{"name":"of Tempestscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Tempestfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Tempestguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Tempestshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Tempestveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Tempestward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Tempestmantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Tempestscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Tempestmail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Tempestplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}]}},{"name":"戒指","prefixes":["暴击伤害提高","最大法力提高","毒素伤害额外提高","火焰伤害额外提高","物理伤害额外提高","金币获取量额外提高","雷电伤害额外提高"],"suffixes":["攻击技能的伤害额外提高","攻击技能的伤害额外提高 / 攻击技能的技能速度降低","毒素防御（固定调整）","法术伤害额外提高","法术伤害额外提高 / 法术技能的法力消耗提高","火焰防御（固定调整）","金币获取量额外提高","雷电防御（固定调整）"],"tiers":{"prefixes:暴击伤害提高":[{"name":"Harmful","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Dangerous","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Grievous","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Lethal","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Mortal","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Deadly","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Fatal","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Grim","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Terrible","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Terminal","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:最大法力提高":[{"name":"Thoughtful","tier":1,"level":1,"variant":"","ranges":["2～4%"]},{"name":"Cognitive","tier":2,"level":50,"variant":"","ranges":["5～7%"]},{"name":"Analytical","tier":3,"level":100,"variant":"","ranges":["8～10%"]},{"name":"Knowing","tier":4,"level":150,"variant":"","ranges":["11～13%"]},{"name":"Sagacious","tier":5,"level":200,"variant":"","ranges":["14～16%"]},{"name":"Insightful","tier":6,"level":260,"variant":"","ranges":["17～19%"]},{"name":"Intelligent","tier":7,"level":330,"variant":"","ranges":["20～22%"]},{"name":"Intuitive","tier":8,"level":410,"variant":"","ranges":["23～25%"]},{"name":"Gifted","tier":9,"level":500,"variant":"","ranges":["26～28%"]},{"name":"Genius","tier":10,"level":600,"variant":"","ranges":["29～32%"]}],"prefixes:毒素伤害额外提高":[{"name":"Sick","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Ill","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Diseased","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Plagued","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Pestiferous","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Septic","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Cancerous","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Putrid","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Necrotic","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Pandemic","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:火焰伤害额外提高":[{"name":"Tepid","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Warm","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Heated","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Hot","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Torrid","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Fiery","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Molten","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Igneous","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Sulfurous","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Infernal","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:物理伤害额外提高":[{"name":"Striking","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Lashing","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Pummeling","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Breaking","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Crushing","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Smashing","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Fracturing","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Shattering","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Destroying","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Ravaging","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:金币获取量额外提高":[{"name":"Shiny","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Gleaming","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Glistening","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Lustrous","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Radiant","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Polished","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Brilliant","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Resplendent","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Gilded","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Opulent","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"prefixes:雷电伤害额外提高":[{"name":"Charged","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"Foaming","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"Conductive","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"Swirling","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"Voltaic","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"Turbulent","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"Uproaring","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"Fulminating","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"Hazardous","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"Maelstromic","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:攻击技能的伤害额外提高":[{"name":"of Ire","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Temper","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Wrath","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Belligerence","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Ferocity","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Aggression","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Rage","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Hatred","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Fury","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Bloodlust","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:攻击技能的伤害额外提高 / 攻击技能的技能速度降低":[{"name":"of Caution","tier":1,"level":1,"variant":"","ranges":["50～90%","5～5%"]},{"name":"of Carefulness","tier":2,"level":50,"variant":"","ranges":["110～140%","10～10%"]},{"name":"of Attention","tier":3,"level":100,"variant":"","ranges":["160～190%","15～15%"]},{"name":"of Watchfulness","tier":4,"level":150,"variant":"","ranges":["210～240%","20～20%"]},{"name":"of Deliberation","tier":5,"level":200,"variant":"","ranges":["260～290%","25～25%"]},{"name":"of Focus","tier":6,"level":260,"variant":"","ranges":["320～360%","30～30%"]},{"name":"of Calculation","tier":7,"level":330,"variant":"","ranges":["390～440%","35～35%"]},{"name":"of Discipline","tier":8,"level":410,"variant":"","ranges":["470～530%","40～40%"]},{"name":"of Control","tier":9,"level":500,"variant":"","ranges":["560～640%","45～45%"]},{"name":"of Reckoning","tier":10,"level":600,"variant":"","ranges":["700～800%","50～50%"]}],"suffixes:毒素防御（固定调整）":[{"name":"of Venomscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Venomfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Venomguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Venomshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Venomveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Venomward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Venommantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Venomscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Venommail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Venomplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:法术伤害额外提高":[{"name":"of Spellcasting","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Wizardry","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Sorcery","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Thaumaturgy","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Arcanum","tier":5,"level":200,"variant":"","ranges":["120～145%"]},{"name":"of Theurgy","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Enchantment","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Incantation","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Conjuration","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Invocation","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:法术伤害额外提高 / 法术技能的法力消耗提高":[{"name":"of Confidence","tier":1,"level":1,"variant":"","ranges":["40～65%","25～25%"]},{"name":"of Presumption","tier":2,"level":50,"variant":"","ranges":["75～105%","50～50%"]},{"name":"of Vanity","tier":3,"level":100,"variant":"","ranges":["120～145%","75～75%"]},{"name":"of Arrogance","tier":4,"level":150,"variant":"","ranges":["155～180%","100～100%"]},{"name":"of Conceit","tier":5,"level":200,"variant":"","ranges":["190～215%","125～125%"]},{"name":"of Audacity","tier":6,"level":260,"variant":"","ranges":["240～270%","150～150%"]},{"name":"of Insolence","tier":7,"level":330,"variant":"","ranges":["290～330%","175～175%"]},{"name":"of Pride","tier":8,"level":410,"variant":"","ranges":["350～400%","200～200%"]},{"name":"of Ego","tier":9,"level":500,"variant":"","ranges":["420～480%","225～225%"]},{"name":"of Hubris","tier":10,"level":600,"variant":"","ranges":["525～600%","250～250%"]}],"suffixes:火焰防御（固定调整）":[{"name":"of Emberscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Emberfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Emberguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Embershield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Emberveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Emberward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Embermantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Emberscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Embermail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Emberplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}],"suffixes:金币获取量额外提高":[{"name":"of Greed","tier":1,"level":1,"variant":"","ranges":["25～45%"]},{"name":"of Cupidity","tier":2,"level":50,"variant":"","ranges":["55～70%"]},{"name":"of Avarice","tier":3,"level":100,"variant":"","ranges":["80～95%"]},{"name":"of Covetousness","tier":4,"level":150,"variant":"","ranges":["105～120%"]},{"name":"of Rapacity","tier":5,"level":200,"variant":"","ranges":["130～145%"]},{"name":"of Plunder","tier":6,"level":260,"variant":"","ranges":["160～180%"]},{"name":"of Pillage","tier":7,"level":330,"variant":"","ranges":["195～220%"]},{"name":"of Looting","tier":8,"level":410,"variant":"","ranges":["235～265%"]},{"name":"of Hoarding","tier":9,"level":500,"variant":"","ranges":["280～320%"]},{"name":"of Gluttony","tier":10,"level":600,"variant":"","ranges":["350～400%"]}],"suffixes:雷电防御（固定调整）":[{"name":"of Tempestscreen","tier":1,"level":1,"variant":"","ranges":["25～45"]},{"name":"of Tempestfoil","tier":2,"level":50,"variant":"","ranges":["55～70"]},{"name":"of Tempestguard","tier":3,"level":100,"variant":"","ranges":["80～95"]},{"name":"of Tempestshield","tier":4,"level":150,"variant":"","ranges":["105～120"]},{"name":"of Tempestveil","tier":5,"level":200,"variant":"","ranges":["130～145"]},{"name":"of Tempestward","tier":6,"level":260,"variant":"","ranges":["155～170"]},{"name":"of Tempestmantle","tier":7,"level":330,"variant":"","ranges":["180～195"]},{"name":"of Tempestscale","tier":8,"level":410,"variant":"","ranges":["205～220"]},{"name":"of Tempestmail","tier":9,"level":500,"variant":"","ranges":["230～250"]},{"name":"of Tempestplate","tier":10,"level":600,"variant":"","ranges":["260～300"]}]}},{"name":"符文","prefixes":["攻击技能的技能速度提高","暴击伤害提高","最大法力提高","最大生命提高","毒素伤害提高","法术技能的技能速度提高","火焰伤害提高","物理伤害提高","防御提高","雷电伤害提高"],"suffixes":["持续伤害闪避率（固定调整）","攻击技能的伤害提高","暴击率提高","法力恢复（固定调整）","法术技能的伤害提高","生命恢复（固定调整）","金币获取量额外提高"],"tiers":{"prefixes:攻击技能的技能速度提高":[{"name":"Nimble","tier":1,"level":1,"variant":"","ranges":["1～1%"]},{"name":"Quick","tier":2,"level":100,"variant":"","ranges":["2～2%"]},{"name":"Swift","tier":3,"level":200,"variant":"","ranges":["3～3%"]},{"name":"Brisk","tier":4,"level":300,"variant":"","ranges":["4～4%"]},{"name":"Sudden","tier":5,"level":400,"variant":"","ranges":["5～5%"]},{"name":"Impulsive","tier":6,"level":500,"variant":"","ranges":["6～6%"]},{"name":"Precipitate","tier":7,"level":600,"variant":"","ranges":["7～7%"]},{"name":"Abrupt","tier":8,"level":700,"variant":"","ranges":["8～8%"]},{"name":"Immediate","tier":9,"level":800,"variant":"","ranges":["9～9%"]},{"name":"Unforeseen","tier":10,"level":900,"variant":"","ranges":["10～10%"]}],"prefixes:暴击伤害提高":[{"name":"Harmful","tier":1,"level":1,"variant":"","ranges":["5～10%"]},{"name":"Dangerous","tier":2,"level":100,"variant":"","ranges":["15～20%"]},{"name":"Grievous","tier":3,"level":200,"variant":"","ranges":["25～30%"]},{"name":"Lethal","tier":4,"level":300,"variant":"","ranges":["35～40%"]},{"name":"Mortal","tier":5,"level":400,"variant":"","ranges":["45～50%"]},{"name":"Deadly","tier":6,"level":500,"variant":"","ranges":["55～60%"]},{"name":"Fatal","tier":7,"level":600,"variant":"","ranges":["65～70%"]},{"name":"Grim","tier":8,"level":700,"variant":"","ranges":["75～80%"]},{"name":"Terrible","tier":9,"level":800,"variant":"","ranges":["85～90%"]},{"name":"Terminal","tier":10,"level":900,"variant":"","ranges":["95～100%"]}],"prefixes:最大法力提高":[{"name":"Thoughtful","tier":1,"level":1,"variant":"","ranges":["1～2%"]},{"name":"Cognitive","tier":2,"level":50,"variant":"","ranges":["3～4%"]},{"name":"Analytical","tier":3,"level":200,"variant":"","ranges":["5～6%"]},{"name":"Knowing","tier":4,"level":300,"variant":"","ranges":["7～8%"]},{"name":"Sagacious","tier":5,"level":400,"variant":"","ranges":["9～10%"]},{"name":"Insightful","tier":6,"level":500,"variant":"","ranges":["11～12%"]},{"name":"Intelligent","tier":7,"level":600,"variant":"","ranges":["13～14%"]},{"name":"Intuitive","tier":8,"level":700,"variant":"","ranges":["15～16%"]},{"name":"Gifted","tier":9,"level":800,"variant":"","ranges":["17～18%"]},{"name":"Genius","tier":10,"level":900,"variant":"","ranges":["19～20%"]}],"prefixes:最大生命提高":[{"name":"Hefty","tier":1,"level":1,"variant":"","ranges":["1～2%"]},{"name":"Robust","tier":2,"level":100,"variant":"","ranges":["3～4%"]},{"name":"Stout","tier":3,"level":200,"variant":"","ranges":["5～6%"]},{"name":"Beefy","tier":4,"level":300,"variant":"","ranges":["7～8%"]},{"name":"Endurant","tier":5,"level":400,"variant":"","ranges":["9～10%"]},{"name":"Hulking","tier":6,"level":500,"variant":"","ranges":["11～12%"]},{"name":"Resistant","tier":7,"level":600,"variant":"","ranges":["13～14%"]},{"name":"Stalwart","tier":10,"level":600,"variant":"","ranges":["19～20%"]},{"name":"Tenacious","tier":8,"level":700,"variant":"","ranges":["15～16%"]},{"name":"Resilient","tier":9,"level":800,"variant":"","ranges":["17～18%"]}],"prefixes:毒素伤害提高":[{"name":"Sick","tier":1,"level":1,"variant":"","ranges":["10～20%"]},{"name":"Ill","tier":2,"level":100,"variant":"","ranges":["30～40%"]},{"name":"Diseased","tier":3,"level":200,"variant":"","ranges":["50～60%"]},{"name":"Plagued","tier":4,"level":300,"variant":"","ranges":["70～80%"]},{"name":"Pestiferous","tier":5,"level":400,"variant":"","ranges":["90～100%"]},{"name":"Septic","tier":6,"level":500,"variant":"","ranges":["110～120%"]},{"name":"Cancerous","tier":7,"level":600,"variant":"","ranges":["130～140%"]},{"name":"Putrid","tier":8,"level":700,"variant":"","ranges":["150～160%"]},{"name":"Necrotic","tier":9,"level":800,"variant":"","ranges":["170～180%"]},{"name":"Pandemic","tier":10,"level":900,"variant":"","ranges":["190～200%"]}],"prefixes:法术技能的技能速度提高":[{"name":"Spiraling","tier":1,"level":1,"variant":"","ranges":["1～1%"]},{"name":"Veering","tier":2,"level":100,"variant":"","ranges":["2～2%"]},{"name":"Surging","tier":3,"level":200,"variant":"","ranges":["3～3%"]},{"name":"Soaring","tier":4,"level":300,"variant":"","ranges":["4～4%"]},{"name":"Warping","tier":5,"level":400,"variant":"","ranges":["5～5%"]},{"name":"Distorting","tier":6,"level":500,"variant":"","ranges":["6～6%"]},{"name":"Skewed","tier":7,"level":600,"variant":"","ranges":["7～7%"]},{"name":"Displaced","tier":8,"level":700,"variant":"","ranges":["8～8%"]},{"name":"Anomalous","tier":9,"level":800,"variant":"","ranges":["9～9%"]},{"name":"Paradoxical","tier":10,"level":900,"variant":"","ranges":["10～10%"]}],"prefixes:火焰伤害提高":[{"name":"Tepid","tier":1,"level":1,"variant":"","ranges":["10～20%"]},{"name":"Warm","tier":2,"level":100,"variant":"","ranges":["30～40%"]},{"name":"Heated","tier":3,"level":200,"variant":"","ranges":["50～60%"]},{"name":"Hot","tier":4,"level":300,"variant":"","ranges":["70～80%"]},{"name":"Torrid","tier":5,"level":400,"variant":"","ranges":["90～100%"]},{"name":"Fiery","tier":6,"level":500,"variant":"","ranges":["110～120%"]},{"name":"Molten","tier":7,"level":600,"variant":"","ranges":["130～140%"]},{"name":"Igneous","tier":8,"level":700,"variant":"","ranges":["150～160%"]},{"name":"Sulfurous","tier":9,"level":800,"variant":"","ranges":["170～180%"]},{"name":"Infernal","tier":10,"level":900,"variant":"","ranges":["190～200%"]}],"prefixes:物理伤害提高":[{"name":"Striking","tier":1,"level":1,"variant":"","ranges":["10～20%"]},{"name":"Lashing","tier":2,"level":100,"variant":"","ranges":["30～40%"]},{"name":"Pummeling","tier":3,"level":200,"variant":"","ranges":["50～60%"]},{"name":"Breaking","tier":4,"level":300,"variant":"","ranges":["70～80%"]},{"name":"Crushing","tier":5,"level":400,"variant":"","ranges":["90～100%"]},{"name":"Smashing","tier":6,"level":500,"variant":"","ranges":["110～120%"]},{"name":"Fracturing","tier":7,"level":600,"variant":"","ranges":["130～140%"]},{"name":"Shattering","tier":8,"level":700,"variant":"","ranges":["150～160%"]},{"name":"Destroying","tier":9,"level":800,"variant":"","ranges":["170～180%"]},{"name":"Ravaging","tier":10,"level":900,"variant":"","ranges":["190～200%"]}],"prefixes:防御提高":[{"name":"Tough","tier":1,"level":1,"variant":"","ranges":["5～10%"]},{"name":"Sturdy","tier":2,"level":100,"variant":"","ranges":["15～20%"]},{"name":"Reinforcing","tier":3,"level":200,"variant":"","ranges":["25～30%"]},{"name":"Bulwarked","tier":4,"level":300,"variant":"","ranges":["35～40%"]},{"name":"Protective","tier":5,"level":400,"variant":"","ranges":["45～50%"]},{"name":"Defensive","tier":6,"level":500,"variant":"","ranges":["55～60%"]},{"name":"Guardian","tier":7,"level":600,"variant":"","ranges":["65～70%"]},{"name":"Sentinel","tier":8,"level":700,"variant":"","ranges":["75～80%"]},{"name":"Bastion","tier":9,"level":800,"variant":"","ranges":["85～90%"]},{"name":"Fortress","tier":10,"level":900,"variant":"","ranges":["95～100%"]}],"prefixes:雷电伤害提高":[{"name":"Charged","tier":1,"level":1,"variant":"","ranges":["10～20%"]},{"name":"Foaming","tier":2,"level":100,"variant":"","ranges":["30～40%"]},{"name":"Conductive","tier":3,"level":200,"variant":"","ranges":["50～60%"]},{"name":"Swirling","tier":4,"level":300,"variant":"","ranges":["70～80%"]},{"name":"Voltaic","tier":5,"level":400,"variant":"","ranges":["90～100%"]},{"name":"Turbulent","tier":6,"level":500,"variant":"","ranges":["110～120%"]},{"name":"Uproaring","tier":7,"level":600,"variant":"","ranges":["130～140%"]},{"name":"Fulminating","tier":8,"level":700,"variant":"","ranges":["150～160%"]},{"name":"Hazardous","tier":9,"level":800,"variant":"","ranges":["170～180%"]},{"name":"Maelstromic","tier":10,"level":900,"variant":"","ranges":["190～200%"]}],"suffixes:持续伤害闪避率（固定调整）":[{"name":"of Dodging","tier":1,"level":1,"variant":"","ranges":["1～1%"]},{"name":"of Evasion","tier":2,"level":100,"variant":"","ranges":["2～2%"]},{"name":"of Footwork","tier":3,"level":200,"variant":"","ranges":["3～3%"]},{"name":"of Agility","tier":4,"level":300,"variant":"","ranges":["4～4%"]},{"name":"of Elusion","tier":5,"level":400,"variant":"","ranges":["5～5%"]},{"name":"of Fleetness","tier":6,"level":500,"variant":"","ranges":["6～6%"]},{"name":"of Phasing","tier":7,"level":600,"variant":"","ranges":["7～7%"]},{"name":"of Ghosting","tier":8,"level":700,"variant":"","ranges":["8～8%"]},{"name":"of Intangibility","tier":9,"level":800,"variant":"","ranges":["9～9%"]},{"name":"of Untouchability","tier":10,"level":900,"variant":"","ranges":["10～10%"]}],"suffixes:攻击技能的伤害提高":[{"name":"of Ire","tier":1,"level":1,"variant":"","ranges":["10～20%"]},{"name":"of Temper","tier":2,"level":100,"variant":"","ranges":["30～40%"]},{"name":"of Wrath","tier":3,"level":200,"variant":"","ranges":["50～60%"]},{"name":"of Belligerence","tier":4,"level":300,"variant":"","ranges":["70～80%"]},{"name":"of Ferocity","tier":5,"level":400,"variant":"","ranges":["90～100%"]},{"name":"of Aggression","tier":6,"level":500,"variant":"","ranges":["110～120%"]},{"name":"of Rage","tier":7,"level":600,"variant":"","ranges":["130～140%"]},{"name":"of Hatred","tier":8,"level":700,"variant":"","ranges":["150～160%"]},{"name":"of Fury","tier":9,"level":800,"variant":"","ranges":["170～180%"]},{"name":"of Bloodlust","tier":10,"level":900,"variant":"","ranges":["190～200%"]}],"suffixes:暴击率提高":[{"name":"of Aim","tier":1,"level":1,"variant":"","ranges":["3～5%"]},{"name":"of Rigor","tier":2,"level":100,"variant":"","ranges":["7～10%"]},{"name":"of Accuracy","tier":3,"level":200,"variant":"","ranges":["13～15%"]},{"name":"of Efficiency","tier":4,"level":300,"variant":"","ranges":["17～20%"]},{"name":"of Precision","tier":5,"level":400,"variant":"","ranges":["23～25%"]},{"name":"of Incisiveness","tier":6,"level":500,"variant":"","ranges":["27～30%"]},{"name":"of Exactitude","tier":7,"level":600,"variant":"","ranges":["33～35%"]},{"name":"of Meticulousness","tier":8,"level":700,"variant":"","ranges":["37～40%"]},{"name":"of Certainty","tier":9,"level":800,"variant":"","ranges":["43～45%"]},{"name":"of Perfection","tier":10,"level":900,"variant":"","ranges":["47～50%"]}],"suffixes:法力恢复（固定调整）":[{"name":"of Flow","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Stream","tier":2,"level":100,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Current","tier":3,"level":200,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Progress","tier":4,"level":300,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Growth","tier":5,"level":400,"variant":"","ranges":["0.9～1%"]},{"name":"of Cogitation","tier":6,"level":500,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Meditation","tier":7,"level":600,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Tranquility","tier":8,"level":700,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Enlightenment","tier":9,"level":800,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Nirvana","tier":10,"level":900,"variant":"","ranges":["1.9～2%"]}],"suffixes:法术技能的伤害提高":[{"name":"of Spellcasting","tier":1,"level":1,"variant":"","ranges":["10～20%"]},{"name":"of Wizardry","tier":2,"level":100,"variant":"","ranges":["30～40%"]},{"name":"of Sorcery","tier":3,"level":200,"variant":"","ranges":["50～60%"]},{"name":"of Thaumaturgy","tier":4,"level":300,"variant":"","ranges":["70～80%"]},{"name":"of Arcanum","tier":5,"level":400,"variant":"","ranges":["90～100%"]},{"name":"of Theurgy","tier":6,"level":500,"variant":"","ranges":["110～120%"]},{"name":"of Enchantment","tier":7,"level":600,"variant":"","ranges":["130～140%"]},{"name":"of Incantation","tier":8,"level":700,"variant":"","ranges":["150～160%"]},{"name":"of Conjuration","tier":9,"level":800,"variant":"","ranges":["170～180%"]},{"name":"of Invocation","tier":10,"level":900,"variant":"","ranges":["190～200%"]}],"suffixes:生命恢复（固定调整）":[{"name":"of Regeneration","tier":1,"level":1,"variant":"","ranges":["0.1～0.2%"]},{"name":"of Vigor","tier":2,"level":100,"variant":"","ranges":["0.3～0.4%"]},{"name":"of Restoration","tier":3,"level":200,"variant":"","ranges":["0.5～0.6%"]},{"name":"of Endurance","tier":4,"level":300,"variant":"","ranges":["0.7～0.8%"]},{"name":"of Vitality","tier":5,"level":400,"variant":"","ranges":["0.9～1%"]},{"name":"of Renewal","tier":6,"level":500,"variant":"","ranges":["1.1～1.2%"]},{"name":"of Rejuvenation","tier":7,"level":600,"variant":"","ranges":["1.3～1.4%"]},{"name":"of Invigoration","tier":8,"level":700,"variant":"","ranges":["1.5～1.6%"]},{"name":"of Perpetuity","tier":9,"level":800,"variant":"","ranges":["1.7～1.8%"]},{"name":"of Immortality","tier":10,"level":900,"variant":"","ranges":["1.9～2%"]}],"suffixes:金币获取量额外提高":[{"name":"of Greed","tier":1,"level":1,"variant":"","ranges":["5～10%"]},{"name":"of Cupidity","tier":2,"level":100,"variant":"","ranges":["15～20%"]},{"name":"of Avarice","tier":3,"level":200,"variant":"","ranges":["25～30%"]},{"name":"of Covetousness","tier":4,"level":300,"variant":"","ranges":["35～40%"]},{"name":"of Rapacity","tier":5,"level":400,"variant":"","ranges":["45～50%"]},{"name":"of Plunder","tier":6,"level":500,"variant":"","ranges":["55～60%"]},{"name":"of Pillage","tier":7,"level":600,"variant":"","ranges":["65～70%"]},{"name":"of Looting","tier":8,"level":700,"variant":"","ranges":["75～80%"]},{"name":"of Hoarding","tier":9,"level":800,"variant":"","ranges":["85～90%"]},{"name":"of Gluttony","tier":10,"level":900,"variant":"","ranges":["95～100%"]}]}},{"name":"敕令","prefixes":["敌人持续伤害闪避率（固定调整） / 掉落物品稀有度提高 / 掉落物品战力等级提高","敌人最大生命提高 / 掉落物品稀有度提高 / 掉落物品战力等级提高","敌人格挡率（固定调整） / 掉落物品稀有度提高 / 掉落物品战力等级提高","敌人生命恢复（固定调整） / 掉落物品稀有度提高 / 掉落物品战力等级提高","敌人诅咒技能的持续效果抗性（固定调整） / 敌人眩晕抗性（固定调整） / 掉落物品稀有度提高 / 掉落物品战力等级提高","敌人防御（固定调整） / 敌人防御提高 / 掉落物品稀有度提高 / 掉落物品战力等级提高"],"suffixes":["敌人伤害额外提高 / 掉落物品稀有度提高 / 精英怪物宝石奖励提高 / 掉落物品战力等级提高","敌人技能速度提高 / 掉落物品稀有度提高 / 掉落物品战力等级提高","敌人暴击伤害（固定调整） / 敌人暴击率（固定调整） / 掉落物品稀有度提高 / 掉落物品战力等级提高","敌人金币获取量额外降低 / 敌人区域物品发现率提高 / 掉落物品战力等级提高","敌人额外获得等同于基础命中伤害一定比例的最高雷电伤害 / 掉落物品稀有度提高 / 掉落物品战力等级提高","敌人额外获得等同于基础命中伤害一定比例的火焰伤害 / 掉落物品稀有度提高 / 掉落物品战力等级提高"],"tiers":{"prefixes:敌人持续伤害闪避率（固定调整） / 掉落物品稀有度提高 / 掉落物品战力等级提高":[{"name":"Dodging","tier":1,"level":100,"variant":"","ranges":["20～20%","10～10%","2～2"]},{"name":"Evasive","tier":2,"level":200,"variant":"","ranges":["22～22%","20～20%","4～4"]},{"name":"Footwork","tier":3,"level":300,"variant":"","ranges":["25～25%","30～30%","6～6"]},{"name":"Agile","tier":4,"level":400,"variant":"","ranges":["28～28%","40～40%","8～8"]},{"name":"Elusive","tier":5,"level":500,"variant":"","ranges":["30～30%","50～50%","10～10"]},{"name":"Fleet","tier":6,"level":600,"variant":"","ranges":["32～32%","60～60%","12～12"]},{"name":"Phasing","tier":7,"level":700,"variant":"","ranges":["35～35%","70～70%","14～14"]},{"name":"Ghosting","tier":8,"level":800,"variant":"","ranges":["38～38%","80～80%","16～16"]},{"name":"Intangible","tier":9,"level":900,"variant":"","ranges":["40～40%","100～100%","20～20"]}],"prefixes:敌人最大生命提高 / 掉落物品稀有度提高 / 掉落物品战力等级提高":[{"name":"Hefty","tier":1,"level":100,"variant":"","ranges":["50～50%","20～20%","4～4"]},{"name":"Robust","tier":2,"level":200,"variant":"","ranges":["100～100%","40～40%","8～8"]},{"name":"Stout","tier":3,"level":300,"variant":"","ranges":["200～200%","60～60%","12～12"]},{"name":"Beefy","tier":4,"level":400,"variant":"","ranges":["300～300%","80～80%","16～16"]},{"name":"Endurant","tier":5,"level":500,"variant":"","ranges":["500～500%","100～100%","20～20"]},{"name":"Hulking","tier":6,"level":600,"variant":"","ranges":["800～800%","120～120%","24～24"]},{"name":"Resistant","tier":7,"level":700,"variant":"","ranges":["1300～1300%","140～140%","28～28"]},{"name":"Tenacious","tier":8,"level":800,"variant":"","ranges":["2000～2000%","160～160%","32～32"]},{"name":"Resilient","tier":9,"level":900,"variant":"","ranges":["3500～3500%","200～200%","40～40"]}],"prefixes:敌人格挡率（固定调整） / 掉落物品稀有度提高 / 掉落物品战力等级提高":[{"name":"Deflecting","tier":1,"level":100,"variant":"","ranges":["20～20%","10～10%","2～2"]},{"name":"Deflecting","tier":2,"level":200,"variant":"","ranges":["22～22%","20～20%","4～4"]},{"name":"Protective","tier":3,"level":300,"variant":"","ranges":["25～25%","30～30%","6～6"]},{"name":"Guarding","tier":4,"level":400,"variant":"","ranges":["28～28%","40～40%","8～8"]},{"name":"Shielding","tier":5,"level":500,"variant":"","ranges":["30～30%","50～50%","10～10"]},{"name":"Fortified","tier":6,"level":600,"variant":"","ranges":["32～32%","60～60%","12～12"]},{"name":"Vigilant","tier":7,"level":700,"variant":"","ranges":["35～35%","70～70%","14～14"]},{"name":"Preserving","tier":8,"level":800,"variant":"","ranges":["38～38%","80～80%","16～16"]},{"name":"Safeguarding","tier":9,"level":900,"variant":"","ranges":["40～40%","100～100%","20～20"]}],"prefixes:敌人生命恢复（固定调整） / 掉落物品稀有度提高 / 掉落物品战力等级提高":[{"name":"Lively","tier":1,"level":100,"variant":"","ranges":["0.3～0.3%","20～20%","4～4"]},{"name":"Healthy","tier":2,"level":200,"variant":"","ranges":["0.6～0.6%","40～40%","8～8"]},{"name":"Hearty","tier":3,"level":300,"variant":"","ranges":["0.9～0.9%","60～60%","12～12"]},{"name":"Enduring","tier":4,"level":400,"variant":"","ranges":["1.2～1.2%","80～80%","16～16"]},{"name":"Vigorous","tier":5,"level":500,"variant":"","ranges":["1.5～1.5%","100～100%","20～20"]},{"name":"Burly","tier":6,"level":600,"variant":"","ranges":["1.8～1.8%","120～120%","24～24"]},{"name":"Brawny","tier":7,"level":700,"variant":"","ranges":["2.1～2.1%","140～140%","28～28"]},{"name":"Solid","tier":8,"level":800,"variant":"","ranges":["2.5～2.5%","160～160%","32～32"]},{"name":"Imposing","tier":9,"level":900,"variant":"","ranges":["3～3%","200～200%","40～40"]}],"prefixes:敌人诅咒技能的持续效果抗性（固定调整） / 敌人眩晕抗性（固定调整） / 掉落物品稀有度提高 / 掉落物品战力等级提高":[{"name":"Resilient","tier":1,"level":100,"variant":"","ranges":["50～50%","50～50%","10～10%","2～2"]},{"name":"Resolute","tier":2,"level":200,"variant":"","ranges":["55～55%","55～55%","20～20%","4～4"]},{"name":"Unyielding","tier":3,"level":300,"variant":"","ranges":["60～60%","60～60%","30～30%","6～6"]},{"name":"Steadfast","tier":4,"level":400,"variant":"","ranges":["70～70%","70～70%","40～40%","8～8"]},{"name":"Stalwart","tier":5,"level":500,"variant":"","ranges":["75～75%","75～75%","50～50%","10～10"]},{"name":"Adamant","tier":6,"level":600,"variant":"","ranges":["80～80%","80～80%","60～60%","12～12"]},{"name":"Unbreakable","tier":7,"level":700,"variant":"","ranges":["85～85%","85～85%","70～70%","14～14"]},{"name":"Indomitable","tier":8,"level":800,"variant":"","ranges":["90～90%","90～90%","80～80%","16～16"]},{"name":"Unconquerable","tier":9,"level":900,"variant":"","ranges":["100～100%","100～100%","100～100%","20～20"]}],"prefixes:敌人防御（固定调整） / 敌人防御提高 / 掉落物品稀有度提高 / 掉落物品战力等级提高":[{"name":"Tough","tier":1,"level":100,"variant":"","ranges":["50～50","50～50%","20～20%","4～4"]},{"name":"Sturdy","tier":2,"level":200,"variant":"","ranges":["50～50","100～100%","40～40%","8～8"]},{"name":"Reinforcing","tier":3,"level":300,"variant":"","ranges":["50～50","200～200%","60～60%","12～12"]},{"name":"Bulwarked","tier":4,"level":400,"variant":"","ranges":["50～50","300～300%","80～80%","16～16"]},{"name":"Protective","tier":5,"level":500,"variant":"","ranges":["50～50","400～400%","100～100%","20～20"]},{"name":"Defensive","tier":6,"level":600,"variant":"","ranges":["50～50","500～500%","120～120%","24～24"]},{"name":"Guardian","tier":7,"level":700,"variant":"","ranges":["50～50","600～600%","140～140%","28～28"]},{"name":"Sentinel","tier":8,"level":800,"variant":"","ranges":["50～50","700～700%","160～160%","32～32"]},{"name":"Bastion","tier":9,"level":900,"variant":"","ranges":["50～50","800～800%","200～200%","40～40"]}],"suffixes:敌人伤害额外提高 / 掉落物品稀有度提高 / 精英怪物宝石奖励提高 / 掉落物品战力等级提高":[{"name":"of Pain","tier":1,"level":100,"variant":"","ranges":["40～40%","20～20%","10～10%","4～4"]},{"name":"of Ache","tier":2,"level":200,"variant":"","ranges":["80～80%","40～40%","20～20%","8～8"]},{"name":"of Agony","tier":3,"level":300,"variant":"","ranges":["120～120%","60～60%","30～30%","12～12"]},{"name":"of Torment","tier":4,"level":400,"variant":"","ranges":["160～160%","80～80%","40～40%","16～16"]},{"name":"of Anguish","tier":5,"level":500,"variant":"","ranges":["200～200%","100～100%","50～50%","20～20"]},{"name":"of Suffering","tier":6,"level":600,"variant":"","ranges":["240～240%","120～120%","60～60%","24～24"]},{"name":"of Misery","tier":7,"level":700,"variant":"","ranges":["280～280%","140～140%","70～70%","28～28"]},{"name":"of Excruciation","tier":8,"level":800,"variant":"","ranges":["320～320%","160～160%","80～80%","32～32"]},{"name":"of Persecution","tier":9,"level":900,"variant":"","ranges":["400～400%","200～200%","100～100%","40～40"]}],"suffixes:敌人技能速度提高 / 掉落物品稀有度提高 / 掉落物品战力等级提高":[{"name":"of Hurry","tier":1,"level":100,"variant":"","ranges":["20～20%","20～20%","4～4"]},{"name":"of Velocity","tier":2,"level":200,"variant":"","ranges":["40～40%","40～40%","8～8"]},{"name":"of Urgency","tier":3,"level":300,"variant":"","ranges":["60～60%","60～60%","12～12"]},{"name":"of Acceleration","tier":4,"level":400,"variant":"","ranges":["80～80%","80～80%","16～16"]},{"name":"of Haste","tier":5,"level":500,"variant":"","ranges":["100～100%","100～100%","20～20"]},{"name":"of Frenzy","tier":6,"level":600,"variant":"","ranges":["120～120%","120～120%","24～24"]},{"name":"of Tantrum","tier":7,"level":700,"variant":"","ranges":["140～140%","140～140%","28～28"]},{"name":"of Craze","tier":8,"level":800,"variant":"","ranges":["160～160%","160～160%","32～32"]},{"name":"of Madness","tier":9,"level":900,"variant":"","ranges":["200～200%","200～200%","40～40"]}],"suffixes:敌人暴击伤害（固定调整） / 敌人暴击率（固定调整） / 掉落物品稀有度提高 / 掉落物品战力等级提高":[{"name":"of Destruction","tier":1,"level":100,"variant":"","ranges":["100～100%","10～10%","20～20%","4～4"]},{"name":"of Havoc","tier":2,"level":200,"variant":"","ranges":["140～140%","12～12%","40～40%","8～8"]},{"name":"of Demolition","tier":3,"level":300,"variant":"","ranges":["180～180%","14～14%","60～60%","12～12"]},{"name":"of Annihilation","tier":4,"level":400,"variant":"","ranges":["220～220%","16～16%","80～80%","16～16"]},{"name":"of Obliteration","tier":5,"level":500,"variant":"","ranges":["260～260%","18～18%","100～100%","20～20"]},{"name":"of Rampage","tier":6,"level":600,"variant":"","ranges":["300～300%","20～20%","120～120%","24～24"]},{"name":"of Ruination","tier":7,"level":700,"variant":"","ranges":["340～340%","22～22%","140～140%","28～28"]},{"name":"of Devastation","tier":8,"level":800,"variant":"","ranges":["380～380%","24～24%","160～160%","32～32"]},{"name":"of Extermination","tier":9,"level":900,"variant":"","ranges":["420～420%","30～30%","200～200%","40～40"]}],"suffixes:敌人金币获取量额外降低 / 敌人区域物品发现率提高 / 掉落物品战力等级提高":[{"name":"of Greed","tier":1,"level":100,"variant":"","ranges":["50～50%","40～40%","2～2"]},{"name":"of Cupidity","tier":2,"level":200,"variant":"","ranges":["100～100%","80～80%","4～4"]},{"name":"of Avarice","tier":3,"level":300,"variant":"","ranges":["200～200%","120～120%","6～6"]},{"name":"of Covetousness","tier":4,"level":400,"variant":"","ranges":["300～300%","160～160%","8～8"]},{"name":"of Rapacity","tier":5,"level":500,"variant":"","ranges":["500～500%","200～200%","10～10"]},{"name":"of Plunder","tier":6,"level":600,"variant":"","ranges":["800～800%","240～240%","12～12"]},{"name":"of Pillage","tier":7,"level":700,"variant":"","ranges":["1300～1300%","280～280%","14～14"]},{"name":"of Looting","tier":8,"level":800,"variant":"","ranges":["2000～2000%","320～320%","16～16"]},{"name":"of Gluttony","tier":9,"level":900,"variant":"","ranges":["3500～3500%","400～400%","20～20"]}],"suffixes:敌人额外获得等同于基础命中伤害一定比例的最高雷电伤害 / 掉落物品稀有度提高 / 掉落物品战力等级提高":[{"name":"of Static","tier":1,"level":100,"variant":"","ranges":["40～40%","20～20%","4～4"]},{"name":"of Current","tier":2,"level":200,"variant":"","ranges":["80～80%","40～40%","8～8"]},{"name":"of Conduction","tier":3,"level":300,"variant":"","ranges":["120～120%","60～60%","12～12"]},{"name":"of Turbulence","tier":4,"level":400,"variant":"","ranges":["160～160%","80～80%","16～16"]},{"name":"of Voltage","tier":5,"level":500,"variant":"","ranges":["200～200%","100～100%","20～20"]},{"name":"of Tempest","tier":6,"level":600,"variant":"","ranges":["240～240%","120～120%","24～24"]},{"name":"of Thunder","tier":7,"level":700,"variant":"","ranges":["280～280%","140～140%","28～28"]},{"name":"of Fulmination","tier":8,"level":800,"variant":"","ranges":["320～320%","160～160%","32～32"]},{"name":"of Cataclysm","tier":9,"level":900,"variant":"","ranges":["400～400%","200～200%","40～40"]}],"suffixes:敌人额外获得等同于基础命中伤害一定比例的火焰伤害 / 掉落物品稀有度提高 / 掉落物品战力等级提高":[{"name":"of Warmth","tier":1,"level":100,"variant":"","ranges":["40～40%","20～20%","4～4"]},{"name":"of Embers","tier":2,"level":200,"variant":"","ranges":["80～80%","40～40%","8～8"]},{"name":"of Flame","tier":3,"level":300,"variant":"","ranges":["120～120%","60～60%","12～12"]},{"name":"of Blaze","tier":4,"level":400,"variant":"","ranges":["160～160%","80～80%","16～16"]},{"name":"of Scorching","tier":5,"level":500,"variant":"","ranges":["200～200%","100～100%","20～20"]},{"name":"of Conflagration","tier":6,"level":600,"variant":"","ranges":["240～240%","120～120%","24～24"]},{"name":"of Sulfur","tier":7,"level":700,"variant":"","ranges":["280～280%","140～140%","28～28"]},{"name":"of Immolation","tier":8,"level":800,"variant":"","ranges":["320～320%","160～160%","32～32"]},{"name":"of Inferno","tier":9,"level":900,"variant":"","ranges":["400～400%","200～200%","40～40"]}]}}],"rangeSource":{"name":"本地游戏词缀库","observedAt":"2026-10-01"}};
  if (!core || !catalog) return;
  const key = 'rollrune-crafting-settings-v1';
  const labels = { add: '随机词缀', prefix: '随机前缀', suffix: '随机后缀', remove: '随机移除' };
  let panel = null, context = null, active = null, scheduled = false;
  const visible = e => e?.isConnected && e.getClientRects().length && !e.closest('[aria-hidden="true"]') && getComputedStyle(e).visibility !== 'hidden';
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const numeric = text => Number(text.replace(/[,，\s]/g, ''));
  function node(tag, attrs = {}, text = '') {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.textContent = text;
    return e;
  }
  function forge() {
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (!visible(dialog)) continue;
      const buttons = [...dialog.querySelectorAll('button')].filter(b => !b.closest('[data-rr-craft-panel]'));
      const add = buttons.find(b => /^随机词缀/.test(b.textContent.trim()));
      if (!add) continue;
      const pane = add.closest('.mobile-flow-detail');
      if (!pane) continue;
      const tooltip = pane.querySelector('.rr-layered-tooltip');
      const card = pane.querySelector('.rr-item-card');
      if (!tooltip || !card) continue;
      const controls = Object.fromEntries(Object.entries(labels).map(([action, label]) => [action, buttons.find(b => pane.contains(b) && b.textContent.trim().startsWith(label))]));
      if (Object.values(controls).some(b => !b)) continue;
      return { dialog, pane, tooltip, card, controls };
    }
    return null;
  }
  function identity(c) { return `${c.card.getAttribute('aria-label')}|${c.card.querySelector('img')?.getAttribute('src')}`; }
  function read(c) {
    const type = [...c.tooltip.querySelectorAll('li')].filter(li => !li.closest('strong')).map(li => li.textContent.trim()).find(t => /^(普通|魔法|稀有|大师杰作|暗金)/.test(t));
    if (!type) throw new Error('没有读到物品类型，请重新选择物品');
    if (/^暗金/.test(type)) throw new Error('暗金物品不支持随机词缀制作');
    const affixes = core.readAffixes(c.tooltip);
    // Removing the last affix does not reset the native item's rarity to Ordinary.
    // No removal price (rather than merely disabled) proves the native affix count is zero.
    const empty = c.controls.remove.disabled && !c.controls.remove.querySelector('.text-fuchsia-300,img[alt="宝石"]');
    if (!affixes.length && !/^普通/.test(type) && !empty) throw new Error('没有读到前后缀明细，请展开装备说明');
    const gemIcon = [...document.querySelectorAll('img[alt="宝石"]')].find(e => !e.closest('[role="dialog"]') && visible(e));
    const gems = gemIcon ? numeric(gemIcon.parentElement.parentElement.textContent) : NaN;
    return { affixes, gems, identity: identity(c), fingerprint: JSON.stringify(affixes) };
  }
  function guess(c) {
    const type = [...c.tooltip.querySelectorAll('li')].map(e => e.textContent.trim()).find(t => /^(普通|魔法|稀有|大师杰作)/.test(t)) || '';
    const category = catalog.categories.find(x => type.includes(x.name));
    if (category) return category.name;
    if (/武器/.test(type)) return /法术|法杖|魔杖/.test(c.tooltip.textContent) ? '法术武器' : '攻击武器';
    return '';
  }
  function config() {
    const category = catalog.categories.find(c => c.name === panel.querySelector('[data-rr-craft-category]').value);
    const targets = core.families(category).filter(f => f.supported && panel.querySelector(`[data-rr-craft-pick="${f.id}"]`).checked).map(f => ({ ...f,
      minimums: [...panel.querySelectorAll(`[data-rr-craft-min="${f.id}"]`)].map(input => input.value === '' ? null : Number(input.value)),
    }));
    if (!targets.length) throw new Error('先勾选想要的词缀，再设置满足条数和预算');
    if (targets.some(t => t.minimums.some(n => n !== null && !Number.isFinite(n)))) throw new Error('请填写有效的目标数值');
    const required = Number(panel.querySelector('[data-rr-craft-required]').value);
    const tier = panel.querySelector('[data-rr-craft-tier]').value;
    const options = core.allocations(targets, required, tier);
    return { category: category.name, targets, required, tier, options };
  }
  function status(text) { if (panel) panel.querySelector('[data-rr-craft-status]').textContent = text; }
  function log(text) {
    if (!panel) return;
    const list = panel.querySelector('[data-rr-craft-log]');
    list.prepend(node('li', {}, `${new Date().toLocaleTimeString('zh-CN')} · ${text}`));
    while (list.children.length > 40) list.lastElementChild.remove();
  }
  function missingProtected(affixes, protectedAffixes) {
    const remaining = affixes.map(a => JSON.stringify(a));
    return protectedAffixes.find(a => {
      const index = remaining.indexOf(JSON.stringify(a));
      if (index < 0) return true;
      remaining.splice(index, 1);return false;
    });
  }
  function renderProtected(c) {
    const section = node('fieldset', { 'data-rr-craft-protected': '' });
    section.append(node('legend', {}, '可选：装备现有词缀被移除时停止'), node('p', { class: 'rr-craft-note' }, '下方仅列出这件装备当前已有的随机词缀，默认不勾选。不勾选则不启用；勾选后，任意一条被移除就立即停止后续操作。本次剥离无法撤销。'));
    const affixes = read(c).affixes;
    affixes.forEach(affix => {
      const label = node('label');
      const input = node('input', { type: 'checkbox', 'data-rr-craft-protect': JSON.stringify(affix) });
      label.append(input, node('span', {}, `${affix.header}：${affix.lines.join(' / ')}`));section.append(label);
    });
    if (!affixes.length) section.append(node('p', { class: 'rr-craft-note' }, '当前没有已有随机词缀可勾选。'));
    panel.append(section);
  }
  function save() {
    if (!panel || active) return;
    try {
      const settings = JSON.parse(localStorage.getItem(key) || '{}');
      const picks = [...panel.querySelectorAll('[data-rr-craft-pick]')].filter(e => e.checked).map(e => ({
        id: e.getAttribute('data-rr-craft-pick'), values: [...panel.querySelectorAll(`[data-rr-craft-min="${e.getAttribute('data-rr-craft-pick')}"]`)].map(x => x.value),
      }));
      settings[panel.querySelector('[data-rr-craft-category]').value] = { picks, required: panel.querySelector('[data-rr-craft-required]').value, tier: panel.querySelector('[data-rr-craft-tier]').value };
      localStorage.setItem(key, JSON.stringify(settings));
    } catch (_) { /* Storage is optional. */ }
  }
  function preview() {
    if (!panel || active) return;
    try {
      const c = forge();
      if (!c) throw new Error('请在锻造词缀页选择物品');
      const state = read(c), cfg = config(), next = core.plan(state, cfg.targets, cfg.required, cfg.options);
      const p = state.affixes.filter(a => a.side === 'prefixes').length;
      const score = next.score;
      panel.querySelector('[data-rr-craft-current]').textContent = `当前 ${p} 前缀／${state.affixes.length - p} 后缀 · 达标 ${score.total}/${cfg.required}（前 ${score.prefixes}／后 ${score.suffixes}）`;
      panel.querySelector('[data-rr-craft-plan]').textContent = `循环底板 ${cfg.options[0].base}／${cfg.options[0].base}，最多 ${cfg.options[0].peak} 条词缀。${next.action === 'stop' ? next.reason : `下一步：${labels[next.action]} · ${next.reason}`}`;
      status(next.action === 'stop' ? next.reason : '设置好预算后点击开始');
      for (const row of panel.querySelectorAll('[data-rr-craft-row]')) {
        row.setAttribute('data-rr-craft-met', score.matched.some(t => t.id === row.getAttribute('data-rr-craft-row')) ? 'true' : 'false');
      }
    } catch (error) {
      panel.querySelector('[data-rr-craft-plan]').textContent = '';
      status(error.message);
      try {
        const state = read(forge());
        const p = state.affixes.filter(a => a.side === 'prefixes').length;
        panel.querySelector('[data-rr-craft-current]').textContent = `当前 ${p} 前缀／${state.affixes.length - p} 后缀`;
      } catch (_) {}
    }
  }
  function renderChoices() {
    const category = catalog.categories.find(c => c.name === panel.querySelector('[data-rr-craft-category]').value);
    const list = panel.querySelector('[data-rr-craft-choices]');
    panel.querySelector('[data-rr-craft-affix-tooltip]')?.remove();
    list.replaceChildren();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(key) || '{}')[category.name] || {}; } catch (_) {}
    for (const side of ['prefixes', 'suffixes']) {
      list.append(node('h4', {}, side === 'prefixes' ? '目标前缀' : '目标后缀'));
      for (const family of core.families(category).filter(f => f.side === side)) {
        const row = node('div', { 'data-rr-craft-row': family.id });
        const label = node('label');
        const pick = node('input', { type: 'checkbox', 'data-rr-craft-pick': family.id });
        const settings = saved.picks?.find(p => p.id === family.id);
        pick.checked = family.supported && !!settings;
        pick.disabled = !family.supported;
        if (!family.supported) pick.setAttribute('data-rr-craft-unsupported', '');
        label.append(pick, node('span', {}, family.label + (family.supported ? '' : '（当前数值识别未支持）')));
        const title = node('div', { class: 'rr-craft-affix-heading' });
        const info = node('button', { type: 'button', 'data-rr-craft-affix-info': '', 'aria-label': `${family.label} 出现等级与范围`, 'aria-expanded': 'false' }, 'ⓘ');
        let hideTimer, popup;
        const hide = () => { popup?.remove();info.setAttribute('aria-expanded', 'false');info.removeAttribute('aria-describedby'); };
        const display = () => {
          clearTimeout(hideTimer);
          panel.querySelector('[data-rr-craft-affix-tooltip]')?.remove();
          for (const b of panel.querySelectorAll('[data-rr-craft-affix-info]')) b.setAttribute('aria-expanded', 'false');
          const tip = node('div', { 'data-rr-craft-affix-tooltip': '', id: 'rr-craft-affix-tooltip', role: 'tooltip' });
          popup = tip;
          info.setAttribute('aria-describedby', tip.id);info.setAttribute('aria-expanded', 'true');
          tip.append(node('strong', {}, `${category.name} · ${family.label}`), node('p', {}, '出现等级为物品战力等级；范围为词缀库基础值。'));
          const table = node('table');const head = node('tr');
          ['档位／名称', '出现等级', ...family.stats].forEach(s => head.append(node('th', {}, s)));
          const thead = node('thead');thead.append(head);table.append(thead);
          const body = node('tbody');
          const tiers = category.tiers?.[`${side}:${family.label}`] || [];
          tiers.forEach(t => {
            const tr = node('tr');
            [`T${t.tier} ${t.name}${t.variant ? `（${t.variant}）` : ''}`, String(t.level), ...t.ranges].forEach(s => tr.append(node('td', {}, s)));
            body.append(tr);
          });
          table.append(body);tip.append(tiers.length ? table : node('p', {}, '这份词缀库暂无对应范围。'));
          tip.append(node('small', {}, `本地游戏词缀库 · ${catalog.rangeSource?.observedAt || catalog.observedAt}`));
          tip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
          tip.addEventListener('mouseleave', hide);panel.append(tip);
          const rect = info.getBoundingClientRect();
          const box = tip.getBoundingClientRect();
          tip.style.left = `${Math.max(8, Math.min(rect.right - box.width, innerWidth - box.width - 8))}px`;
          tip.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - box.height - 8))}px`;
        };
        info.addEventListener('mouseenter', display);info.addEventListener('focus', display);
        info.addEventListener('mouseleave', () => { hideTimer = setTimeout(hide, 180); });
        info.addEventListener('blur', hide);
        title.append(label, info);row.append(title);
        family.stats.forEach((stat, index) => {
          const minLabel = node('label', { class: 'rr-craft-minimum' });
          const input = node('input', { type: 'number', step: 'any', placeholder: '不限数值', 'data-rr-craft-min': family.id, 'aria-label': `${side === 'prefixes' ? '前缀' : '后缀'} ${stat} 最低值` });
          input.value = settings?.values[index] ?? '';input.disabled = !pick.checked;
          minLabel.append(node('span', {}, family.stats.length === 1 ? '最低值' : `${stat} 最低值`), input);row.append(minLabel);
        });
        pick.addEventListener('change', () => { for (const input of row.querySelectorAll('[data-rr-craft-min]')) input.disabled = !pick.checked; });
        list.append(row);
      }
    }
    panel.querySelector('[data-rr-craft-required]').value = saved.required || '3';
    panel.querySelector('[data-rr-craft-tier]').value = saved.tier || 'auto';
    preview();
  }
  function show(c) {
    if (panel) { panel.focus();return; }
    context = { dialog: c.dialog, identity: identity(c) };
    panel = node('section', { 'data-rr-craft-panel': '', role: 'region', 'aria-label': '自动制作装备', tabindex: '-1' });
    const heading = node('div', { class: 'rr-craft-heading' });
    heading.append(node('h3', {}, `自动制作 · ${c.card.getAttribute('aria-label')}`), node('button', { type: 'button', 'data-rr-craft-command': 'close', 'aria-label': '关闭自动制作' }, '关闭'));
    panel.append(heading, node('p', { class: 'rr-craft-note' }, '勾选目标并填写最低值，满足任意 X 条立即停止。复合词缀整体计 1 条；空值只要求该词缀存在。剥离会随机删除所操作栏中的词缀，可能删掉已达标属性。'));
    const categoryLabel = node('label');categoryLabel.append(node('span', {}, '物品种类'));
    const category = node('select', { 'data-rr-craft-category': '', 'aria-label': '制作物品种类' });
    catalog.categories.forEach(x => category.append(node('option', { value: x.name }, x.name)));
    category.value = guess(c) || '胸甲';categoryLabel.append(category);panel.append(categoryLabel);
    const controls = node('div', { class: 'rr-craft-settings' });
    function input(label, marker, value, attrs = {}) {
      const row = node('label');const e = node('input', { type: 'number', [marker]: '', 'aria-label': label, ...attrs });e.value = value;
      row.append(node('span', {}, label), e);controls.append(row);return e;
    }
    input('满足条数', 'data-rr-craft-required', '3', { min: '1', max: '5', step: '1' });
    const tierLabel = node('label');tierLabel.append(node('span', {}, '循环档位'));
    const tier = node('select', { 'data-rr-craft-tier': '', 'aria-label': '循环档位' });
    [['auto', '自动选择最低档'], ['0', '0／0 ↔ 1 条'], ['1', '1／1 ↔ 3 条'], ['2', '2／2 ↔ 5 条']].forEach(([value, text]) => tier.append(node('option', { value }, text)));
    tierLabel.append(tier);controls.append(tierLabel);
    input('本次宝石预算', 'data-rr-craft-budget', '', { min: '1', step: '1', placeholder: '必须填写' });
    input('最多操作次数', 'data-rr-craft-limit', '100', { min: '1', max: '10000', step: '1' });
    panel.append(controls, node('p', { 'data-rr-craft-status': '', role: 'status' }), node('p', { 'data-rr-craft-current': '' }), node('p', { 'data-rr-craft-plan': '', class: 'rr-craft-note' }));
    panel.append(node('p', { class: 'rr-craft-note' }, '最低值按游戏显示的数字填写，不带 %：法力恢复 0.2% 填 0.2，防御提高 85% 填 85；固定防御 +100 填 100。'));
    try { renderProtected(c); } catch (_) { /* The main status reports unreadable details. */ }
    const source = node('a', { href: catalog.source, target: '_blank', rel: 'noopener', class: 'rr-craft-note' }, `词缀库：Wiki ${catalog.observedAt} 快照（数值按制作页实际词缀判断）`);
    panel.append(source, node('div', { 'data-rr-craft-choices': '' }));
    const footer = node('div', { class: 'rr-craft-footer' });
    footer.append(node('button', { type: 'button', 'data-rr-craft-command': 'start' }, '开始制作'), node('button', { type: 'button', 'data-rr-craft-command': 'stop' }, '立即停止'));
    panel.append(footer, node('ol', { 'data-rr-craft-log': '', 'aria-label': '制作操作记录' }));
    panel.addEventListener('change', event => {
      if (event.target === category) renderChoices();
      save();preview();
    });
    panel.addEventListener('input', () => { save();preview(); });
    document.body.append(panel);renderChoices();panel.focus();
  }
  function stop(reason = '已手动停止') {
    if (!active) { status(reason);return; }
    active.stop = true;active.stopReason = reason;
    status(active.waiting ? `${reason}，等待当前操作返回` : reason);
  }
  function cost(button) {
    const icon = button.querySelector('img[alt="宝石"]');
    const raw = button.querySelector('.text-fuchsia-300')?.textContent;
    const n = raw == null ? NaN : numeric(raw);
    if (!icon || !Number.isFinite(n) || n < 0) throw new Error('无法读取本次宝石费用，已暂停');
    return n;
  }
  function sameContext(c, session) {
    if (location.pathname !== session.route || !c || c.dialog !== session.dialog || identity(c) !== session.identity) throw new Error('物品、角色或锻造界面已切换，已暂停');
  }
  function transition(before, after, action) {
    const subset = (small, large) => {
      const entries = large.affixes.map(a => JSON.stringify(a));
      return small.affixes.every(a => { const i = entries.indexOf(JSON.stringify(a));if (i < 0) return false;entries.splice(i, 1);return true; });
    };
    if (action === 'remove' ? !subset(after, before) : !subset(before, after)) return false;
    const count = (s, side) => s.affixes.filter(a => a.side === side).length;
    const dp = count(after, 'prefixes') - count(before, 'prefixes');
    const ds = count(after, 'suffixes') - count(before, 'suffixes');
    if (action === 'remove') {
      const p = count(before, 'prefixes'), s = count(before, 'suffixes');
      return dp + ds === -1 && ((p > s && dp === -1 && ds === 0) || (s > p && ds === -1 && dp === 0) || (p === s && (dp === -1 && ds === 0 || ds === -1 && dp === 0)));
    }
    if (action === 'prefix') return dp === 1 && ds === 0;
    if (action === 'suffix') return ds === 1 && dp === 0;
    const p = count(before, 'prefixes'), s = count(before, 'suffixes');
    return dp + ds === 1 && ((p < s && dp === 1 && ds === 0) || (s < p && ds === 1 && dp === 0) || (p === s && (dp === 1 && ds === 0 || ds === 1 && dp === 0)));
  }
  async function waitResult(session, before, action) {
    const end = Date.now() + 8000;
    let changedAt = 0, last = '';
    let confirmed = false;
    while (Date.now() < end) {
      const c = forge();sameContext(c, session);
      if (action === 'remove' && !confirmed) {
        // Only confirm the removal dialog created by this pending operation.
        // The native modal has no role=dialog; its message and paired buttons identify it.
        const candidates = [...document.querySelectorAll('p')].filter(p => visible(p) && !p.closest('[data-rr-craft-panel]') && (
          /^Removing an affix is random and cannot be undone\. Continue\?$/.test(p.textContent.trim()) ||
          /(?:移除|删除|剥离).*(?:词缀|词条).*(?:随机|不可|无法)/.test(p.textContent.trim())
        )).map(p => {
          const box = p.parentElement;
          const buttons = [...box.querySelectorAll('button')].filter(visible);
          const confirm = buttons.find(b => /^(确认|确定|Confirm)$/.test(b.textContent.trim()));
          const cancel = buttons.find(b => /^(取消|Cancel)$/.test(b.textContent.trim()));
          return confirm && cancel ? { confirm, cancel } : null;
        }).filter(Boolean);
        if (candidates.length > 1) throw new Error('出现多个移除确认弹窗，已暂停');
        if (candidates.length === 1 && session.stop) {
          candidates[0].cancel.click();
          session.count--;session.spent -= session.pendingFee;
          throw new Error(`${session.stopReason || '已停止'}，本次移除确认已取消`);
        }
        if (candidates.length === 1 && !candidates[0].confirm.disabled) {
          const state = read(c);
          if (state.fingerprint !== before.fingerprint) throw new Error('确认前装备已变化，已暂停');
          if (cost(c.controls.remove) !== session.pendingFee || !Number.isFinite(state.gems) || state.gems < session.pendingFee) throw new Error('确认前费用或余额已变化，已暂停');
          confirmed = true;
          candidates[0].confirm.click();
          log('已确认本次随机移除');
        }
      }
      const state = read(c);
      if (state.fingerprint !== before.fingerprint) {
        if (state.fingerprint !== last) { last = state.fingerprint;changedAt = Date.now(); }
        if (Date.now() - changedAt >= 220 && Object.values(c.controls).some(b => !b.disabled)) {
          if (!transition(before, state, action)) throw new Error('返回的前后缀变化与本次操作不一致，已暂停');
          return state;
        }
      }
      await pause(60);
    }
    throw new Error('未确认本次操作结果，已暂停；请检查装备与余额后再决定是否开始');
  }
  async function start() {
    if (active) return;
    let session;
    try {
      const c = forge();if (!c) throw new Error('请在锻造词缀页选择物品');
      const pendingConfirm = [...document.querySelectorAll('p')].some(p => visible(p) && !p.closest('[data-rr-craft-panel]') && [...p.parentElement.querySelectorAll('button')].some(b => visible(b) && /^(确认|确定|Confirm)$/.test(b.textContent.trim())) && [...p.parentElement.querySelectorAll('button')].some(b => visible(b) && /^(取消|Cancel)$/.test(b.textContent.trim())));
      if (pendingConfirm) throw new Error('请先处理已有确认弹窗，再开始制作');
      const cfg = config(), initial = read(c), kind = guess(c);
      const protectedAffixes = [...panel.querySelectorAll('[data-rr-craft-protect]:checked')].map(input => JSON.parse(input.getAttribute('data-rr-craft-protect')));
      if (missingProtected(initial.affixes, protectedAffixes)) throw new Error('勾选的已有词缀已变化，请关闭并重新打开自动制作');
      if (kind && cfg.category !== kind) throw new Error(`当前物品是${kind}，请核对所选种类`);
      const next = core.plan(initial, cfg.targets, cfg.required, cfg.options);
      if (next.action === 'stop') { status(next.reason);panel.querySelector('[data-rr-craft-status]').scrollIntoView({ block: 'nearest' });return; }
      const budget = Number(panel.querySelector('[data-rr-craft-budget]').value);
      const limit = Number(panel.querySelector('[data-rr-craft-limit]').value);
      if (!Number.isSafeInteger(budget) || budget < 1 || !Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('请填写正整数宝石预算与 1～10000 的操作次数');
      if (!Number.isFinite(initial.gems)) throw new Error('无法核对当前宝石余额，已暂停');
      save();session = { ...cfg, protectedAffixes, budget, limit, spent: 0, count: 0, waiting: false, stop: false, pendingRemoval: false, dialog: c.dialog, identity: initial.identity, route: location.pathname };
      active = session;
      for (const e of panel.querySelectorAll('input,select,[data-rr-craft-command="start"]')) e.disabled = true;
      log(`开始，预算 ${budget} 宝石，最多 ${limit} 次，目标 ${cfg.required} 条`);
      while (!session.stop) {
        if (document.hidden) throw new Error('页面进入后台，已暂停');
        const current = forge();sameContext(current, session);
        const state = read(current);
        if (missingProtected(state.affixes, session.protectedAffixes)) { session.stopReason = '已监控的已有词缀被移除，自动制作已停止';break; }
        const decision = core.plan(state, session.targets, session.required, session.options, session.pendingRemoval);
        const p = state.affixes.filter(a => a.side === 'prefixes').length;
        panel.querySelector('[data-rr-craft-current]').textContent = `当前 ${p} 前缀／${state.affixes.length - p} 后缀 · 达标 ${decision.score.total}/${session.required} · 已用 ${session.spent} 宝石／${session.count} 次`;
        if (decision.action === 'stop') { session.stopReason = decision.reason;break; }
        if (session.count >= session.limit) throw new Error('已达到操作次数上限');
        const button = current.controls[decision.action];
        if (button.disabled) throw new Error(`${labels[decision.action]}不可用，已暂停`);
        const fee = cost(button);
        if (session.spent + fee > session.budget) throw new Error(`剩余预算不足，下次需要 ${fee} 宝石`);
        if (!Number.isFinite(state.gems) || state.gems < fee) throw new Error('当前宝石余额不足或无法读取');
        status(`${decision.reason} · ${labels[decision.action]}（${fee} 宝石）`);
        log(`#${session.count + 1} ${labels[decision.action]}，${fee} 宝石，${p}／${state.affixes.length - p}，达标 ${decision.score.total}`);
        session.waiting = true;session.pendingFee = fee;session.count++;session.spent += fee;
        button.click();
        const result = await waitResult(session, state, decision.action);
        session.waiting = false;
        const removed = missingProtected(result.affixes, session.protectedAffixes);
        if (removed) { session.stopReason = `已监控的已有词缀被移除：${removed.lines.join(' / ')}，自动制作已停止`;break; }
        const score = core.evaluate(result.affixes, session.targets);
        log(`结果：${score.total}/${session.required} 条达标`);
        if (score.total >= session.required) { session.stopReason = `已满足 ${score.total}/${session.required} 条目标`;break; }
        session.pendingRemoval = decision.action !== 'remove' && state.affixes.length === session.options[0].base * 2;
        await pause(180);
      }
      status(`${session.stopReason || '已停止'} · 已尝试 ${session.count} 次，费用合计 ${session.spent} 宝石`);
      log(session.stopReason || '已停止');
    } catch (error) { status(error.message);log(error.message);panel?.querySelector('[data-rr-craft-status]')?.scrollIntoView({ block: 'nearest' }); }
    finally {
      if (session && active === session) active = null;
      if (panel) {
        for (const e of panel.querySelectorAll('input,select,[data-rr-craft-command="start"]')) e.disabled = false;
        for (const e of panel.querySelectorAll('[data-rr-craft-unsupported]')) e.disabled = true;
        for (const e of panel.querySelectorAll('[data-rr-craft-min]')) e.disabled = !panel.querySelector(`[data-rr-craft-pick="${e.getAttribute('data-rr-craft-min')}"]`).checked;
      }
    }
  }
  const style = node('style', { 'data-rr-craft-style': '' });
  style.textContent = `
    [data-rr-craft-launch]{margin:8px 0;padding:8px;border:1px solid #806438;border-radius:5px;background:#30271b;color:#f5d68a;cursor:pointer}
    [data-rr-craft-panel]{position:fixed;z-index:2147483646;top:8vh;right:20px;width:min(530px,calc(100vw - 24px));max-height:84vh;overflow:auto;box-sizing:border-box;padding:16px;border:1px solid #806438;border-radius:8px;background:#18171b;color:#e6dcc6;box-shadow:0 8px 40px #000b;font:13px/1.6 system-ui;text-align:left;white-space:normal}
    [data-rr-craft-panel] h3{font-size:17px;color:#f5d68a;margin:0} [data-rr-craft-panel] h4{color:#a4bef5;margin:12px 0 4px}
    [data-rr-craft-panel] .rr-craft-affix-heading{display:flex;align-items:center;gap:6px} [data-rr-craft-panel] .rr-craft-affix-heading label{flex:1}
    [data-rr-craft-panel] [data-rr-craft-affix-info]{padding:0 5px;color:#a4bef5;flex:none}
    [data-rr-craft-affix-tooltip]{position:fixed;z-index:2147483647;width:max-content;max-width:calc(100vw - 16px);max-height:60vh;overflow:auto;box-sizing:border-box;padding:12px;background:#141820;border:1px solid #7384a5;border-radius:6px;box-shadow:0 6px 24px #000b;font-size:12px}
    [data-rr-craft-affix-tooltip] strong{display:block;max-width:480px;white-space:normal} [data-rr-craft-affix-tooltip] p{margin:5px 0;color:#b4ac9c}
    [data-rr-craft-affix-tooltip] table{border-collapse:collapse} [data-rr-craft-affix-tooltip] th,[data-rr-craft-affix-tooltip] td{padding:5px 8px;border:1px solid #393e49;text-align:left;min-width:65px} [data-rr-craft-affix-tooltip] th{color:#a4bef5;max-width:170px} [data-rr-craft-affix-tooltip] small{color:#b4ac9c}
    [data-rr-craft-panel] .rr-craft-heading,[data-rr-craft-panel] label{display:flex;align-items:center;justify-content:space-between;gap:8px}
    [data-rr-craft-panel] label{margin:5px 0;justify-content:flex-start} [data-rr-craft-panel] label>span{flex:1}
    [data-rr-craft-panel] input,[data-rr-craft-panel] select{background:#111216;color:#eee2c4;border:1px solid #705b39;border-radius:4px;padding:5px;box-sizing:border-box}
    [data-rr-craft-panel] input[type=number]{width:104px} [data-rr-craft-panel] input[type=checkbox]{appearance:auto;width:16px;height:16px;accent-color:#d5b16d}
    [data-rr-craft-panel] button{border:1px solid #806438;border-radius:4px;background:#30271b;color:#f5d68a;padding:7px 12px;cursor:pointer}
    [data-rr-craft-panel] :disabled{opacity:.5} [data-rr-craft-panel] .rr-craft-settings{display:grid;grid-template-columns:1fr 1fr;gap:2px 12px}
    [data-rr-craft-protected]{border:1px solid #705b39;border-radius:5px;margin:10px 0;padding:8px} [data-rr-craft-protected] legend{color:#f2c17e}
    [data-rr-craft-panel] .rr-craft-note{font-size:12px;color:#b0a796;display:block;margin:6px 0}
    [data-rr-craft-row]{border-bottom:1px solid #39342b;padding:5px} [data-rr-craft-met=true]{background:#193022} [data-rr-craft-panel] .rr-craft-minimum{padding-left:24px;font-size:12px;color:#b4ac9c}
    [data-rr-craft-panel] .rr-craft-footer{position:sticky;bottom:0;display:flex;gap:8px;background:#18171b;padding:10px 0} [data-rr-craft-status]{color:#f2c17e}
    [data-rr-craft-log]{padding-left:24px;font-size:12px;max-height:150px;overflow:auto;color:#b4ac9c}
    @media(max-width:550px){[data-rr-craft-panel]{right:12px;top:4vh;max-height:92vh}[data-rr-craft-panel] .rr-craft-settings{grid-template-columns:1fr}}
  `;
  document.head.append(style);
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend']) {
    window.addEventListener(type, event => {
      const target = event.target instanceof Element ? event.target : null;
      const command = target?.closest('[data-rr-craft-command]');
      if (target?.closest('[data-rr-craft-panel],[data-rr-craft-launch]')) {
        event.stopImmediatePropagation();
        if (type !== 'click') return;
        if (target.closest('[data-rr-craft-launch]')) { const c = forge();if (c) show(c);return; }
        if (!command || command.disabled) return;
        switch (command.getAttribute('data-rr-craft-command')) {
          case 'start': void start();break;
          case 'stop': stop();break;
          case 'close': stop();panel?.remove();panel = null;context = null;break;
        }
      } else if (active && event.isTrusted && (type === 'pointerdown' || type === 'touchstart' || type === 'click')) stop('检测到手动操作，已暂停');
    }, { capture: true });
  }
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel) { event.stopImmediatePropagation();stop('Esc 已停止'); }
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden && active) stop('页面进入后台，已暂停'); });
  function mount() {
    scheduled = false;
    const c = forge();
    for (const button of document.querySelectorAll('[data-rr-craft-launch]')) if (!c || !c.pane.contains(button)) button.remove();
    if (!c) { if (active) stop('锻造界面已关闭');else { panel?.remove();panel = null;context = null; } return; }
    if (context && (context.dialog !== c.dialog || context.identity !== identity(c))) {
      if (active) stop('锻造物品已切换');else { panel?.remove();panel = null;context = null; }
    }
    if (!c.pane.querySelector('[data-rr-craft-launch]')) {
      c.controls.add.parentElement.append(node('button', { type: 'button', 'data-rr-craft-launch': '' }, '自动制作装备'));
    }
  }
  new MutationObserver(records => {
    if (records.every(r => r.target instanceof Element && r.target.closest('[data-rr-craft-panel]'))) return;
    if (!scheduled) { scheduled = true;setTimeout(mount, 80); }
  }).observe(document.body, { childList: true, characterData: true, subtree: true });
  mount();
})();
