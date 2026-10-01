const fs = require('node:fs');
const game = fs.readFileSync('src/game-helper.js', 'utf8').replace(/^\uFEFF/, '').replace(/@version\s+[\d.]+/, '@version      ' + require('./package.json').version);
const crafting = fs.readFileSync('src/auto-craft.js', 'utf8').replace('/*__RR_CRAFTING_CATALOG__*/ null', JSON.stringify(require('./data/crafting-catalog.json')));
fs.writeFileSync('rollrune-helper.user.js', [game, fs.readFileSync('src/price-check.js', 'utf8'), fs.readFileSync('src/character-lookup.js', 'utf8'), fs.readFileSync('src/crafting-core.js', 'utf8'), crafting].map(s => s.replace(/^\uFEFF/, '')).join('\n'));
require('./build-wiki.cjs');
