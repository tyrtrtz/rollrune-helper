// Refresh the bundled snapshot; normal builds never depend on the external game checkout.
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/import-crafting-tiers.cjs <game data directory>');
const catalog = require('../data/crafting-catalog.json');
const names = {
  '最大生命提高':'inc_life','最大生命':'add_life','最大法力提高':'inc_mana','最大法力':'add_mana',
  '物理防御提高':'inc_armor','物理防御':'add_armor','防御提高':'inc_armor','防御':'add_armor',
  '威胁值获取降低':'dec_threat','威胁值获取提高':'inc_threat','生命恢复效果提高':'inc_restore',
  '生命恢复':'add_life_regen','法力恢复':'add_mana_regen','金币获取量额外提高':'inc_gold',
  '毒素防御':'add_poison_res','火焰防御':'add_fire_res','雷电防御':'add_storm_res',
  '持续伤害闪避率':'add_evade','格挡率提高':'inc_block','格挡率':'add_block',
  '暴击伤害提高':'inc_crit_damage','暴击率提高':'inc_crit_chance','技能等级':'add_skill_level',
  '伤害提高':'inc_damage','物理伤害提高':'inc_phys_damage','物理伤害额外提高':'inc_phys_damage',
  '火焰伤害提高':'inc_fire_damage','火焰伤害额外提高':'inc_fire_damage',
  '毒素伤害提高':'inc_poison_damage','毒素伤害额外提高':'inc_poison_damage',
  '雷电伤害提高':'inc_storm_damage','雷电伤害额外提高':'inc_storm_damage',
  '最低物理伤害':'add_physical_damage','最低火焰伤害':'add_fire_damage','最低毒素伤害':'add_poison_damage','最高雷电伤害':'add_storm_damage',
  '攻击技能命中恢复生命':'life_leech','攻击技能命中恢复法力':'mana_leech',
  '攻击技能的技能速度提高':'inc_attack_speed','法术技能的技能速度提高':'inc_spell_speed',
  '法术技能的暴击率提高':'inc_spell_crit_chance','技能速度提高':'inc_action_speed',
  '攻击技能的伤害额外提高':'inc_attack_damage','攻击技能的伤害提高':'inc_attack_damage',
  '法术伤害额外提高':'inc_spell_damage','法术技能的伤害提高':'inc_spell_damage',
  '持续伤害额外提高':'inc_dot_damage','移动速度提高':'inc_movement_speed',
  '正面状态持续时间提高':'inc_buff_duration','负面状态持续时间提高':'inc_status_duration',
  '诅咒技能的状态效果提高':'inc_status_power','施加负面状态成功率提高':'inc_status_success_chance',
};
const categories = {'披风':['Cloak','Accessory'],'头盔':['Helmet','Armor'],'胸甲':['Body','Armor'],'手套':['Gloves','Armor'],'靴子':['Boots','Armor'],'护身符':['Amulet','Jewelry'],'戒指':['Ring','Jewelry'],'盾牌':['Shield'],'法器':['Focus'],'法术武器':['SpellWeapon'],'攻击武器':['AttackWeapon','MeleeWeapon1H','MeleeWeapon2H','RangedWeapon'],'符文':['Rune'],'敕令':['Map']};
const restrictionNames = {MeleeWeapon1H:'单手近战',MeleeWeapon2H:'双手近战',RangedWeapon:'远程武器'};
function load(dir) { return fs.readdirSync(path.join(root,dir)).filter(f=>f.endsWith('.json')).flatMap(f=> { const d=JSON.parse(fs.readFileSync(path.join(root,dir,f),'utf8'));return Array.isArray(d)?d:Object.values(d).flat(); }).filter(a=>a.family); }
const pools = {item_affixes:load('item_affixes'),rune_affixes:load('rune_affixes'),map_affixes:load('map_affixes')};
for (const category of catalog.categories) {
  category.tiers = {};
  const pool = pools[category.name==='符文'?'rune_affixes':category.name==='敕令'?'map_affixes':'item_affixes'];
  for (const side of ['prefixes','suffixes']) for (const label of category[side]) {
    const stats=label.split(' / '), first=stats[0].replace(/（[^）]*）/g,'').replace(/^敌人/,'');
    let family=names[first];
    if (first==='金币获取量额外提高' && side==='prefixes') family='inc_gold_2';
    if (first==='攻击技能的技能速度提高' && category.name==='攻击武器') family='inc_speed';
    if (category.name==='敕令') family = {'持续伤害闪避率':'add_evade','最大生命提高':'inc_life','格挡率':'add_block','生命恢复':'add_life_regen','诅咒技能的持续效果抗性':'add_status_resist','防御':'add_armor','伤害额外提高':'inc_damage','技能速度提高':'inc_speed','暴击伤害':'inc_crit_damage','金币获取量额外降低':'dec_gold','额外获得等同于基础命中伤害一定比例的最高雷电伤害':'extra_storm_damage','额外获得等同于基础命中伤害一定比例的火焰伤害':'extra_fire_damage'}[first];
    let rows=pool.filter(a=>a.family===family && a.affix_type===(side==='prefixes'?'Prefix':'Suffix') && a.effects.length===stats.length && (!a.restrictions||a.restrictions.some(r=>categories[category.name].includes(r))));
    if(category.name==='敕令'&&family==='add_armor') rows.push(...pool.filter(a=>a.family==='inc_armor'));
    if(!rows.length) throw new Error(`Unmapped ${category.name}: ${side} ${label}`);
    category.tiers[`${side}:${label}`]=rows.sort((a,b)=>a.item_level-b.item_level||a.tier-b.tier).map(a=>({name:a.name,tier:a.tier,level:a.item_level,variant:(a.restrictions||[]).filter(r=>restrictionNames[r]).map(r=>restrictionNames[r]).join('／'),ranges:a.effects.map((e,i)=>{
      let values=Array.isArray(e.value)?e.value:[e.value,e.value];
      const regen=e.stat==='LifeRegen'||e.stat==='ManaRegen';
      if(regen) values=values.map(v=>v/10);
      if(stats[i].includes('降低')) values=values.map(Math.abs).sort((a,b)=>a-b);
      const percent=regen||e.modifier!=='Flat'||/暴击|格挡|闪避|抗性|额外获得/.test(stats[i]);
      return values.map(v=>Number(v.toFixed(6))).join('～')+(percent?'%':'');
    })}));
  }
}
catalog.rangeSource = {name:'本地游戏词缀库',observedAt:'2026-10-01'};
fs.writeFileSync(path.join(__dirname,'../data/crafting-catalog.json'),JSON.stringify(catalog,null,2)+'\n');
console.log('Imported all category affix tiers');
