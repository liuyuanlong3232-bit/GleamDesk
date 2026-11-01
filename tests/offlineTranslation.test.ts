import {test} from 'node:test';
import assert from 'node:assert/strict';
import {translationChunks,needsOfflineDescription,readDescriptionCache,writeDescriptionCache} from '../src/services/translationText';
test('translation preserves every word and bounds long paragraphs without truncation',()=>{
 const text=Array.from({length:900},(_,i)=>`word${i}`).join(' ');
 const chunks=translationChunks(text).filter(Boolean);assert.ok(chunks.length>1);assert.ok(chunks.every(chunk=>chunk.length<=400));assert.equal(chunks.join(' '),text);
});
test('translation keeps paragraph boundaries and rejects empty or excessive input',()=>{
 assert.deepEqual(translationChunks('First paragraph.\r\n\r\nSecond paragraph.'),['First paragraph.','','Second paragraph.']);
 assert.throws(()=>translationChunks('  '));assert.throws(()=>translationChunks('x'.repeat(16001)));
 const text='a'.repeat(1000);assert.equal(translationChunks(text).join(''),text);
});
test('daily offline cache is tied to exact source text, bounded and safe for special object keys',()=>{
 const storage={value:'',getItem(){return this.value},setItem(_key:string,value:string){this.value=value}};
 const entries:Record<string,string>=Object.create(null);entries['English source']='英文译文';entries['__proto__']='特殊来源';writeDescriptionCache(entries,storage);
 const read=readDescriptionCache(storage);assert.equal(read['English source'],'英文译文');assert.equal(read['Changed source'],undefined);assert.equal(read['__proto__'],'特殊来源');assert.equal(Object.getPrototypeOf(read),null);
 for(let i=0;i<90;i++)entries[`source ${i}`]=`译文${i}`;writeDescriptionCache(entries,storage);assert.equal(Object.keys(readDescriptionCache(storage)).length,64);
 storage.value='{broken';assert.equal(Object.keys(readDescriptionCache(storage)).length,0);
});
test('daily automatic translation skips Chinese descriptions and missing text',()=>{
 assert.ok(needsOfflineDescription('A desktop productivity app.'));assert.ok(!needsOfflineDescription('支持 GitHub 项目的桌面工具'));assert.ok(!needsOfflineDescription(''));
});
test('unavailable optional public cache cannot stop translation',()=>{
 assert.equal(Object.keys(readDescriptionCache({getItem(){throw Error('storage blocked')}})).length,0);
 assert.doesNotThrow(()=>writeDescriptionCache({'source':'译文'},{setItem(){throw Error('storage full')}}));
});
