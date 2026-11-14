import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, appendFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {once} from 'node:events';
import {reduceTranscript, utteranceText} from '../ui/transcript.js';

const binary = resolve('target/debug/gijiroku-mcp');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function client(t, sharedDir) {
  const dir = sharedDir ?? await mkdtemp(join(tmpdir(), 'gijiroku-mcp-test-'));
  const speech = join(dir, 'speech');
  const modelState = join(dir, 'models.json');
  const setModels = state => writeFile(modelState, JSON.stringify(state));
  await setModels({ready:true,bytes:100});
  const catalogPrefix = `import fs from 'node:fs';
const statePath = ${JSON.stringify(modelState)};
if(process.argv[2]==='mics') { console.log(JSON.stringify({microphones:[{name:'内蔵',default:true},{name:'\u200eUSB Mic',default:false}]})); process.exit(0); }
if(process.argv[2]==='models') {
 const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
 console.log(JSON.stringify({models:['haas-ja-v1.0','silero-vad',...(state.diarization ? ['nemotron-3-diarization'] : []),...(state.fastdiar ? ['fastdiar-large'] : [])].map(name=>({name,type:'test',files:[{type:'test',size:100,fetched:state.ready,partial:state.bytes}]}))}));
 process.exit(0);
}
`;
  const setEngine = body => writeFile(speech, `#!${process.execPath}\n${catalogPrefix}${body}\n`, {mode:0o755});
  await setEngine(`if(process.argv[2]==='pull'){console.log('prepared');process.exit(0)}
console.log(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'日本語テスト',pid:process.pid})); console.error('fake microphone active'); setInterval(()=>{},1000);`);
  const child = spawn(binary, [speech, join(dir, 'data'), join(dir, 'models')], {stdio:['pipe','pipe','pipe']});
  let stderr = ''; child.stderr.on('data', b => stderr += b);
  const pending = new Map(); let id = 0;
  createInterface({input:child.stdout}).on('line', line => {
    const response = JSON.parse(line);
    const resolve = pending.get(response.id); pending.delete(response.id); resolve?.(response);
  });
  const exited = once(child, 'exit');
  t.after(async () => { child.stdin.end(); if(child.exitCode===null && child.signalCode===null) await exited; if(!sharedDir) await rm(dir,{recursive:true,force:true}); assert.equal(stderr,''); });
  const rpc = (method,params={}) => { const next = ++id; return new Promise(resolve => { pending.set(next,resolve); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n'); }); };
  const call = async(name, args={}) => (await rpc('tools/call',{name,arguments:args})).result;
  const value = result => JSON.parse(result.content[0].text);
  async function recorded() {
    for(let i=0;i<100;i++) { const r = await call('read_recording'); if(!r.isError && value(r).events.includes('日本語テスト')) return value(r); await delay(20); }
    throw Error('fake speech did not produce output');
  }
  return {child,rpc,call,value,recorded,exited,speech,setModels,setEngine,dir};
}

test('MCP negotiation, tools, validation and recording lifecycle', {timeout:10000}, async t => {
  const c = await client(t);
  assert.equal((await c.rpc('initialize',{protocolVersion:'2025-06-18'})).result.protocolVersion,'2025-06-18');
  assert.equal((await c.rpc('tools/list')).result.tools.length,10);
  assert.equal(c.value(await c.call('recording_status')).operation,'idle');
  assert.equal((await c.call('read_recording')).isError,true);
  assert.equal((await c.call('start_recording',{path:'arbitrary'})).isError,true);
  const started=c.value(await c.call('start_recording'));
  assert.equal(started.autoStopSeconds,null);
  assert.equal(started.remainingSeconds,null);
  const recorded = await c.recorded();
  assert.equal((await c.call('start_recording')).isError,true);
  assert.equal(c.value(await c.call('stop_recording')).operation,'idle');
  const pid = JSON.parse(recorded.events.trim()).pid;
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal(c.value(await c.call('stop_recording')).operation,'idle');
  assert.equal((await c.rpc('unknown')).error.code,-32601);
  assert.equal((await c.call('unknown')).isError,true);
});

for(const shutdown of ['eof','SIGTERM']) {
  test(`recording child is reaped on ${shutdown}`, {timeout:10000}, async t => {
    const c = await client(t); await c.call('start_recording');
    const pid = JSON.parse((await c.recorded()).events.trim()).pid;
    if(shutdown==='eof') c.child.stdin.end(); else c.child.kill(shutdown);
    await c.exited;
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  });
}

test('model preparation completes', {timeout:10000}, async t => {
  const c = await client(t);
  assert.equal(c.value(await c.call('prepare_models')).operation,'preparing');
  for(let i=0;i<100;i++) {
    const state = c.value(await c.call('recording_status'));
    if(state.operation==='idle') { assert.match(state.lastExit,/0/); return; }
    await delay(20);
  }
  assert.fail('preparation never completed');
});

test('recording IDs expose live files across independent MCP processes and survive reconnects', {timeout:10000}, async t => {
  const writer = await client(t);
  assert.deepEqual(writer.value(await writer.call('list_recordings')).recordings,[]);
  await writer.call('prepare_models');
  for(let i=0;i<100;i++) {
    if(writer.value(await writer.call('recording_status')).operation==='idle') break;
    await delay(20);
  }
  assert.deepEqual(writer.value(await writer.call('list_recordings')).recordings,[], 'model downloads are not recordings');
  const first = writer.value(await writer.call('start_recording'));
  await writer.recorded();
  const reader = await client(t, writer.dir);
  assert.equal(reader.value(await reader.call('recording_status')).recording,null);
  assert.equal((await reader.call('read_recording')).isError,true);
  let list = reader.value(await reader.call('list_recordings')).recordings;
  assert.equal(list.length,1);
  assert.equal(list[0].id,first.id);
  assert.equal(list[0].startedAtMs,Number(first.id.split('-')[0]));
  assert.ok(list[0].bytes > 0);
  const live = reader.value(await reader.call('read_recording',{id:first.id}));
  assert.match(live.events,/日本語テスト/);
  assert.equal(live.running,null, 'a reader does not guess another process lifecycle');
  assert.equal(live.truncated,false);
  await appendFile(live.path,JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'2',transcript:'追加の文章'})+'\n');
  assert.match(reader.value(await reader.call('read_recording',{id:first.id})).events,/追加の文章/);
  await writer.call('stop_recording');
  const second = writer.value(await writer.call('start_recording'));
  await writer.recorded();
  await writer.call('stop_recording');
  list = reader.value(await reader.call('list_recordings')).recordings;
  assert.deepEqual(list.map(r=>r.id),[second.id,first.id]);
  assert.equal(reader.value(await reader.call('read_recording',{id:first.id})).id,first.id);
  assert.equal(reader.value(await reader.call('read_recording',{id:second.id})).id,second.id);
  writer.child.stdin.end();
  await writer.exited;
  assert.match(reader.value(await reader.call('read_recording',{id:first.id})).events,/日本語テスト/);
  assert.equal(reader.value(await reader.call('recording_status')).recording,null, 'reading never stores a selection');
  for(const args of [{id:'../speech'}, {id:''}, {id:123}, {id:null}, {id:first.id,extra:true}, {id:'1-1'}]) {
    assert.equal((await reader.call('read_recording',args)).isError,true);
  }
  await writeFile(join(writer.dir,'data','recordings',`${second.id}.jsonl`),'x'.repeat(70000));
  const tail = reader.value(await reader.call('read_recording',{id:second.id}));
  assert.equal(tail.truncated,true);
  assert.equal(tail.bytes,70000);
  assert.equal(tail.events.length,65536);
});


test('missing engine is a tool error and leaves server idle', {timeout:10000}, async t => {
  const c = await client(t);
  await rm(c.speech);
  assert.equal((await c.call('start_recording')).isError,true);
  assert.equal(c.value(await c.call('recording_status')).operation,'idle');
});

test('engine failure is visible in status and does not leave a running job', {timeout:10000}, async t => {
  const c = await client(t);
  await c.setEngine("console.error('microphone permission denied');process.exit(1);");
  await c.call('start_recording');
  for(let i=0;i<100;i++) {
    const state = c.value(await c.call('recording_status'));
    if(state.operation==='idle') {
      assert.match(state.lastExit,/1/);
      assert.match(state.log,/microphone permission denied/);
      return;
    }
    await delay(20);
  }
  assert.fail('failed engine still reported running');
});


test('download progress, stdout and completion can be followed without another user message', {timeout:10000}, async t => {
  const c = await client(t);
  await c.setModels({ready:false,bytes:0});
  await c.setEngine(`if(process.argv[2]==='pull'){
 console.log('model download started');console.error('downloading');
 setTimeout(()=>fs.writeFileSync(statePath,JSON.stringify({ready:false,bytes:40})),300);
 setTimeout(()=>{fs.writeFileSync(statePath,JSON.stringify({ready:true,bytes:100}));console.log('download complete');process.exit(0)},2200);
}`);
  const missing = c.value(await c.call('recording_status'));
  assert.equal(missing.phase,'models_missing');
  assert.equal((await c.call('start_recording')).isError,true);
  let state = c.value(await c.call('prepare_models'));
  assert.equal(state.operation,'preparing');
  let sawProgress = false, sawStdout = false;
  for(let i=0;i<15;i++) {
    const response = await c.call('wait_for_update',{afterRevision:state.revision,timeoutSeconds:2});
    assert.notEqual(response.isError,true,response.content[0].text);
    state = c.value(response);
    assert.deepEqual(response.structuredContent,state);
    if(state.models.percent===40) sawProgress=true;
    if(state.operationOutput.includes('model download started')) sawStdout=true;
    if(state.operation==='idle') break;
  }
  assert.equal(sawProgress,true);
  assert.equal(sawStdout,true);
  assert.equal(state.operation,'idle');
  assert.equal(state.lastOperation.outcome,'completed');
  assert.equal(state.models.ready,true);
  assert.equal(state.models.percent,100);
});

test('wait timeout does not imply completion and stop/ping remain responsive', {timeout:10000}, async t => {
  const c = await client(t); await c.call('start_recording'); await c.recorded();
  let state = c.value(await c.call('recording_status'));
  assert.equal(state.phase,'transcribing');
  assert.equal(state.transcript.latestFinalText,'日本語テスト');
  const timeout = c.value(await c.call('wait_for_update',{afterRevision:state.revision,timeoutSeconds:1}));
  assert.equal(timeout.changed,false);
  assert.equal(timeout.timedOut,true);
  assert.equal(timeout.operation,'recording');
  const waiting = c.call('wait_for_update',{afterRevision:timeout.revision,timeoutSeconds:20});
  assert.deepEqual((await c.rpc('ping')).result,{});
  assert.equal(c.value(await c.call('stop_recording')).lastOperation.outcome,'stopped');
  state=c.value(await waiting);
  assert.equal(state.changed,true);
  assert.equal(state.timedOut,false);
  assert.equal(state.lastOperation.outcome,'stopped');
  assert.equal(state.operation,'idle');
});

test('live partial and final transcripts wake wait_for_update', {timeout:10000}, async t => {
  const c = await client(t);
  await c.setEngine(`
 setTimeout(()=>console.log(JSON.stringify({type:'conversation.item.input_audio_transcription.delta',item_id:'1',delta:'途中'})),300);
 setTimeout(()=>console.log(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'確定した文章'})),800);
 setInterval(()=>{},1000);
 `);
  let state = c.value(await c.call('start_recording'));
  assert.equal(state.phase,'awaiting_audio_events');
  let sawPartial=false;
  for(let i=0;i<10;i++) {
    state=c.value(await c.call('wait_for_update',{afterRevision:state.revision,timeoutSeconds:2}));
    if(state.transcript.provisionalText==='途中') sawPartial=true;
    if(state.transcript.latestFinalText==='確定した文章') break;
  }
  assert.equal(sawPartial,true);
  assert.equal(state.transcript.latestFinalText,'確定した文章');
  assert.equal(state.transcript.provisionalText,'');
});

test('invalid wait arguments are rejected', {timeout:10000}, async t => {
  const c = await client(t);
  for(const args of [{},{afterRevision:-1},{afterRevision:0,timeoutSeconds:21},{afterRevision:0,timeoutSeconds:0.5},{afterRevision:0,extra:true},{afterRevision:999999}]) {
    assert.equal((await c.call('wait_for_update',args)).isError,true);
  }
});


test('MCP Apps negotiation, UI linkage and embedded resource; opening never records', {timeout:10000}, async t => {
  const c = await client(t);
  await c.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});
  const tools=(await c.rpc('tools/list')).result.tools;
  const uri=tools.find(t=>t.name==='open_gijiroku')._meta.ui.resourceUri;
  for(const name of ['start_recording','prepare_models']) assert.equal(tools.find(t=>t.name===name)._meta.ui.resourceUri,uri);
  assert.equal(tools.find(t=>t.name==='recording_status')._meta.ui.resourceUri,undefined);
  assert.ok(tools.every(t=>t._meta.ui.visibility.includes('app')));
  const resource=(await c.rpc('resources/read',{uri})).result.contents[0];
  assert.equal(resource.mimeType,'text/html;profile=mcp-app');
  assert.match(resource.text,/gijiroku-mcp/);
  assert.doesNotMatch(resource.text,/APP_SCRIPT/);
  assert.deepEqual(resource._meta.ui.csp.connectDomains,[]);
  assert.equal((await c.rpc('resources/list')).result.resources[0].uri,uri);
  assert.equal((await c.rpc('resources/read',{uri:'file:///private/data'})).error.code,-32002);
  const opened=c.value(await c.call('open_gijiroku'));
  assert.equal(opened.operation,'idle');
  assert.equal(opened.recording,null);
});

