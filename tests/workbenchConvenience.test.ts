import test from "node:test";
import assert from "node:assert/strict";
import {loadRecentScopes,rememberRecentScope,conversationShortcuts} from "../src/services/roomWorkspace";
import {readWorkbenchNotes,saveWorkbenchNotes,workbenchNotesKey,workbenchNotesBackupKey,type WorkbenchNoteData} from "../src/components/WorkbenchNotes";
import type {ChatRoom} from "../src/domain/agent/roomWorkspace";
const memory=()=>{const values=new Map<string,string>();return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};};
const rooms:ChatRoom[]=[{id:"room-a",name:"研究室",members:["GPT"],mode:"group"},{id:"room-b",name:"灵感室",members:["GPT"],mode:"free"}];
test("recent conversations track actual opens, deduplicate and exclude notes",()=>{
 const store=memory();assert.deepEqual(loadRecentScopes(store),[]);
 rememberRecentScope(store,"room-a");rememberRecentScope(store,"direct-GPT");rememberRecentScope(store,"room-a");
 assert.deepEqual(rememberRecentScope(store,"notes"),["room-a","direct-GPT"]);
 for(let i=0;i<25;i++)rememberRecentScope(store,`room-${i}`);
 assert.equal(loadRecentScopes(store).length,20);assert.equal(loadRecentScopes(store)[0],"room-24");
});
test("shortcuts use current room names, filter removed rooms and distinguish fallback",()=>{
 assert.deepEqual(conversationShortcuts(rooms,[],"notes"),{last:null,rooms,hasRecentRooms:false});
 const value=conversationShortcuts(rooms,["room-deleted","room-b","direct-GPT","room-a"],"room-b");
 assert.deepEqual(value.last,{scope:"direct-GPT",label:"与 GPT 对话"});assert.deepEqual(value.rooms,[rooms[0]]);assert.equal(value.hasRecentRooms,true);
 assert.equal(conversationShortcuts([{...rooms[0],name:"新名字"}],["room-a"],"notes").last?.label,"新名字");
});
test("unreadable recent history is preserved and write failures propagate",()=>{
 const store=memory();store.values.set("codex-desktop.agent-room-recent.v1","broken");
 assert.throws(()=>rememberRecentScope(store,"room-a"));assert.equal(store.getItem("codex-desktop.agent-room-recent.v1"),"broken");
 assert.throws(()=>rememberRecentScope({getItem:()=>null,setItem:()=>{throw Error("disk");}},"room-a"),/disk/);
});
test("notes and todos round-trip locally and retain the previous saved version",()=>{
 const store=memory(),initial=readWorkbenchNotes(store);assert.deepEqual(initial.data,{version:1,note:"",todos:[]});
 const data:WorkbenchNoteData={version:1,note:"本地想法 <script>",todos:[{id:"one",text:"核对数据",done:false}]};
 const first=saveWorkbenchNotes(store,data,null);assert.deepEqual(readWorkbenchNotes(store).data,data);
 const changed={...data,todos:[{...data.todos[0],done:true}]};saveWorkbenchNotes(store,changed,first);
 assert.equal(store.getItem(workbenchNotesBackupKey),first);assert.equal(readWorkbenchNotes(store).data.todos[0].done,true);
 assert.equal(store.values.size,2);
});
test("corrupt notes are never replaced with defaults",()=>{
 for(const raw of ["broken",JSON.stringify({version:9,note:"original",todos:[]}),JSON.stringify({version:1,note:"original",todos:[{id:"one",text:"x",done:"yes"}]}),"x".repeat(65537)]){
  const store=memory();store.values.set(workbenchNotesKey,raw);assert.throws(()=>readWorkbenchNotes(store));assert.equal(store.getItem(workbenchNotesKey),raw);
 }
});
test("stale-window edits cannot overwrite newer notes",()=>{
 const store=memory(),data:WorkbenchNoteData={version:1,note:"first",todos:[]};const first=saveWorkbenchNotes(store,data,null);
 const second=saveWorkbenchNotes(store,{...data,note:"second"},first);
 assert.throws(()=>saveWorkbenchNotes(store,{...data,note:"stale"},first),/其他窗口/);assert.equal(store.getItem(workbenchNotesKey),second);
});
test("backup and save errors propagate without replacing current notes",()=>{
 for(const failingKey of [workbenchNotesKey,workbenchNotesBackupKey]){
  const store=memory(),data:WorkbenchNoteData={version:1,note:"original",todos:[]},first=saveWorkbenchNotes(store,data,null);
  const faulty={getItem:store.getItem,setItem:(key:string,value:string)=>{if(key===failingKey)throw Error("disk full");store.setItem(key,value);}};
  assert.throws(()=>saveWorkbenchNotes(faulty,{...data,note:"new"},first),/disk full/);assert.equal(store.getItem(workbenchNotesKey),first);
 }
});
test("notes enforce size limits and unique todo identifiers before writing",()=>{
 const store=memory(),data:WorkbenchNoteData={version:1,note:"",todos:[]};
 const row={id:"a",text:"x",done:false};
 for(const bad of [{...data,note:"x".repeat(4001)},{...data,todos:[row,row]},{...data,todos:[{...row,text:" "}]},{...data,todos:Array.from({length:21},(_,i)=>({...row,id:String(i)}))}])assert.throws(()=>saveWorkbenchNotes(store,bad,null));
 assert.equal(store.values.size,0);
});
