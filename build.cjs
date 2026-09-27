const fs = require('node:fs');
const game = fs.readFileSync('src/game-helper.js', 'utf8').replace(/^\uFEFF/, '').replace(/@version\s+[\d.]+/, '@version      ' + require('./package.json').version);
fs.writeFileSync('rollrune-helper.user.js', game);
require('./build-wiki.cjs');
