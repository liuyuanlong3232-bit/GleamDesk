export type RoomMode="group"|"free"|"quick"|"round"|"creative";
export const roomMembers=["DeepSeek","GPT","Gemini","Claude","Qwen","Kimi","Grok","豆包","MiMo","Ollama"] as const;
export type RoomMember=typeof roomMembers[number];
export interface ChatRoom{id:string;name:string;members:RoomMember[];mode:RoomMode}
export type QuotaSource="cash"|"gift"|"local";
export interface PriceConfirmation{model:string;inputYuan:number;outputYuan:number;version:string}
export interface PricePreset{inputYuan:number;outputYuan:number;source:string;checkedAt:string;version:string}
export interface RoomLimits{calls:number;budgetYuan:number}
export interface ModelConfig{provider:RoomMember;model:string;inputYuan:number|null;outputYuan:number|null;vision:boolean;quotaSource?:QuotaSource;pricing?:"official"|"manual";priceConfirmation?:PriceConfirmation|null}
export interface ModelStatus extends ModelConfig{connected:boolean;credentialSource:string|null}
export interface ChatAttachment{id:string;name:string;mime:string;size:number;text:string|null;data:string|null}
export interface WorkspaceMessage{id:string;scope:string;role:"user"|"assistant";speaker:string;text:string;createdAt:string;status:string;attachments:ChatAttachment[];error:string|null;replyTo:string|null}
export interface WorkspaceSnapshot{rooms:ChatRoom[];messages:WorkspaceMessage[];models:ModelStatus[];paused:boolean;paidEnabled:boolean;usage:{day:string;calls:number;estimatedYuan:number};limits:RoomLimits;hasOlder:boolean}
export interface WorkspaceSend{id:string;scope:string;text:string;provider:RoomMember|null;attachments:ChatAttachment[];mode?:RoomMode}
export function officialPrice(provider:RoomMember,model:string):PricePreset|null{const base={checkedAt:"2026-10-14",version:"2026-10-14"};if(provider==="DeepSeek"&&model==="deepseek-flash")return {...base,inputYuan:2,outputYuan:8,source:"https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"};if(provider==="MiMo"&&model==="mimo-v2.6-flash")return {...base,inputYuan:1,outputYuan:2,source:"https://mimo.mi.com/docs/price"};return null}
export function priceConfirmation(config:ModelConfig):PriceConfirmation|null{if(config.provider==="Ollama")return null;const preset=config.pricing!=="manual"?officialPrice(config.provider,config.model):null;const input=preset?.inputYuan??config.inputYuan,output=preset?.outputYuan??config.outputYuan;if((config.pricing!=="manual"&&!preset)||input===null||output===null||!Number.isFinite(input)||!Number.isFinite(output)||input<=0||output<=0)return null;return {model:config.model,inputYuan:input,outputYuan:output,version:preset?.version??"manual"}}
export function isPriceConfirmed(config:ModelConfig){if(config.provider==="Ollama")return true;const expected=priceConfirmation(config),saved=config.priceConfirmation;return !!expected&&!!saved&&expected.model===saved.model&&expected.inputYuan===saved.inputYuan&&expected.outputYuan===saved.outputYuan&&expected.version===saved.version}
export function validateLimits(limits:RoomLimits){if(!Number.isInteger(limits.calls)||limits.calls<1||limits.calls>10000||!Number.isFinite(limits.budgetYuan)||limits.budgetYuan<0.01||limits.budgetYuan>10000)throw Error("每日次数需为1～10000的整数，预算需为¥0.01～¥10000");return limits}
export const discussionModes=[{id:"group",name:"群聊",detail:"像同事聊天，简短补充，不重复；没有补充可以沉默"},{id:"free",name:"自由聊天",detail:"自然交流，各自回答你的消息"},{id:"round",name:"圆桌讨论",detail:"结合房间记录补充、反驳或修正观点"},{id:"creative",name:"创意碰撞",detail:"提出不同方向和新点子"},{id:"quick",name:"快速意见",detail:"给简短判断和理由"}] as const;
export function isSilentReply(message:WorkspaceMessage){return message.role==="assistant"&&message.status==="saved"&&!message.error&&message.text.trim()==="（沉默）"}
/** Presentation only: follow an admitted human turn; AI mentions never route calls. */
export function replyingMember(snapshot:WorkspaceSnapshot):RoomMember|null{
 if(snapshot.paused)return null;
 const human=[...snapshot.messages].reverse().find(message=>message.role==="user");
 if(!human||human.status!=="sending"||human.error)return null;
 const room=snapshot.rooms.find(value=>value.id===human.scope);
 const named=memberMentions(human.text);
 const targets=room?(named.length?named:room.members):roomMembers.filter(id=>human.scope===`direct-${id}`);
 const answered=new Set(snapshot.messages.filter(message=>message.role==="assistant"&&message.replyTo===human.id).map(message=>message.speaker));
 return targets.find(id=>(!room||room.members.includes(id))&&snapshot.models.some(model=>model.provider===id&&model.connected)&&!answered.has(id))??null;
}
export function memberMentions(text:string):RoomMember[]{return [...new Set([...text.matchAll(/(?:^|\s)@(DeepSeek|GPT|Gemini|Claude|Qwen|Kimi|Grok|豆包|MiMo|Ollama)(?=\s|$)/gi)].map(match=>roomMembers.find(id=>id.toLowerCase()===match[1].toLowerCase())!))]}
export function memberMention(text:string):RoomMember|null{const mentions=memberMentions(text);if(mentions.length>1)throw Error("当前是独立对话；请只指定当前模型，或进入房间让多位成员回复");return mentions[0]??null}
export function validateRoom(room:ChatRoom){if(!/^room-[a-zA-Z0-9-]{1,70}$/.test(room.id)||!room.name.trim()||room.name.length>40||!room.members.length||room.members.some(id=>!roomMembers.includes(id))||!discussionModes.some(mode=>mode.id===room.mode))throw Error("房间名称或成员无效");return {...room,name:room.name.trim(),members:[...new Set(room.members)]}}
export function validateSend(request:WorkspaceSend){if(!request.text.trim()&&!request.attachments.length)throw Error("请写消息或添加附件");if(request.text.length>2000)throw Error("消息最多2000字");if(request.attachments.length>5)throw Error("每条消息最多5个附件");if(request.mode&&!discussionModes.some(mode=>mode.id===request.mode))throw Error("讨论模式无效");if(!request.scope.startsWith("room-"))memberMention(request.text);return request}
