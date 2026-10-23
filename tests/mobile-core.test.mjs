import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopSteerParams,asyncQuestions,pendingAsyncQuestions,questionReplyText,questionReplies,desktopSettings} from '../mobile-core.mjs';

test('desktop steering carries the native restore-message context',()=>{
  const state={cwd:'/tmp/mobile-test',latestCollaborationMode:{mode:'default',settings:{model:'test',reasoning_effort:'high'}}};
  const text='test',content={text,input:[{type:'text',text}],attachments:[]};
  const p=desktopSteerParams(state,content,'message-1');
  assert.deepEqual(p.restoreMessage.context.workspaceRoots,[state.cwd]);
  assert.equal(p.restoreMessage.context.collaborationMode,state.latestCollaborationMode);
  assert.equal(p.restoreMessage.context.prompt,text);
  assert.deepEqual(p.restoreMessage.context.commentAttachments,[]);
  assert.equal(p.restoreMessage.id,p.clientUserMessageId);
  assert.equal(p.restoreMessage.cwd,state.cwd);
  assert.equal(p.input,content.input);
  assert.equal(p.attachments,content.attachments);
});

test('question answer round trip settles one card without duplicates',()=>{
  const item={id:'question-message',type:'agentMessage',questions:[{title:'Choose',options:['A','B']}]};
  const turns=[{id:'turn',items:[item,item]}];
  const [card]=asyncQuestions(turns);
  assert.equal(asyncQuestions(turns).length,1);
  const text=questionReplyText(card,{[card.id]:{answers:['A']}});
  assert.equal(questionReplies([{type:'text',text}])[0].questionItemId,card.id);
  turns.push({id:'next',items:[{type:'steeringUserMessage',status:'pending',input:[{type:'text',text}]}]});
  assert.equal(asyncQuestions(turns)[0].submitted,undefined);
  turns[1].items[0].status='accepted';
  assert.equal(asyncQuestions(turns)[0].submitted,true);
  assert.equal(asyncQuestions(turns)[0].answer,'A');
});

test('current turn effort is independent of the next-turn default',()=>{
  const settings=desktopSettings({latestModel:'test',latestReasoningEffort:null,turns:[{status:'inProgress',requestedReasoningEffort:'ultra'}]});
  assert.equal(settings.effort,null);
  assert.equal(settings.activeEffort,'ultra');
});

test('answered latest question does not revive stale historical prompts',()=>{
  const turns=[{id:'old',items:[{type:'agentMessage',id:'old-question',questions:[{title:'Old network question'}]}]},
    {id:'new',items:[{type:'agentMessage',id:'new-question',questions:[{title:'Current question'}]}]}];
  const pending=pendingAsyncQuestions(turns);
  assert.equal(pending.length,1);
  assert.equal(pending[0].sourceItemId,'new-question');
  turns[1].items.push({type:'userMessage',content:[{type:'text',text:questionReplyText(pending[0],{[pending[0].id]:{answers:['done']}})}]});
  assert.deepEqual(pendingAsyncQuestions(turns),[]);
  assert.equal(asyncQuestions(turns).length,2);
});
