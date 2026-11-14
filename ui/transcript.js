export function reduceTranscript(state, event) {
  const id = event.item_id;
  if (!id) return state;
  if (event.type === 'conversation.item.input_audio_transcription.delta') {
    if (state.final.some(x => x.id === id)) return state;
    return {...state, pending: {...state.pending, [id]: (state.pending[id] || '') + (event.delta || '')}};
  }
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    const pending = {...state.pending}; delete pending[id];
    return {pending, final: [...state.final.filter(x => x.id !== id), {id, text: event.transcript || '', ...(Array.isArray(event.speakers) ? {speakers: event.speakers} : {})}]};
  }
  return state;
}

export function readJournal(text) {
  let state = {final: [], pending: {}};
  let ended = false;
  // A crash or concurrent read can leave the last line incomplete.
  const lines = text.split('\n'); lines.pop();
  for (const line of lines) {
    const event = JSON.parse(line);
    state = reduceTranscript(state, event);
    if (event.type === 'session.ended') ended = true;
  }
  return {...state, ended};
}
const MIN_LABEL_MS = 400;
export function utteranceText(item) {
  // An utterance has no word-to-speaker alignment; show its speakers without guessing text boundaries.
  const totals = new Map();
  for (const x of item.speakers || []) {
    if (typeof x?.speaker === 'string' && /^[A-Z]+$/.test(x.speaker)) totals.set(x.speaker, (totals.get(x.speaker) || 0) + ((x.end_ms - x.start_ms) || 0));
  }
  const longest = Math.max(...totals.values());
  // ponytail: a fixed cutoff also hides a real backchannel of 400 ms or less; the raw intervals stay in item.speakers.
  const speakers = [...totals].filter(([, ms]) => ms > MIN_LABEL_MS || ms === longest).map(([speaker]) => speaker);
  return (speakers.length ? `[${speakers.map(x => `話者${x}`).join('・')}] ` : '') + item.text;
}
export function transcriptText(state, includePending = true) {
  const text = state.final.map(utteranceText).join('\n');
  const pending = Object.values(state.pending).join('\n');
  return text + (includePending && pending ? `\n\n[認識途中・未確定]\n${pending}` : '');
}
