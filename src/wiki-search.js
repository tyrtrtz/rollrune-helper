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
  const sectionKinds = { uniques: '暗金', skills: '技能', passives: '被动' };
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
  `;
  document.head.append(style);
  function close() { if (!panel || panel.hidden) return; panel.hidden = true; host?.removeAttribute('data-rr-wiki-active'); if (previousFocus?.isConnected) previousFocus.focus(); }
  function build() {
    panel = make('section'); panel.className = host.querySelector(':scope > div')?.className || 'mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-9'; panel.id = 'rr-wiki-search'; panel.hidden = true;
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '暗金与被动增强搜索');
    const top = make('div', '', 'rrw-top'), title = make('div', '', 'rrw-title');
    const heading=make('h1',currentKind()+'百科 · 增强搜索','mt-2 font-display text-3xl font-bold tracking-tight text-[#f3dfae] md:text-4xl');title.append(heading);
    const exit = make('button', '原版视图'); exit.type = 'button'; exit.onclick = close; title.append(exit);
    top.append(title, make('p', '当前栏目内搜索 · 资料为参考快照，最新数值请核对原 Wiki。暗金：2026-09-22；被动：2026-09-23；技能：此前收集的资料（日期未记录）。', 'rrw-note'));
    const controls = make('div', '', 'rrw-controls'), fields = {};
    function select(id, caption, options) {
      const label = make('label', caption), input = make('select'); input.dataset.field = id;
      for (const [value, text] of options) { const option = make('option', text); option.value = value; input.append(option); }
      fields[id] = input; label.append(input); controls.append(label); return input;
    }
    const qLabel = make('label', '多个关键词用空格分隔，例如：毒素 伤害', 'rrw-query-label');
    const query = make('input'); query.type = 'search'; query.placeholder = '搜索名称、词条、触发效果、升华…'; query.dataset.field = 'query'; fields.query = query; qLabel.append(query); controls.append(qLabel);
    select('mode', '匹配方式', [['all','全部关键词'],['any','任一关键词']]);
    select('kind', '资料类型', [['暗金','暗金'],['技能','技能'],['被动','被动']]);
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
        const card=make('article','','rrw-card'), heading=make('h3'); highlight(heading,item.name,tokens);
        const link=make('a','查看原 Wiki ↗'); link.href=item.path; link.target='_blank'; link.rel='noopener noreferrer';
        const meta=make('div',`${item.kind} · ${item.category}\n${item.level!==null?'最低掉落等级 '+item.level+'\n':''}快照 ${item.date}\n`,'rrw-meta'); meta.append(link);
        const identity=make('div','','rrw-identity');const text=make('div');text.append(heading,meta);const native=[...host.querySelectorAll(':scope > div a[href]')].find(a=>new URL(a.href,location.href).pathname===item.path);const icon=native?.querySelector('img')?.parentElement;if(icon)identity.append(icon.cloneNode(true));identity.append(text);card.append(identity);
        const cols=make('div','','rrw-columns');
        for(const [caption,text] of [['详情',item.effects.split('\n').filter(line=>!line.trim().startsWith('用途：')).join('\n')],[item.kind==='技能'?'技能精通与升级':item.kind==='被动'?'升华':'强化',item.upgrade||'无相关说明']]) {const col=make('div'), pre=make('pre'); highlight(pre,text,tokens); col.append(make('h4',caption),pre); cols.append(col);}
        card.append(cols);
        const details=make('details'); details.append(make('summary','用途、掉落与基础信息')); const pre=make('pre'); highlight(pre,[item.overview,item.meta,item.drop].filter(Boolean).join('\n\n'),tokens); details.append(pre); card.append(details); results.append(card);
      }
      count.textContent=`${list.length} / ${catalog.filter(i=>i.kind===currentKind()).length} 条 · 第 ${page} / ${pages} 页`; prev.disabled=page<=1; next.disabled=page>=pages; results.scrollTop=0;
    }
    for(const field of Object.values(fields)) field.addEventListener(field===query?'input':'change',()=>{page=1;if(field===fields.kind) categories();clearTimeout(queryTimer);queryTimer=setTimeout(render,field===query?120:0);});
    reset.onclick=()=>{query.value='';for(const f of Object.values(fields)) if(f.tagName==='SELECT') f.selectedIndex=0;fields.kind.value=currentKind();categories();page=1;render();query.focus();};
    prev.onclick=()=>{page--;render();};next.onclick=()=>{page++;render();};
    panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close();}});
    categories(); render(); panel.openSearch=(kind=currentKind())=>{previousFocus=document.activeElement;heading.textContent=kind+'百科 · 增强搜索';query.value='';fields.nodeKind.value='';fields.level.value='';if(kind!==undefined){fields.kind.value=kind;category.value='';categories();page=1;render();}panel.hidden=false;host.setAttribute('data-rr-wiki-active','');host.scrollTop=0;query.focus({preventScroll:true});};
  }

  function mount() {
    if (!/^\/wiki(?:\/|$)/.test(location.pathname)) {close();launcher?.remove();lastPath=null;return;}
    const header=document.querySelector('main > header');
    const nextHost=document.querySelector('main aside')?.parentElement.querySelector(':scope > section');
    if(!header||!nextHost) return;
    if(!currentKind()){close();launcher?.remove();lastPath=null;return;}
    if(host!==nextHost){close();panel?.remove();panel=null;host=nextHost;lastPath=null;}
    if(!launcher?.isConnected){launcher=make('button','增强搜索');launcher.id='rr-wiki-launch';launcher.type='button';launcher.onclick=()=>{if(!panel?.isConnected) build();panel.openSearch();};header.append(launcher);}
    if(lastPath!==location.pathname){close();lastPath=location.pathname;if(/^\/wiki\/(uniques|skills|passives)\/?$/.test(lastPath)){if(!panel?.isConnected) build();panel.openSearch(currentKind());}}
  }
  document.addEventListener('input',e=>{if(e.target.matches('main > header input')) close();});
  mount(); setInterval(mount,500);
})();