test('clients without UI support keep usable text tools without UI metadata', {timeout:10000}, async t => {
  const c = await client(t);
  await c.rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{}});
  assert.ok((await c.rpc('tools/list')).result.tools.every(t=>!t._meta));
  assert.deepEqual((await c.rpc('resources/list')).result.resources,[]);
  assert.equal(c.value(await c.call('open_gijiroku')).operation,'idle');
});


test('optional diarization validates input, checks model readiness and forwards CLI flags', {timeout:10000}, async t => {
 const c = await client(t);
 assert.equal((await c.call('start_recording', {diarize:'true'})).isError, true);
 assert.equal((await c.call('start_recording', {diarize:true})).isError, true);
 await c.setModels({ready:true, bytes:100, diarization:true});
 await c.setEngine(`if(process.argv[2]==='pull'){console.log(JSON.stringify(process.argv.slice(2)));process.exit(0)}
if(!process.argv.includes('--diarize') || !process.argv.includes('nemotron-3-diarization')) process.exit(2);
console.log(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'日本語テスト',speakers:[{speaker:'A',start_ms:0,end_ms:1000}]}));setInterval(()=>{},1000);`);
 assert.equal(c.value(await c.call('start_recording', {diarize:true})).operation, 'recording');
 assert.match((await c.recorded()).events, /speakers/);
 const status = c.value(await c.call('recording_status'));
 assert.equal(status.transcript.latestFinalSpeakers[0].speaker, 'A');
 await c.call('stop_recording');
 await c.call('prepare_models', {diarize:true});
 let state;
 for(let i=0;i<40;i++) { state=c.value(await c.call('recording_status')); if(state.operation==='idle') break; await delay(30); }
 assert.match(state.operationOutput, /nemotron-3-diarization/);
});

