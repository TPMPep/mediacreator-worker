import type { Job } from 'bullmq';
import type { SpeakerDiarizationJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat } from '../base44-client.js';
import { env } from '../env.js';
import { alignTranscript, assertAlignmentQuality } from '../alignment-client.js';
import { auditTimelineIntegrity, clampAcousticOnsets, restoreDivergedCaptures } from '../timeline-integrity.js';

const API = 'https://api.pyannote.ai/v1';
const COLORS = ['blue','purple','green','amber','red','pink','cyan','orange'];
type Turn = { speaker:string; start:number; end:number; confidence?:Record<string,number> };
type Word = { text?:string; start_ms:number; end_ms:number; confidence?:number; cluster?:string|null };
type Segment = { id:string; sequence_index:number; start_ms:number; end_ms:number; source_text:string; speaker_label?:string; source_text_status?:string; confidence?:number; avg_word_confidence?:number; aai_word_timings?:Word[]; provider_name?:string; version_number?:number; consensus_run_id?:string; consensus_word_sources?:Array<{start_ms?:number;end_ms?:number;[key:string]:unknown}>; is_music?:boolean; music_source?:string; music_context?:string };

const label = (cluster:string,index:number) => { const m=cluster.match(/(\d+)$/); return `Speaker ${m?Number(m[1])+1:index+1}`; };
const tc = (ms:number,fps=25) => { const s=Math.floor(ms/1000), f=Math.floor((ms%1000)/(1000/fps)); return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')};${String(f).padStart(2,'0')}`; };
const join = (words:Word[]) => words.map(w=>String(w.text||'').trim()).filter(Boolean).join(' ').replace(/\s+([,.;:!?])/g,'$1').replace(/\s+/g,' ').trim();
function best(turns:Turn[],startMs:number,endMs:number,c:{i:number}) { const s=startMs/1000,e=endMs/1000; while(c.i<turns.length&&turns[c.i].end<s)c.i++; let found:Turn|null=null, overlap=0; for(let i=Math.max(0,c.i-2);i<turns.length&&turns[i].start<=e;i++){const n=Math.max(0,Math.min(e,turns[i].end)-Math.max(s,turns[i].start));if(n>overlap){overlap=n;found=turns[i];}} return found; }
function confidence(turn:Turn){const n=turn.confidence?.[turn.speaker];return typeof n==='number'?Math.max(0,Math.min(1,n>1?n/100:n)):null;}
async function timedFetch(url:string,init:RequestInit,signal:AbortSignal,timeoutMs=60000){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs),abort=()=>ctrl.abort();signal.addEventListener('abort',abort,{once:true});try{return await fetch(url,{...init,signal:ctrl.signal});}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}}
async function provider(url:string,init:RequestInit,signal:AbortSignal):Promise<Record<string,any>>{const r=await timedFetch(url,init,signal,60000);const b:any=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`pyannote HTTP ${r.status}: ${b.message||b.error||'request failed'}`);return b;}
async function sleep(ms:number,signal:AbortSignal){await new Promise<void>((resolve,reject)=>{const t=setTimeout(resolve,ms);signal.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('worker lock lost'));},{once:true});});}

