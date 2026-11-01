import {mkdir,readFile,writeFile,copyFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';

const revision='046f55aec303cdee3e0318604406d4df20f1e8ea';
const files=[
 ['config.json',1503],['generation_config.json',293],['tokenizer.json',6380952],
 ['tokenizer_config.json',282],['special_tokens_map.json',74],
 ['onnx/encoder_model_quantized.onnx',52899742,'d3b7912bf6a9bd27e4c074c2df91d4ff3d5b4bc5f7f6c8d7cc9c805c98fbafee'],
 ['onnx/decoder_model_merged_quantized.onnx',60212804,'023be4f841f4c47cd65fffcbaa81c0d99d7f7e0138f7ba0e03fa220a4e688aff'],
];
const check=process.argv.includes('--check');
for(const [name,size,hash] of files){
 const destination=resolve('public/translation-models/Xenova/opus-mt-en-zh',name);
 const valid=async()=>{try{const bytes=await readFile(destination);return bytes.length===size&&(!hash||createHash('sha256').update(bytes).digest('hex')===hash);}catch{return false;}};
 if(await valid())continue;
 if(check)throw Error('离线翻译模型未备齐，请先运行 npm run prepare:translation');
 console.log(`准备翻译模型：${name}`);
 const response=await fetch(`https://huggingface.co/Xenova/opus-mt-en-zh/resolve/${revision}/${name}`,{signal:AbortSignal.timeout(300000)});
 if(!response.ok)throw Error(`模型下载失败：HTTP ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());
 if(bytes.length!==size||(hash&&createHash('sha256').update(bytes).digest('hex')!==hash))throw Error(`模型校验失败：${name}`);
 await mkdir(dirname(destination),{recursive:true});await writeFile(destination+'.tmp',bytes);await rename(destination+'.tmp',destination);
}
for(const name of ['ort-wasm-simd-threaded.jsep.mjs','ort-wasm-simd-threaded.jsep.wasm']){
 const source=resolve('node_modules/onnxruntime-web/dist',name),destination=resolve('public/translation-runtime',name);
 if(check){const [a,b]=await Promise.all([readFile(source),readFile(destination)]);if(!a.equals(b))throw Error('离线翻译运行文件不完整，请重新运行 npm run prepare:translation');}
 else{await mkdir(dirname(destination),{recursive:true});await copyFile(source,destination);}
}
console.log(check?'离线翻译资源校验通过':'离线翻译资源已就绪，运行时无需联网。');
