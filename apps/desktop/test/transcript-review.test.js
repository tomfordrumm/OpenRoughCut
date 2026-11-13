import test from 'node:test';
import assert from 'node:assert/strict';
import {wordDiff,reviewChains} from '../src/transcript-review.js';
test('Repeated words are aligned in order; changed number is visible',()=>{
 assert.deepEqual(wordDiff('Это 10 это 12','Это 10 это 14').filter(x=>x.changed).map(x=>x.text),['12']);
});
test('Shared later take groups a chain without using earlier multi-block bounds',()=>{
 const segments=[{start:0,end:2,text:'Мы сделали...'},{start:3,end:5,text:'Мы сделали 10 вещей'},{start:6,end:9,text:'Мы сделали 12 вещей'}];
 const groups=reviewChains(segments,[{start:0,end:2,removedText:'Мы сделали...',keptText:'Мы сделали 12 вещей'},{start:3,end:5,removedText:'Мы сделали 10 вещей',keptText:'Мы сделали 12 вещей'}]);
 assert.equal(groups.length,1);assert.equal(groups[0].takes.length,3);assert.equal(groups[0].takes.at(-1).start,6);
});
test('A replacement inside a longer untimed block is not editable as that full block',()=>{
 const groups=reviewChains([{start:0,end:2,text:'Начало'},{start:4,end:10,text:'Вот мысль. И важное продолжение.'}],[{start:0,end:2,removedText:'Начало',keptText:'Вот мысль.'}]);
 assert.equal(groups[0].takes.at(-1).start,null);
});
test('a selected earlier take remains the group reference when the final take failed',()=>{
 const segments=[{start:0,end:2,text:'Неудачная'},{start:3,end:6,text:'Удачная'},{start:7,end:8,text:'Сорванная'}];
 const groups=reviewChains(segments,[0,2].map((i)=>({start:segments[i].start,end:segments[i].end,removedText:segments[i].text,keptText:'Удачная',keptRanges:[{start:3,end:6}],groupId:'group',attemptId:String(i),winnerId:'1'})));
 assert.equal(groups.length,1); assert.equal(groups[0].takes.length,3);
 assert.equal(groups[0].takes.find(t=>t.selected).start,3);
});