export async function processSpeakerDiarization(job:Job<SpeakerDiarizationJobData>){
  const started=Date.now();
  const {project_id,run_id,job_run_id,request_id,user_email,auth_token}=job.data;
  // Generalised invoker. `call` (below) remains the speakerDiarizationWorkerStep
  // operation dispatcher; `post` lets this processor also reach a SEPARATE Base44
  // function \u2014 persistTimelineIntegrityReport \u2014 with the identical bounded
  // transient-retry budget, instead of duplicating the retry loop.
  const post=async <T=any>(fn:string,payload:Record<string,unknown>,signal?:AbortSignal,label?:string):Promise<T>=>{
    const what=label||fn;
    const maxAttempts=6;
    for(let attempt=1;attempt<=maxAttempts;attempt++){
      try{return await invokeBase44Function<T>({fn,authToken:auth_token,payload,timeoutMs:170000,signal});}
      catch(error){
        const message=String((error as Error)?.message||error);
        const transient=/rate limit|HTTP 429|HTTP 50[234]|timeout|timed out|ECONNRESET|fetch failed|network/i.test(message);
        if(!transient||attempt===maxAttempts||signal?.aborted)throw error;
        const ceiling=Math.min(20_000,1_000*(2**(attempt-1)));
        const delay=Math.max(500,Math.floor(Math.random()*ceiling));
        console.warn(`[speaker-diarization] ${what} transient failure; retry ${attempt}/${maxAttempts} in ${delay}ms: ${message.slice(0,200)}`);
        if(signal)await sleep(delay,signal);else await new Promise(resolve=>setTimeout(resolve,delay));
      }
    }
    throw new Error(`${what} retry budget exhausted`);
  };
  const call=<T=any>(operation:string,payload:Record<string,unknown>={},signal?:AbortSignal):Promise<T>=>
    post<T>('speakerDiarizationWorkerStep',{project_id,run_id,job_run_id,operation,...payload},signal,operation);
  try{return await runWithLockHeartbeat(job,async signal=>{
    if(!env.PYANNOTE_API_KEY)throw new Error('PYANNOTE_API_KEY is not configured in Railway');
    const prep=await call<any>('prepare',{},signal); if(prep.action==='done')return {ok:true,already_terminal:true};
    const auth={Authorization:`Bearer ${env.PYANNOTE_API_KEY}`}; let providerId=prep.run.provider_job_id||'';
    if(!providerId){const expected=Number(prep.run.expected_speakers);const submitted=await provider(`${API}/diarize`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({url:prep.source_url,model:'precision-2',turnLevelConfidence:true,confidence:true,exclusive:false,transcription:false,...(Number.isInteger(expected)&&expected>0?{numSpeakers:expected}:{minSpeakers:1,maxSpeakers:32})})},signal);providerId=String(submitted.jobId||'');if(!providerId)throw new Error('pyannote returned no jobId');await call('mark_polling',{provider_job_id:providerId},signal);}
    let result:any=null,polls=0; while(Date.now()-started<40*60*1000){result=await provider(`${API}/jobs/${providerId}`,{headers:auth},signal);if(result.status==='succeeded')break;if(!['pending','created','running'].includes(result.status))throw new Error(`pyannote job ${result.status||'failed'}: ${result.output?.error||'provider failure'}`);polls++;await call('heartbeat',{progress_pct:Math.min(75,15+polls*3)},signal);await sleep(5000,signal);} if(result?.status!=='succeeded')throw new Error('speaker diarization exceeded 40 minutes');
    const turns:Turn[]=(result.output?.diarization||[]).filter((t:Turn)=>t?.speaker&&Number.isFinite(t.start)&&Number.isFinite(t.end)).sort((a:Turn,b:Turn)=>a.start-b.start);if(!turns.length)throw new Error('pyannote returned no usable turns');await call('mark_reconciling',{},signal);
    const upload=await timedFetch(prep.raw_result_upload_url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)},signal,120000);if(!upload.ok)throw new Error(`raw result archive failed: HTTP ${upload.status}`);
    const source:Segment[]=[];let pageCursor:number|null=-1;while(pageCursor!==null){const page:{rows:Segment[];next_cursor:number|null}=await call<{rows:Segment[];next_cursor:number|null}>('read_segments',{cursor:pageCursor,limit:500},signal);source.push(...page.rows);pageCursor=page.next_cursor;}if(!source.length)throw new Error('No active transcript segments found');
    const alignmentInput=source.flatMap(segment=>{const words=segment.aai_word_timings||[];if(!words.length&& !segment.is_music)throw new Error(`Missing provider word timings for segment ${segment.id}`);return words.map((word,index)=>({key:`${segment.id}:${index}`,text:String(word.text||'').trim(),provider_start_ms:Number(word.start_ms),provider_end_ms:Number(word.end_ms)})).filter(word=>word.text);});
    if(!alignmentInput.length)throw new Error('No provider words available for forced alignment');
    const alignment=await alignTranscript({requestId:`${request_id}:${run_id}`,audioUrl:prep.source_url,languageCode:String(prep.project.source_language||'en'),words:alignmentInput,signal});
    assertAlignmentQuality('Speaker refinement',alignment);
    const alignmentArchive=await timedFetch(prep.alignment_result_upload_url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(alignment)},signal,120000);if(!alignmentArchive.ok)throw new Error(`alignment result archive failed: HTTP ${alignmentArchive.status}`);
    // Both RAW responses are archived above, untouched. Only the CONSUMED timeline
    // is repaired, in two ordered stages.
    // STAGE 0 first: a word whose aligned window diverges beyond the trust
    // threshold has its provider-measured window restored, because that rejected
    // value would otherwise still decide the word's line break AND its speaker.
    // This runs BEFORE the onset clamp deliberately — a restored word carries the
    // provider's own short duration, so it can no longer look like an absorbed
    // onset, and the clamp is left to handle only genuine absorption.
    const providerByKey=new Map(alignmentInput.map(word=>[word.key,{start_ms:word.provider_start_ms,end_ms:word.provider_end_ms}]));
    const captureRestore=restoreDivergedCaptures(alignment.words,providerByKey);
    if(captureRestore.report.capture_restored_words||captureRestore.report.unrestorable_words)await logEvent({function_name:'bullmq:speaker-diarization',level:'warn',event:'diverged_capture_restored',message:`Restored the provider-measured window for ${captureRestore.report.capture_restored_words} word(s) whose alignment diverged beyond the trust threshold (worst ${captureRestore.report.worst_restored_divergence_ms}ms); ${captureRestore.report.unrestorable_words} could not be restored without breaking chronological order and remain flagged.`,context:{project_id,run_id,job_run_id,request_id,...captureRestore.report}});
    // STAGE 1: pull absorbed onsets forward to a plausible word start so one
    // un-transcribed audio gap can no longer define a segment window.
    const onsetRepair=clampAcousticOnsets(captureRestore.words);
    if(onsetRepair.report.onset_absorption_repairs)await logEvent({function_name:'bullmq:speaker-diarization',level:'warn',event:'acoustic_onset_absorption_repaired',message:`Reconstructed ${onsetRepair.report.onset_absorption_repairs} absorbed word onset(s); worst absorbed ${onsetRepair.report.worst_onset_absorbed_ms}ms of un-transcribed audio. Affected rows are flagged for disclosure.`,context:{project_id,run_id,job_run_id,request_id,...onsetRepair.report}});
    const alignedByKey=new Map(onsetRepair.words.map(word=>[word.key,word]));
    const clusters=[...new Set(turns.map(t=>t.speaker))];const plans=clusters.map((cluster,index)=>{const ts=turns.filter(t=>t.speaker===cluster),cs=ts.map(confidence).filter((n):n is number=>n!==null);return {cluster,label:label(cluster,index),color:COLORS[index%COLORS.length],confidence:cs.length?cs.reduce((a,b)=>a+b,0)/cs.length:null,turn_count:ts.length};});
    const staged=await call<any>('stage_speakers',{speakers:plans},signal);const speakers=Object.fromEntries(staged.speakers.map((s:any)=>[s.diarization_cluster_id,s]));
    const output:any[]=[],counts:Record<string,number>={};let splits=0,unresolved=0,reassigned=0;const cursor={i:0};
    for(const segment of source){const providerWords=segment.aai_word_timings||[];if(!providerWords.length&&segment.is_music){const t=best(turns,Number(segment.start_ms),Number(segment.end_ms),cursor),cluster=t?.speaker||clusters[0],sp=speakers[cluster];counts[cluster]=(counts[cluster]||0)+1;output.push({sequence_index:output.length,start_ms:segment.start_ms,end_ms:segment.end_ms,tc_in:tc(segment.start_ms,prep.project.frame_rate||25),tc_out:tc(segment.end_ms,prep.project.frame_rate||25),speaker_id:sp.id,speaker_label:sp.label,speaker_color:sp.color,source_text:segment.source_text,source_text_status:segment.source_text_status||'machine',confidence:segment.confidence,avg_word_confidence:segment.avg_word_confidence,aai_word_timings:[],provider_name:segment.provider_name,version_number:segment.version_number||1,_alignment:{status:'not_applicable',model:alignment.model,model_revision:alignment.model_revision,language_code:alignment.language_code,words:[],mean_confidence:0,max_provider_shift_ms:0,raw_result_key:prep.alignment_result_key},is_music:true,music_source:segment.music_source,music_context:segment.music_context||'foreground'});continue;}const acousticWords=providerWords.map((word,index)=>{const aligned=alignedByKey.get(`${segment.id}:${index}`);if(!aligned)throw new Error(`Missing forced alignment result for ${segment.id}:${index}`);// The per-word repair disclosures MUST travel onto the object the row is built
// from. They previously did not: the flags were set on the aligned word and this
// mapping rebuilt the object from the PROVIDER word, silently dropping them — so
// `onset_reconstructed` could never be true on any row, and a run that applied 3
// onset repairs disclosed 0 rows. A repair nobody can locate is the same class of
// failure as evidence that never persisted.
return {...word,start_ms:aligned.start_ms,end_ms:aligned.end_ms,alignment_confidence:aligned.confidence,onset_reconstructed:aligned.onset_reconstructed===true,onset_absorbed_ms:Number(aligned.onset_absorbed_ms||0),capture_restored:aligned.capture_restored===true,capture_divergence_ms:Number(aligned.capture_divergence_ms||0),provider_word:word};});const mapped:any[]=acousticWords.map(w=>{const t=best(turns,Number(w.start_ms),Number(w.end_ms),cursor);if(!t)unresolved++;else if((segment.speaker_label||'')!==label(t.speaker,clusters.indexOf(t.speaker)))reassigned++;return {...w,cluster:t?.speaker||null};});
      for(let i=0;i<mapped.length;i++)mapped[i].cluster ||= mapped[i-1]?.cluster||mapped[i+1]?.cluster||clusters[0];const groups:{cluster:string;words:any[]}[]=[];for(const w of mapped){const c=String(w.cluster);const last=groups.at(-1);last?.cluster===c?last.words.push(w):groups.push({cluster:c,words:[w]});}splits+=Math.max(0,groups.length-1);for(const g of groups){const sp=speakers[g.cluster],cs=g.words.map(w=>w.confidence).filter((n):n is number=>n!=null),start=Number(g.words[0].start_ms),end=Number(g.words.at(-1)!.end_ms),alignmentScores=g.words.map(w=>Number(w.alignment_confidence||0)),alignmentWords=g.words.map(w=>({text:String(w.text||''),start_ms:Number(w.start_ms),end_ms:Number(w.end_ms),confidence:Number(w.alignment_confidence||0),provider_start_ms:Number(w.provider_word.start_ms),provider_end_ms:Number(w.provider_word.end_ms)})),maxShift=Math.max(...alignmentWords.map(w=>Math.max(Math.abs(w.start_ms-w.provider_start_ms),Math.abs(w.end_ms-w.provider_end_ms))));counts[g.cluster]=(counts[g.cluster]||0)+1;output.push({sequence_index:output.length,start_ms:start,end_ms:end,tc_in:tc(start,prep.project.frame_rate||25),tc_out:tc(end,prep.project.frame_rate||25),speaker_id:sp.id,speaker_label:sp.label,speaker_color:sp.color,source_text:join(g.words)||segment.source_text,source_text_status:segment.source_text_status||'machine',confidence:cs.length?cs.reduce((a,b)=>a+b,0)/cs.length:segment.confidence,avg_word_confidence:cs.length?cs.reduce((a,b)=>a+b,0)/cs.length:segment.avg_word_confidence,aai_word_timings:g.words.map(w=>w.provider_word),provider_name:segment.provider_name,version_number:segment.version_number||1,_alignment:{status:'verified',model:alignment.model,model_revision:alignment.model_revision,language_code:alignment.language_code,words:alignmentWords,mean_confidence:alignmentScores.reduce((a,b)=>a+b,0)/alignmentScores.length,max_provider_shift_ms:maxShift,raw_result_key:prep.alignment_result_key},...(()=>{const rec=g.words.filter(w=>w.onset_reconstructed===true);return rec.length?{onset_reconstructed:true,onset_absorbed_ms:Math.max(...rec.map(w=>Number(w.onset_absorbed_ms||0)))}:{};})(),...(()=>{const res=g.words.filter(w=>w.capture_restored===true);return res.length?{capture_restored:true,capture_restored_ms:Math.max(...res.map(w=>Number(w.capture_divergence_ms||0)))}:{};})(),...(segment.consensus_run_id?{consensus_run_id:segment.consensus_run_id}:{}),...(segment.consensus_word_sources?.length?{consensus_word_sources:segment.consensus_word_sources.filter(w=>Number(w.end_ms)>start&&Number(w.start_ms)<end)}:{}),...(segment.is_music?{is_music:true,music_source:segment.music_source,music_context:segment.music_context||'foreground'}:{})});}}
    if(output.some(row=>row._alignment?.status==='verified'&&!row._alignment.words?.length))throw new Error('Forced alignment evidence is incomplete');
    // Repair the benign band, quarantine the rest, never veto the run. Mutates
    // `output` in place (bounded end-pull + defect flags) before staging.
    // sequence_index MUST stay monotonic in time. A repaired onset can move a row
    // earlier than a lower-indexed neighbour, which would render the editor list
    // out of chronological order and break every monotonicity assumption
    // downstream. Re-derive the index from the final windows before auditing.
    output.sort((a,b)=>(Number(a.start_ms)-Number(b.start_ms))||(Number(a.end_ms)-Number(b.end_ms)));
    output.forEach((row,index)=>{row.sequence_index=index;});
    const integrity=auditTimelineIntegrity(output,(ms:number)=>tc(ms,prep.project.frame_rate||25),onsetRepair.report,captureRestore.report);
    // Attribution travels WITH the finding. The worker owns the audit, so it stamps
    // the run id onto every row it flagged or repaired instead of leaving the
    // persisting function to re-derive it — the 21:38 run proved that boundary is
    // where attribution gets lost (defect labels landed, run ids came back null).
    for(const row of output)if(row.timing_defect||row.onset_reconstructed||row.capture_restored)row.timing_defect_run_id=run_id;
    if(integrity.same_speaker_overlap_defects||integrity.provider_capture_defects)await logEvent({function_name:'bullmq:speaker-diarization',level:'warn',event:'timeline_integrity_defects_flagged',message:`Flagged ${integrity.same_speaker_overlap_defects} same-speaker overlap and ${integrity.provider_capture_defects} provider-capture defect(s) for human review; transcript was not modified.`,context:{project_id,run_id,job_run_id,request_id,...integrity}});
    // EVIDENCE BEFORE CUTOVER. The integrity report is persisted as a typed
    // TimelineIntegrityReport row and READ BACK before a single transcript row is
    // staged. Ordering is the guarantee: if evidence cannot be recorded, nothing
    // has been mutated yet, so aborting is free \u2014 and the cached pyannote
    // provider_job_id means a retry never re-spends on the provider. This exists
    // because the report previously lived as an unverified key in a free-form
    // checkpoint blob and vanished silently across multiple runs while every
    // neighbouring value persisted. A refined transcript must never be able to
    // exist without its audit evidence. SOC 2 CC7.4 / CC8.1.
    const evidence=await post<{verified?:boolean;report_id?:string}>('persistTimelineIntegrityReport',{project_id,run_id,job_run_id,request_id,report:integrity,source_segment_count:source.length,output_segment_count:output.length},signal,'persist_timeline_integrity');
    if(!evidence?.verified)throw new Error('timeline_integrity_evidence_unverified: refusing transcript cutover without verified audit evidence');
    await logEvent({function_name:'bullmq:speaker-diarization',event:'timeline_integrity_evidence_verified',context:{project_id,run_id,job_run_id,request_id,report_id:evidence.report_id||null}});
    for(let i=0;i<output.length;i+=50){await call('stage_segments',{segments:output.slice(i,i+50)},signal);await call('heartbeat',{progress_pct:Math.min(96,82+Math.floor(i/output.length*14))},signal);}
    const cs=plans.map(p=>p.confidence).filter((n):n is number=>n!==null),avg=cs.length?cs.reduce((a,b)=>a+b,0)/cs.length:null;await call('finalize',{timeline_integrity:integrity,raw_result_key:prep.raw_result_key,provider_job_id:providerId,source_segment_count:source.length,output_segment_count:output.length,detected_speaker_count:clusters.length,split_count:splits,reassigned_word_count:reassigned,unresolved_word_count:unresolved,average_confidence:avg,speaker_counts:counts,alignment:{status:'verified',provider:alignment.provider,model:alignment.model,model_revision:alignment.model_revision,language_code:alignment.language_code,word_count:alignment.word_count,mean_confidence:alignment.mean_confidence,max_provider_shift_ms:alignment.max_provider_shift_ms,duration_ms:alignment.duration_ms,raw_result_key:prep.alignment_result_key}},signal);
    await logEvent({function_name:'bullmq:speaker-diarization',event:'speaker_diarization_completed',duration_ms:Date.now()-started,context:{project_id,run_id,job_run_id,request_id,provider_job_id:providerId,output_segments:output.length,speakers:clusters.length}});return {ok:true,action:'done'};
  });}catch(error){const message=String((error as Error)?.message||error).slice(0,500),max=Number(job.opts.attempts||1),terminal=job.attemptsMade+1>=max||/not configured|No source|no usable turns|No active transcript|staging|Translation started|Forced alignment HTTP 4|word-count mismatch|token mismatch|invalid alignment|Missing provider word|timeline_integrity_evidence_unverified/i.test(message);if(terminal)await call('terminal_failure',{terminal_failure:message}).catch(()=>{});await logEvent({function_name:'bullmq:speaker-diarization',level:terminal?'error':'warn',event:terminal?'speaker_diarization_failed':'speaker_diarization_retrying',message,context:{project_id,run_id,job_run_id,request_id,user_email,attempt:job.attemptsMade+1,max_attempts:max}});throw error;}
}
