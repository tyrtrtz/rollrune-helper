// 在游戏原生“挂机中”列表中按角色名或 UUID 打开公开资料。
(() => {
  'use strict';
  if (/^\/wiki(?:\/|$)/.test(location.pathname)) return;

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const style = document.createElement('style');
  style.setAttribute('data-rr-character-style', '');
  style.textContent = `
    [data-rr-character-form]{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px;margin-bottom:4px;background:#18181b;border-bottom:1px solid #52525b;cursor:default}
    [data-rr-character-form] label{color:#e4c78f;white-space:nowrap}
    [data-rr-character-form] input{flex:1;min-width:140px;padding:5px 7px;color:#f4f4f5;background:#27272a;border:1px solid #71717a;border-radius:4px;user-select:text}
    [data-rr-character-form] button{padding:5px 9px;color:#f5d68a;background:#3b2c19;border:1px solid #8b6b3b;border-radius:4px;cursor:pointer}
    [data-rr-character-error]{width:100%;color:#fca5a5;text-align:left}
    [data-rr-live-profile]{flex:none;white-space:nowrap;color:#fcd34d;font-size:12px;font-weight:600;line-height:1.5;cursor:pointer}
    [data-rr-live-profile]:hover{color:#fef3c7}
  `;
  document.head.append(style);

  function findPopup() {
    for (const label of document.querySelectorAll('span')) {
      if (label.textContent.trim() !== '挂机中') continue;
      const indicator = label.parentElement?.parentElement;
      if (!indicator?.classList.contains('fixed') || !indicator.classList.contains('bottom-2')) continue;
      const popup = [...indicator.children].find(child => child.classList.contains('absolute') && child.classList.contains('bottom-full'));
      if (popup) return popup;
    }
    return null;
  }

  function mount() {
    mountLeaderboard();
    const popup = findPopup();
    if (!popup || popup.querySelector('[data-rr-character-form]')) return;
    const form = document.createElement('form');
    form.setAttribute('data-rr-character-form', '');
    form.innerHTML = '<label for="rr-character-id">查角色</label><input id="rr-character-id" name="character-id" type="text" autocomplete="off" spellcheck="false" placeholder="输入角色名或 UUID" aria-label="角色名或 ID"><button type="submit">查看资料</button><span data-rr-character-error role="status" hidden></span>';
    // 原生列表的外层点击会切换弹窗；表单内部交互不应触发它。
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']) {
      form.addEventListener(type, event => event.stopPropagation());
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      event.stopPropagation();
      const input = form.elements.namedItem('character-id');
      let value = input.value.trim();
      const error = form.querySelector('[data-rr-character-error]');
      if (/^https?:\/\//i.test(value)) {
        try {
          const link = new URL(value);
          if (!['rollrune.top', 'direct.rollrune.top'].includes(link.hostname) || !/^\/view-character\//.test(link.pathname)) throw new Error('invalid profile link');
          value = decodeURIComponent(link.pathname.slice('/view-character/'.length));
        } catch {
          error.textContent = '请输入角色名、完整 UUID 或游戏资料链接';
          error.hidden = false;
          return;
        }
      }
      const id = value.startsWith('id/') ? value.slice(3) : value;
      const isId = uuid.test(id);
      const name = isId ? '' : value;
      if (!isId && (!name || name.length > 80 || /[\x00-\x1f/\\]/.test(name) || name.startsWith('id/'))) {
        error.textContent = '请输入角色名、完整 UUID 或游戏资料链接';
        error.hidden = false;
        return;
      }
      location.assign(isId
        ? `${location.origin}/view-character/id/${id.toLowerCase()}`
        : `${location.origin}/view-character/${encodeURIComponent(name)}`);
    });
    popup.prepend(form);
  }

  function leaderboardTarget(row) {
    const dialog = row.closest('[role="dialog"][aria-modal="true"]');
    const sidebar = dialog?.querySelector('aside[aria-label="地图列表"],aside[aria-label="榜单列表"]');
    if (!sidebar) return null;
    const board = sidebar.querySelector('button[aria-pressed="true"]')?.getAttribute('title');
    const cell = row.children[1];
    // 新玩家榜上方为账号名，下方才是角色名；财富榜没有角色。
    if (board === '财富榜') return null;
    if (board === '战力榜' || board === '黑手榜') {
      const line = cell?.children[1];
      const character = line?.querySelector(':scope > span');
      if (!character || character.classList.contains('text-amber-400/90')) return null;
      const name = character.textContent.trim();
      return name ? { name, line } : null;
    }
    if (!row.querySelector('button[aria-label$="· 查看配装与天赋 →"]')) return null;
    const line = cell?.firstElementChild;
    const name = line?.querySelector('span[title]')?.getAttribute('title')?.trim();
    return name ? { name, line } : null;
  }

  function mountLeaderboard() {
    for (const dialog of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
      if (!dialog.querySelector('aside[aria-label="地图列表"],aside[aria-label="榜单列表"]')) continue;
      const rows = [...dialog.querySelectorAll('div.grid')].filter(row =>
        row.firstElementChild?.tagName === 'SPAN' && /^\d+$/.test(row.firstElementChild.textContent.trim()));
      for (const row of rows) {
        const target = leaderboardTarget(row);
        for (const old of row.querySelectorAll('[data-rr-live-profile]')) {
          if (!target || old.parentElement !== target.line) old.remove();
        }
        if (!target) continue;
        const { name, line } = target;
        let button = line.querySelector('[data-rr-live-profile]');
        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('data-rr-live-profile', '');
          button.textContent = '查看实时信息';
          button.addEventListener('click', event => {
            event.stopPropagation();
            const liveName = leaderboardTarget(row)?.name;
            if (liveName) location.assign(`${location.origin}/view-character/${encodeURIComponent(liveName)}`);
          });
          line.append(button);
        }
        const label = `${name} · 查看实时信息`;
        const title = `查看 ${name} 的实时资料`;
        if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
        if (button.title !== title) button.title = title;
      }
    }
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; mount(); }, 50);
  }).observe(document.body, { childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-pressed'], subtree: true });
  mount();
})();
