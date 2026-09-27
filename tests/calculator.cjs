const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');const fs=require('fs'),assert=require('assert/strict');
(async()=>{const b=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true});try{const p=await b.newPage();await p.setContent('<html><head></head><body></body></html>');const source=fs.readFileSync('rollrune-helper.user.js','utf8');await p.addScriptTag({content:source});
async function check(lines,expected){await p.evaluate(lines=>{document.body.innerHTML='<div class="rr-game-tooltip"><section class="rr-layered-tooltip"><ul></ul></section></div>';const ul=document.querySelector('ul');for(const text of lines){const li=document.createElement('li');li.className='text-blue-400';li.textContent=text;ul.append(li)}},lines);await p.keyboard.press('Backquote');const boxes=p.locator('[data-rr-inline-calc] input');assert.equal(await boxes.count(),lines.length);for(let i=0;i<lines.length;i++)await boxes.nth(i).check();const text=await p.locator('.rr-calc-total strong').textContent();assert.ok(text.startsWith('×'+new Intl.NumberFormat('zh-CN',{maximumFractionDigits:4}).format(expected)+' ·'),text);await p.keyboard.press('Escape');}
await check(['法术技能的伤害额外提高 100%（90%～110%）','法术技能的伤害额外提升 200%','毒素伤害额外提高 50%'],6);
await check(['金币获取量额外提高 100%','金币获取量额外提高 200%'],1.9);
await check(['+4 技能等级','+1 技能等级'],1.3**5);
await check(['对燃烧目标的伤害额外提高 100%','对中毒目标的伤害额外提高 100%'],4);
await check(['伤害额外提高 50%（低血时）','伤害额外提高 50%（满血时）'],2.25);
console.log('PASS: same-name sum, different-name product, roll ranges, gold grouping, skill exponents, distinct conditions.');}finally{await b.close()}})().catch(e=>{console.error(e);process.exitCode=1});
