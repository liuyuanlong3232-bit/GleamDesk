/// <reference lib="webworker" />
import {env,pipeline, type TranslationPipeline} from '@huggingface/transformers';
import {translationChunks} from './translationText';

env.allowRemoteModels=false;
env.allowLocalModels=true;
env.localModelPath='/translation-models/';
env.useBrowserCache=false;
env.backends.onnx.wasm!.wasmPaths=import.meta.env.DEV?{mjs:'/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',wasm:'/translation-runtime/ort-wasm-simd-threaded.jsep.wasm'}:'/translation-runtime/';
env.backends.onnx.wasm!.numThreads=1;
env.backends.onnx.wasm!.proxy=false;
let translator:TranslationPipeline|undefined;
const createTranslator=pipeline as (task:'translation',model:string,options:{device:'wasm';dtype:'q8';local_files_only:true})=>Promise<TranslationPipeline>;
async function translateText(text:string){
 const chunks=translationChunks(text);const result:string[]=[];
 for(const chunk of chunks){
  if(!chunk){result.push('\n\n');continue;}
  const output=await translator!('>>cmn_Hans<< '+chunk,{max_new_tokens:512,num_beams:1} as Parameters<TranslationPipeline>[1]);
  const item=Array.isArray(output)?output[0]:output;
  if(!item||!('translation_text' in item)||typeof item.translation_text!=='string')throw Error('模型没有返回译文');result.push(item.translation_text+' ');
 }
 return result.join('').trim();
}
self.onmessage=async(event:MessageEvent<{text?:string;texts?:string[]}>)=>{
 try{
  const batch=event.data.texts;const texts=batch??[event.data.text??''];
  if(!texts.length||texts.length>8)throw Error('推荐翻译条目超过上限');texts.forEach(translationChunks);
  self.postMessage({status:'正在加载本机翻译模型…'});
  translator??=await createTranslator('translation','Xenova/opus-mt-en-zh',{device:'wasm',dtype:'q8',local_files_only:true});
  for(let index=0;index<texts.length;index++){
   self.postMessage({status:`正在离线翻译 ${index+1}/${texts.length}…`});
   const result=await translateText(texts[index]);self.postMessage(batch?{item:{index,result}}:{result});
  }
  if(batch)self.postMessage({done:true});
 }catch(error){self.postMessage({error:`离线翻译失败：${error instanceof Error?error.message:String(error)}`});}
};
