const fs = require('node:fs');
const game = fs.readFileSync('src/game-helper.js', 'utf8').replace(/^\uFEFF/, '').replace(/@version\s+[\d.]+/, '@version      ' + require('./package.json').version);
fs.writeFileSync('rollrune-helper.user.js', game + '\n' + fs.readFileSync('src/price-check.js', 'utf8').replace(/^\uFEFF/, '') + '\n' + fs.readFileSync('src/character-lookup.js', 'utf8').replace(/^\uFEFF/, ''));
require('./build-wiki.cjs');
