/* Exercise the client exporter's capture and change detection without Minecraft. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Tag {
  constructor(){this.data={};}
  put(k,v){this.data[k]=v;}
  putDouble(k,v){this.data[k]=v;}
  putInt(k,v){this.data[k]=v;}
  get(k){return this.data[k];}
  getCompound(k){return this.data[k] || new Tag();}
  toString(){return JSON.stringify(this.data);}
}
let health=220, hearts=100, tick, written=[];
const player={saveWithoutId(root){root.put('Attributes',[{Name:'minecraft:generic.max_health',Base:20}]);root.put('Inventory',[]);},
  getAttributes(){return {getSyncableAttributes:()=>[{getAttribute:()=> 'minecraft:generic.max_health',getValue:()=>health}]};},
  displayClientMessage(){}};
const classes={
  'net.minecraft.client.Minecraft':{getInstance:()=>({player})},
  'net.minecraft.nbt.CompoundTag':Tag,'net.minecraft.nbt.ListTag':Array,
  'dev.latvian.mods.kubejs.KubeJSPaths':{DIRECTORY:{resolve:x=>x}},
  'net.minecraftforge.registries.ForgeRegistries':{ATTRIBUTES:{getKey:x=>x}},
  'tictim.paraglider.api.vessel.VesselContainer':{get:()=>({heartContainer:()=>hearts})},
  'com.robertx22.mine_and_slash.uncommon.datasaving.Load':{
    player:()=>({buildClientNBT:()=>new Tag()}),Unit:()=>({serializeNBT:()=>new Tag()})},
};
const ctx=vm.createContext({console,Java:{loadClass:name=>{assert.ok(classes[name],name);return classes[name];}},
  ClientEvents:{tick:fn=>{tick=fn;}},Text:{green:x=>x,yellow:x=>x,red:x=>x},
  NBTIO:{write:(path,root)=>{written.push(root);}}});
vm.runInContext(fs.readFileSync('kubejs/client_scripts/pob_export.js','utf8'),ctx);
for(let i=0;i<60;i++)tick({});
assert.equal(written.length,1);
assert.equal(written[0].get('PobRuntimeAttributes').get('minecraft:generic.max_health'),220);
assert.equal(written[0].get('Attributes')[0].Base,20);
assert.equal(written[0].get('PobHeartContainers'),100);
for(let i=0;i<60;i++)tick({});
assert.equal(written.length,1,'unchanged state is not rewritten');
health=222;
for(let i=0;i<60;i++)tick({});
assert.equal(written.length,2,'attribute-only changes must export');
hearts=99;
for(let i=0;i<60;i++)tick({});
assert.equal(written.length,3,'container-count-only changes must export');
console.log('PASS live attributes include health bonuses and trigger exports independently');
