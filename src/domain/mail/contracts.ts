export type MailProvider="gmail"|"outlook"|"netease"|"qq";
export const mailProviders:{id:MailProvider;name:string;connection:"oauth"|"imap";website:string}[]=[
  {id:"gmail",name:"Gmail",connection:"oauth",website:"https://mail.google.com/"},
  {id:"outlook",name:"Outlook",connection:"oauth",website:"https://outlook.live.com/mail/"},
  {id:"netease",name:"163邮箱",connection:"imap",website:"https://mail.163.com/"},
  {id:"qq",name:"QQ邮箱",connection:"imap",website:"https://mail.qq.com/"},
];
export interface MailMessage{id:string;subject:string;sender:string;receivedAt:string;unread:boolean|null;important:boolean}
export interface MailSnapshot{provider:MailProvider;account:string;unreadCount:number|null;messages:MailMessage[];observedAtUnixMs:number;source:string}
export function validateMailSnapshot(value:unknown,provider:MailProvider):MailSnapshot{
  const snapshot=value as MailSnapshot;if(!snapshot||snapshot.provider!==provider||typeof snapshot.account!=="string"||!Array.isArray(snapshot.messages)||snapshot.messages.length>12||!Number.isFinite(snapshot.observedAtUnixMs)||snapshot.observedAtUnixMs>Date.now()+1000)throw new Error("邮件来源或结构无效");
  if(snapshot.unreadCount!==null&&(!Number.isSafeInteger(snapshot.unreadCount)||snapshot.unreadCount<0))throw new Error("未读数量无效");
  for(const message of snapshot.messages){if(!message||![message.id,message.subject,message.sender,message.receivedAt].every(value=>typeof value==="string")||![true,false,null].includes(message.unread))throw new Error("邮件元数据无效");}
  return snapshot;
}
