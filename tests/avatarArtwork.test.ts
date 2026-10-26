import test from "node:test";import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createElement} from "react";import {renderToStaticMarkup} from "react-dom/server";
import {AvatarArtwork,avatarCrop} from "../src/components/AvatarArtwork";
import {RoomPortrait} from "../src/components/RoomPortrait";
import {customAvatarEnabled,resetAvatar,subscribeAvatars} from "../src/services/agentAvatars";
import {roomMembers} from "../src/domain/agent/roomWorkspace";
import {appThemes} from "../src/presentation/theme";
test("approved artwork dimensions match the original PNG files",async()=>{
 for(const [kind,file] of [["personal","brand-avatar-themes"],["daily","hud-themes-v2"],["member","room-members-v2"]] as const){
  const image=await readFile(`src/assets/avatars-3d/${file}.png`),crop=avatarCrop(kind,"DeepSeek");assert.equal(image.readUInt32BE(16),crop.width);assert.equal(image.readUInt32BE(20),crop.height);
 }
});

test("all room members have distinct crops in roster order without changing routing IDs",()=>{
 const crops=roomMembers.map(id=>avatarCrop("member",id));assert.equal(new Set(crops.map(c=>`${c.x}:${c.y}`)).size,10);
 for(const crop of crops){assert.ok(crop.x>=0&&crop.x+crop.size<=crop.width);assert.ok(crop.y>=0&&crop.y+crop.size<=crop.height);}
 assert.throws(()=>avatarCrop("member","unknown"),/成员/);
});
test("personal and HUD artwork provides four different theme variants",()=>{
 for(const kind of ["personal","daily","workbench"] as const){const crops=appThemes.map(t=>avatarCrop(kind,"你",t.id));assert.equal(new Set(crops.map(c=>c.x)).size,4);const html=renderToStaticMarkup(createElement(AvatarArtwork,{kind}));for(const theme of appThemes)assert.match(html,new RegExp(`data-portrait-theme="${theme.id}"`));}
 const member=renderToStaticMarkup(createElement(RoomPortrait,{id:"GPT"}));assert.match(member,/avatar-art-member/);assert.match(member,/alt="GPT头像"/);assert.match(member,/data-avatar-id="GPT"/);
});
test("explicit file previews still take priority over themed defaults",()=>{
 const html=renderToStaticMarkup(createElement(RoomPortrait,{id:"你",preview:"blob:local-preview"}));assert.match(html,/src="blob:local-preview"/);assert.doesNotMatch(html,/avatar-art-personal/);
});
test("using themed defaults retains custom media and notifies the existing subscribers",async()=>{
 const storage=Object.getOwnPropertyDescriptor(globalThis,"localStorage"),oldWindow=Object.getOwnPropertyDescriptor(globalThis,"window"),values=new Map<string,string>(),target=new EventTarget();
 Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)}});Object.defineProperty(globalThis,"window",{configurable:true,value:target});
 try{assert.equal(customAvatarEnabled("你"),false);values.set("codex-desktop.avatar-source.v1.你","custom");assert.equal(customAvatarEnabled("你"),true);let changed=0;const stop=subscribeAvatars(()=>changed++);await resetAvatar("你","idle");assert.equal(customAvatarEnabled("你"),false);assert.equal(changed,1);stop();}
 finally{if(storage)Object.defineProperty(globalThis,"localStorage",storage);else Reflect.deleteProperty(globalThis,"localStorage");if(oldWindow)Object.defineProperty(globalThis,"window",oldWindow);else Reflect.deleteProperty(globalThis,"window");}
});
test("failed avatar-source saves report failure and keep the earlier selection",async()=>{
 const storage=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
 Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:()=>"custom",setItem:()=>{throw Error("disk full");}}});
 try{await assert.rejects(resetAvatar("你","idle"),/未能保存/);assert.equal(customAvatarEnabled("你"),true);}
 finally{if(storage)Object.defineProperty(globalThis,"localStorage",storage);else Reflect.deleteProperty(globalThis,"localStorage");}
});
