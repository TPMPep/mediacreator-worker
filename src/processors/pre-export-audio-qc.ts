import type { Job } from 'bullmq';
import type { PreExportAudioQCJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat } from '../base44-client.js';
import { BUILD_TAG } from '../build-tag.js';

interface Step { action: 'continue'|'done'|'failed'; status?: string }
export async function processPreExportAudioQC(job: Job<PreExportAudioQCJobData>) {
  const { project_id, run_id, user_email, request_id, auth_token } = job.data;
  if (!auth_token) throw new Error('pre-export-audio-qc: missing auth token');
  try {
    for (let tick=1; tick<=10000; tick++) {
      const step=await runWithLockHeartbeat(job, signal=>invokeBase44Function<Step>({fn:'preExportAudioQCWorkerStep',authToken:auth_token,payload:{project_id,run_id,worker_build_tag:BUILD_TAG},timeoutMs:90000,signal}));
      if(tick===1||tick%10===0||step.action!=='continue') await logEvent({function_name:'bullmq:pre-export-audio-qc',event:'pre_export_audio_qc_tick',context:{project_id,run_id,user_email,request_id,tick,action:step.action}});
      if(step.action!=='continue') return {ok:step.action==='done',status:step.status,ticks:tick};
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('pre-export audio QC tick ceiling exceeded');
  } catch(error) {
    const finalAttempt=job.attemptsMade+1>=Number(job.opts.attempts||1);
    if(finalAttempt) await invokeBase44Function({fn:'preExportAudioQCWorkerStep',authToken:auth_token,payload:{project_id,run_id,action:'fail',error_message:String((error as Error).message||error)},timeoutMs:30000}).catch(()=>{});
    throw error;
  }
}
