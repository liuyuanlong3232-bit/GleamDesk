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
self.onmessage=async(event:MessageEvent<{text:string}>)=>{
 try{
  const chunks=translationChunks(event.data.text);
  self.postMessage({status:'正在加载本机翻译模型…'});
  translator??=await createTranslator('translation','Xenova/opus-mt-en-zh',{device:'wasm',dtype:'q8',local_files_only:true});
  const result:string[]=[];let completed=0;const total=chunks.filter(Boolean).length;
  for(const chunk of chunks){
   if(!chunk){result.push('\n\n');continue;}
   self.postMessage({status:`正在离线翻译 ${++completed}/${total}…`});
   const output=await translator('>>cmn_Hans<< '+chunk,{max_new_tokens:512,num_beams:1} as Parameters<TranslationPipeline>[1]);
   const item=Array.isArray(output)?output[0]:output;
   if(!item||!('translation_text' in item)||typeof item.translation_text!=='string')throw Error('模型没有返回译文');
   result.push(item.translation_text+' ');
  }
  self.postMessage({result:result.join('').trim()});
 }catch(error){self.postMessage({error:`离线翻译失败：${error instanceof Error?error.message:String(error)}`});}
};
