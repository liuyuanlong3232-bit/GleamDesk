import {useCallback,useEffect,useRef,useState} from 'react';
import {translationChunks} from '../services/translationText';
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

export function OfflineTranslator(){
 const [open,setOpen]=useState(false),[text,setText]=useState('');const task=useTranslation();const close=()=>{task.cancel();setOpen(false);};
 useEffect(()=>{const show=()=>setOpen(true);window.addEventListener('gleamdesk.open-translator',show);return()=>window.removeEventListener('gleamdesk.open-translator',show);},[]);
 useEffect(()=>{if(!open)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[open]);
 if(!open)return null;
 return <div className="offline-backdrop" data-main-hit-region><section className="offline-dialog glass" role="dialog" aria-modal="true" aria-labelledby="offline-title" data-no-page-swipe><header><div><h2 id="offline-title">离线翻译</h2><small>英文 → 简体中文 · 内容仅在本机处理</small></div><button type="button" aria-label="关闭翻译" onClick={close}>×</button></header><label htmlFor="offline-input">英文原文</label><textarea id="offline-input" autoFocus value={text} maxLength={16000} disabled={task.busy} onChange={event=>setText(event.target.value)} placeholder="粘贴要翻译的英文…"/><div className="offline-actions"><small>{text.length}/16000</small><button type="button" className="wb-primary" disabled={!text.trim()} onClick={()=>task.busy?task.cancel():task.translate(text)}>{task.busy?'停止':'翻译'}</button></div>{task.status&&<p role="status">{task.status}</p>}{task.error&&<p role="alert">{task.error}</p>}{task.result&&<div className="offline-result" lang="zh-CN">{task.result}</div>}</section></div>;
}
