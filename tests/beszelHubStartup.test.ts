import assert from "node:assert/strict";
import {test} from "node:test";
import {defaultSettings,loadSettings,saveSettings} from "../src/providers/settingsStore";

test("profile name defaults to empty and normalizes control characters without importing identity",()=>{
 globalThis.localStorage={getItem:()=>JSON.stringify({displayName:"  测试\n昵称  "}),setItem:()=>{}} as unknown as Storage;
 assert.equal(defaultSettings.displayName,"");assert.equal(loadSettings().displayName,"测试昵称");
});

test("local Hub startup stays off for new and legacy configurations",()=>{
  for(const value of [null,{}, {beszelUrl:"http://127.0.0.1:8090"}, {beszelAutoStartHub:"true"}]){
    globalThis.localStorage={getItem:()=>JSON.stringify(value),setItem:()=>{}} as unknown as Storage;
    const settings=loadSettings();
    assert.equal(settings.beszelAutoStartHub,false);
    assert.equal(settings.beszelHubExecutable,"");
    assert.equal(settings.beszelHubDataDirectory,"");
  }
});

test("explicit Hub choice and paths survive restart without credentials or author paths",()=>{
  let raw:string|null=null;
  globalThis.localStorage={getItem:(key:string)=>key==="codex-desktop.settings.v1"?raw:null,setItem:(key:string,value:string)=>{if(key==="codex-desktop.settings.v1")raw=value;}} as unknown as Storage;
  saveSettings({...defaultSettings,beszelAutoStartHub:true,beszelHubExecutable:"C:\\My Hub\\beszel.exe",beszelHubDataDirectory:"D:\\My data\\beszel_data"});
  const restored=loadSettings();
  assert.equal(restored.beszelAutoStartHub,true);
  assert.equal(restored.beszelHubExecutable,"C:\\My Hub\\beszel.exe");
  assert.equal(restored.beszelHubDataDirectory,"D:\\My data\\beszel_data");
  assert.doesNotMatch(raw!,/GitHub_Projects|password|apiToken/);
});
