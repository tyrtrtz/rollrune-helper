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
  const make = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
  const style = make('style');
  style.textContent = `
    [data-rr-wiki-active] > :not(#rr-wiki-search){display:none!important}
    #rr-wiki-launch{border:1px solid #6c5329;border-radius:5px;background:#242124;color:#f3dfae;padding:7px 12px;font-size:13px;white-space:nowrap;cursor:pointer}
    #rr-wiki-search{position:relative;color:#e4e3dc;font:14px/1.7 system-ui,sans-serif;max-width:1450px;padding:32px clamp(16px,3vw,48px);margin:auto;box-sizing:border-box}
    #rr-wiki-search[hidden]{display:none} #rr-wiki-search *{box-sizing:border-box}
    #rr-wiki-search .rrw-title{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}
    #rr-wiki-search h2{font-size:30px;letter-spacing:1px;font-weight:600;margin:0;color:#f3dfae}
    #rr-wiki-search .rrw-note{font-size:12px;color:#9d978c;margin:8px 0 24px}
    #rr-wiki-search .rrw-controls{display:flex;flex-wrap:wrap;gap:14px 12px;align-items:end;padding:22px;background:#171b19;border:1px solid #39433a;border-radius:8px}
    #rr-wiki-search label{font-size:11px;color:#a9b0a5;display:flex;flex-direction:column;gap:6px}
    #rr-wiki-search .rrw-query-label{flex:1 1 65%}
    #rr-wiki-search input,#rr-wiki-search select,#rr-wiki-search button{font:inherit;color:#e4e3dc;background:#202621;border:1px solid #444e41;border-radius:5px;padding:9px 12px}
    #rr-wiki-search input{min-width:0;width:100%;font-size:16px;background:#101612;border-color:#6b775d}
    #rr-wiki-search button{cursor:pointer} #rr-wiki-search button:disabled{opacity:.4;cursor:default}
    #rr-wiki-search :focus-visible{outline:2px solid #d6b779;outline-offset:2px}
    #rr-wiki-search .rrw-results{padding:0}
    #rr-wiki-search .rrw-card{display:grid;grid-template-columns:190px minmax(0,1.25fr) minmax(0,1fr);gap:24px;padding:25px 0;border-bottom:1px solid #343a34}
    #rr-wiki-search h3{font-size:18px;line-height:1.6;margin:0 0 9px;color:#ecd09b}
    #rr-wiki-search .rrw-meta{font-size:12px;color:#9fa597;line-height:1.9;white-space:pre-line}
    #rr-wiki-search .rrw-columns{display:contents}
    #rr-wiki-search h4{color:#a9c4ad;font-size:12px;letter-spacing:1px;margin:0 0 10px}
    #rr-wiki-search pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.85 system-ui,sans-serif;margin:0;color:#d4d8ce}
    #rr-wiki-search a{display:inline-block;margin-top:8px;color:#d6b779;text-decoration:none} #rr-wiki-search a:hover{text-decoration:underline} #rr-wiki-search mark{background:#695329;color:#fff0ba;padding:0 1px}
    #rr-wiki-search details{grid-column:2/-1;margin-top:-8px;font-size:13px} #rr-wiki-search summary{cursor:pointer;color:#9da996}
    #rr-wiki-search .rrw-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:22px 0 10px;font-size:13px;color:#aaa99d}
    #rr-wiki-search .rrw-foot button{margin-left:6px;padding:6px 12px}
    @media(max-width:1100px){#rr-wiki-search .rrw-card{grid-template-columns:150px minmax(0,1fr);gap:16px}#rr-wiki-search .rrw-columns>div:last-child{grid-column:2}#rr-wiki-search details{grid-column:2}}
    @media(max-width:650px){#rr-wiki-search{padding:20px 14px}#rr-wiki-search h2{font-size:23px}#rr-wiki-search .rrw-card{grid-template-columns:1fr}#rr-wiki-search .rrw-columns>div:last-child,#rr-wiki-search details{grid-column:1}#rr-wiki-search .rrw-controls{padding:14px;gap:10px}#rr-wiki-search select{max-width:155px}#rr-wiki-search .rrw-note{margin-bottom:16px}}
  `;
  document.head.append(style);
  function close() { if (!panel || panel.hidden) return; panel.hidden = true; host?.removeAttribute('data-rr-wiki-active'); if (previousFocus?.isConnected) previousFocus.focus(); }
  function build() {
    panel = make('section'); panel.id = 'rr-wiki-search'; panel.hidden = true;
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '暗金与被动属性搜索');
    const top = make('div', '', 'rrw-top'), title = make('div', '', 'rrw-title');
    title.append(make('h2', '暗金 · 被动属性搜索'));
    const exit = make('button', '原版视图'); exit.type = 'button'; exit.onclick = close; title.append(exit);
    top.append(title, make('p', '离线资料快照：暗金 2026-09-22 · 被动 2026-09-23。非实时数据；更新后的数值请核对原 Wiki。', 'rrw-note'));
    const controls = make('div', '', 'rrw-controls'), fields = {};
    function select(id, caption, options) {
      const label = make('label', caption), input = make('select'); input.dataset.field = id;
      for (const [value, text] of options) { const option = make('option', text); option.value = value; input.append(option); }
      fields[id] = input; label.append(input); controls.append(label); return input;
    }
    const qLabel = make('label', '多个关键词用空格分隔，例如：毒素 伤害', 'rrw-query-label');
    const query = make('input'); query.type = 'search'; query.placeholder = '搜索名称、词条、触发效果、升华…'; query.dataset.field = 'query'; fields.query = query; qLabel.append(query); controls.append(qLabel);
    select('mode', '匹配方式', [['all','全部关键词'],['any','任一关键词']]);
    select('kind', '资料类型', [['','暗金 + 被动'],['暗金','暗金'],['被动','被动']]);
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
      fields.nodeKind.disabled=fields.kind.value==='暗金'; fields.level.disabled=fields.kind.value==='被动';
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
        if(fields.kind.value && i.kind!==fields.kind.value) return false;
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
        const identity=make('div');identity.append(heading,meta);card.append(identity);
        const cols=make('div','','rrw-columns');
        for(const [caption,text] of [['属性与效果',item.effects.split('\n').filter(line=>!line.trim().startsWith('用途：')).join('\n')],['强化 / 升华',item.upgrade||'无强化或升华说明']]) {const col=make('div'), pre=make('pre'); highlight(pre,text,tokens); col.append(make('h4',caption),pre); cols.append(col);}
        card.append(cols);
        const details=make('details'); details.append(make('summary','用途、掉落与基础信息')); const pre=make('pre'); highlight(pre,[item.overview,item.meta,item.drop].filter(Boolean).join('\n\n'),tokens); details.append(pre); card.append(details); results.append(card);
      }
      count.textContent=`${list.length} / ${catalog.length} 条 · 第 ${page} / ${pages} 页`; prev.disabled=page<=1; next.disabled=page>=pages; results.scrollTop=0;
    }
    for(const field of Object.values(fields)) field.addEventListener(field===query?'input':'change',()=>{page=1;if(field===fields.kind) categories();clearTimeout(queryTimer);queryTimer=setTimeout(render,field===query?120:0);});
    reset.onclick=()=>{query.value='';for(const f of Object.values(fields)) if(f.tagName==='SELECT') f.selectedIndex=0;categories();page=1;render();query.focus();};
    prev.onclick=()=>{page--;render();};next.onclick=()=>{page++;render();};
    panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close();}});
    categories(); render(); panel.openSearch=(kind)=>{previousFocus=document.activeElement;if(kind!==undefined){fields.kind.value=kind;category.value='';categories();page=1;render();}panel.hidden=false;host.setAttribute('data-rr-wiki-active','');host.scrollTop=0;query.focus({preventScroll:true});};
  }

  function mount() {
    if (!/^\/wiki(?:\/|$)/.test(location.pathname)) {close();launcher?.remove();lastPath=null;return;}
    const header=document.querySelector('main > header');
    const nextHost=document.querySelector('main aside')?.parentElement.querySelector(':scope > section');
    if(!header||!nextHost) return;
    if(host!==nextHost){close();panel?.remove();panel=null;host=nextHost;lastPath=null;}
    if(!launcher?.isConnected){launcher=make('button','属性搜索');launcher.id='rr-wiki-launch';launcher.type='button';launcher.onclick=()=>{if(!panel?.isConnected) build();panel.openSearch();};header.append(launcher);}
    if(lastPath!==location.pathname){close();lastPath=location.pathname;if(/^\/wiki\/(uniques|passives)\/?$/.test(lastPath)){if(!panel?.isConnected) build();panel.openSearch(lastPath.includes('uniques')?'暗金':'被动');}}
  }
  document.addEventListener('input',e=>{if(e.target.matches('main > header input')) close();});
  mount(); setInterval(mount,500);
})();
