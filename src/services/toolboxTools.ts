export type NativeToolId = "json" | "base64-encode" | "base64-decode" | "timestamp" | "uuid" | "sha256";
export const nativeTools:[NativeToolId,string,string][]=[["json","JSON 格式化","校验并整理JSON"],["base64-encode","Base64 编码","UTF-8文本编码"],["base64-decode","Base64 解码","还原UTF-8文本"],["timestamp","时间戳","Unix与日期转换"],["uuid","UUID","生成随机标识"],["sha256","Hash","计算SHA-256"]];
export const networkTools:[string,string][]=[["dns","DNS解析"],["ping","Ping"],["traceroute","Traceroute"],["port","TCP端口"],["ssl","SSL 证书检测"]];
export async function runNativeTool(id:NativeToolId,input:string):Promise<string> {
  if(new TextEncoder().encode(input).length>65536)throw new Error("输入最多64KB");
  switch(id){
    case "json":return JSON.stringify(JSON.parse(input),null,2);
    case "base64-encode":return btoa(String.fromCharCode(...new TextEncoder().encode(input)));
    case "base64-decode":return new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(atob(input.trim()),char=>char.charCodeAt(0)));
    case "timestamp":{
      const text=input.trim();if(!text)throw new Error("请输入Unix时间戳或日期");
      const date=/^-?\d{10,13}$/.test(text)?new Date(Number(text)*(text.replace("-","").length<=10?1000:1)):new Date(text);
      if(!Number.isFinite(date.getTime()))throw new Error("无法识别日期或时间戳");
      return `UTC: ${date.toISOString()}\n本地: ${date.toLocaleString()}\n秒: ${Math.floor(date.getTime()/1000)}\n毫秒: ${date.getTime()}`;
    }
    case "uuid":return crypto.randomUUID();
    case "sha256":return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(input)))).map(byte=>byte.toString(16).padStart(2,"0")).join("");
  }
}
