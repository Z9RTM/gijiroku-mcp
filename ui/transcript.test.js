import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reduceTranscript as reduce} from './transcript.js';
test('final replaces provisional text and late deltas cannot duplicate it', () => {
 let s = {final: [], pending: {}};
 s = reduce(s, {type:'conversation.item.input_audio_transcription.delta', item_id:'1', delta:'こんにち'});
 s = reduce(s, {type:'conversation.item.input_audio_transcription.completed', item_id:'1', transcript:'こんにちは。'});
 s = reduce(s, {type:'conversation.item.input_audio_transcription.delta', item_id:'1', delta:'は'});
 assert.deepEqual(s, {final:[{id:'1',text:'こんにちは。'}],pending:{}});
});

test('journal restores pending text and ignores an incomplete trailing write', async () => {
 const {readJournal, transcriptText} = await import('./transcript.js');
 const lines = [
  {type:'session.started'},
  {type:'conversation.item.input_audio_transcription.delta',item_id:'1',delta:'途中'},
  {type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'確定'},
  {type:'conversation.item.input_audio_transcription.delta',item_id:'2',delta:'未確定'},
  {type:'session.ended'}
 ].map(x => JSON.stringify(x)).join('\n') + '\n{"type":';
 const state = readJournal(lines);
 assert.equal(state.ended, true);
 assert.deepEqual(state.pending, {'2':'未確定'});
 assert.equal(transcriptText(state), '確定\n\n[認識途中・未確定]\n未確定');
});


test('speaker intervals survive journals, labels appear in text without guessing word boundaries', async () => {
 const {readJournal, transcriptText, utteranceText} = await import('./transcript.js');
 const speakers = [{speaker:'A',start_ms:100,end_ms:400},{speaker:'B',start_ms:300,end_ms:800},{speaker:'A',start_ms:700,end_ms:900}];
 const event = {type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'こんにちは。はい。',speakers};
 const state = readJournal(JSON.stringify(event) + '\n');
 assert.deepEqual(state.final[0].speakers, speakers);
 assert.equal(transcriptText(state), '[話者A・話者B] こんにちは。はい。');
 assert.equal(utteranceText({text:'旧履歴'}), '旧履歴');
 assert.equal(utteranceText({text:'本文',speakers:[null,{}, {speaker:'<script>'}]}), '本文');
});

test('short minority speakers stay in the data but not in the label', async () => {
 const {utteranceText} = await import('./transcript.js');
 const at = (speaker, ms) => ({speaker, start_ms:0, end_ms:ms});
 assert.equal(utteranceText({text:'本文',speakers:[at('A',160),at('B',2800)]}), '[話者B] 本文');
 assert.equal(utteranceText({text:'本文',speakers:[at('A',400),at('B',2800)]}), '[話者B] 本文');
 assert.equal(utteranceText({text:'本文',speakers:[at('A',401),at('B',2800)]}), '[話者A・話者B] 本文');
 assert.equal(utteranceText({text:'本文',speakers:[at('A',200),at('B',2800),at('A',300)]}), '[話者A・話者B] 本文', 'pieces of one speaker add up');
 assert.equal(utteranceText({text:'はい',speakers:[at('A',100),at('B',300)]}), '[話者B] はい', 'a short utterance keeps its longest speaker');
});
