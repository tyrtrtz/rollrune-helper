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
  let panel, launcher, previousFocus, queryTimer;
  const pageSize = 24;
  let page = 1;
  const make = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
  const style = make('style');
  style.textContent = `
    #rr-wiki-launch{border:1px solid #96723e;border-radius:6px;background:#292116;color:#f5d99c;padding:7px 12px;font-size:13px;white-space:nowrap;cursor:pointer}
    #rr-wiki-search{position:fixed;inset:74px 12px 12px;z-index:2147483646;background:#151416;color:#e6dfd2;border:1px solid #6e5838;border-radius:12px;box-shadow:0 12px 50px #000b;display:flex;flex-direction:column;font:14px/1.6 system-ui,sans-serif;max-width:1400px;margin:auto;box-sizing:border-box}
    #rr-wiki-search[hidden]{display:none} #rr-wiki-search *{box-sizing:border-box}
    #rr-wiki-search .rrw-top{padding:14px 18px;border-bottom:1px solid #493d2c;flex:none}
    #rr-wiki-search .rrw-title{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px}
    #rr-wiki-search h2{font-size:19px;font-weight:600;margin:0;color:#f3d89f}
    #rr-wiki-search .rrw-note{font-size:12px;color:#b7ac99;margin:5px 0 10px}
    #rr-wiki-search .rrw-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end}
    #rr-wiki-search label{font-size:11px;color:#baad95;display:flex;flex-direction:column;gap:3px}
    #rr-wiki-search .rrw-query-label{flex:1 1 250px}
    #rr-wiki-search input,#rr-wiki-search select,#rr-wiki-search button{font:inherit;color:#eee0c7;background:#25211c;border:1px solid #6b5739;border-radius:5px;padding:7px 10px}
    #rr-wiki-search input{min-width:0;width:100%;font-size:14px}
    #rr-wiki-search button{cursor:pointer} #rr-wiki-search button:disabled{opacity:.4;cursor:default}
    #rr-wiki-search :focus-visible{outline:2px solid #ddb765;outline-offset:2px}
    #rr-wiki-search .rrw-results{overflow:auto;padding:16px 18px;flex:1;min-height:0}
    #rr-wiki-search .rrw-card{padding:16px;background:#1d1b1b;border:1px solid #494031;border-radius:8px;margin-bottom:12px}
    #rr-wiki-search h3{font-size:18px;margin:0 0 4px;color:#f1d297}
    #rr-wiki-search .rrw-meta{font-size:12px;color:#b6aa94;margin-bottom:10px}
    #rr-wiki-search .rrw-columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}
    #rr-wiki-search h4{color:#b5cdbb;font-size:12px;margin:5px 0}
    #rr-wiki-search pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.75 system-ui,sans-serif;margin:0;color:#ddd7cd}
    #rr-wiki-search a{color:#e9c17b;text-decoration:underline} #rr-wiki-search mark{background:#6e5321;color:#fff1bd;padding:0}
    #rr-wiki-search details{margin-top:8px;font-size:13px} #rr-wiki-search summary{cursor:pointer;color:#bfa879}
    #rr-wiki-search .rrw-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 18px;border-top:1px solid #493d2c;font-size:12px}
    @media(max-width:650px){#rr-wiki-search{inset:65px 5px 5px}#rr-wiki-search .rrw-columns{grid-template-columns:1fr}#rr-wiki-search .rrw-top{padding:10px}#rr-wiki-search .rrw-note{max-height:48px;overflow:auto}#rr-wiki-search .rrw-controls{gap:5px}#rr-wiki-search select{max-width:150px;padding:5px}}
  `;
  document.head.append(style);
  function close() { if (!panel || panel.hidden) return; panel.hidden = true; if (previousFocus?.isConnected) previousFocus.focus(); }
  function build() {
    panel = make('section'); panel.id = 'rr-wiki-search'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '暗金与被动属性搜索');
    const top = make('div', '', 'rrw-top'), title = make('div', '', 'rrw-title');
    title.append(make('h2', '暗金 · 被动属性搜索'));
    const exit = make('button', '关闭 ×'); exit.type = 'button'; exit.onclick = close; title.append(exit);
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
    const nav = make('div'), prev = make('button','上一页'), next = make('button','下一页'); prev.type = next.type = 'button'; nav.append(prev,next); footer.append(count,nav); panel.append(top,results,footer); document.body.append(panel);
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
        const meta=make('div',`${item.kind} · ${item.category}${item.level!==null?' · 最低掉落等级 '+item.level:''} · 快照 ${item.date}　`,'rrw-meta'); meta.append(link);
        card.append(heading,meta);
        const cols=make('div','','rrw-columns');
        for(const [caption,text] of [['属性与效果',item.effects],['强化 / 升华',item.upgrade||'无强化或升华说明']]) {const col=make('div'), pre=make('pre'); highlight(pre,text,tokens); col.append(make('h4',caption),pre); cols.append(col);}
        card.append(cols);
        const details=make('details'); details.append(make('summary','用途、掉落与基础信息')); const pre=make('pre'); highlight(pre,[item.overview,item.meta,item.drop].filter(Boolean).join('\n\n'),tokens); details.append(pre); card.append(details); results.append(card);
      }
      count.textContent=`${list.length} / ${catalog.length} 条 · 第 ${page} / ${pages} 页`; prev.disabled=page<=1; next.disabled=page>=pages; results.scrollTop=0;
    }
    for(const field of Object.values(fields)) field.addEventListener(field===query?'input':'change',()=>{page=1;if(field===fields.kind) categories();clearTimeout(queryTimer);queryTimer=setTimeout(render,field===query?120:0);});
    reset.onclick=()=>{query.value='';for(const f of Object.values(fields)) if(f.tagName==='SELECT') f.selectedIndex=0;categories();page=1;render();query.focus();};
    prev.onclick=()=>{page--;render();};next.onclick=()=>{page++;render();};
    panel.addEventListener('keydown',e=>{ if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();} if(e.key==='Tab'){const nodes=[...panel.querySelectorAll('button,input,select,a')].filter(n=>!n.disabled&&n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}} });
    categories(); render(); panel.openSearch=()=>{previousFocus=document.activeElement;panel.hidden=false;query.focus();};
  }
  function mount() {
    if (!/^\/wiki(?:\/|$)/.test(location.pathname)) {close();launcher?.remove();return;}
    const header=document.querySelector('main > header'); if(!header) return;
    if(!launcher?.isConnected){launcher=make('button','属性搜索');launcher.id='rr-wiki-launch';launcher.type='button';launcher.onclick=()=>{if(!panel) build();panel.openSearch();};header.append(launcher);}
  }
  mount(); setInterval(mount,1000);
})();
