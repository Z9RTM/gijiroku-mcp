import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {reduceTranscript, utteranceText} from '../ui/transcript.js';

const source = (await readFile('ui/app.js','utf8')).replace(/import \{App, applyDocumentTheme, applyHostStyleVariables\} from '[^']+';/, 'const {App, applyDocumentTheme, applyHostStyleVariables} = sdk;').replace("import {reduceTranscript, utteranceText} from './transcript.js';",'');
const tick = () => new Promise(resolve=>setImmediate(resolve));
const initial = () => ({operation:'idle', phase:'ready', revision:1, recording:null, models:{ready:true,percent:100,downloadedBytes:200,totalBytes:200}, lastOperation:null});
async function setup(t) {
  const elements = new Map(); const listeners={}; const calls=[]; const waits=[];
  let instance, state=initial(), events='', mics=[{name:'内蔵',default:true},{name:'USB',default:false}];
  const element = id => {
    if(!elements.has(id)) elements.set(id,{textContent:'',hidden:false,disabled:true,value:0,dataset:{},scrollHeight:1000,scrollTop:700,clientHeight:300,replaceChildren(...children){this.children=children},removeAttribute(name){delete this[name];}});
    return elements.get(id);
  };
  const document={createElement:()=>({value:'',textContent:''}),getElementById:element,hidden:false,addEventListener:(name,handler)=>listeners[name]=handler};
  class App {
    constructor(){instance=this}
    async connect(){}
    getHostContext(){return {theme:'light'}}
    async callServerTool({name,arguments:args},{signal}={}) {
      calls.push({name,args});
      if(name==='wait_for_update') return new Promise((resolve,reject)=>{
        const wait={resolve:value=>resolve({structuredContent:value}),reject}; waits.push(wait);
        signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
      });
      if(name==='list_microphones') { if(!mics) throw new Error('no mics'); return {structuredContent:{microphones:mics}}; }
      if(name==='start_recording') state={...state,revision:state.revision+1,operation:'recording',phase:'awaiting_audio_events',recording:'session-1',elapsedSeconds:0,started:true,id:'session-1'};
      if(name==='stop_recording') state={...state,revision:state.revision+1,operation:'idle',phase:'stopped',lastOperation:{id:state.recording,operation:'recording',outcome:'stopped',elapsedSeconds:2}};
      if(name==='prepare_models') state={...state,revision:state.revision+1,operation:'preparing',phase:'downloading_models',started:true,id:'prepare-1'};
      if(name==='read_recording') return {structuredContent:{id:args.id,events}};
      return {structuredContent:state};
    }
  }
  vm.runInNewContext(source,{sdk:{App,applyDocumentTheme(){},applyHostStyleVariables(){}},reduceTranscript,utteranceText,document,window:{addEventListener(){}},performance,AbortController,TextEncoder,setInterval:()=>1,clearInterval(){},console});
  await tick();
  t.after(async()=>{await instance.onteardown();await tick()});
  return {element,calls,waits,instance,document,listeners,setState:value=>state=value,setEvents:value=>events=value,setMics:value=>mics=value};
}

test('opening only checks status; buttons start and stop explicitly', async t=>{
  const c=await setup(t);
  assert.deepEqual(c.calls.map(x=>x.name).sort(),['list_microphones','recording_status','wait_for_update']);
  assert.equal(c.element('start').disabled,false);
  assert.equal(c.element('stop').disabled,true);
  await c.element('start').onclick();
  assert.equal(c.element('start').disabled,true);
  assert.equal(c.element('stop').disabled,false);
  assert.equal(c.element('phase').textContent,'音声イベント待機');
  const longRunning={...initial(),operation:'recording',phase:'transcribing',recording:'session-1',revision:3,elapsedSeconds:125,remainingSeconds:null};
  c.setState(longRunning);c.instance.ontoolresult({structuredContent:longRunning});
  assert.equal(c.element('time').textContent,'125秒・録音中');
  await c.element('stop').onclick();
  assert.equal(c.element('phase').textContent,'停止済み');
  assert.equal(c.element('start').disabled,false);
});

test('live transcript uses text and preserves manual scroll position', async t=>{
  const c=await setup(t);
  c.setEvents([
    {type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'<img src=x onerror=alert(1)>'},
    {type:'conversation.item.input_audio_transcription.delta',item_id:'2',delta:'認識途中'},
  ].map(JSON.stringify).join('\n')+'\n');
  c.element('text').scrollTop=10;
  await c.element('start').onclick();await tick();
  assert.equal(c.element('recording-id').textContent,'録音ID: session-1');
  assert.equal(c.calls.find(call=>call.name==='read_recording').args.id,'session-1');
  assert.equal(c.element('final').textContent,'<img src=x onerror=alert(1)>');
  assert.match(c.element('pending').textContent,/認識途中/);
  assert.equal(c.element('text').scrollTop,10);
  assert.equal(c.element('scope').hidden,true);
});

