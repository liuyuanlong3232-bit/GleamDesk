import {invoke,isTauri} from '@tauri-apps/api/core';
import {launchApplication} from './launcher/launcherService';
export type MailProvider='qq'|'mail163'|'gmail'|'outlook';
export interface MailAccount {id:string;provider:MailProvider;email:string;enabled:boolean}
export interface OtpNotice {id:string;accountId:string;sender:string;subject:string;code:string|null;receivedAt:number;expiresAt:number}
export interface MailSnapshot {accounts:MailAccount[];statuses:{accountId:string;state:string;message:string}[];notices:OtpNotice[];inbox?:OtpNotice[]}
export const mailProviders:Record<MailProvider,string>={qq:'QQ 邮箱',mail163:'163 邮箱',gmail:'Gmail',outlook:'Outlook'};
export function mailWebUrl(provider:MailProvider){
 const urls:Record<MailProvider,string>={qq:'https://mail.qq.com/',mail163:'https://mail.163.com/',gmail:'https://mail.google.com/mail/u/0/#inbox',outlook:'https://outlook.live.com/mail/0/inbox'};
 if(!Object.hasOwn(urls,provider))throw new Error('不支持的邮箱类型');
 return urls[provider];
}
export function openMailWebsite(provider:MailProvider){return launchApplication({id:`mail-web-${provider}`,name:mailProviders[provider],icon:'',type:'url',target:mailWebUrl(provider),pinned:false,order:0});}
export function mailAccountsByLatest(snapshot:MailSnapshot){
 const latest=new Map<string,number>();
 for(const mail of [...(snapshot.inbox??[]),...snapshot.notices])latest.set(mail.accountId,Math.max(latest.get(mail.accountId)??0,mail.receivedAt));
 return [...snapshot.accounts].sort((a,b)=>(latest.get(b.id)??0)-(latest.get(a.id)??0));
}
export function mailSenderLabel(sender:string){return sender.split('<',1)[0].trim().replace(/^"(.*)"$/,'$1')||sender.trim()||'未知发件人';}
export function mailStateLabel(account:Pick<MailAccount,'enabled'>,status?:{state:string}){if(!account.enabled)return '已暂停';return status?.state==='ready'?'监听中':status?.state==='error'?'连接异常':status?.state==='paused'?'模拟暂停':status?.state==='connecting'?'连接中…':'等待连接';}
export function nextOtp(notices:OtpNotice[],dismissed:ReadonlySet<string>,now:number){const ready=notices.filter(n=>n.expiresAt>now&&!dismissed.has(n.id));return ready.find(n=>n.code)||ready[0];}
export function remainingOtpTime(shownAt:number,expiresAt:number,now:number){return Math.max(0,Math.min(shownAt+30_000,expiresAt)-now);}
export async function readMailSnapshot():Promise<MailSnapshot>{if(!isTauri())return {accounts:[],statuses:[],notices:[]};return invoke('mail_otp_snapshot');}
export function addMailAccount(provider:MailProvider,email:string,authorization:string,consent:boolean){return invoke<MailAccount>('mail_otp_add',{provider,email,authorization,consent});}
export function connectMailOAuth(provider:MailProvider,clientId:string,clientSecret:string,consent:boolean){return invoke<MailAccount>('mail_oauth_connect',{request:{provider,clientId,clientSecret:clientSecret||null,consent}});}
export function cancelMailOAuth(){return invoke('mail_oauth_cancel');}
export function updateMailAccount(id:string,enabled:boolean,remove=false){return invoke('mail_otp_update',{id,enabled,remove});}
export function refreshMailInbox(){return invoke('mail_otp_refresh');}
