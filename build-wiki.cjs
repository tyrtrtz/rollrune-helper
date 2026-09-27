const fs = require('node:fs');
const catalog = JSON.parse(fs.readFileSync('data/wiki-catalog.json', 'utf8').replace(/^\uFEFF/, ''));
const wiki = fs.readFileSync('src/wiki-search.js', 'utf8').replace(/^\uFEFF/, '').replace('/*__WIKI_CATALOG__*/ []', JSON.stringify(catalog));
const header = `// ==UserScript==
// @name         RollRune Wiki 增强搜索
// @namespace    local.rollrune.wiki-search
// @version      ${require('./package.json').wikiVersion || require('./package.json').version}
// @description  Wiki 栏目内属性搜索、彩色详情、强化与升华说明；独立于游戏助手。
// @match        https://rollrune.top/wiki*
// @match        https://direct.rollrune.top/wiki*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

`;
fs.writeFileSync('rollrune-wiki.user.js', header + wiki);
