// One CDP responsive/a11y workflow, with all APIs mocked before hydration.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const executable = process.env.CHROMIUM_PATH; if (!executable) throw Error('Set CHROMIUM_PATH to an installed Chromium binary.');
const profile = mkdtempSync('/tmp/lain-6d-browser-');
const browser = spawn(executable, ['--headless', '--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--disable-vulkan-surface', '--remote-debugging-port=9246', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws;
try {
  let endpoint; for (let i=0;i<100;i++) { try { endpoint=await(await fetch('http://127.0.0.1:9246/json/version')).json(); break; } catch { await delay(100); } }
  if (!endpoint) throw Error('Chromium unavailable');
  ws=new WebSocket(endpoint.webSocketDebuggerUrl); await new Promise(resolve=>{ws.onopen=resolve;});
  let seq=0;const pending=new Map(),listeners=new Set();
  ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(Error(JSON.stringify(m.error)));else p.resolve(m.result);}else for(const listener of listeners)listener(m);};
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const waitFor=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(100);}throw Error('Condition timed out: '+expression+' '+await evaluate('document.body.innerText.slice(-300)'));};
  const key=async(key,modifiers=0)=>{const windowsVirtualKeyCode={Tab:9,Escape:27,ArrowDown:40,ArrowUp:38}[key]??0;await call('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,modifiers,windowsVirtualKeyCode},sessionId);await call('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,modifiers,windowsVirtualKeyCode},sessionId);};
  const tap=async selector=>{const r=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x,y:r.y}]},sessionId);await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},sessionId);await delay(100);};
  const id='11111111-1111-4111-8111-111111111111',other='11111111-1111-4111-8111-111111111112',uuid=n=>`22222222-2222-4222-8222-${String(n).padStart(12,'0')}`;
  const historyItem=(id,title)=>({id,title,createdAt:'2026-11-15T01:00:00Z',updatedAt:'2026-11-15T01:00:00Z'});
  const errors=[];let apiCalls=0;
  const mock=async m=>{if(m.sessionId!==sessionId)return;if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method!=='Fetch.requestPaused')return;apiCalls++;const {requestId,request}=m.params,u=new URL(request.url),offset=Number(u.searchParams.get('offset')??0);let body;
    if(u.pathname==='/api/session')body={ok:true,session:{id:uuid(90),expiresAt:'2030-01-01T00:00:00Z'}};
    else if(u.pathname==='/api/conversations')body={ok:true,conversations:[historyItem(offset?other:id,offset?'Another saved conversation':'A saved conversation with a deliberately long title')],pagination:{limit:20,offset,nextOffset:offset?null:20}};
    else {const owner=u.pathname.split('/').at(-1);body={ok:true,conversation:historyItem(owner,'Saved fixture'),messages:Array.from({length:6},(_,i)=>({id:uuid(i),conversationId:owner,role:i%2?'assistant':'user',content:i%2?'A readable **response** with a [link](https://example.com).\n\n```javascript\n// A subtle comment\nconst long = "'+ 'x'.repeat(180) +'";\n```\n\n| A long heading | Another long heading | A third long heading |\n| --- | --- | --- |\n| value | value | value |':'A question '+i,status:'completed',createdAt:'2026-11-15T01:00:00Z'})),pagination:{limit:50,offset:0,nextOffset:null}};}
    await call('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(body)).toString('base64')},sessionId);
  };listeners.add(mock);
  await call('Runtime.enable',{},sessionId);await call('Page.enable',{},sessionId);await call('Fetch.enable',{patterns:[{urlPattern:'*/api/*'}]},sessionId);
  await call('Network.enable',{},sessionId);await call('Network.setBlockedURLs',{urls:['*api.openai.com*','*huggingface.co*']},sessionId);
  await call('Page.addScriptToEvaluateOnNewDocument',{source:readFileSync(new URL('./benchmark-client-init.js',import.meta.url),'utf8')},sessionId);
  const viewport=async(width,height)=>{await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:2,mobile:width<900},sessionId);await call('Emulation.setTouchEmulationEnabled',{enabled:width<900},sessionId);await delay(600);};
  const navigate=async(active)=>{await call('Page.navigate',{url:'http://127.0.0.1:3160/'+(active?'?conversation='+id:'')},sessionId);await waitFor(`!!document.querySelector('textarea') && !document.querySelector('textarea').disabled && ${active?"document.querySelectorAll('article[data-message-id]').length===6":"!!document.querySelector('h2')"}`);await delay(600);};
  const measure=()=>evaluate(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};const input=document.querySelector('textarea'),f=input.closest('footer'),v=visualViewport;return {width:innerWidth,height:innerHeight,visualHeight:v.height,scrollWidth:document.documentElement.scrollWidth,composer:rect(f),input:rect(input),headerControls:[...document.querySelectorAll('header button,header summary')].filter(n=>n.getClientRects().length).map(n=>({name:n.getAttribute('aria-label')||n.textContent.trim(),...rect(n)})),log:document.querySelector('[role=log]')?rect(document.querySelector('[role=log]')):null,describedByMissing:input.getAttribute('aria-describedby').split(' ').filter(id=>!document.getElementById(id)),codeScroll:!![...document.querySelectorAll('pre')].find(n=>n.scrollWidth>n.clientWidth),tableScroll:!![...document.querySelectorAll('[aria-label="Response table"]')].find(n=>n.scrollWidth>n.clientWidth)}})()`);
  const phases=[];
  for(const phase of (process.env.REVIEW_ONLY_INTERACTIONS ? [] : process.env.REVIEW_COMPARE ? ['before','after'] : ['after'])) {
    await viewport(390,844);await navigate(false);const welcome=[];
    for(const [w,h] of [[320,740],[375,812],[390,844],[768,1024],[1440,900]]){await viewport(w,h);welcome.push(await measure());}
    await navigate(true);const active=[];
    for(const [w,h] of [[320,740],[375,812],[390,844],[768,1024],[1440,900],[768,375],[844,390]]){await viewport(w,h);active.push(await measure());}
    await viewport(390,844);
    await evaluate(`Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>280});Object.defineProperty(visualViewport,'offsetTop',{configurable:true,get:()=>40});visualViewport.dispatchEvent(new Event('resize'))`);await delay(650);const keyboard=await measure();
    await tap('[aria-label="Open conversation history"]');await delay(300);const drawerKeyboard=await evaluate(`(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,focus:document.activeElement.getAttribute('aria-label')}})()`);await key('Escape');await delay(300);
    await evaluate(`delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'))`);
    await viewport(844,390);await tap('summary[aria-label="Voice controls"]');const voiceLandscape=await evaluate(`(()=>{const n=document.querySelector('[aria-label="Voice settings"]'),r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight}})()`);await key('Escape');
    const result={phase,welcome,active,keyboard,drawerKeyboard,voiceLandscape};phases.push(result);writeFileSync('docs/responsive-6d-results.json',JSON.stringify({browser:await call('Browser.getVersion'),emulated:true,phases},null,2)+'\n');console.log(JSON.stringify(result));
    if(phase==='before'){console.log('Baseline ready; waiting for /tmp/lain-6d-continue');while(!existsSync('/tmp/lain-6d-continue'))await delay(500);}
  }
  // Final focused touch/keyboard/accessibility/PCM/fallback checks.
  if (process.env.REVIEW_ONLY_INTERACTIONS) { await viewport(375,812); await navigate(true); }
  await viewport(375,812);await tap('[aria-label="Open conversation history"]');await waitFor(`document.querySelector('dialog[open]') && !!document.querySelector('[data-conversation-id]')`);
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'Close history');await delay(300);await tap('dialog button[class*="action"]');await waitFor('document.querySelectorAll("[data-conversation-id]").length===2');
  await evaluate(`document.querySelector('[aria-label="Close history"]').focus()`);await key('Tab',8);assert.ok(await evaluate('document.querySelector("dialog").contains(document.activeElement)'));
  await tap('button[aria-haspopup="menu"]');assert.equal(await evaluate('document.activeElement.textContent'),'Rename');await key('Escape');assert.ok(await evaluate('document.activeElement.matches("[aria-haspopup=menu]")'));await key('Escape');await delay(300);assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'Open conversation history');
  await tap('[aria-label="Open conversation history"]');await delay(350);await tap('dialog button[class*="action"]');await waitFor('document.querySelectorAll("[data-conversation-id]").length===2');await tap(`[data-conversation-id="${other}"]`);await delay(500);assert.ok((await evaluate('location.search')).includes(other));
  const canvasStable=await evaluate('bench.savedCanvas=document.querySelector("canvas");true');assert.ok(canvasStable);
  await evaluate(`[...document.querySelectorAll('[aria-label="Read response aloud"]')].at(-1).scrollIntoView({block:'nearest'})`);await tap(`[data-message-id="${uuid(5)}"] [aria-label="Read response aloud"]`);
  await waitFor('bench.activeSources>0');await tap('summary[aria-label="Voice controls"]');await waitFor('document.querySelector("[data-chat-voice-state]").dataset.chatVoiceState==="playing"');
  await evaluate(`[...document.querySelectorAll('button')].find(n=>n.textContent==='Stop voice'&&!n.disabled).click()`);await waitFor('bench.activeSources===0');
  await evaluate(`[...document.querySelectorAll('button')].find(n=>n.textContent==='Disable voice').click()`);await waitFor('bench.contexts===0');await key('Escape');
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);await delay(200);const reduced=await evaluate('bench.sample(400)');assert.equal(reduced.draws,0);assert.ok(await evaluate('bench.savedCanvas===document.querySelector("canvas")'));
  const ax=await call('Accessibility.getFullAXTree',{},sessionId);assert.ok(ax.nodes.some(n=>n.role?.value==='textbox'&&n.name?.value==='Message Lain'));
  await call('Page.addScriptToEvaluateOnNewDocument',{source:`const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type.includes('webgl')?null:original.call(this,type,...args)}`},sessionId);await navigate(false);await waitFor('document.body.innerText.includes("3D unavailable")');
  const report=JSON.parse(readFileSync('docs/responsive-6d-results.json','utf8'));report.workflow={historyPagination:true,focusTrap:true,escapeRestoration:true,menuKeyboard:true,conversationSwitch:true,explicitTouchAudio:true,stop:true,disableClosesContext:true,reducedMotion:true,canvasStable:true,accessibleComposerName:true,webglFallback:true,apiCalls,exceptions:errors};writeFileSync('docs/responsive-6d-results.json',JSON.stringify(report,null,2)+'\n');console.log('Responsive/a11y workflow passed');
}finally{ws?.close();browser.kill('SIGTERM');}
