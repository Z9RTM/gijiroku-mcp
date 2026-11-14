import {App, applyDocumentTheme, applyHostStyleVariables} from '@modelcontextprotocol/ext-apps';
import {reduceTranscript, utteranceText} from './transcript.js';

const $ = id => document.getElementById(id);
const app = new App({name:'gijiroku-mcp', version:'0.6.0'});
let state, connected = false, disposed = false, busy = false, reading = false;
let monitor, heartbeat, actionError = '';
let clockAt = performance.now();
// All chats share one server and the host names no chat, so a panel shows only what it started or was given.
let ownRecording = null, ownOperation = null, shownRecording = null;
const phases = {models_missing:'モデル未準備', downloading_models:'モデル準備中', awaiting_audio_events:'音声イベント待機', transcribing:'文字起こし中', ready:'準備完了', failed:'処理失敗', stopped:'停止済み', timed_out:'処理時間超過', model_status_unknown:'モデル確認エラー'};

function showError(error) {
  actionError = String(error?.message ?? error);
  $('error').textContent = actionError;
  $('error').hidden = !actionError;
}
function unpack(result) {
  if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text ?? '操作に失敗しました');
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
}
async function tool(name, args = {}, signal) {
  return unpack(await app.callServerTool({name, arguments:args}, {signal, timeout:25000}));
}
function controls() {
  const active = state?.operation && state.operation !== 'idle';
  $('start').disabled = !connected || busy || active || state?.models?.ready !== true || (!!$('diarize').value && speakerModel()?.ready !== true);
  $('prepare').disabled = !connected || busy || active;
  $('stop').disabled = !connected || !active;
  $('diarize').disabled = !connected || busy || active;
  $('mic').disabled = !connected || busy || active;
  $('refresh').disabled = !connected || busy;
}
function adopt(next) {
  if (next?.started && next.id) {
    ownOperation = next.id;
    if (next.operation === 'recording') ownRecording = next.id;
  }
  if (next?.viewRecording) ownRecording = next.viewRecording;
}
const elsewhere = () => state?.operation === 'recording' && state.recording !== ownRecording;
const ownResult = () => !!ownOperation && state?.lastOperation?.id === ownOperation;
function clock() {
  if (!state) return;
  const elapsed = (state.elapsedSeconds ?? 0) + Math.floor((performance.now() - clockAt) / 1000);
  $('time').textContent = state.operation === 'recording' && !elsewhere() ? `${elapsed}秒・録音中` : state.operation === 'preparing' ? `準備中 ${elapsed}秒` : ownResult() && state.lastOperation.operation === 'recording' ? `${state.lastOperation.elapsedSeconds}秒・終了` : ownRecording ? '終了' : '録音待機中';
}
function shownPhase() {
  if (elsewhere()) return '別のチャットで録音中';
  if (!['failed','stopped','timed_out'].includes(state.phase) || ownResult()) return phases[state.phase] ?? '状態を確認中';
  return state.models?.ready === true ? phases.ready : state.models?.ready === false ? phases.models_missing : phases.model_status_unknown;
}
function render(next) {
  if (disposed || !next?.operation) return;
  // A stale result can still name this panel's recording (adopt), so repaint even when its state is dropped.
  if (!state || next.revision >= state.revision) { state = next; clockAt = performance.now(); }
  $('phase').textContent = shownPhase();
  $('badge').dataset.active = String(state.operation !== 'idle');
  const percent = state.models?.percent;
  $('model-label').textContent = state.models?.ready ? '音声認識モデルの準備完了' : state.models?.ready === false ? `モデル ${Number(percent ?? 0).toFixed(1)}%` : 'モデルの状態を取得できません';
  $('model-size').textContent = Number.isFinite(state.models?.totalBytes) ? `${(state.models.downloadedBytes / 1048576).toFixed(1)} / ${(state.models.totalBytes / 1048576).toFixed(1)} MB` : '';
  if (Number.isFinite(percent)) $('progress').value = percent;
  else $('progress').removeAttribute('value');
  $('notice').textContent = state.operation === 'preparing' ? 'ダウンロード・検証の完了を待っています。完了後に「録音を開始」を押してください。' : elsewhere() ? '別のチャットで録音中です。終了するまで、ここからは録音を開始できません。' : state.phase === 'awaiting_audio_events' ? '認識エンジンを起動しました。マイクの許可が表示されたら確認して、話してください。' : state.operation === 'recording' ? '文字起こしを自動更新しています。' : '録音やモデル準備は、ボタンを押すと開始します。';
  $('logs').textContent = ownResult() || (state.operation !== 'idle' && !elsewhere()) ? [state.log, state.operationOutput].filter(Boolean).join('\n') : '';
  $('recording-id').textContent = ownRecording ? `録音ID: ${ownRecording}` : '';
  const failure = ownResult() && ['failed','timed_out'].includes(state.lastOperation?.outcome);
  if (!actionError) {
    $('error').textContent = state.models?.error ?? (failure ? '処理を完了できませんでした。詳細ログを確認してください。' : '');
    $('error').hidden = !$('error').textContent;
  }
  if (shownRecording !== ownRecording) { shownRecording = ownRecording; $('final').textContent = ''; $('pending').textContent = ''; }
  controls(); clock(); speakerStatus();
  void readTranscript();
}
async function readTranscript() {
  if (!ownRecording || reading || disposed) return;
  const id = ownRecording;
  reading = true;
  try {
    const data = await tool('read_recording', {id});
    if (disposed || ownRecording !== id || data.id !== id) return;
    let transcript = {final:[], pending:{}};
    const lines = data.events.split('\n'); lines.pop();
    for (const line of lines) {
      try { transcript = reduceTranscript(transcript, JSON.parse(line)); } catch { /* Tail may begin in the middle of an event. */ }
    }
    const panel = $('text');
    const follow = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40;
    $('final').textContent = transcript.final.map(utteranceText).join('\n');
    const pending = Object.values(transcript.pending).join('\n');
    $('pending').textContent = pending ? `認識途中・未確定\n${pending}` : '';
    $('scope').hidden = new TextEncoder().encode(data.events).length < 65536;
    if (follow) panel.scrollTop = panel.scrollHeight;
  } catch (error) { if (!disposed) showError(error); }
  finally { reading = false; }
}
function stopMonitor() { monitor?.abort(); monitor = undefined; }
async function startMonitor() {
  if (monitor || disposed || !connected || document.hidden) return;
  const controller = new AbortController(); monitor = controller;
  try {
    while (!controller.signal.aborted && !disposed) {
      const next = await tool('wait_for_update', {afterRevision:state?.revision ?? 0, timeoutSeconds:1}, controller.signal).catch(error => {
        if (!/afterRevision is newer/.test(error?.message)) throw error;
        // The server restarted and its revisions began again.
        state = undefined; showError('');
        return tool('recording_status', {}, controller.signal);
      });
      render(next);
    }
  } catch (error) {
    if (!controller.signal.aborted && !disposed) {
      showError(`自動更新が止まりました。「更新」で再試行できます。\n${error.message}`);
    }
  } finally { if (monitor === controller) monitor = undefined; }
}
async function action(name) {
  if (busy && name !== 'stop_recording') return;
  busy = true; showError(''); controls();
  try {
    const args = ['start_recording','prepare_models'].includes(name) ? ($('diarize').value ? {diarizer: $('diarize').value} : {diarize: false}) : {};
    if (name === 'start_recording' && $('mic').value) args.microphone = $('mic').value;
    const next = await tool(name, args);
    adopt(next); render(next);
  }
  catch (error) { showError(error); }
  finally { busy = false; controls(); void startMonitor(); }
}
function micOption(value, text) {
  const option = document.createElement('option');
  option.value = value; option.textContent = text;
  return option;
}
async function loadMicrophones() {
  // Only the default stays available when the list fails; recording does not need it.
  const names = await tool('list_microphones').then(data => data.microphones.map(m => m.name), () => []);
  const chosen = $('mic').value;
  const options = [micOption('', '既定のマイク'), ...names.map(name => micOption(name, name))];
  // Keep a chosen device that left, so recording fails visibly rather than moving to another microphone.
  if (chosen && !names.includes(chosen)) options.push(micOption(chosen, `${chosen}（未接続）`));
  $('mic').replaceChildren(...options);
  $('mic').value = chosen;
}
function theme(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
app.ontoolresult = result => {
  try { const next = unpack(result); adopt(next); if (next.operation) render(next); }
  catch (error) { showError(error); }
};
app.onhostcontextchanged = theme;
app.ontoolcancelled = () => { showError('操作がキャンセルされました。「更新」で状態を確認できます。'); };
app.onteardown = async () => { disposed = true; stopMonitor(); clearInterval(heartbeat); return {}; };
$('diarize').onchange = () => { controls(); speakerStatus(); };
function speakerModel() { return state?.models?.[$('diarize').value === 'fastdiar-large' ? 'fastdiar' : 'diarization']; }
function speakerStatus() {
  const model = speakerModel();
  $('speaker-status').textContent = !$('diarize').value ? '' : model?.ready ? '話者モデル準備完了。発話の確定時にラベルが付きます。' : '話者モデルの準備が必要です。「モデルを準備」を押してください。' + (model?.totalBytes ? ` (${(model.downloadedBytes / 1048576).toFixed(1)} / ${(model.totalBytes / 1048576).toFixed(1)} MB)` : '');
}
$('start').onclick = () => action('start_recording');
$('stop').onclick = () => action('stop_recording');
$('prepare').onclick = () => action('prepare_models');
$('refresh').onclick = async () => { stopMonitor(); await Promise.all([action('recording_status'), loadMicrophones()]); };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMonitor();
  else if (connected && !disposed) void action('recording_status');
});
window.addEventListener('pagehide', () => { disposed = true; stopMonitor(); clearInterval(heartbeat); });
(async () => {
  try {
    await app.connect(undefined, {timeout:10000});
    if (disposed) return;
    connected = true; theme(app.getHostContext());
    render(await tool('recording_status'));
    heartbeat = setInterval(clock, 1000);
    void loadMicrophones();
    void startMonitor();
  } catch (error) { $('phase').textContent = '接続できません'; showError(`MCP Apps対応クライアントで開いてください。\n${error.message}`); }
})();