test('model preparation is separate from recording and progress follows tool notifications', async t=>{
  const c=await setup(t);
  const state={...initial(),revision:2,models:{ready:false,percent:25,downloadedBytes:50,totalBytes:200}};
  c.setState(state);c.instance.ontoolresult({structuredContent:state});
  assert.equal(c.element('start').disabled,true);
  assert.equal(c.element('progress').value,25);
  await c.element('prepare').onclick();
  assert.equal(c.element('phase').textContent,'モデル準備中');
  assert.equal(c.calls.some(c=>c.name==='start_recording'),false);
  c.instance.ontoolresult({structuredContent:{...initial(),revision:4}});
  assert.equal(c.element('start').disabled,false);
  c.instance.ontoolresult({structuredContent:{...state,revision:3}});
  assert.equal(c.element('start').disabled,false,'stale notifications cannot overwrite newer state');
});

test('failed updates show an error, refresh recovers, teardown ends monitoring', async t=>{
  const c=await setup(t);
  c.waits[0].reject(new Error('bridge disconnected'));await tick();
  assert.match(c.element('error').textContent,/更新/);
  await c.element('refresh').onclick();await tick();
  assert.equal(c.element('error').hidden,true);
  assert.ok(c.waits.length>=2);
  const count=c.calls.length;
  await c.instance.onteardown();await tick();
  assert.equal(c.calls.length,count);
});


test('speaker labels wait for the optional model and are rendered after completion', async t => {
 const c = await setup(t);
 c.element('diarize').value = 'nemotron-3-diarization';
 c.element('diarize').onchange();
 assert.equal(c.element('start').disabled, true);
 assert.match(c.element('speaker-status').textContent, /準備が必要/);
 const ready = {...initial(), revision:2, models:{...initial().models,diarization:{ready:true}}};
 c.setState(ready); c.instance.ontoolresult({structuredContent:ready});
 assert.equal(c.element('start').disabled, false);
 c.setEvents(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'発話',speakers:[{speaker:'A',start_ms:0,end_ms:1000}]})+'\n');
 await c.element('start').onclick(); await tick();
 assert.equal(c.calls.find(x=>x.name==='start_recording').args.diarizer, 'nemotron-3-diarization');
 assert.equal(c.element('final').textContent, '[話者A] 発話');
 assert.equal(c.element('diarize').disabled, true);
});

test('FASTDIAR waits for its own model, not Nemotron\'s', async t => {
 const c = await setup(t);
 c.element('diarize').value = 'fastdiar-large';
 c.element('diarize').onchange();
 const nemotron = {...initial(), revision:2, models:{...initial().models,diarization:{ready:true},fastdiar:{ready:false,downloadedBytes:0,totalBytes:1048576}}};
 c.setState(nemotron); c.instance.ontoolresult({structuredContent:nemotron});
 assert.equal(c.element('start').disabled, true);
 assert.match(c.element('speaker-status').textContent, /準備が必要/);
 const ready = {...nemotron, revision:3, models:{...nemotron.models,fastdiar:{ready:true}}};
 c.setState(ready); c.instance.ontoolresult({structuredContent:ready});
 assert.equal(c.element('start').disabled, false);
 await c.element('start').onclick(); await tick();
 assert.equal(c.calls.find(x=>x.name==='start_recording').args.diarizer, 'fastdiar-large');
});

test('choosing no speaker labels turns them off explicitly', async t => {
 const c = await setup(t);
 c.element('diarize').value = '';
 c.element('diarize').onchange();
 assert.equal(c.element('start').disabled, false);
 assert.equal(c.element('speaker-status').textContent, '');
 await c.element('start').onclick(); await tick();
 const args = c.calls.find(x=>x.name==='start_recording').args;
 assert.equal(args.diarize, false);
 assert.equal(args.diarizer, undefined);
});

test('a new panel hides another chat\'s finished recording', async t => {
 const c = await setup(t);
 const other = {...initial(), revision:2, recording:'other', phase:'failed', log:'secret', lastOperation:{id:'other',operation:'recording',outcome:'failed',elapsedSeconds:9}};
 c.setState(other); c.instance.ontoolresult({structuredContent:other}); await tick();
 assert.equal(c.element('recording-id').textContent, '');
 assert.equal(c.element('final').textContent, '');
 assert.equal(c.element('logs').textContent, '');
 assert.equal(c.element('error').hidden, true);
 assert.equal(c.element('time').textContent, '録音待機中');
 assert.equal(c.element('phase').textContent, '準備完了');
 assert.equal(c.calls.some(x=>x.name==='read_recording'), false);
});

test('another chat recording shows only a notice and keeps stop', async t => {
 const c = await setup(t);
 const other = {...initial(), revision:2, operation:'recording', phase:'transcribing', recording:'other', log:'secret', elapsedSeconds:9};
 c.setState(other); c.instance.ontoolresult({structuredContent:other}); await tick();
 assert.match(c.element('notice').textContent, /別のチャットで録音中/);
 assert.equal(c.element('phase').textContent, '別のチャットで録音中');
 assert.equal(c.element('start').disabled, true);
 assert.equal(c.element('stop').disabled, false);
 assert.equal(c.element('logs').textContent, '');
 assert.equal(c.element('time').textContent, '録音待機中');
 assert.equal(c.calls.some(x=>x.name==='read_recording'), false);
});

