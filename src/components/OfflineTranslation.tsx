import {useCallback,useEffect,useRef,useState} from 'react';
import {translationChunks,readDescriptionCache,writeDescriptionCache,needsOfflineDescription} from '../services/translationText';
import './offline-translation.css';

let activeCancel:(()=>void)|undefined;
function useTranslation(){
 const [result,setResult]=useState(''),[status,setStatus]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const worker=useRef<Worker|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const stop=useCallback(()=>{worker.current?.terminate();worker.current=null;clearTimeout(timer.current);},[]);
 const cancel=useCallback(()=>{stop();setBusy(false);setStatus('已停止');if(activeCancel===cancel)activeCancel=undefined;},[stop]);
 useEffect(()=>()=>{stop();if(activeCancel===cancel)activeCancel=undefined;},[stop,cancel]);
 const reset=()=>{cancel();setStatus('');setResult('');setError('');};
 const translate=(text:string)=>{
  activeCancel?.();stop();activeCancel=cancel;setResult('');setError('');setStatus('');
  try{translationChunks(text);setBusy(true);const task=new Worker(new URL('../services/translation.worker.ts',import.meta.url),{type:'module'});worker.current=task;
   const fail=(message:string)=>{stop();setBusy(false);setStatus('');setError(message);};
   task.onmessage=event=>{const data=event.data as {status?:string;result?:string;error?:string};if(data.error)fail(data.error);else if(data.result!==undefined){setResult(data.result);setBusy(false);setStatus('离线翻译完成 · 仅供参考');stop();}else if(data.status)setStatus(data.status);};
   task.onerror=()=>fail('离线翻译暂不可用，请确认翻译模型和运行文件已备齐');
   timer.current=setTimeout(()=>fail('翻译超过 5 分钟，已停止；请减少内容后重试'),300000);
   task.postMessage({text});
  }catch(e){setBusy(false);setError(String(e instanceof Error?e.message:e));}
 };
 return {result,status,error,busy,translate,cancel,reset};
}

export function TranslateInline({text}:{text:string}){
 const task=useTranslation();
 useEffect(()=>{task.reset();},[text]);
 if(!/[a-zA-Z]{3}/.test(text))return null;
 return <div className="offline-inline"><button type="button" className="text-button" onClick={()=>task.busy?task.cancel():task.translate(text)}>{task.busy?'停止翻译':'译为中文 · 离线'}</button>{task.status&&<small role="status">{task.status}</small>}{task.error&&<p role="alert">{task.error}</p>}{task.result&&<div className="offline-result" lang="zh-CN">{task.result}</div>}</div>;
}

/** Translate the visible recommendation list in one worker, then reuse the public-text cache. */
export function useOfflineDescriptions(items:readonly {description:string}[],active:boolean){
 const [results,setResults]=useState<Record<string,string>>(()=>Object.create(null)),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const signature=JSON.stringify(items.map(item=>item.description));
 useEffect(()=>{
  setError('');setBusy(false);if(!active)return;
  const sources=[...new Set(JSON.parse(signature) as string[])].filter(needsOfflineDescription);
  const cached=readDescriptionCache();setResults(cached);
  const pending=sources.filter(text=>!cached[text]);if(!pending.length)return;
  let alive=true;let worker:Worker;try{worker=new Worker(new URL('../services/translation.worker.ts',import.meta.url),{type:'module'});}catch{setError('离线翻译暂不可用，保留原文');return;}setBusy(true);
  const stop=()=>{worker.terminate();clearTimeout(timer);};
  const fail=(message:string)=>{if(alive){setError(message);setBusy(false);}stop();};
  const timer=setTimeout(()=>fail('离线翻译达到时限，保留原文；重新打开推荐可重试'),300000);
  worker.onmessage=event=>{if(!alive)return;const data=event.data as {item?:{index:number;result:string};done?:boolean;error?:string};
   if(data.error)fail(data.error);
   else if(data.item){const source=pending[data.item.index],result=data.item.result;if(source&&typeof result==='string'&&result.trim()){cached[source]=result;writeDescriptionCache(cached);setResults(Object.assign(Object.create(null),cached));}}
   else if(data.done){setBusy(false);stop();}
  };
  worker.onerror=()=>fail('离线翻译暂不可用，保留原文');worker.postMessage({texts:pending});
  return()=>{alive=false;stop();};
 },[signature,active]);
 return {results,busy,error};
}