test('FASTDIAR is chosen by name, checked against its own readiness and forwarded to the CLI', {timeout:10000}, async t => {
 const c = await client(t);
 assert.equal((await c.call('start_recording', {diarizer:'unknown'})).isError, true);
 await c.setModels({ready:true, bytes:100, diarization:true});
 assert.equal((await c.call('start_recording', {diarizer:'fastdiar-large'})).isError, true);
 await c.setModels({ready:true, bytes:100, fastdiar:true});
 await c.setEngine(`if(process.argv[2]==='pull'){console.log(JSON.stringify(process.argv.slice(2)));process.exit(0)}
if(process.argv[process.argv.indexOf('--diarize')+1]!=='fastdiar-large') process.exit(2);
console.log(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'日本語テスト',speakers:[{speaker:'K',start_ms:0,end_ms:1000}]}));setInterval(()=>{},1000);`);
 const started = c.value(await c.call('start_recording', {diarizer:'fastdiar-large'}));
 assert.equal(started.operation, 'recording');
 assert.equal(started.models.fastdiar.ready, true);
 assert.match((await c.recorded()).events, /"K"/);
 await c.call('stop_recording');
 await c.call('prepare_models', {diarizer:'fastdiar-large'});
 let state;
 for(let i=0;i<40;i++) { state=c.value(await c.call('recording_status')); if(state.operation==='idle') break; await delay(30); }
 assert.match(state.operationOutput, /fastdiar-large/);
});

