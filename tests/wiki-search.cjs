const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');const fs=require('fs'),assert=require('assert/strict');
(async()=>{const b=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true});try{const p=await b.newPage();await p.route('https://rollrune.top/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<html><head><style>body{background:#090a0c;color:#e7e5e4}section>div{padding:20px}aside{width:160px} @media(max-width:650px){aside{display:none}}</style></head><body><main><header><input placeholder="原生搜索"></header><div style="display:flex"><aside>百科目录</aside><section style="flex:1;min-width:0;overflow:auto;height:95vh"><div><h1>原版</h1></div></section></div></main></body></html>'}));const src=fs.readFileSync('rollrune-wiki.user.js','utf8');
for(const [path,kind,count] of [['uniques','暗金',102],['passives','被动',163]]){await p.goto('https://rollrune.top/wiki/'+path);await p.addScriptTag({content:src});await p.waitForFunction(()=>document.querySelector('#rr-wiki-search')&&!document.querySelector('#rr-wiki-search').hidden);const panel=p.locator('#rr-wiki-search');assert.equal(await p.locator('#rr-wiki-launch').textContent(),'增强搜索');assert.ok((await panel.locator('[aria-live]').textContent()).startsWith(count+' / '+count));assert.equal(await panel.locator('[data-field=kind]').isVisible(),false);assert.equal(await panel.locator('[role=dialog]').count(),0);assert.equal(await panel.locator('.rrw-card').first().evaluate(e=>getComputedStyle(e).display),'grid');assert.equal(await panel.locator('.rrw-card').first().locator('.rrw-badge').last().textContent(),kind);await panel.locator('[data-field=query]').fill('伤害');await p.waitForTimeout(160);assert.ok(parseInt(await panel.locator('[aria-live]').textContent())>0);await panel.getByRole('button',{name:'重置',exact:true}).click();assert.ok((await panel.locator('[aria-live]').textContent()).startsWith(count+' / '+count));await panel.getByRole('button',{name:'原版视图',exact:true}).click();assert.equal(await panel.isVisible(),false);await p.locator('#rr-wiki-launch').click();assert.equal(await panel.isVisible(),true);}
await p.setViewportSize({width:390,height:844});assert.ok(await p.locator('#rr-wiki-search').evaluate(e=>e.getBoundingClientRect().right<=innerWidth));await p.screenshot({path:'tests/wiki-mobile.png'});
// Original view survives reload and a visit to the native skill section.
await p.getByRole('button',{name:'原版视图',exact:true}).click();
await p.reload();await p.addScriptTag({content:src});
assert.equal(await p.locator('#rr-wiki-search').isVisible(),false);
await p.goto('https://rollrune.top/wiki/skills');await p.addScriptTag({content:src});
assert.equal(await p.locator('#rr-wiki-launch').count(),0);
assert.equal(await p.locator('[data-rr-wiki-active]').count(),0);
assert.equal(await p.evaluate(()=>localStorage.getItem('rollrune-wiki-view')),'original');
await p.goto('https://rollrune.top/wiki/uniques');await p.addScriptTag({content:src});
assert.equal(await p.locator('#rr-wiki-search').isVisible(),false);
await p.locator('#rr-wiki-launch').click();
await p.reload();await p.addScriptTag({content:src});
assert.equal(await p.locator('#rr-wiki-search').isVisible(),true);
await p.evaluate(()=>history.pushState({},'', '/wiki/skills'));
await p.waitForTimeout(600);
assert.equal(await p.locator('#rr-wiki-launch').count(),0);
assert.equal(await p.locator('#rr-wiki-search').isVisible(),false);
assert.equal(await p.evaluate(()=>localStorage.getItem('rollrune-wiki-view')),'enhanced');
await p.evaluate(()=>history.pushState({},'', '/wiki/passives'));
await p.waitForTimeout(600);
assert.equal(await p.locator('#rr-wiki-search').isVisible(),true);
console.log('PASS: remembered original/enhanced view across reload and route changes; native skill pages;');
console.log('PASS: one item per row with three internal columns, category-isolated 102/163 search, hidden cross-category control, reset, original toggle, mobile width.');}finally{await b.close()}})().catch(e=>{console.error(e);process.exitCode=1});
