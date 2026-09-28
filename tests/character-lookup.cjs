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
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