test('viewRecording opens that recording even when the result arrives stale', async t => {
 const c = await setup(t);
 const newer = {...initial(), revision:5}; c.instance.ontoolresult({structuredContent:newer});
 c.setEvents(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'以前の発話'})+'\n');
 c.instance.ontoolresult({structuredContent:{...initial(), revision:1, viewRecording:'old'}}); await tick();
 assert.equal(c.calls.find(x=>x.name==='read_recording').args.id, 'old');
 assert.equal(c.element('final').textContent, '以前の発話');
 assert.equal(c.element('recording-id').textContent, '録音ID: old');
 assert.equal(c.element('time').textContent, '終了');
});

test('a start_recording result from the host becomes this panel\'s recording', async t => {
 const c = await setup(t);
 const started = {...initial(), revision:2, operation:'recording', phase:'awaiting_audio_events', recording:'r1', started:true, id:'r1', elapsedSeconds:0};
 c.setState(started); c.instance.ontoolresult({structuredContent:started}); await tick();
 assert.equal(c.element('recording-id').textContent, '録音ID: r1');
 assert.equal(c.calls.find(x=>x.name==='read_recording').args.id, 'r1');
 assert.notEqual(c.element('phase').textContent, '別のチャットで録音中');
});

test('this panel\'s model preparation failure is still shown', async t => {
 const c = await setup(t);
 await c.element('prepare').onclick();
 const failed = {...initial(), revision:9, phase:'failed', log:'engine log', lastOperation:{id:'prepare-1',operation:'preparing',outcome:'failed',elapsedSeconds:1}};
 c.setState(failed); c.instance.ontoolresult({structuredContent:failed}); await tick();
 assert.equal(c.element('phase').textContent, '処理失敗');
 assert.match(c.element('error').textContent, /完了できません/);
 assert.equal(c.element('logs').textContent, 'engine log');
});

test('a server restart resets the revision and monitoring recovers', async t => {
 const c = await setup(t);
 await c.element('start').onclick(); await tick();
 const running = {...initial(), revision:50, operation:'recording', phase:'transcribing', recording:'session-1'};
 c.setState(running); c.instance.ontoolresult({structuredContent:running}); await tick();
 c.setState({...initial(), revision:1});
 const count = c.waits.length;
 c.waits.at(-1).reject(new Error('afterRevision is newer than this connection\'s state. Call recording_status for a current revision.'));
 await tick(); await tick(); await tick();
 assert.equal(c.element('error').hidden, true);
 assert.ok(c.waits.length > count);
 assert.equal(c.calls.filter(x=>x.name==='wait_for_update').at(-1).args.afterRevision, 1);
 assert.equal(c.element('start').disabled, false);
 assert.equal(c.element('recording-id').textContent, '録音ID: session-1');
 assert.equal(c.element('time').textContent, '終了');
});

const micNames = c => c.element('mic').children.map(x=>x.textContent);

test('the chosen microphone is sent to start_recording; the default sends nothing', async t => {
 const c = await setup(t); await tick();
 assert.deepEqual(micNames(c),['既定のマイク','内蔵','USB']);
 await c.element('start').onclick(); await tick();
 assert.equal(c.calls.find(x=>x.name==='start_recording').args.microphone, undefined);
 assert.equal(c.element('mic').disabled, true);
 await c.element('stop').onclick(); await tick();
 assert.equal(c.element('mic').disabled, false);
 c.element('mic').value = 'USB';
 await c.element('start').onclick(); await tick();
 assert.equal(c.calls.filter(x=>x.name==='start_recording').at(-1).args.microphone, 'USB');
});

test('model preparation never sends a microphone', async t => {
 const c = await setup(t); await tick();
 c.element('mic').value = 'USB';
 await c.element('prepare').onclick(); await tick();
 assert.equal(c.calls.find(x=>x.name==='prepare_models').args.microphone, undefined);
});

test('refresh reloads microphones and keeps a chosen one that disappeared', async t => {
 const c = await setup(t); await tick();
 c.element('mic').value = 'USB';
 c.setMics([{name:'内蔵',default:true},{name:'新しいマイク',default:false}]);
 await c.element('refresh').onclick(); await tick();
 assert.deepEqual(micNames(c),['既定のマイク','内蔵','新しいマイク','USB（未接続）']);
 assert.equal(c.element('mic').value, 'USB', 'recording must not silently move to another microphone');
});

test('a failed microphone list leaves only the default and shows no error', async t => {
 const c = await setup(t);
 c.setMics(null);
 await c.element('refresh').onclick(); await tick();
 assert.deepEqual(micNames(c),['既定のマイク']);
 assert.equal(c.element('error').hidden, true);
 assert.equal(c.element('start').disabled, false);
});
