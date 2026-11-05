import {invoke,isTauri} from '@tauri-apps/api/core';
export type MailProvider='qq'|'mail163'|'gmail'|'outlook';
export interface MailAccount {id:string;provider:MailProvider;email:string;enabled:boolean}
export interface OtpNotice {id:string;accountId:string;sender:string;code:string;receivedAt:number;expiresAt:number}
export interface MailSnapshot {accounts:MailAccount[];statuses:{accountId:string;state:string;message:string}[];notices:OtpNotice[]}
export const mailProviders:Record<MailProvider,string>={qq:'QQ 邮箱',mail163:'163 邮箱',gmail:'Gmail',outlook:'Outlook'};
export function nextOtp(notices:OtpNotice[],dismissed:ReadonlySet<string>,now:number){return notices.find(n=>n.expiresAt>now&&!dismissed.has(n.id));}
export function remainingOtpTime(shownAt:number,expiresAt:number,now:number){return Math.max(0,Math.min(shownAt+15_000,expiresAt)-now);}
export async function readMailSnapshot():Promise<MailSnapshot>{if(!isTauri())return {accounts:[],statuses:[],notices:[]};return invoke('mail_otp_snapshot');}
export function addMailAccount(provider:MailProvider,email:string,authorization:string,consent:boolean){return invoke<MailAccount>('mail_otp_add',{provider,email,authorization,consent});}
export function connectMailOAuth(provider:MailProvider,clientId:string,clientSecret:string,consent:boolean){return invoke<MailAccount>('mail_oauth_connect',{request:{provider,clientId,clientSecret:clientSecret||null,consent}});}
export function cancelMailOAuth(){return invoke('mail_oauth_cancel');}
export function updateMailAccount(id:string,enabled:boolean,remove=false){return invoke('mail_otp_update',{id,enabled,remove});}
