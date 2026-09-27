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
