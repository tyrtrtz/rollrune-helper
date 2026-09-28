const { chromium } = require('playwright');
const fs = require('fs');
const assert = require('assert/strict');
(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://rollrune.top/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head></head><body></body></html>' }));
    await page.goto('https://rollrune.top/game');
    await page.evaluate(() => {
      window.fetch = async () => ({ ok: true, json: async () => ({ areas: { test: { header_background: 'areas/test_header.webp', power_level: 30, item_level_modifier: 0 } } }) });
      document.body.innerHTML = '<div style="background-image:url(areas/test_header.webp)"><div><span class="font-display">森林</span> — 10</div><div id="edict"><svg></svg></div></div>';
      const icon = document.querySelector('#edict');
      window.attempts = 0;
      let timer;
      icon.addEventListener('mouseenter', () => {
        window.attempts++;
        // First attempt fails completely; subsequent attempts have a partial tooltip.
        if (window.attempts === 1) return;
        const tip = document.createElement('div');
        tip.className = 'rr-game-tooltip';
        tip.innerHTML = '<section class="rr-layered-tooltip"><ul><li>顽强指令</li><li>次级敕令</li><li>大师杰作敕令</li></ul></section>';
        document.body.append(tip);
        timer = setTimeout(() => { tip.querySelector('ul').insertAdjacentHTML('beforeend', '<li>物品战力等级 +12</li><li>物品战力等级 +16</li><li>需求战力等级：600</li><li>物品战力等级：636</li>'); }, 400);
      });
      icon.addEventListener('mouseleave', () => { clearTimeout(timer); document.querySelector('.rr-game-tooltip')?.remove(); });
    });
    await page.addScriptTag({ content: fs.readFileSync(process.env.SCRIPT_SOURCE || 'src/game-helper.js', 'utf8') });
    await page.waitForFunction(() => document.querySelector('[data-rr-drop-level]')?.textContent.includes('= 68 级'), { }, { timeout: 9000 });
    assert.ok(await page.evaluate(() => window.attempts >= 2));
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-rr-reading-edict'));
    assert.equal(await page.locator('.rr-game-tooltip').count(), 0);
    const before = await page.evaluate(() => window.attempts);
    await page.locator('[data-rr-drop-level]').click();
    await page.waitForFunction(n => window.attempts > n, before);
    console.log('PASS: failed attempt recovers; delayed partial tooltip is not cached as zero; probe cleans up; manual retry works.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
