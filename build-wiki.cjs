const fs = require('node:fs');
const marker = '\n// === RollRune Wiki Search ===\n';
const main = fs.readFileSync('rollrune-helper.user.js', 'utf8').split(marker)[0].trimEnd();
const catalog = JSON.parse(fs.readFileSync('data/wiki-catalog.json', 'utf8').replace(/^\uFEFF/, ''));
const wiki = fs.readFileSync('src/wiki-search.js', 'utf8').replace(/^\uFEFF/, '').replace('/*__WIKI_CATALOG__*/ []', JSON.stringify(catalog));
fs.writeFileSync('rollrune-helper.user.js', main.replace(/@version\s+[\d.]+/, '@version      ' + require('./package.json').version).replace('敕令与掉落等级汇总；反引号键 固定当前装备属性，勾选词条计算乘算收益。','敕令与掉落等级汇总、装备收益计算，以及 Wiki 暗金与被动属性搜索。') + marker + wiki);
