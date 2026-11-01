import {test} from 'node:test';
import assert from 'node:assert/strict';
import {translationChunks} from '../src/services/translationText';
test('translation preserves every word and bounds long paragraphs without truncation',()=>{
 const text=Array.from({length:900},(_,i)=>`word${i}`).join(' ');
 const chunks=translationChunks(text).filter(Boolean);assert.ok(chunks.length>1);assert.ok(chunks.every(chunk=>chunk.length<=400));assert.equal(chunks.join(' '),text);
});
test('translation keeps paragraph boundaries and rejects empty or excessive input',()=>{
 assert.deepEqual(translationChunks('First paragraph.\r\n\r\nSecond paragraph.'),['First paragraph.','','Second paragraph.']);
 assert.throws(()=>translationChunks('  '));assert.throws(()=>translationChunks('x'.repeat(16001)));
 const text='a'.repeat(1000);assert.equal(translationChunks(text).join(''),text);
});
