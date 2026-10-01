const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const core = require('../src/crafting-core.js');
const catalog = require('../data/crafting-catalog.json');
for (const c of catalog.categories) for (const side of ['prefixes','suffixes']) for (const label of c[side]) {
  assert.ok(c.tiers[`${side}:${label}`].length, `${c.name} ${label} needs ranges`);
  for (const t of c.tiers[`${side}:${label}`]) assert.equal(t.ranges.length, label.split(' / ').length);
}
const weaponTiers = catalog.categories.find(c => c.name === '攻击武器').tiers['prefixes:最低火焰伤害（固定调整）（本地） / 最高火焰伤害（固定调整）（本地）'];
assert.deepEqual(weaponTiers.filter(t=>t.level===1).map(t=>t.ranges), [['1～2','3～5'],['1～3','4～8']]);
const family = (name, side, label, minimums = [null]) => ({ ...core.families(catalog.categories.find(c => c.name === name)).find(f => f.side === side && f.label === label), minimums });
const affix = (side, ...lines) => ({ side, lines, header: side });
const hp = family('胸甲', 'prefixes', '最大生命提高', [20]);
const life = family('胸甲', 'prefixes', '最大生命（固定调整）', [100]);
const armor = family('胸甲', 'prefixes', '物理防御提高（本地）', [20]);
const fire = family('胸甲', 'suffixes', '火焰防御（固定调整）', [100]);
const desired = [hp, life, armor, fire];
assert.equal(core.readStat('法力恢复（固定调整）', '每秒法力恢复 +0.6%（按最大法力计算）（0.5%～0.6%）'), 0.6);
assert.equal(core.readStat('暴击率提高', '暴击率提高 5%（×105%）（3%～5%）'), 5);
assert.equal(core.readStat('最大生命（固定调整）', '最大生命提高 100%'), null);
assert.equal(core.readStat('法术技能的技能速度提高', '攻击技能的技能速度提高 5%'), null);
const hybrid = family('戒指', 'suffixes', '攻击技能的伤害额外提高 / 攻击技能的技能速度降低', [50, 10]);
const simple = family('戒指', 'suffixes', '攻击技能的伤害额外提高');
const compound = affix('suffixes', '攻击技能的伤害额外提高 60%', '攻击技能的技能速度降低 12%');
assert.equal(core.evaluate([compound], [hybrid, simple]).total, 1);
assert.equal(core.evaluate([compound], [{ ...hybrid, minimums: [70, 10] }]).total, 0);
const opts = core.allocations(desired, 4);
assert.deepEqual(opts, [{ prefixes: 3, suffixes: 1, base: 2, peak: 5 }]);
assert.throws(() => core.allocations(desired, 4, '1'), /无法满足/);
const ordinaryP = affix('prefixes', '最大生命提高 10%');
const ordinaryS = affix('suffixes', '+20 火焰防御');
const goodP = affix('prefixes', '最大生命提高 25%');
const goodLife = affix('prefixes', '+120 最大生命');
const goodArmor = affix('prefixes', '本装备的物理防御提高 30%');
const goodS = affix('suffixes', '+150 火焰防御');
// Establish the required suffix first, then keep both suffixes while rerolling prefixes.
assert.equal(core.plan({ affixes: [goodP, goodLife, ordinaryS, ordinaryS] }, desired, 4, opts).action, 'suffix');
assert.equal(core.plan({ affixes: [goodP, goodLife, goodS, ordinaryS] }, desired, 4, opts).action, 'prefix');
assert.equal(core.plan({ affixes: [goodP, goodLife, ordinaryP, goodS, ordinaryS] }, desired, 4, opts, true).action, 'remove');
assert.equal(core.plan({ affixes: [goodP, goodLife, goodArmor, goodS, ordinaryS] }, desired, 4, opts, true).action, 'stop');
const three = core.allocations([hp, life, fire], 3);
assert.equal(three[0].base, 1);
assert.equal(core.plan({ affixes: [ordinaryP, ordinaryS] }, [hp, life, fire], 3, three).action, 'suffix');
assert.equal(core.plan({ affixes: [ordinaryP, goodS] }, [hp, life, fire], 3, three).action, 'prefix');
assert.equal(core.plan({ affixes: [ordinaryP, ordinaryS, goodS] }, [hp, life, fire], 3, three).action, 'remove');
assert.throws(() => core.plan({ affixes: [goodP, goodLife, goodArmor, ordinaryS] }, desired, 4, opts), /规则/);
assert.equal(core.evaluate([goodP, goodP], [hp]).total, 1);
const poison = family('胸甲', 'suffixes', '毒素防御（固定调整）', [100]);
const goodPoison = affix('suffixes', '+120 毒素防御');
const fiveTargets = [...desired, poison];
const five = core.allocations(fiveTargets, 5);
assert.equal(core.plan({ affixes: [goodP, goodLife, goodS, goodPoison] }, fiveTargets, 5, five).action, 'prefix');
assert.equal(core.plan({ affixes: [goodP, goodLife, goodArmor, goodS, goodPoison] }, fiveTargets, 5, five, true).action, 'stop');
const mana = family('胸甲', 'suffixes', '法力恢复（固定调整）');
const reverseTargets = [hp, fire, poison, mana];
const reverse = core.allocations(reverseTargets, 4);
assert.equal(core.plan({ affixes: [ordinaryP, goodLife, goodS, goodPoison] }, reverseTargets, 4, reverse).action, 'prefix');
assert.equal(core.plan({ affixes: [goodP, goodLife, goodS, goodPoison] }, reverseTargets, 4, reverse).action, 'suffix');
const flexible = core.allocations([hp, fire], 1);
assert.equal(core.plan({ affixes: [] }, [hp, fire], 1, flexible).action, 'add');
console.log('PASS: value thresholds, ranges, hybrid counting, 2+1 and 3+1/2 strategies, stop before removal, invalid states.');

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://rollrune.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head></head><body></body></html>' }));
    const source = fs.readFileSync('src/auto-craft.js', 'utf8').replace('/*__RR_CRAFTING_CATALOG__*/ null', JSON.stringify(catalog));
    async function setup({ affixes = [], delay = 60, stall = false, magicEmpty = false, confirmationDelay = 0 } = {}) {
      await page.goto('https://rollrune.test/town');
      await page.evaluate(({ affixes, delay, stall, magicEmpty, confirmationDelay }) => {
        document.body.innerHTML = '<main><div><span id="gems">200</span><div><img alt="宝石"></div></div></main><div role="dialog"><div class="mobile-flow-detail"><button class="rr-item-card" aria-label="软垫外衣"><img src="padded_tunic.webp"></button><section class="rr-layered-tooltip"><div><strong><ul><li>软垫外衣</li></ul></strong><ul><li>普通 胸甲</li></ul></div><ul id="affixes"></ul></section><div id="buttons"><button id="add"><b>随机词缀</b> 消耗 <span class="text-fuchsia-300">1</span><div><img alt="宝石"></div></button><button id="prefix"><b>随机前缀</b> <span class="text-fuchsia-300">2</span><div><img alt="宝石"></div></button><button id="suffix"><b>随机后缀</b> <span class="text-fuchsia-300">2</span><div><img alt="宝石"></div></button><button id="remove"><b>随机移除</b> 词缀 消耗 <span class="text-fuchsia-300">1</span><div><img alt="宝石"></div></button></div></div><button id="other-item">其他装备</button></div>';
        window.fixture = { affixes, calls: [], delay, stall, history: [], confirmations: 0 };
        window.paint = () => {
          const list = document.querySelector('#affixes');list.replaceChildren();
          for (const a of window.fixture.affixes) {
            const h = document.createElement('li');h.textContent = (a.side === 'prefixes' ? '前缀' : '后缀') + ' ‘测试’（等级：1）';list.append(h);
            for (const text of a.lines) { const li = document.createElement('li');li.className = 'text-blue-400';li.textContent = text;list.append(li); }
          }
          const p = window.fixture.affixes.filter(a => a.side === 'prefixes').length;
          const s = window.fixture.affixes.length - p;
          document.querySelector('#prefix').disabled = p !== s || p >= 3;
          document.querySelector('#suffix').disabled = p !== s || s >= 3;
          document.querySelector('#add').disabled = p + s >= 5;
          document.querySelector('#remove').disabled = p + s === 0;
          if (magicEmpty && p + s === 0) {
            document.querySelector('.rr-layered-tooltip>div>ul>li').textContent = '魔法 胸甲';
            document.querySelector('#remove').innerHTML = '<b>随机移除</b> 词缀';
          } else if (magicEmpty) document.querySelector('#remove').innerHTML = '<b>随机移除</b> 词缀 <span class="text-fuchsia-300">1</span><img alt="宝石">';
        };
        window.paint();
        for (const action of ['add', 'prefix', 'suffix', 'remove']) {
          const execute = () => {
          const f = window.fixture;f.calls.push(action);
          const before = JSON.parse(JSON.stringify(f.affixes));f.history.push(before);
          for (const b of document.querySelectorAll('#buttons button')) b.disabled = true;
          if (f.stall) return;
          setTimeout(() => {
            const p = f.affixes.filter(a => a.side === 'prefixes').length, s = f.affixes.length - p;
            if (action === 'remove') {
              const side = p >= s ? 'prefixes' : 'suffixes';
              f.affixes.splice(f.removalIndices?.shift() ?? f.affixes.findLastIndex(a => a.side === side), 1);
            } else {
              const side = action === 'prefix' ? 'prefixes' : action === 'suffix' ? 'suffixes' : p < s ? 'prefixes' : 'suffixes';
              f.affixes.push(f.additions?.shift() || { side, lines: [side === 'prefixes' ? '最大生命提高 25%' : '+150 火焰防御'] });
            }
            document.querySelector('#gems').textContent = String(Number(document.querySelector('#gems').textContent) - (action === 'add' || action === 'remove' ? 1 : 2));
            window.paint();
          }, f.delay);
          };
          document.querySelector('#' + action).onclick = () => {
            if (action !== 'remove') { execute();return; }
            setTimeout(() => {
              const modal = document.createElement('div');modal.id = 'remove-confirm';
              modal.innerHTML = '<h3>确认操作</h3><p></p><div><button>取消</button><button>确认</button></div>';
              modal.querySelector('p').textContent = window.fixture.confirmationText || 'Removing an affix is random and cannot be undone. Continue?';
              modal.querySelectorAll('button')[0].onclick = () => modal.remove();
              modal.querySelectorAll('button')[1].onclick = () => { window.fixture.confirmations++;modal.remove();execute(); };
              document.body.append(modal);
            }, confirmationDelay);
          };
        }
        // Mimic a native dialog dismissal listener: plugin control interactions must be isolated.
        document.addEventListener('pointerdown', e => { if (e.target.closest('[data-rr-craft-panel]')) window.unwantedDismissal = true; });
      }, { affixes, delay, stall, magicEmpty, confirmationDelay });
      await page.addScriptTag({ content: fs.readFileSync('src/crafting-core.js', 'utf8') });
      await page.addScriptTag({ content: source });
      await page.locator('[data-rr-craft-launch]').click();
      await page.locator('[data-rr-craft-panel]').waitFor();
    }
    async function configure(targets, required, budget = 20, limit = 20) {
      for (const t of targets) {
        await page.locator(`[data-rr-craft-pick="${t.id}"]`).check();
        for (let i = 0; i < t.minimums.length; i++) if (t.minimums[i] !== null) await page.locator(`[data-rr-craft-min="${t.id}"]`).nth(i).fill(String(t.minimums[i]));
      }
      await page.locator('[data-rr-craft-required]').fill(String(required));
      await page.locator('[data-rr-craft-budget]').fill(String(budget));
      await page.locator('[data-rr-craft-limit]').fill(String(limit));
    }
    await setup();
    const info = page.getByRole('button', { name: '最大生命提高 出现等级与范围', exact: true });
    await info.hover();
    const tooltip = page.locator('[data-rr-craft-affix-tooltip]');
    await tooltip.waitFor();
    assert.match(await tooltip.textContent(), /出现等级为物品战力等级/);
    assert.match(await tooltip.textContent(), /2～4%/);
    assert.equal(await page.locator('[data-rr-craft-pick]:checked').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), []);
    const bounds = await tooltip.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1280);
    await page.mouse.move(0, 0);
    await page.locator('[data-rr-craft-category]').selectOption('符文');
    assert.equal(await tooltip.count(), 0);
    await page.getByRole('button', { name: '法力恢复（固定调整） 出现等级与范围', exact: true }).focus();
    assert.match(await tooltip.textContent(), /0.1～0.2%/);
    await page.locator('[data-rr-craft-category]').selectOption('胸甲');
    await configure([fire], 1);
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('已满足'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['suffix']);
    assert.equal(await page.evaluate(() => !!window.unwantedDismissal), false);
    // Full 3 desired prefixes + 1 desired suffix + 1 arbitrary suffix workflow.
    await page.evaluate(() => localStorage.clear());await setup({ affixes: [goodP, goodLife, ordinaryS, goodPoison] });
    await page.locator('[data-rr-craft-protect]').nth(1).check();
    await configure(desired, 4, 100);
    await page.evaluate(({ goodS, goodArmor }) => {
      window.fixture.additions = [goodS, { side: 'prefixes', lines: ['生命恢复效果提高 5%'] }, goodArmor];
      window.fixture.removalIndices = [2, 4];
    }, { goodS, goodArmor });
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('已满足'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['suffix', 'remove', 'prefix', 'remove', 'prefix']);
    assert.equal(await page.evaluate(() => window.fixture.confirmations), 2);
    const finalAffixes = await page.evaluate(() => window.fixture.affixes);
    assert.equal(core.evaluate(finalAffixes, desired).total, 4);
    assert.equal(finalAffixes.filter(a => a.side === 'prefixes').length, 3);
    assert.equal(finalAffixes.filter(a => a.side === 'suffixes').length, 2);
    // Loss of a monitored initial affix stops before any next addition.
    await page.evaluate(() => localStorage.clear());await setup({ affixes: [ordinaryP] });await configure([fire], 1);
    await page.locator('[data-rr-craft-protect]').check();
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('已有词缀被移除'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['remove']);
    assert.equal(await page.evaluate(() => window.fixture.affixes.length), 0);
    assert.equal(await page.evaluate(() => window.fixture.confirmations), 1);
    // All calls are serial; the second operation waits for the delayed first result.
    await page.evaluate(() => localStorage.clear());
    await setup({ affixes: [ordinaryP, ordinaryS], delay: 350 });
    await configure([hp, fire], 2, 2);
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('预算不足'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['add', 'remove']);
    assert.equal(await page.evaluate(() => window.fixture.affixes.length), 2);
    // A changed native fee is read again before the next operation.
    await page.evaluate(() => localStorage.clear());await setup({ affixes: [ordinaryP, ordinaryS], delay: 350 });await configure([hp, fire], 2, 20);
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.evaluate(() => { document.querySelector('#remove .text-fuchsia-300').textContent = '30'; });
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('预算不足'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['add']);
    await page.evaluate(() => localStorage.clear());await setup({ affixes: [ordinaryP, ordinaryS] });await configure([hp, life, fire], 3, 100, 1);
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('次数上限'));
    assert.equal((await page.evaluate(() => window.fixture.calls)).length, 1);
    // Budget and stop count are checked before the very first operation.
    await page.evaluate(() => localStorage.clear());await setup({ affixes: [goodS, goodP] });
    await configure([hp, fire], 2, 20);
    await page.locator('[data-rr-craft-command="start"]').click();
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), []);
    await page.evaluate(() => localStorage.clear());await setup();await configure([fire], 1, 1);
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('预算不足'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), []);
    // A stop during an in-flight operation never schedules another request.
    await page.evaluate(() => localStorage.clear());await setup({ affixes: [ordinaryP, ordinaryS], delay: 700 });
    await configure([hp, life, fire], 3);
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.locator('[data-rr-craft-command="stop"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-rr-craft-command="start"]').disabled);
    assert.equal((await page.evaluate(() => window.fixture.calls)).length, 1);
    // Changing the selection pauses; no operation is ever sent for the next item.
    await page.evaluate(() => localStorage.clear());await setup({ affixes: [ordinaryP, ordinaryS], delay: 600 });await configure([hp, life, fire], 3);
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.locator('#other-item').click();
    await page.waitForFunction(() => !document.querySelector('[data-rr-craft-command="start"]').disabled);
    assert.equal((await page.evaluate(() => window.fixture.calls)).length, 1);
    // Silence/no response is an uncertain result, never grounds for automatic retry.
    await page.evaluate(() => localStorage.clear());await setup({ stall: true });await configure([fire], 1);
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('未确认'), { timeout: 10000 });
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['suffix']);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('[data-rr-craft-panel]').evaluate(e => e.getBoundingClientRect().right <= innerWidth && e.getBoundingClientRect().left >= 0));
    await page.getByRole('button', { name: '最大生命提高 出现等级与范围', exact: true }).hover();
    assert.ok(await tooltip.evaluate(e => {const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;}));
    await page.mouse.move(0,0);
    await tooltip.waitFor({state:'detached'});
    await page.locator('[data-rr-craft-command="close"]').click();
    assert.equal(await page.locator('[data-rr-craft-panel]').count(), 0);
    await page.evaluate(() => document.querySelector('[role="dialog"]').remove());
    await page.waitForFunction(() => !document.querySelector('[data-rr-craft-launch]'));
    // Native zero-affix magic item: rarity survives removal, and there is no removal price.
    await page.evaluate(() => localStorage.clear());await setup({ magicEmpty: true });await configure([fire], 1);
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('已满足'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['suffix']);
    // Stop while the removal confirmation is loading must cancel without spending.
    await page.evaluate(() => localStorage.clear());await setup({ affixes: [ordinaryP], confirmationDelay: 400 });await configure([fire], 1);
    await page.evaluate(() => { window.fixture.confirmationText = '移除词缀是随机的，且无法撤销。继续？'; });
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('随机移除'));
    await page.locator('[data-rr-craft-command="stop"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('确认已取消'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), []);
    assert.equal(await page.evaluate(() => window.fixture.confirmations), 0);
    await page.evaluate(() => localStorage.clear());await setup();await configure([fire], 1);
    await page.evaluate(() => { const m=document.createElement('div');m.innerHTML='<p>Removing an affix is random and cannot be undone. Continue?</p><button>取消</button><button>确认</button>';m.id='old-confirm';document.body.append(m); });
    await page.locator('[data-rr-craft-command="start"]').click();
    assert.match(await page.locator('[data-rr-craft-status]').textContent(), /先处理已有确认/);
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), []);
    // Ordinary-attack glossary text does not make a magic item look affix-free.
    await page.evaluate(() => localStorage.clear());await setup();await configure([fire], 1);
    await page.evaluate(() => { document.querySelector('.rr-layered-tooltip>div>ul>li').textContent = '魔法 胸甲';document.querySelector('.rr-layered-tooltip').append('普通攻击'); });
    await page.locator('[data-rr-craft-command="start"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rr-craft-status]').textContent.includes('明细'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), []);
    console.log('PASS: real mouse controls, thresholds, stop before actions, live fee/budget limits, delayed serial updates, in-flight stop, manual pause, uncertain result without retries, mobile and cleanup.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error);process.exitCode = 1; });