test('read_transcript returns every utterance of a long recording as plain text', {timeout:10000}, async t => {
 const c = await client(t);
 const started = i => ({type:'input_audio_buffer.speech_started',audio_start_ms:i*1000,item_id:`i${i}`});
 const done = (i,text,speakers) => ({type:'conversation.item.input_audio_transcription.completed',item_id:`i${i}`,transcript:text,...(speakers?{speakers}:{})});
 const noise = {type:'conversation.item.input_audio_transcription.delta',item_id:'x',delta:'途中'.repeat(40)};
 const events = [];
 for(let i=0;i<1000;i++) events.push(started(i), noise, done(i,`発話${i}`,[{speaker:'A',start_ms:0,end_ms:100},{speaker:'B',start_ms:100,end_ms:1000}]));
 events.push(started(3700), done(3700,'話者なし'));
 events.push(done(3701,'開始なし'));
 events.push(done(5,'置き換え',[{speaker:'A',start_ms:0,end_ms:500},{speaker:'B',start_ms:500,end_ms:1000}]));
 const body = events.map(JSON.stringify).join('\n')+'\n';
 await mkdir(join(c.dir,'data','recordings'),{recursive:true});
 const cut = Buffer.from(JSON.stringify(done(9999,'途中で切れた行'))).subarray(0,-12);
 await writeFile(join(c.dir,'data','recordings','1-1.jsonl'),Buffer.concat([Buffer.from(body),cut]));
 assert.ok(body.length > 65536);

 const result = await c.call('read_transcript',{id:'1-1'});
 assert.equal(result.isError,undefined);
 const [head,...lines] = result.content[0].text.split('\n');
 let state = {final:[],pending:{}};
 for(const e of events) state = reduceTranscript(state,e);
 assert.equal(head,`録音 1-1 / 確定発話 ${state.final.length}件 / 状態不明`);
 assert.deepEqual(lines.map(x=>x.slice(11)),state.final.map(utteranceText));
 assert.equal(lines[0],'[00:00:00] [話者B] 発話0');
 assert.equal(lines.at(-3),'[01:01:40] 話者なし');
 assert.equal(lines.at(-2),'[--:--:--] 開始なし');
 assert.equal(lines.at(-1),'[00:00:05] [話者A・話者B] 置き換え');
 assert.deepEqual(result.structuredContent,{id:'1-1',running:null,utterances:state.final.length});

 assert.equal((await c.call('read_transcript')).isError,true);
 assert.equal((await c.call('read_transcript',{id:'../x'})).isError,true);
 assert.equal((await c.call('read_transcript',{id:'2-2'})).isError,true);
 assert.equal((await c.call('read_transcript',{id:'1-1',extra:1})).isError,true);
});

