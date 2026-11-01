/** Bound every segment before tokenization; never silently drop long mail text. */
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
