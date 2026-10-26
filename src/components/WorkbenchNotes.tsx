import {useEffect,useRef,useState} from "react";
import {CloseIcon} from "./CloseIcon";

export const workbenchNotesKey="codex-desktop.workbench-notes.v1";
export const workbenchNotesBackupKey=`${workbenchNotesKey}.previous`;
export interface WorkbenchNoteData {version:1;note:string;todos:{id:string;text:string;done:boolean}[]}
type NoteStorage=Pick<Storage,"getItem"|"setItem">;
function checked(value:unknown):WorkbenchNoteData {
 const data=value as WorkbenchNoteData;
 if(!data||data.version!==1||typeof data.note!=="string"||data.note.length>4000||!Array.isArray(data.todos)||data.todos.length>20||data.todos.some(item=>!item||typeof item.id!=="string"||!item.id||item.id.length>100||typeof item.text!=="string"||!item.text.trim()||item.text.length>120||typeof item.done!=="boolean")||new Set(data.todos.map(item=>item.id)).size!==data.todos.length)throw Error("便签记录无法读取，原内容已保留");
 return data;
}
export function readWorkbenchNotes(storage:Pick<Storage,"getItem">){
 const raw=storage.getItem(workbenchNotesKey);
 if(raw!==null&&raw.length>65536)throw Error("便签记录无法读取，原内容已保留");
 return {raw,data:raw===null?{version:1,note:"",todos:[]} as WorkbenchNoteData:checked(JSON.parse(raw))};
}
export function saveWorkbenchNotes(storage:NoteStorage,data:WorkbenchNoteData,expectedRaw:string|null):string {
 checked(data);
 if(storage.getItem(workbenchNotesKey)!==expectedRaw)throw Error("内容已在其他窗口改变，请先重新读取");
 const raw=JSON.stringify(data);
 if(raw===expectedRaw)return raw;
 if(expectedRaw!==null)storage.setItem(workbenchNotesBackupKey,expectedRaw);
 storage.setItem(workbenchNotesKey,raw);
 return raw;
}

export function WorkbenchNotes(){
 const [data,setData]=useState<WorkbenchNoteData|null>(null),[todo,setTodo]=useState(""),[error,setError]=useState(""),[saved,setSaved]=useState(false);
 const raw=useRef<string|null>(null);
 const load=()=>{try{const value=readWorkbenchNotes(localStorage);raw.current=value.raw;setData(value.data);setSaved(value.raw!==null);setError("");}catch{setData(null);setError("便签无法读取，原内容已保留");}};
 useEffect(load,[]);
 const update=(next:WorkbenchNoteData)=>{setData(next);try{raw.current=saveWorkbenchNotes(localStorage,next,raw.current);setSaved(true);setError("");}catch(cause){setSaved(false);setError(cause instanceof Error&&cause.message.includes("其他窗口")?"其他窗口已更新内容，本次编辑尚未保存":"保存失败，本次编辑尚未保存，原记录已保留");}};
 return <section className="wb-card wb-notes" aria-label="便签与待办"><header><h2>便签与待办</h2><small role="status">{error?"未保存":saved?"已保存到本机":"仅本机"}</small></header>
 {error&&<div className="wb-notes-error" role="alert"><span>{error}</span>{data&&<button onClick={()=>update(data)}>重试保存</button>}<button onClick={()=>{if(!data||window.confirm("重新读取将放弃本次未保存的编辑，是否继续？"))load();}}>重新读取</button></div>}
 {data&&<div className="wb-notes-grid"><label className="wb-note-field"><span>随手记</span><textarea aria-label="随手记" maxLength={4000} value={data.note} placeholder="记下一点想法…" onChange={e=>update({...data,note:e.target.value})}/></label><section className="wb-todos" aria-label="待办"><form onSubmit={e=>{e.preventDefault();if(!todo.trim()||data.todos.length>=20)return;update({...data,todos:[...data.todos,{id:crypto.randomUUID(),text:todo.trim(),done:false}]});setTodo("");}}><label htmlFor="wb-new-todo">待办</label><div><input id="wb-new-todo" maxLength={120} value={todo} onChange={e=>setTodo(e.target.value)} placeholder="添加一件事…"/><button type="submit" disabled={!todo.trim()||data.todos.length>=20}>添加</button></div></form><ul>{data.todos.map(item=><li key={item.id}><label><input type="checkbox" checked={item.done} onChange={e=>update({...data,todos:data.todos.map(row=>row.id===item.id?{...row,done:e.target.checked}:row)})}/><span className={item.done?"done":""}>{item.text}</span></label><button className="ui-icon-button" aria-label={`删除待办：${item.text}`} onClick={()=>update({...data,todos:data.todos.filter(row=>row.id!==item.id)})}><CloseIcon/></button></li>)}</ul>{!data.todos.length&&<p>暂无待办</p>}{data.todos.length>=20&&<p>已满 20 项，完成后可移除</p>}</section></div>}
 </section>;
}
