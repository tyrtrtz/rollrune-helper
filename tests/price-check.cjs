const { chromium }=require('playwright');
const fs=require('fs'), assert=require('assert/strict');
(async()=>{
 const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<html><head></head><body></body></html>');
  await page.evaluate(()=>{
   window.searches=[];
   const mk=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
   const inv=mk('div');inv.innerHTML='<button class="rr-item-card" aria-label="怪谈木屐"></button><div><div id="menu"><button>装备</button><button>锁定</button><button id="cancel">取消</button></div></div>';
   const tip=mk('div');tip.className='selected-item-details';tip.innerHTML='<section class="rr-layered-tooltip"><div><strong><ul><li>怪谈木屐</li></ul></strong><ul><li>暗金 靴子</li></ul></div><ul><li class="text-blue-400">+13% 持续伤害闪避率（10%～15%）</li><li class="text-blue-400">移动速度提高 35%（20%～40%）</li><li class="text-blue-400">+183 雷电防御（150～200）</li><li class="text-blue-400">伤害额外提高 20%（对燃烧目标）</li><li>鬼步提供<ul><li class="text-blue-400">移动速度提高 5%</li></ul></li><li class="text-blue-400">最大生命提高 10%</li><li class="text-blue-400">最大法力提高 10%</li><li class="text-blue-400">金币获取量额外提高 100%</li></ul></section>';
   document.body.append(inv,tip);
   document.querySelector('#cancel').onclick=()=>{inv.remove();tip.remove();};
   const auction=mk('button','拍卖行');document.body.append(auction);
   auction.onclick=()=>{
    const panel=mk('div');panel.id='auction';document.body.append(panel);
    const filters=mk('div');panel.append(filters);
    function dropdown(label,opts,onselect){
     const row=mk('div'),wrap=mk('div'),b=mk('button',opts[0]+'▼'),list=mk('ul');row.append(mk('span',label),wrap);wrap.append(b,list);b.setAttribute('aria-haspopup','listbox');b.setAttribute('aria-expanded','false');list.setAttribute('aria-hidden','true');
     b.onclick=()=>{b.setAttribute('aria-expanded','true');list.setAttribute('aria-hidden','false');};
     for(const opt of opts){const option=mk('button',opt);option.setAttribute('role','option');option.onclick=()=>{b.textContent=opt+'▼';b.setAttribute('aria-expanded','false');list.setAttribute('aria-hidden','true');onselect?.(opt,row);};list.append(option);}
     filters.append(row);return b;
    }
    const filterButton=mk('button','筛选');panel.prepend(filterButton);
    const reset=mk('button','重置');filters.append(reset);
    const name=mk('input');name.id='item_name';name.value='旧搜索';filters.append(name);
    const category=dropdown('物品类别：',['不限','靴子']);const rarity=dropdown('物品稀有度：',['不限','暗金','稀有']);const sort=dropdown('排序方式：',['最新上架','价格最低']);
    for(let i=0;i<5;i++)dropdown('', ['+ 添加属性筛选','+#% 持续伤害闪避率','移动速度提高 #%','+# 雷电防御','最大生命提高 #%','最大法力提高 #%','金币获取量额外提高 #%'],(_,row)=>{if(!row.querySelector('input')){const input=mk('input');input.id='stat_value_1';row.append(input);}});
    reset.onclick=()=>{name.value='';window.didReset=true;};
    const buy=mk('button','购买');panel.append(buy);buy.onclick=()=>window.searches.push({name:name.value,category:category.textContent,rarity:rarity.textContent,sort:sort.textContent,values:[...filters.querySelectorAll('[id^=stat_value]')].map(x=>x.value)});
    const danger=mk('button','购买物品');danger.onclick=()=>{window.danger=true;};panel.append(danger);
   };
  });
  await page.addScriptTag({content:fs.readFileSync('src/price-check.js','utf8')});
  await page.evaluate(()=>{document.querySelector('.rr-layered-tooltip strong li').textContent='随机词缀之靴';document.querySelector('.rr-layered-tooltip > div > ul li').textContent='稀有 靴子';});
  await page.locator('[data-rr-price-button]').click();
  assert.equal(await page.locator('[data-rr-price-form] input[type=checkbox]').first().isChecked(),false);
  assert.equal(await page.locator('[data-rr-price-form] select[aria-label="稀有度"]').inputValue(),'稀有');
  await page.locator('[data-rr-price-form]').getByText('收起',{exact:true}).click();
  await page.evaluate(()=>{document.querySelector('.rr-layered-tooltip strong li').textContent='怪谈木屐';document.querySelector('.rr-layered-tooltip > div > ul li').textContent='暗金 靴子';});
  await page.locator('[data-rr-price-button]').click();
  const form=page.locator('[data-rr-price-form]');
  assert.equal(await form.locator('select[aria-label="部位"]').inputValue(),'靴子');
  assert.equal(await form.locator('.rr-price-row').count(),7); // Nested triggered speed excluded.
  assert.equal(await form.locator('.rr-price-row input[type=checkbox]:disabled').count(),1);
  const checks=form.locator('.rr-price-row input[type=checkbox]:enabled');
  for(let i=0;i<6;i++)await checks.nth(i).check();
  await form.getByText('去拍卖行搜索',{exact:true}).click();
  assert.match(await form.locator('[role=status]').textContent(),/最多支持 5/);
  for(let i=3;i<6;i++)await checks.nth(i).uncheck();
  const mins=form.locator('.rr-price-row input[type=number]:enabled');
  for(const [i,value] of ['10','20','150'].entries())await mins.nth(i).fill(value);
  await form.getByText('去拍卖行搜索',{exact:true}).click();
  await page.waitForFunction(()=>window.searches.length===1);
  assert.deepEqual(await page.evaluate(()=>window.searches[0]),{name:'怪谈木屐',category:'靴子▼',rarity:'暗金▼',sort:'价格最低▼',values:['10','20','150']});
  assert.equal(await page.evaluate(()=>!!window.danger),false);
  assert.equal(await page.evaluate(()=>window.didReset),true);
  console.log('PASS: inline item menu, affix matching, nested/conditional exclusions, max five, reset, duplicate input IDs, native filters and search only.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
