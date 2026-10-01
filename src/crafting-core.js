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
