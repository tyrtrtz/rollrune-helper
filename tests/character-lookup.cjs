const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.route(/^http:\/\/rollrune\.test\//, route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<html><body><main><div id="indicator" class="fixed bottom-2 right-2"><div><span>123</span><span>挂机中</span></div></div></main></body></html>',
    }));
    await page.goto('http://rollrune.test/town');
    await page.evaluate(() => {
      document.querySelector('#indicator').addEventListener('click', event => {
        if (event.target.closest('form')) window.unwantedToggle = true;
        const indicator = document.querySelector('#indicator');
        const old = indicator.querySelector('.absolute.bottom-full');
        if (old) old.remove();
        else {
          const popup = document.createElement('div');
          popup.className = 'absolute bottom-full';
          popup.innerHTML = '<button>某位玩家</button>';
          indicator.append(popup);
        }
      });
    });
    await page.addScriptTag({ content: fs.readFileSync('src/character-lookup.js', 'utf8') });
    await page.getByText('挂机中').click();
    const form = page.locator('[data-rr-character-form]');
    await form.locator('input').click();
    assert.equal(await form.count(), 1);
    assert.equal(await page.evaluate(() => !!window.unwantedToggle), false);
    await form.locator('input').fill('bad/name');
    await form.getByRole('button', { name: '查看资料' }).click();
    assert.match(await form.locator('[role=status]').textContent(), /角色名/);
    assert.equal(new URL(page.url()).pathname, '/town');
    const id = '662ae1dd-37e6-4665-a620-a2f9bc98e351';
    await form.locator('input').fill(`https://direct.rollrune.top:34569/view-character/id/${id}`);
    await form.getByRole('button', { name: '查看资料' }).click();
    await page.waitForURL(`http://rollrune.test/view-character/id/${id}`);
    await page.addScriptTag({ content: fs.readFileSync('src/character-lookup.js', 'utf8') });
    await page.evaluate(() => {
      const popup = document.createElement('div');
      popup.className = 'absolute bottom-full';
      document.querySelector('#indicator').append(popup);
    });
    await page.locator('[data-rr-character-form] input').fill('段语仙');
    await page.locator('[data-rr-character-form] button').click();
    await page.waitForURL('http://rollrune.test/view-character/%E6%AE%B5%E8%AF%AD%E4%BB%99');

    await page.evaluate(() => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.innerHTML = '<aside aria-label="地图列表"></aside><div id="rankings"><div class="grid"><span>1</span><div><div class="flex"><span title="段语仙">段语仙</span></div></div><button aria-label="段语仙 · 查看配装与天赋 →">查看配装与天赋</button><div><button aria-label="段语仙 · 查看配装与天赋 →">查看配装与天赋</button></div></div></div>';
      document.body.append(dialog);
    });
    await page.addScriptTag({ content: fs.readFileSync('src/character-lookup.js', 'utf8') });
    assert.equal(await page.locator('[data-rr-live-profile]').count(), 1);
    await page.evaluate(() => {
      document.querySelector('#rankings').innerHTML = '<div class="grid"><span>2</span><div><div class="flex"><span title="清风夜雨">清风夜雨</span></div></div><button aria-label="清风夜雨 · 查看配装与天赋 →">查看配装与天赋</button></div>';
    });
    const live = page.locator('[data-rr-live-profile]');
    await live.waitFor();
    assert.equal(await live.count(), 1);
    assert.equal(await live.locator('xpath=..').locator('span[title]').getAttribute('title'), '清风夜雨');
    await live.click();
    await page.waitForURL('http://rollrune.test/view-character/%E6%B8%85%E9%A3%8E%E5%A4%9C%E9%9B%A8');

    // The game reuses ranking rows when changing maps. The old button must
    // follow the row's new character instead of its original click closure.
    await page.goto('http://rollrune.test/town');
    await page.evaluate(() => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.innerHTML = '<aside aria-label="地图列表"></aside><div class="grid" id="reused-row"><span>5</span><div><div><span title="茶叶蛋">茶叶蛋</span></div></div><button aria-label="茶叶蛋 · 查看配装与天赋 →">查看配装与天赋</button></div>';
      document.body.append(dialog);
    });
    await page.addScriptTag({ content: fs.readFileSync('src/character-lookup.js', 'utf8') });
    const reused = page.locator('#reused-row [data-rr-live-profile]');
    await reused.waitFor();
    await page.evaluate(() => {
      const row = document.querySelector('#reused-row');
      const name = row.querySelector('span[title]');
      name.title = '星界琉璃';
      name.textContent = '星界琉璃';
      row.querySelector('button[aria-label$="· 查看配装与天赋 →"]').setAttribute('aria-label', '星界琉璃 · 查看配装与天赋 →');
    });
    await page.waitForFunction(() => document.querySelector('#reused-row [data-rr-live-profile]')?.getAttribute('aria-label') === '星界琉璃 · 查看实时信息');
    assert.equal(await reused.count(), 1);
    assert.equal(await reused.getAttribute('title'), '查看 星界琉璃 的实时资料');
    await reused.click();
    await page.waitForURL('http://rollrune.test/view-character/%E6%98%9F%E7%95%8C%E7%90%89%E7%92%83');

    // The updated sidebar and player boards show account names first. Only
    // character-bearing rows may link to profiles, even when values are hidden.
    await page.goto('http://rollrune.test/town');
    await page.evaluate(() => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.innerHTML = '<aside aria-label="榜单列表"><button title="战力榜" aria-pressed="true">战力榜</button><button title="财富榜" aria-pressed="false">财富榜</button><button title="黑手榜" aria-pressed="false">黑手榜</button><button title="混沌领域" aria-pressed="false">混沌领域</button></aside><div class="grid" id="player-row"><span>1</span><div><div><span title="xiaohaven">xiaohaven</span></div><div class="text-zinc-500"><span class="truncate">Haven</span><span class="text-amber-400/90" title="称号">✦ 称号</span></div></div><div>***</div></div><div class="grid"><span>2</span><div><div><span title="账号">账号</span></div><div><span class="text-amber-400/90" title="称号">✦ 称号</span></div></div><div>***</div></div>';
      document.body.append(dialog);
    });
    await page.addScriptTag({ content: fs.readFileSync('src/character-lookup.js', 'utf8') });
    const player = page.locator('#player-row [data-rr-live-profile]');
    assert.equal(await page.locator('[data-rr-live-profile]').count(), 1);
    assert.equal(await player.getAttribute('aria-label'), 'Haven · 查看实时信息');
    await page.evaluate(() => {
      for (const button of document.querySelectorAll('aside button')) button.setAttribute('aria-pressed', String(button.title === '财富榜'));
    });
    await page.waitForFunction(() => !document.querySelector('[data-rr-live-profile]'));
    await page.evaluate(() => {
      for (const button of document.querySelectorAll('aside button')) button.setAttribute('aria-pressed', String(button.title === '黑手榜'));
      document.querySelector('#player-row > div > div:nth-child(2) > span').textContent = 'Ethlyn';
    });
    await player.waitFor();
    await page.waitForFunction(() => document.querySelector('#player-row [data-rr-live-profile]')?.getAttribute('aria-label') === 'Ethlyn · 查看实时信息');
    assert.equal(await page.locator('[data-rr-live-profile]').count(), 1);
    // Reuse the same row for a map record, then back for a player record.
    await page.evaluate(() => {
      for (const button of document.querySelectorAll('aside button')) button.setAttribute('aria-pressed', String(button.title === '混沌领域'));
      const row = document.querySelector('#player-row');
      row.querySelector('span[title]').title = '地图角色';
      row.querySelector('span[title]').textContent = '地图角色';
      const snapshot = document.createElement('button');
      snapshot.setAttribute('aria-label', '地图角色 · 查看配装与天赋 →');
      row.append(snapshot);
    });
    await page.waitForFunction(() => document.querySelector('#player-row [data-rr-live-profile]')?.getAttribute('aria-label') === '地图角色 · 查看实时信息');
    assert.equal(await page.locator('[data-rr-live-profile]').count(), 1);
    await page.evaluate(() => {
      for (const button of document.querySelectorAll('aside button')) button.setAttribute('aria-pressed', String(button.title === '战力榜'));
      document.querySelector('#player-row > div > div:nth-child(2) > span').firstChild.data = '新角色';
    });
    await page.waitForFunction(() => document.querySelector('#player-row [data-rr-live-profile]')?.getAttribute('aria-label') === '新角色 · 查看实时信息');
    assert.equal(await page.locator('[data-rr-live-profile]').count(), 1);
    await player.click();
    await page.waitForURL('http://rollrune.test/view-character/%E6%96%B0%E8%A7%92%E8%89%B2');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