test('read_transcript marks a recording in progress and then finished', {timeout:10000}, async t => {
 const c = await client(t);
 const {id} = c.value(await c.call('start_recording'));
 await c.recorded();
 assert.match((await c.call('read_transcript',{id})).content[0].text,new RegExp(`^録音 ${id} / 確定発話 1件 / 録音中\\n\\[--:--:--\\] 日本語テスト$`));
 assert.equal((await c.call('read_transcript',{id})).structuredContent.running,true);
 assert.match(c.value(await c.call('stop_recording')).nextAction,/read_transcript/);
 assert.match((await c.call('read_transcript',{id})).content[0].text,/\/ 終了\n/);
});

test('open_gijiroku with an id returns viewRecording', {timeout:10000}, async t => {
 const c = await client(t);
 await mkdir(join(c.dir,'data','recordings'),{recursive:true});
 await writeFile(join(c.dir,'data','recordings','1-1.jsonl'),'');
 assert.equal(c.value(await c.call('open_gijiroku',{id:'1-1'})).viewRecording,'1-1');
 assert.equal('viewRecording' in c.value(await c.call('open_gijiroku')),false);
 assert.equal((await c.call('open_gijiroku',{id:'2-2'})).isError,true);
 assert.equal((await c.call('open_gijiroku',{id:'../x'})).isError,true);
 assert.equal((await c.call('open_gijiroku',{other:1})).isError,true);
});

