/** Bound every segment before tokenization; never silently drop long input text. */
export function translationChunks(text:string):string[]{
 if(!text.trim())throw Error('请先输入英文内容');
 if(text.length>16000)throw Error('每次最多翻译 16000 个字符，请分段翻译');
 const chunks:string[]=[];
 for(const paragraph of text.replace(/\r\n?/g,'\n').split(/\n\s*\n/)){
  let rest=paragraph.trim();
  while(rest.length){
   let end=Math.min(rest.length,400);
   if(end<rest.length){const boundary=rest.slice(0,end).search(/[.!?;]\s+[^.!?;]*$/);const space=rest.lastIndexOf(' ',end);if(boundary>80)end=boundary+1;else if(space>80)end=space;}
   chunks.push(rest.slice(0,end).trim());rest=rest.slice(end).trim();
  }
  if(chunks.length)chunks.push('');
 }
 if(chunks.at(-1)==='')chunks.pop();return chunks;
}

const descriptionCacheKey='gleamdesk.daily-offline-en-zh.opus-046f55a.v1';
export function needsOfflineDescription(text:string){return /[a-zA-Z]{3}/.test(text)&&!/[\u3400-\u9fff]/.test(text);}
export function readDescriptionCache(storage?:Pick<Storage,'getItem'>):Record<string,string>{
 const result:Record<string,string>=Object.create(null);
 try{const entries:unknown=JSON.parse((storage??localStorage).getItem(descriptionCacheKey)??'[]');
  if(Array.isArray(entries))for(const entry of entries.slice(-64)){
   if(Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&entry[0].length<=700&&typeof entry[1]==='string'&&entry[1].length<=6000&&entry[1].trim())result[entry[0]]=entry[1];
  }
 }catch{/* Public translation cache is optional; the original description remains visible. */}
 return result;
}
export function writeDescriptionCache(values:Record<string,string>,storage?:Pick<Storage,'setItem'>){
 try{(storage??localStorage).setItem(descriptionCacheKey,JSON.stringify(Object.entries(values).slice(-64)));}catch{/* Translation still works when local storage is full or disabled. */}
}
