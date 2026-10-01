// Craft only through the currently selected item's native forge buttons.
(() => {
  'use strict';
  if (/^\/wiki(?:\/|$)/.test(location.pathname) || document.querySelector('[data-rr-craft-style]')) return;
  const core = window.RollRuneCraftingCore;
  const catalog = /*__RR_CRAFTING_CATALOG__*/ null;
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
