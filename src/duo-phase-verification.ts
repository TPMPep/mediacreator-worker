type Word = { text?: string; start_ms: number; end_ms: number };
const norm = (value: unknown) => String(value || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]+/gu,'');

export function buildPhraseDisagreements(primary: Word[], secondary: Word[], contextWords = 4) {
  const p = primary || [], s = secondary || []; const rows = []; let i = 0, j = 0;
  const sameMoment = (a:Word,b:Word) => Math.abs(a.start_ms-b.start_ms) <= 1500;
  for(const word of [...p,...s])if(typeof word.start_ms!=='number'||typeof word.end_ms!=='number'||!Number.isFinite(word.start_ms)||!Number.isFinite(word.end_ms)||word.start_ms<0||word.end_ms<word.start_ms)throw new Error('duo_phrase_invalid_provider_window');
  while (i < p.length || j < s.length) {
    if (i < p.length && j < s.length && norm(p[i].text) === norm(s[j].text) && sameMoment(p[i],s[j])) { i++; j++; continue; }
    const pStart=i,sStart=j; let pSync=-1,sSync=-1;
    for(let a=i;a<Math.min(p.length,i+8)&&pSync<0;a++) for(let b=j;b<Math.min(s.length,j+8);b++) if(norm(p[a].text)&&norm(p[a].text)===norm(s[b].text)&&sameMoment(p[a],s[b])){pSync=a;sSync=b;break;}
    if(pSync<0){pSync=Math.min(p.length,i+1);sSync=Math.min(s.length,j+1);}
    const pg=p.slice(pStart,pSync),sg=s.slice(sStart,sSync);
    const start=Math.min(pg[0]?.start_ms??Infinity,sg[0]?.start_ms??Infinity);const end=Math.max(pg.at(-1)?.end_ms??-Infinity,sg.at(-1)?.end_ms??-Infinity);
    rows.push({kind:pg.length&&sg.length?'wording_difference':pg.length?'primary_only_phrase':'missing_speech_candidate',primary_text:pg.map(w=>w.text).join(' '),secondary_text:sg.map(w=>w.text).join(' '),start_ms:start,end_ms:end,context_before:p.slice(Math.max(0,pStart-contextWords),pStart).map(w=>w.text).join(' '),context_after:p.slice(pSync,pSync+contextWords).map(w=>w.text).join(' '),automatic_action:'review',evidence_sufficient:false});
    i=pSync;j=sSync;
  }
  return rows.filter(row=>Number.isFinite(row.start_ms)&&Number.isFinite(row.end_ms));
}
