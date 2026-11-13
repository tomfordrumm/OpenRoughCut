import test from 'node:test';import assert from 'node:assert/strict';import {buildReviewedPlan} from '../src/edit-cleanup.js';
const frameRate={numerator:30,denominator:1};
const options={frameRate,keepPause:.18,transcript:{segments:[{start:1,end:2,text:'удаляем'},{start:3,end:3.15,text:'Да'}]}};
test('Deleted speech does not leave silence handles as tiny exported clips',()=>{const p=buildReviewedPlan([{startFrame:0,endFrame:27},{startFrame:63,endFrame:87}], [{action:'remove',start:1,end:2}],120,options);assert.deepEqual(p.cleanedHandles,[{startFrame:27,endFrame:30},{startFrame:60,endFrame:63}]);assert(p.keeps.some(r=>r.startFrame===87));});
test('Explicit manual keep protects a short pause handle',()=>{const p=buildReviewedPlan([{startFrame:0,endFrame:27},{startFrame:63,endFrame:87}], [{action:'remove',start:1,end:2},{action:'keep',start:.9,end:1}],120,options);assert(!p.cleanedHandles.some(r=>r.startFrame===27));});
test('Untimed speech and partial cuts are not discarded for being short',()=>{const p=buildReviewedPlan([{startFrame:0,endFrame:27},{startFrame:63,endFrame:87}], [{action:'remove',start:1.1,end:2}],120,options);assert.equal(p.cleanedHandles.length,0);});
test('Pause between two removed takes disappears while a short retained word stays',()=>{const p=buildReviewedPlan([], [{action:'remove',start:0,end:2},{action:'remove',start:2.7,end:4}],180,{frameRate,transcript:{segments:[{start:0,end:2,text:'первый'},{start:2.7,end:4,text:'второй'},{start:4,end:4.2,text:'Да'}]}});assert.deepEqual(p.cleanedHandles,[{startFrame:60,endFrame:81}]);assert.equal(p.keeps[0].startFrame,120);});
test('A long empty gap between deleted takes disappears, but an intervening retained word protects it',()=>{
 const cuts=[{action:'remove',start:0,end:2},{action:'remove',start:7,end:9}];
 const transcript={segments:[{start:0,end:2,text:'первый'},{start:7,end:9,text:'второй'},{start:10,end:12,text:'финал'}]};
 const textCandidates=[{groupId:'new-policy'}];
 assert(!buildReviewedPlan([],cuts,360,{frameRate,transcript}).cleanedHandles.some(r=>r.startFrame===60&&r.endFrame===210));
 assert(buildReviewedPlan([],cuts,360,{frameRate,transcript,textCandidates}).cleanedHandles.some(r=>r.startFrame===60&&r.endFrame===210));
 transcript.segments.splice(1,0,{start:4,end:4.2,text:'Нет'});
 assert(!buildReviewedPlan([],cuts,360,{frameRate,transcript,textCandidates}).cleanedHandles.some(r=>r.startFrame===60&&r.endFrame===210));
});
test('short original pauses do not concatenate into a long empty pause after a take is deleted',()=>{
 const transcript={segments:[{start:0,end:.5,text:'До'},{start:1,end:2,text:'Дубль'},{start:2.5,end:3,text:'После'}]};
 const textCandidates=[{start:1,end:2,applied:true,groupId:'new-policy'}];
 const plan=buildReviewedPlan([{startFrame:30,endFrame:60}],[],90,{frameRate,transcript,textCandidates,keepPause:.2,measuredSilences:[{start:.5,end:1},{start:2,end:2.5}]});
 assert.deepEqual(plan.removals,[{startFrame:18,endFrame:72}]);
 assert.equal(plan.trimmedPauseEdges.length,1);
});
test('pause trimming protects measured words and explicit manual keeps',()=>{
 const transcript={segments:[{start:.4,end:.9,text:'Нет'},{start:1,end:2,text:'Дубль'},{start:2.2,end:2.8,text:'Да'}]};
 const textCandidates=[{start:1,end:2,applied:true,groupId:'new-policy'}];
 const plan=buildReviewedPlan([{startFrame:30,endFrame:60}],[{action:'keep',start:2.05,end:2.15}],90,{frameRate,transcript,textCandidates,keepPause:.2,measuredSilences:[{start:.5,end:1},{start:2,end:2.5}]});
 assert(plan.keeps.some(r=>r.startFrame<=27&&r.endFrame>=27));
 assert(plan.keeps.some(r=>r.startFrame<=62&&r.endFrame>=64));
 assert(!plan.removals.some(r=>r.startFrame<66&&r.endFrame>66));
});
test('partial removals do not strand an empty clip inside a block while a sub-frame word remains',()=>{
 const transcript={segments:[{start:0,end:3,text:'Раз Два Нет',words:[{startChar:0,endChar:3,start:.1,end:.8},{startChar:4,endChar:7,start:1.3,end:1.8},{startChar:8,endChar:11,start:2.001,end:2.015}]}]};
 const automatic=[{startFrame:0,endFrame:30},{startFrame:36,endFrame:60}];
 const textCandidates=[{start:0,end:1,applied:true,groupId:'g'},{start:1.2,end:2,applied:true,groupId:'g'}];
 const plan=buildReviewedPlan(automatic,[],90,{frameRate,transcript,textCandidates});
 assert.deepEqual(plan.keeps,[{startFrame:60,endFrame:90}]);
 const kept=buildReviewedPlan(automatic,[{action:'keep',start:1,end:1.2}],90,{frameRate,transcript,textCandidates});
 assert(kept.keeps.some(r=>r.startFrame===30&&r.endFrame===36));
});
test('word timestamps belonging to a removed take do not protect its leftover pause handles',()=>{
 const transcript={segments:[{start:1,end:2,text:'Дубль',wordTimingBounds:{start:.8,end:2.2},words:[{startChar:0,endChar:5,start:.95,end:2.05}]},{start:3,end:4,text:'Нет',words:[{startChar:0,endChar:3,start:3.1,end:3.4}]}]};
 const textCandidates=[{start:1,end:2,applied:true,groupId:'g'}];
 const plan=buildReviewedPlan([{startFrame:0,endFrame:27},{startFrame:30,endFrame:60},{startFrame:63,endFrame:87}],[],120,{frameRate,transcript,textCandidates});
 assert.deepEqual(plan.keeps,[{startFrame:87,endFrame:120}]);
});
test('a microscopic spike does not split a long quiet pause below the configured threshold',()=>{
 const plan=buildReviewedPlan([],[],90,{frameRate,reviewPolicy:'last-usable-take-v1',minimumSilence:.7,keepPause:.2,measuredSilences:[{start:1,end:1.6},{start:1.60002,end:2.15}]});
 assert.equal(plan.quietBridges,1);assert.deepEqual(plan.removals,[{startFrame:33,endFrame:62}]);
});
test('quiet refinement protects a real word shorter than one frame and respects manual keeps',()=>{
 const options={frameRate,reviewPolicy:'last-usable-take-v1',minimumSilence:.7,keepPause:.2,transcript:{segments:[{start:1.4,end:1.8,text:'Нет',words:[{startChar:0,endChar:3,start:1.601,end:1.615}]}]},measuredSilences:[{start:1,end:1.6},{start:1.62,end:2.15}]};
 assert.deepEqual(buildReviewedPlan([],[],90,options).removals,[]);
 const kept=buildReviewedPlan([], [{action:'keep',start:1.4,end:1.8}],90,{...options,transcript:null,measuredSilences:[{start:1,end:1.6},{start:1.60002,end:2.15}]});
 assert(!kept.removals.some(r=>r.startFrame<54&&r.endFrame>42));
});
