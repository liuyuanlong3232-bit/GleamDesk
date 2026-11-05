import {useEffect,useRef,useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {readMailSnapshot,nextOtp,remainingOtpTime,type MailSnapshot,type OtpNotice} from '../services/mailOtp';
import {CloseIcon} from './CloseIcon';

export function MailOtpToast({blocked,enabled=true,recent=false,onCloseRecent}:{blocked:boolean;enabled?:boolean;recent?:boolean;onCloseRecent?:()=>void}){
 const [snapshot,setSnapshot]=useState<MailSnapshot>({accounts:[],statuses:[],notices:[]}),[active,setActive]=useState<OtpNotice>(),[clock,setClock]=useState(Date.now()),[hover,setHover]=useState(false),[copied,setCopied]=useState(''),[error,setError]=useState('');
 const dismissed=useRef(new Set<string>()),shown=useRef(0),copyTimer=useRef<number|undefined>(undefined);
 const dismiss=()=>{if(active)dismissed.current.add(active.id);setActive(undefined);setHover(false);setCopied('');setError('');};
 useEffect(()=>{setHover(false)},[active?.id,blocked]);
 useEffect(()=>{if(recent){snapshot.notices.forEach(n=>dismissed.current.add(n.id));setActive(undefined);setHover(false)}},[recent,snapshot.notices]);
 useEffect(()=>{if(!enabled||!isTauri())return;let alive=true,inFlight=false;const read=async()=>{if(inFlight)return;inFlight=true;try{const value=await readMailSnapshot();if(alive)setSnapshot(value)}catch{/* Settings displays connection errors; never toast credentials or response bodies. */}finally{inFlight=false}};void read();const timer=window.setInterval(()=>void read(),1500);return()=>{alive=false;window.clearInterval(timer)}},[enabled]);
 useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),250);return()=>{window.clearInterval(timer);window.clearTimeout(copyTimer.current)}},[]);
 useEffect(()=>{const ids=new Set(snapshot.notices.map(n=>n.id));for(const id of dismissed.current)if(!ids.has(id))dismissed.current.delete(id)},[snapshot.notices]);
 useEffect(()=>{if(!enabled){setActive(undefined);return}if(active){if(active.expiresAt<=clock||(!hover&&!blocked&&!recent&&remainingOtpTime(shown.current,active.expiresAt,clock)===0))dismiss();return}if(!blocked&&!recent){const next=nextOtp(snapshot.notices,dismissed.current,clock);if(next){shown.current=clock;setActive(next);setError('');setCopied('')}}},[snapshot.notices,clock,blocked,recent,enabled,active,hover]);
 useEffect(()=>{if(active&&(blocked||recent||hover))shown.current=Date.now()},[active,blocked,recent,hover,clock]);
 const copy=async(n:OtpNotice)=>{if(!n.code||n.expiresAt<=Date.now()){setError('验证码已过期');return}setError('');try{await navigator.clipboard.writeText(n.code);setCopied(n.id);window.clearTimeout(copyTimer.current);copyTimer.current=window.setTimeout(()=>{dismissed.current.add(n.id);setActive(a=>a?.id===n.id?undefined:a);setCopied('');},700)}catch{setError('复制失败，请重试')}};
 const notices=snapshot.notices.filter(n=>n.expiresAt>clock).slice(-20).reverse();
 if(!enabled||blocked&&!recent||!recent&&!active)return null;
 return <MailOtpCard recent={recent} active={active} notices={notices} snapshot={snapshot} copied={copied} error={error} copy={copy} onHover={setHover} onClose={()=>{if(recent)onCloseRecent?.();else dismiss()}}/>;
}
export function MailOtpCard({recent,active,notices,snapshot,copied,error,copy,onClose,onHover}:{recent:boolean;active?:OtpNotice;notices:OtpNotice[];snapshot:MailSnapshot;copied:string;error:string;copy:(notice:OtpNotice)=>Promise<void>;onClose:()=>void;onHover?:(hover:boolean)=>void}){
 return <aside className="island-popover glass mail-otp-toast" data-main-hit-region aria-label={recent?'最近邮件':active?.code?'邮箱验证码':'新邮件'} onMouseEnter={()=>onHover?.(true)} onMouseLeave={()=>onHover?.(false)}>
  <button className="ui-icon-button mail-otp-close" aria-label={recent?'关闭邮箱':active?.code?'关闭验证码':'关闭新邮件提醒'} onClick={onClose}><CloseIcon/></button>
  {recent?<><span className="mail-otp-eyebrow">最近邮件</span>{notices.length?notices.map(n=><div className="mail-otp-recent-row" key={n.id}><div><strong>{n.sender||'新邮件'}</strong><p className="mail-notice-subject">{n.subject||'（无主题）'}</p><small>{snapshot.accounts.find(a=>a.id===n.accountId)?.email}</small></div>{n.code&&<button onClick={()=>void copy(n)} aria-label={`复制验证码 ${n.code}`}>{copied===n.id?'已复制':n.code}</button>}</div>):<p className="mail-otp-hint">暂无最近邮件</p>}</>:active&&<>{active.code?<><span className="mail-otp-eyebrow">{active.sender||'新邮件'}</span><div className="mail-otp-code-row"><button className="mail-otp-code" aria-label={`复制验证码 ${active.code}`} onClick={()=>void copy(active)}>{active.code}</button><button className="mail-otp-copy" onClick={()=>void copy(active)}>{copied===active.id?'已复制':'复制'}</button></div></>:<><span className="mail-otp-eyebrow">新邮件</span><strong className="mail-notice-sender">{active.sender||'未知发件人'}</strong><p className="mail-notice-subject">{active.subject||'（无主题）'}</p></>}<small className="mail-otp-address">{snapshot.accounts.find(a=>a.id===active.accountId)?.email}</small></>}
  {error&&<p role="alert">{error}</p>}
 </aside>;
}
