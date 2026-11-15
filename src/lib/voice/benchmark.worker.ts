import { KokoroTTS } from 'kokoro-js';
import { REFINED_PRESET } from './refined';
let model: Awaited<ReturnType<typeof KokoroTTS.from_pretrained>>;
self.onmessage = async ({data}) => {
 if (process.env.NODE_ENV !== 'development') { self.postMessage({error:'Development benchmark only'}); return; }
 const started=performance.now();
 try {
  const cold=!model;
  model ??= await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
   dtype:data.backend==='webgpu'?'fp32':'q8',device:data.backend==='webgpu'?'webgpu':'wasm',
   progress_callback:e=>{if(e.status==='progress') self.postMessage({progress:{file:e.file,percent:e.progress}})}
  });
  const initialized=performance.now();
  const audio=await model.generate(data.text,{voice:REFINED_PRESET.voice,speed:REFINED_PRESET.speed});
  const generated=performance.now();
  const encoded=await audio.toBlob().arrayBuffer();
  self.postMessage({audio:encoded,metrics:{cold,initializationMs:initialized-started,inferenceMs:generated-initialized,audioSeconds:audio.audio.length/audio.sampling_rate,rtf:(generated-initialized)/(audio.audio.length/audio.sampling_rate*1000),serializationMs:performance.now()-generated}},[encoded]);
 }catch(e){self.postMessage({error:e instanceof Error?e.message:String(e),elapsedMs:performance.now()-started})}
};
