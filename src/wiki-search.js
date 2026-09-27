// Wiki enhancement. Bundled snapshot is intentionally dated, not a live game index.
(() => {
  'use strict';
  const catalog = /*__WIKI_CATALOG__*/ [];
  const norm = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const indexed = catalog.map(item => ({ ...item, fields: {
    name: norm(item.name), effects: norm(item.effects + '\n' + item.upgrade),
    overview: norm(item.overview), drop: norm(item.drop + '\n' + item.meta),
    all: norm([item.name, item.category, item.effects, item.upgrade, item.overview, item.drop, item.meta].join('\n'))
  }}));
  let panel, launcher, previousFocus, queryTimer, host, lastPath;
  const pageSize = 24;
  let page = 1;
  const sectionKinds = { uniques: '暗金', passives: '被动' };
  const viewKey = 'rollrune-wiki-view';
  let viewMode = 'enhanced';
  try { if (localStorage.getItem(viewKey) === 'original') viewMode = 'original'; } catch {}
  function rememberView(mode) {
    viewMode = mode;
    try { localStorage.setItem(viewKey, mode); } catch {}
  }
  const currentKind = () => sectionKinds[location.pathname.split('/')[2]] || '';
  const make = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
  const style = make('style');
  style.textContent = `
    [data-rr-wiki-active] > :not(#rr-wiki-search){display:none!important}
    #rr-wiki-launch{border:1px solid #6c5329;border-radius:4px;background:#242124;color:#f3dfae;padding:7px 12px;font-size:13px;white-space:nowrap;cursor:pointer}
    #rr-wiki-search{position:relative;color:#e7e5e4;font-family:inherit;font-size:14px;line-height:1.75;box-sizing:border-box}
    #rr-wiki-search[hidden],#rr-wiki-search [hidden]{display:none!important} #rr-wiki-search *{box-sizing:border-box}
    #rr-wiki-search .rrw-title{display:flex;justify-content:space-between;align-items:center;gap:12px}
    #rr-wiki-search .rrw-note{font-size:12px;color:#78716c;margin:12px 0 22px}
    #rr-wiki-search .rrw-controls{display:flex;flex-wrap:wrap;gap:12px;align-items:end;padding:0 0 24px;border-bottom:1px solid #4a3d2b}
    #rr-wiki-search label{font-size:12px;color:#a8a29e;display:flex;flex-direction:column;gap:6px}
    #rr-wiki-search .rrw-query-label{flex:1 1 60%}
    #rr-wiki-search input,#rr-wiki-search select,#rr-wiki-search button{font:inherit;color:#e7e5e4;background:#111114;border:1px solid #5c4a2c;border-radius:5px;padding:8px 12px}
    #rr-wiki-search input{min-width:0;width:100%;font-size:14px;background:#0009}
    #rr-wiki-search button{cursor:pointer}#rr-wiki-search button:disabled{opacity:.4;cursor:default}
    #rr-wiki-search :focus-visible{outline:1px solid #b45309;outline-offset:1px}
    #rr-wiki-search .rrw-card{display:block;background:#131417;border:1px solid #443a2b;border-radius:8px;padding:24px;margin-bottom:16px}
    #rr-wiki-search .rrw-identity{display:flex;gap:16px;align-items:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #443a2b}
    #rr-wiki-search h3{font-size:20px;line-height:1.6;margin:0 0 6px;color:#f3dfae;font-weight:700}
    #rr-wiki-search .rrw-meta{font-size:12px;color:#78716c;line-height:1.8;white-space:pre-line}
    #rr-wiki-search .rrw-columns{display:block}
    #rr-wiki-search .rrw-columns>div+div{margin-top:24px;padding-top:18px;border-top:1px solid #443a2b}
    #rr-wiki-search h4{color:#d6b87e;font-size:14px;font-weight:600;margin:0 0 10px}
    #rr-wiki-search pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:14px;line-height:1.85;margin:0;color:#d6d3d1}
    #rr-wiki-search a{display:inline-block;margin-top:6px;color:#d6b87e;text-decoration:none}#rr-wiki-search a:hover{text-decoration:underline}
    #rr-wiki-search mark{background:#78350f88;color:#fde68a;padding:0 1px}
    #rr-wiki-search details{margin-top:20px;font-size:13px}#rr-wiki-search summary{cursor:pointer;color:#a8a29e}
    #rr-wiki-search .rrw-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:18px 0;font-size:12px;color:#a8a29e}
    #rr-wiki-search .rrw-foot button{margin-left:6px;padding:6px 12px}
    @media(max-width:650px){#rr-wiki-search .rrw-card{padding:16px}#rr-wiki-search .rrw-title{align-items:start}#rr-wiki-search .rrw-controls{gap:10px}#rr-wiki-search select{max-width:155px}}

    #rr-wiki-search{max-width:1800px;width:100%}
    #rr-wiki-search .rrw-card{display:grid;grid-template-columns:220px minmax(0,1.15fr) minmax(0,1fr);gap:30px;padding:28px;background:#171d1b;border-color:#303b36;border-radius:12px;align-items:start}
    #rr-wiki-search .rrw-left{padding-right:24px;border-right:1px solid #364038;align-self:stretch}
    #rr-wiki-search .rrw-identity{border:0;padding:0;margin-bottom:18px;align-items:center;gap:14px}
    #rr-wiki-search .rrw-identity>div:first-child:has(img){flex-shrink:0}
    #rr-wiki-search h3{color:#e7b66b;font-size:20px}
    #rr-wiki-search .rrw-meta{color:#adb5ac}
    #rr-wiki-search .rrw-badges{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0}
    #rr-wiki-search .rrw-badge{font-size:11px;background:#242c23;border:1px solid #414b38;border-radius:4px;padding:2px 7px;color:#c4cbb7}
    #rr-wiki-search .rrw-drop{font-size:13px;line-height:1.9;color:#c8cfc6;margin:10px 0 20px}
    #rr-wiki-search .rrw-drop-title{font-size:12px;color:#929d8b;margin-bottom:8px}
    #rr-wiki-search .rrw-attrs h4{color:#97bec5;font-size:12px;font-weight:400}
    #rr-wiki-search .rrw-line{font-size:14px;line-height:1.9;color:#a9d1ff;overflow-wrap:anywhere;margin:3px 0}
    #rr-wiki-search .rrw-line.rrw-affix-heading{color:#8ca3ba;font-size:12px;margin-top:20px}
    #rr-wiki-search .rrw-line.rrw-more{color:#c4b5fd}
    #rr-wiki-search .rrw-line.rrw-small{color:#a6c1ce;font-size:12px}
    #rr-wiki-search .rrw-line.rrw-flavor{color:#afa98c;font-size:13px;font-style:italic;margin-top:16px}
    #rr-wiki-search .rrw-upgrade{background:#20291f;border:1px solid #3e4b33;border-radius:7px;padding:16px 18px;color:#d8ddb2}
    #rr-wiki-search .rrw-upgrade h4{color:#d8ddb2;font-size:13px;font-weight:400}
    #rr-wiki-search .rrw-upgrade .rrw-line{color:#d8ddb2;font-size:13px}
    #rr-wiki-search .rrw-upgrade .rrw-bonus{position:relative;padding-left:21px}
    #rr-wiki-search .rrw-upgrade .rrw-bonus:before{content:'↗';position:absolute;left:0;color:#93b85c}
    #rr-wiki-search .rrw-explanation{margin-top:18px;padding-top:12px;border-top:1px solid #394436}
    #rr-wiki-search .rrw-explanation summary{color:#d8ddb2}
    #rr-wiki-search .rrw-explanation pre{color:#b6d4df;font-size:13px;line-height:2;margin-top:14px}
    #rr-wiki-search mark{background:#c6a44c;color:#171a15;border-radius:2px}
    @media(max-width:1250px){#rr-wiki-search .rrw-card{grid-template-columns:170px minmax(0,1fr);gap:22px}#rr-wiki-search .rrw-right{grid-column:2}#rr-wiki-search .rrw-left{grid-row:1/3}}
    @media(max-width:700px){#rr-wiki-search .rrw-card{grid-template-columns:minmax(0,1fr);padding:18px}#rr-wiki-search .rrw-left{grid-row:auto;border-right:0;border-bottom:1px solid #364038;padding:0 0 15px}#rr-wiki-search .rrw-right{grid-column:1}}
  `;
  document.head.append(style);
  function close(remember = false) { if (remember) rememberView('original'); if (!panel || panel.hidden) return; panel.hidden = true; host?.removeAttribute('data-rr-wiki-active'); if (previousFocus?.isConnected) previousFocus.focus(); }
  function build() {
    panel = make('section'); panel.className = host.querySelector(':scope > div')?.className || 'mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-9'; panel.id = 'rr-wiki-search'; panel.hidden = true;
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '暗金与被动增强搜索');
    const top = make('div', '', 'rrw-top'), title = make('div', '', 'rrw-title');
    const heading=make('h1',currentKind()+'百科 · 增强搜索','mt-2 font-display text-3xl font-bold tracking-tight text-[#f3dfae] md:text-4xl');title.append(heading);
    const exit = make('button', '原版视图'); exit.type = 'button'; exit.onclick = () => close(true); title.append(exit);
    top.append(title, make('p', '当前栏目内搜索 · 资料为参考快照，最新数值请核对原 Wiki。暗金：2026-09-22；被动：2026-09-23。', 'rrw-note'));
    const controls = make('div', '', 'rrw-controls'), fields = {};
    function select(id, caption, options) {
      const label = make('label', caption), input = make('select'); input.dataset.field = id;
      for (const [value, text] of options) { const option = make('option', text); option.value = value; input.append(option); }
      fields[id] = input; label.append(input); controls.append(label); return input;
    }
    const qLabel = make('label', '多个关键词用空格分隔，例如：毒素 伤害', 'rrw-query-label');
    const query = make('input'); query.type = 'search'; query.placeholder = '搜索名称、词条、触发效果、升华…'; query.dataset.field = 'query'; fields.query = query; qLabel.append(query); controls.append(qLabel);
    select('mode', '匹配方式', [['all','全部关键词'],['any','任一关键词']]);
    select('kind', '资料类型', [['暗金','暗金'],['被动','被动']]);
    fields.kind.parentElement.hidden=true;fields.kind.value=currentKind();
    const category = select('category', '分类', [['','全部分类']]);
    select('scope', '搜索范围', [['all','全部详情'],['effects','属性与强化 / 升华'],['name','仅名称'],['overview','用途说明'],['drop','掉落与基础信息']]);
    select('nodeKind', '节点类型', [['','全部节点'],['repeat','可重复升华'],['town','需城镇解锁'],['root','根节点']]);
    select('level', '暗金掉落等级上限', [['','不限'],...[...new Set(catalog.filter(i=>i.kind==='暗金').map(i=>i.level))].sort((a,b)=>a-b).map(v=>[String(v),String(v)])]);
    select('sort', '排序', [['source','原图鉴顺序'],['name','名称'],['level','暗金掉落等级升序']]);
    const reset = make('button', '重置'); reset.type = 'button'; controls.append(reset); top.append(controls);
    const results = make('div', '', 'rrw-results'); results.setAttribute('aria-label','搜索结果');
    const footer = make('div', '', 'rrw-foot'), count = make('span'); count.setAttribute('aria-live','polite');
    const nav = make('div'), prev = make('button','上一页'), next = make('button','下一页'); prev.type = next.type = 'button'; nav.append(prev,next); footer.append(count,nav); panel.append(top,footer,results); host.prepend(panel);
    function categories() {
      const old = category.value; category.replaceChildren();
      for (const v of ['',...[...new Set(indexed.filter(i=>!fields.kind.value||i.kind===fields.kind.value).map(i=>i.category))].sort((a,b)=>a.localeCompare(b,'zh-CN'))]) { const o=make('option',v||'全部分类'); o.value=v; category.append(o); }
      if ([...category.options].some(o=>o.value===old)) category.value=old;
      fields.nodeKind.disabled=fields.kind.value!=='被动';fields.nodeKind.parentElement.hidden=fields.nodeKind.disabled;fields.level.disabled=fields.kind.value!=='暗金';fields.level.parentElement.hidden=fields.level.disabled;fields.sort.parentElement.hidden=fields.kind.value==='技能';
    }
    function highlight(target, text, tokens) {
      // Text nodes only: catalog contents and search input are never interpreted as HTML.
      const escaped = tokens.filter(Boolean).sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
      if (!escaped.length) { target.textContent=text; return; }
      const re=new RegExp(escaped.join('|'),'giu'); let last=0, match;
      while ((match=re.exec(text))) { target.append(document.createTextNode(text.slice(last,match.index)),make('mark',match[0])); last=match.index+match[0].length; }
      target.append(document.createTextNode(text.slice(last)));
    }
    function render() {
      const tokens=[...new Set(norm(query.value).split(' ').filter(Boolean))];
      const list=indexed.filter(i=>{
        if(i.kind!==currentKind()) return false;
        if(category.value && i.category!==category.value) return false;
        if(!fields.nodeKind.disabled && fields.nodeKind.value && (i.kind!=='被动'||i.nodeKind!==fields.nodeKind.value)) return false;
        if(!fields.level.disabled && fields.level.value!=='' && (i.kind!=='暗金'||i.level>Number(fields.level.value))) return false;
        const hay=i.fields[fields.scope.value];
        return !tokens.length || (fields.mode.value==='any'?tokens.some(t=>hay.includes(t)):tokens.every(t=>hay.includes(t)));
      });
      if(fields.sort.value==='name') list.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
      if(fields.sort.value==='level') list.sort((a,b)=>(a.level??Infinity)-(b.level??Infinity));
      const pages=Math.max(1,Math.ceil(list.length/pageSize)); page=Math.min(page,pages);
      results.replaceChildren();
      if(!list.length) results.append(make('p','没有匹配结果，试试减少关键词或重置筛选。'));
      for(const item of list.slice((page-1)*pageSize,page*pageSize)) {
        const card=make('article','','rrw-card'), left=make('div','','rrw-left'), middle=make('div','','rrw-attrs'), right=make('div','','rrw-right');
        const heading=make('h3');highlight(heading,item.name,tokens);
        const identity=make('div','','rrw-identity'), caption=make('div');caption.append(heading,make('div',item.category,'rrw-meta'));
        const native=[...host.querySelectorAll(':scope > div a[href]')].find(a=>new URL(a.href,location.href).pathname===item.path);
        const icon=native?.querySelector('img')?.parentElement;if(icon)identity.append(icon.cloneNode(true));identity.append(caption);left.append(identity);
        const badges=make('div','','rrw-badges');if(item.level!==null)badges.append(make('span','最低掉落 Lv. '+item.level,'rrw-badge'));badges.append(make('span',item.kind,'rrw-badge'));left.append(badges);
        if(item.drop){const drop=make('div','','rrw-drop');drop.append(make('div','掉落来源','rrw-drop-title'));const value=make('div');highlight(value,item.drop,tokens);drop.append(value);left.append(drop);}
        const link=make('a','原 Wiki 详情 ↗');link.href=item.path;link.target='_blank';link.rel='noopener noreferrer';left.append(link,make('div','资料快照：'+item.date,'rrw-meta'));
        middle.append(make('h4','属性明细'));
        let afterLevel=false;
        for(const raw of item.effects.split('\n')) {
          const line=raw.trim();if(!line||line===item.name||line.startsWith('用途：'))continue;
          let cls='rrw-line';
          if(/^(基础词缀|前缀|后缀)/.test(line))cls+=' rrw-affix-heading';
          else if(/^(需求战力等级|物品战力等级|暗金|魔法|稀有)/.test(line))cls+=' rrw-small';
          else if(afterLevel)cls+=' rrw-flavor';
          else if(/额外|独立/.test(line))cls+=' rrw-more';
          const row=make('div','',cls);highlight(row,line,tokens);middle.append(row);
          if(/^物品战力等级/.test(line))afterLevel=true;
        }
        const upgrade=make('div','','rrw-upgrade');upgrade.append(make('h4',item.kind==='暗金'?'每次暗金强化':item.kind==='被动'?'升华效果':'技能精通与升级'));
        for(const raw of (item.upgrade||'无相关说明').split('\n')){const line=raw.trim();if(!line||line==='暗金强化'||line==='每次强化获得')continue;const isBonus=/[%％+]|提高|增加|降低|恢复/.test(line)&&!/^可强化/.test(line);const row=make('div','','rrw-line'+(isBonus?' rrw-bonus':''));highlight(row,line,tokens);upgrade.append(row);}right.append(upgrade);
        const details=make('details','','rrw-explanation');details.open=true;details.append(make('summary','用途与机制说明'));const pre=make('pre');highlight(pre,item.overview||item.meta||'暂无额外说明',tokens);details.append(pre);right.append(details);
        card.append(left,middle,right);results.append(card);

      }
      count.textContent=`${list.length} / ${catalog.filter(i=>i.kind===currentKind()).length} 条 · 第 ${page} / ${pages} 页`; prev.disabled=page<=1; next.disabled=page>=pages; results.scrollTop=0;
    }
    for(const field of Object.values(fields)) field.addEventListener(field===query?'input':'change',()=>{page=1;if(field===fields.kind) categories();clearTimeout(queryTimer);queryTimer=setTimeout(render,field===query?120:0);});
    reset.onclick=()=>{query.value='';for(const f of Object.values(fields)) if(f.tagName==='SELECT') f.selectedIndex=0;fields.kind.value=currentKind();categories();page=1;render();query.focus();};
    prev.onclick=()=>{page--;render();};next.onclick=()=>{page++;render();};
    panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close(true);}});
    categories(); render(); panel.openSearch=(kind=currentKind())=>{previousFocus=document.activeElement;heading.textContent=kind+'百科 · 增强搜索';query.value='';fields.nodeKind.value='';fields.level.value='';if(kind!==undefined){fields.kind.value=kind;category.value='';categories();page=1;render();}panel.hidden=false;host.setAttribute('data-rr-wiki-active','');host.scrollTop=0;query.focus({preventScroll:true});};
  }

  function mount() {
    if (!/^\/wiki(?:\/|$)/.test(location.pathname)) {close();launcher?.remove();lastPath=null;return;}
    const header=document.querySelector('main > header');
    const nextHost=document.querySelector('main aside')?.parentElement.querySelector(':scope > section');
    if(!header||!nextHost) return;
    if(!currentKind()){close();launcher?.remove();lastPath=null;return;}
    if(host!==nextHost){close();panel?.remove();panel=null;host=nextHost;lastPath=null;}
    if(!launcher?.isConnected){launcher=make('button','增强搜索');launcher.id='rr-wiki-launch';launcher.type='button';launcher.onclick=()=>{rememberView('enhanced');if(!panel?.isConnected) build();panel.openSearch();};header.append(launcher);}
    if(lastPath!==location.pathname){close();lastPath=location.pathname;if(viewMode==='enhanced' && /^\/wiki\/(uniques|passives)\/?$/.test(lastPath)){if(!panel?.isConnected) build();panel.openSearch(currentKind());}}
  }
  document.addEventListener('input',e=>{if(e.target.matches('main > header input')) close(true);});
  mount(); setInterval(mount,500);
})();