test('list_microphones returns the engine list', {timeout:10000}, async t => {
 const c = await client(t);
 assert.deepEqual(c.value(await c.call('list_microphones')).microphones,[{name:'内蔵',default:true},{name:'‎USB Mic',default:false}]);
 assert.equal((await c.call('list_microphones',{x:1})).isError,true);
 await c.setEngine(`console.error('no audio');process.exit(1)`);
});

test('a chosen microphone reaches the engine and bad names are refused', {timeout:10000}, async t => {
 const c = await client(t);
 for(const bad of ['','-x','a\nb',1]) assert.equal((await c.call('start_recording',{microphone:bad})).isError,true,String(bad));
 assert.equal((await c.call('prepare_models',{microphone:'USB'})).isError,true);
 await c.setEngine(`console.log(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'日本語テスト',argv:process.argv.slice(2)})); setInterval(()=>{},1000);`);
 await c.call('start_recording',{microphone:'‎USB Mic',diarize:false});
 let argv = JSON.parse((await c.recorded()).events.trim()).argv;
 assert.deepEqual(argv.slice(argv.indexOf('--mic')),['--mic','‎USB Mic']);
 await c.call('stop_recording');
 await c.call('start_recording');
 for(let i=0;i<100;i++){ const e=c.value(await c.call('read_recording')).events; if(e.includes('argv')){ argv=JSON.parse(e.trim()).argv; break } await delay(20); }
 assert.equal(argv.includes('--mic'),false);
});

test('a microphone that vanished fails visibly and leaves the server idle', {timeout:10000}, async t => {
 const c = await client(t);
 await c.setEngine(`console.error('no microphone is named USB');process.exit(1)`);
 await c.call('start_recording',{microphone:'USB'});
 let state;
 for(let i=0;i<100;i++){ state=c.value(await c.call('recording_status')); if(state.operation==='idle') break; await delay(20); }
 assert.equal(state.lastOperation.outcome,'failed');
 assert.match(state.log,/no microphone is named USB/);
});
