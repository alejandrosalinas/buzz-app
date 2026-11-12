// @vitest-environment node
// Real Pi durable, SQLite, built-in tools and faux provider. CI installs exactly
// deps/package-lock.json; no credentials, model service or network is used here.
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it, expect } from "vitest";
import host from "./host.mjs?raw";
const deps = process.env.PI_DEPS;
const driver = String.raw`import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {serve,protectTool,protectModels} from './host.mjs';
const data=process.argv[2], agent='b'.repeat(64), faux=fauxProvider(),models=createModels();models.setProvider(faux.provider);
const result={};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const until=async test=>{const end=Date.now()+5000;while(!await test()){if(Date.now()>end)throw new Error('Missing lifecycle boundary');await new Promise(r=>setTimeout(r,5));}};
const exists=path=>stat(path).then(()=>true,()=>false);
function start(check,protectedAgent=agent) {
 const input=new PassThrough(),output=new PassThrough(),pending=new Map(),checks=new Map(),transfers=new Map(),actions=[],nativeHooks=[];let id=0;
 createInterface({input:output}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.method?.startsWith('buzz/security/evidence/')) {
   const operation=m.method.split('/').at(-1),p=m.params;
   const reply=result=>input.write(JSON.stringify({id:m.id,result})+'\n');
   if(operation==='begin'){const id=p.id;transfers.set(id,{kind:p.kind,session:p.session,parts:[],bytes:0,sequence:0});reply({id,chunkBytes:65536});}
   else if(operation==='chunk'){const transfer=transfers.get(p.id),data=Buffer.from(p.data,'base64');assert.equal(p.sequence,transfer.sequence++);assert.ok(data.length<=65536);transfer.bytes+=data.length;transfer.parts.push(data);reply({accepted:true});}
   else if(operation==='finish') {
    const transfer=transfers.get(p.id);assert.equal(p.sequence,transfer.sequence);assert.equal(p.bytes,transfer.bytes);transfers.delete(p.id);
    const params={agent,action:{kind:transfer.kind,session:transfer.session,content:JSON.parse(Buffer.concat(transfer.parts))}};
    const stop=new AbortController();checks.set(m.id,stop);actions.push(params);
    Promise.resolve().then(()=>check(params,stop.signal)).then(allowed=>reply({allowed:allowed===true}),()=>reply({allowed:false})).finally(()=>checks.delete(m.id));
   } else if(operation==='cancel'){transfers.delete(p.id);reply({allowed:false});}
  } else if(m.method==='hook'){nativeHooks.push(m.params);input.write(JSON.stringify({id:m.id,result:undefined})+'\n');}
  else if(m.method==='security_cancel')checks.get(m.params.id)?.abort();
  else if(m.method==='tool')input.write(JSON.stringify({id:m.id,result:{content:[{type:'text',text:'sent'}]}})+'\n');
  else if(m.id!==undefined){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(new Error(m.error)):p?.resolve(m.result);}
 });
 const rpc=(method,params)=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});input.write(JSON.stringify({id,method,params})+'\n');});
 const server=serve({data,models,dir:data,protectedAgent,input,output,exit:()=>{}});
 return {rpc,actions,stop:async()=>{await server.stop();assert.deepEqual(nativeHooks,[]);}};
}
const turn=(request,text='Do the task',key='chan/root')=>({agent,key,at:100,context:{channel:'chan',root:'root'},text,steer:text,request,provider:'faux',model:'faux-1',instructions:'Test.',cwd:data});
let inspect=async()=>true;
let pi=start((...args)=>inspect(...args));
try {
 await pi.rpc('open',{agent,tools:[]});
 // Exact approval gates a real filesystem side effect.
 const entered=deferred(),allow=deferred(),file=join(data,'reviewed.txt');
 inspect=async({action},signal)=>{if(action.kind==='tool'&&action.content.title==='write'){entered.resolve();await Promise.race([allow.promise,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))]);}return true;};
 faux.setResponses([fauxAssistantMessage(fauxToolCall('write',{path:file,content:'reviewed'}),{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
 let submission=await pi.rpc('deliver',turn('write'));let waiting=pi.rpc('wait',{agent,submission:submission.submission});
 await entered.promise;assert.equal(await exists(file),false);allow.resolve();await waiting;assert.equal(await readFile(file,'utf8'),'reviewed');result.exactWrite=true;
 // A denied write never executes.
 const denied=join(data,'denied.txt');inspect=async({action})=>action.kind!=='tool';
 faux.setResponses([fauxAssistantMessage(fauxToolCall('write',{path:denied,content:'denied'}),{stopReason:'toolUse'}),fauxAssistantMessage('stopped')]);
 submission=await pi.rpc('deliver',turn('deny'));await pi.rpc('wait',{agent,submission:submission.submission});assert.equal(await exists(denied),false);result.deniedWrite=true;
 // Both successful and nonzero shell output survive buffering when allowed.
 const secret=join(data,'source.txt'),marker='RAW_RESULT_ONLY_7301';await writeFile(secret,marker);
 for(const suffix of ['','; exit 3']) {
  inspect=async()=>true;
  faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'cat '+JSON.stringify(secret)+suffix}),{stopReason:'toolUse'}),(context)=>{assert.ok(JSON.stringify(context).includes(marker));return fauxAssistantMessage('received');}]);
  submission=await pi.rpc('deliver',turn('bash'+suffix,'run it','shell/'+suffix));await pi.rpc('wait',{agent,submission:submission.submission});
 }
 result.shellOutput=true;
 // Denied output is absent from the next provider request and durable entries.
 inspect=async({action})=>action.kind!=='tool-result'||!JSON.stringify(action.content).includes(marker);
 faux.setResponses([fauxAssistantMessage(fauxToolCall('read',{path:secret}),{stopReason:'toolUse'}),(context)=>{assert.ok(!JSON.stringify(context).includes(marker));return fauxAssistantMessage('withheld');}]);
 submission=await pi.rpc('deliver',turn('output','read it','output/root'));await pi.rpc('wait',{agent,submission:submission.submission});
 assert.ok(!JSON.stringify(await pi.rpc('entries',{agent,conversation:submission.conversation})).includes(marker));result.withheldOutput=true;
 // Denial occurs before the provider is called.
 inspect=async({action})=>action.kind!=='context';const before=faux.state.callCount;
 submission=await pi.rpc('deliver',turn('context','blocked','context/root'));await pi.rpc('wait',{agent,submission:submission.submission});assert.equal(faux.state.callCount,before);result.deniedContext=true;
 // Cancellation while native Bash has emitted output never commits its partial text.
 const barrier=join(data,'shell-started');inspect=async()=>true;
 faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'cat '+JSON.stringify(secret)+'; touch '+JSON.stringify(barrier)+'; sleep 30'}),{stopReason:'toolUse'})]);
 submission=await pi.rpc('deliver',turn('cancel','run','cancel/root'));waiting=pi.rpc('wait',{agent,submission:submission.submission});
 await until(()=>exists(barrier));await pi.rpc('abort',{agent,conversation:submission.conversation});await waiting;
 assert.ok(!JSON.stringify(await pi.rpc('entries',{agent,conversation:submission.conversation})).includes(marker));result.cancelledPartial=true;
 // Safe tool replay after closing storage is checked again.
 const replayEntered=deferred();inspect=async({action},signal)=>{if(action.kind==='tool'&&action.content.title==='tool_search'){replayEntered.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}return true;};
 faux.setResponses([fauxAssistantMessage(fauxToolCall('tool_search',{query:'read files'}),{stopReason:'toolUse'})]);
 submission=await pi.rpc('deliver',turn('replay','read','replay/root'));waiting=pi.rpc('wait',{agent,submission:submission.submission});await replayEntered.promise;await pi.stop();await waiting;
 let replayChecks=0;inspect=async({action})=>{if(action.kind==='tool'&&action.content.title==='tool_search')replayChecks++;return true;};pi=start((...args)=>inspect(...args));await pi.rpc('open',{agent,tools:[]});
 faux.setResponses([(context)=>{return fauxAssistantMessage('recovered');}]);await pi.rpc('wait',{agent,submission:submission.submission});assert.ok(replayChecks>0);result.safeReplay=true;
 // Old history is checked before any resumed/new provider request.
 inspect=async({action})=>action.kind!=='context';const restored=faux.state.callCount;
 submission=await pi.rpc('deliver',turn('restored','continue','replay/root'));await pi.rpc('wait',{agent,submission:submission.submission});assert.equal(faux.state.callCount,restored);result.restoredHistory=true;
 // Concurrent conversations retain distinct, native-mapped review sessions.
 inspect=async()=>true;
 faux.setResponses([fauxAssistantMessage('first'),fauxAssistantMessage('second')]);
 const pair=await Promise.all([pi.rpc('deliver',turn('parallel1','one','parallel/one')),pi.rpc('deliver',turn('parallel2','two','parallel/two'))]);
 await Promise.all(pair.map(item=>pi.rpc('wait',{agent,submission:item.submission})));
 assert.notEqual(pair[0].conversation,pair[1].conversation);
 for(const item of pair)assert.ok(pi.actions.some(row=>row.action.kind==='context'&&row.action.session===String(item.conversation)));
 result.concurrentSessions=true;
 // Compaction's provider call is also held, including recovery after a close.
 faux.setResponses([fauxAssistantMessage('read it'),fauxAssistantMessage('read it too')]);
 for(const id of ['long1','long2']) {const item=await pi.rpc('deliver',turn(id,'word '.repeat(25000),'compact/root'));await pi.rpc('wait',{agent,submission:item.submission});}
 const compactEntered=deferred();inspect=async({action},signal)=>{if(action.kind==='context'){compactEntered.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}return true;};
 const beforeCompact=faux.state.callCount;
 const compact=pi.rpc('session',{agent,key:'compact/root',action:'compact'}).catch(error=>error.message);
 await compactEntered.promise;assert.equal(faux.state.callCount,beforeCompact);await pi.stop();await compact;
 let compactChecks=0;inspect=async({action})=>{if(action.kind==='context')compactChecks++;return true;};
 pi=start((...args)=>inspect(...args));await pi.rpc('open',{agent,tools:[]});faux.setResponses([fauxAssistantMessage('safe summary')]);
 await pi.rpc('session',{agent,key:'compact/root',action:'compact'});assert.ok(compactChecks>0);assert.ok(faux.state.callCount>beforeCompact);result.compactionRecovery=true;
 assert.ok(pi.actions.every(row=>row.agent===agent&&/^\d+$/.test(row.action.session)));
 await assert.rejects(pi.rpc('test',{provider:'faux',model:'faux-1'}),/outside the protected/);result.closedSetupBypass=true;
} finally {await pi.stop();}
// Protected workers accept their exact secondary membership, with the same
// identity's home and other community memberships still rejected.
const secondary=agent+'@secondary.example%3A7447';
const secondaryHost=start(()=>true,secondary);
try {
 await secondaryHost.rpc('open',{agent:secondary,tools:[]});
 for(const other of [agent,agent+'@another.example'])await assert.rejects(secondaryHost.rpc('open',{agent:other,tools:[]}),/belongs to another agent/);
 result.secondaryMembership=true;
} finally {await secondaryHost.stop();}
// A one-shot reviewer has no opened agent and separates trusted instructions
// from adversarial evidence without offering tools.
const reviewer=start(()=>true,null);
try {
 faux.setResponses([(context)=>{
  assert.equal(context.messages[0].role,'system');
  assert.equal(context.messages[0].content,'TRUSTED_REVIEW_INSTRUCTIONS');
  assert.equal(context.messages[1].role,'user');
  assert.equal(context.messages[1].content,'UNTRUSTED_ACTION_EVIDENCE');
  assert.ok(context.messages.every(message=>!message.toolsAdded?.length));
  return fauxAssistantMessage('{"blocked":true,"reason":"Review this action"}');
 }]);
 const reviewed=await reviewer.rpc('review',{id:'isolated-review',provider:'faux',model:'faux-1',prompt:{system:'TRUSTED_REVIEW_INSTRUCTIONS',input:'UNTRUSTED_ACTION_EVIDENCE'}});
 assert.equal(JSON.parse(reviewed.text).blocked,true);
 assert.equal(reviewer.actions.length,0);
 result.toolFreeReview=true;
 // A schema reaches the model in the trusted instructions, never the evidence.
 const outputSchema={type:'object',properties:{blocked:{type:'boolean'}},required:['blocked']};
 faux.setResponses([(context)=>{
  assert.ok(context.messages[0].content.startsWith('TRUSTED_REVIEW_INSTRUCTIONS'));
  assert.ok(context.messages[0].content.includes(JSON.stringify(outputSchema)));
  assert.equal(context.messages[1].content,'UNTRUSTED_ACTION_EVIDENCE');
  return fauxAssistantMessage('{"blocked":false}');
 }]);
 await reviewer.rpc('review',{id:'schema-review',provider:'faux',model:'faux-1',prompt:{system:'TRUSTED_REVIEW_INSTRUCTIONS',input:'UNTRUSTED_ACTION_EVIDENCE',outputSchema}});
 result.reviewSchema=true;
} finally {await reviewer.stop();}
// Wrappers also handle errors and exact snapshots independently.
const emitted=[];let seen;
const api={conversationId:1,output:value=>emitted.push(value),diagnostic:value=>emitted.push(value),details:async value=>emitted.push(value)};
const wrapped=protectTool({name:'throw',execute:async(_args,api)=>{api.output('partial');api.diagnostic({message:'diagnostic'});await api.details({secret:'details'});throw new Error('private error');}},async action=>{seen=action;if(action.kind==='tool-result')throw new Error('denied');});
await assert.rejects(wrapped.execute({},api,{abortSignal:new AbortController().signal}),/denied/);assert.deepEqual(emitted,[]);assert.ok(JSON.stringify(seen).includes('private error'));result.thrownError=true;
const gate=deferred(),entered=deferred();let captured;
const sources=[];const checked=protectModels(models,async action=>{sources.push(action.content);entered.resolve();await gate.promise;},async id=>{if(id!=='known')throw new Error('unknown session');return 1;});
const input={messages:[{role:'system',content:'dynamic instructions',sections:{memory:'untrusted memory text'},toolsAdded:[{name:'schema_fixture',description:'tool metadata '.repeat(25000),parameters:{type:'object',properties:{}}}],timestamp:0},{role:'user',content:'reviewed',timestamp:1}]};const model=structuredClone(faux.getModel());
faux.setResponses([(context,_opts,_state,actual)=>{captured={context,actual};return fauxAssistantMessage('ok');}]);
const reply=checked.completeSimple(model,input,{sessionId:'known'});await entered.promise;input.messages[1].content='mutated';model.id='mutated';gate.resolve();await reply;
assert.equal(captured.context.messages[1].content,'reviewed');assert.ok(JSON.stringify(sources).includes('untrusted memory text'));assert.ok(!JSON.stringify(sources).includes('tool metadata '));assert.ok(sources.every(source=>Buffer.byteLength(JSON.stringify(source))<65536));assert.notEqual(captured.actual.id,'mutated');result.exactModel=true;
const count=faux.state.callCount;await checked.completeSimple(faux.getModel(),input,{sessionId:'unknown'});assert.equal(faux.state.callCount,count);result.unknownSession=true;
for(const method of ['streamDeferred','fetchDeferred','cancelDeferred'])assert.throws(()=>checked[method](faux.getModel(),{}),/does not support deferred/);
const passed=protectModels({streamSimple:(_model,_input,options)=>options},async()=>{},()=>1);const body={};assert.equal(await passed.streamSimple(faux.getModel(),input,{onPayload:payload=>payload}).onPayload(body),undefined);await assert.rejects(passed.streamSimple(faux.getModel(),input,{onPayload:()=>({})}).onPayload(body),/payload override/);result.closedOverrides=true;
console.log(JSON.stringify(result));
`;
it.skipIf(!deps)(
  "enforces protected Pi against real side effects, provider calls and durable recovery",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "buzz-pi-protection-"));
    try {
      await symlink(
        join(deps ?? "", "node_modules"),
        join(folder, "node_modules"),
      );
      await writeFile(join(folder, "host.mjs"), host);
      await writeFile(join(folder, "driver.mjs"), driver);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--disable-sigusr1",
          "--disable-warning=ExperimentalWarning",
          join(folder, "driver.mjs"),
          folder,
        ],
        { cwd: folder, timeout: 30000 },
      );
      const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
      expect(result).toEqual(
        Object.fromEntries(
          [
            "exactWrite",
            "deniedWrite",
            "shellOutput",
            "withheldOutput",
            "deniedContext",
            "cancelledPartial",
            "safeReplay",
            "restoredHistory",
            "closedSetupBypass",
            "thrownError",
            "exactModel",
            "unknownSession",
            "closedOverrides",
            "concurrentSessions",
            "compactionRecovery",
            "toolFreeReview",
            "reviewSchema",
            "secondaryMembership",
          ].map((name) => [name, true]),
        ),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
  35000,
);
