import React,{useEffect,useState} from 'react';
const hours=(s:any)=>typeof s==='number'?(s/3600).toFixed(2)+' h':'Not verified';
export function GpuMonitor(){
 const [data,setData]=useState<any>(null),[error,setError]=useState(''),[selected,setSelected]=useState('video-primary');
 useEffect(()=>{
  let alive=true,timer:ReturnType<typeof setTimeout>;const controller=new AbortController();
  async function refresh(){
   try{const r=await fetch('/api/gpu',{signal:controller.signal,cache:'no-store'});if(!r.ok)throw Error();const d=await r.json();if(alive){setData(d);setError('');}}
   catch(e:any){if(alive&&e.name!=='AbortError')setError('Live status unavailable — last measurements are stale.');}
   finally{if(alive)timer=setTimeout(refresh,5000);}
  }
  refresh();return()=>{alive=false;clearTimeout(timer);controller.abort();};
 },[]);
 const cards=data?.fleet || [];
 const quota=cards.find((p:any)=>p.id===selected)?.weekly;
 const verified=!error&&quota?.quota_verified;
 const remainingPercent=verified?Math.max(0,Math.min(100,100*quota.provider_remaining_seconds/quota.provider_total_seconds)):0;
 return <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-5" data-testid="gpu-monitor" aria-label="GPU fleet and weekly allocation">
  <header className="flex flex-wrap justify-between gap-3"><div><h2 className="font-bold text-lg">GPU fleet &amp; weekly allocation</h2><p className="text-xs text-zinc-400 mt-1">Live device measurements · refreshes every 5 seconds · safe shutdown after persisted output</p></div><span className={error?'text-amber-300 text-xs':'text-emerald-400 text-xs'}>{error?'Telemetry stale':data?'Monitoring connected':'Connecting to telemetry'}</span></header>
  <div className="rounded-xl border border-zinc-700 p-4 space-y-3"><div className="flex flex-wrap justify-between gap-2"><strong className="text-sm">Weekly GPU hours remaining</strong><select aria-label="GPU account for weekly quota" className="bg-zinc-800 rounded px-2 py-1 text-xs" value={selected} onChange={e=>setSelected(e.target.value)}>{cards.map((p:any)=><option key={p.id} value={p.id}>{p.role} {p.priority} · {p.account}</option>)}</select></div>
   <div className="h-3 rounded-full bg-zinc-800 overflow-hidden" role="progressbar" aria-label={verified?'Provider weekly hours remaining':'Remaining weekly hours unverified'} aria-valuemin={0} aria-valuemax={verified?quota.provider_total_seconds/3600:30} aria-valuenow={verified?quota.provider_remaining_seconds/3600:undefined}><div className={'h-full transition-all '+(verified?'bg-emerald-400':'bg-amber-500/20')} style={{width:verified?remainingPercent+'%':'100%'}} /></div>
   <div className="grid grid-cols-3 gap-3 text-sm"><div><p className="text-zinc-400 text-xs">Provider total</p><strong>{hours(verified?quota.provider_total_seconds:null)}</strong></div><div><p className="text-zinc-400 text-xs">Provider used</p><strong>{hours(verified?quota.provider_used_seconds:null)}</strong></div><div><p className="text-zinc-400 text-xs">Remaining, unreserved</p><strong className={verified?'text-emerald-300':'text-amber-300'}>{hours(verified?quota.provider_remaining_seconds:null)}</strong></div></div>
   <p className="text-xs text-zinc-400">{verified?`Reserved: ${hours(quota.reserved_seconds)} · Resets ${new Date(quota.refresh_at).toLocaleString()} · Quota checked ${new Date(quota.verified_at).toLocaleTimeString()}`:'Provider quota not verified. The bar is unknown, not a full balance.'}</p>
   <p className="text-xs text-amber-200/80">Provider balances are per account, not pooled. Quota refreshes every 60 seconds; allocated idle time can consume quota. Accounts must not be rotated to bypass provider limits.</p>
  </div>
  {error&&<p role="alert" className="text-sm text-amber-300">{error}</p>}
  <div className="grid md:grid-cols-2 gap-4">{cards.map((p:any)=>{
   const w=p.worker;const live=!error&&p.telemetry_is_live;const status=error?'UNKNOWN':p.status;
   return <article key={p.id} className="border border-zinc-700 rounded-xl p-4 space-y-3">
    <div className="flex items-center justify-between gap-2"><strong className="capitalize">{p.role} · {p.priority}</strong><span className={'rounded-full px-2 py-1 text-xs '+(status==='ON'&&live?'bg-emerald-500/15 text-emerald-300':'bg-zinc-800 text-zinc-300')}>{status==='ON'&&!live?'ON — telemetry unavailable':status.replaceAll('_',' ')}</span></div>
    <p className="text-xs text-zinc-400">Account: {p.account}</p><h3 className="font-semibold">{live?p.gpu_name || 'Hardware not reported':status==='OFF'?'GPU OFF · not allocated':'GPU hardware not verified'}</h3>
    <dl className="text-xs grid grid-cols-2 gap-2"><dt>Provider total / used</dt><dd>{hours(!error?p.weekly.provider_total_seconds:null)} / {hours(!error?p.weekly.provider_used_seconds:null)}</dd><dt>Observed usage</dt><dd>{hours(p.weekly.observed_seconds)}</dd><dt>Actual remaining</dt><dd className="text-amber-300">{hours(!error&&p.weekly.quota_verified?p.weekly.provider_remaining_seconds:null)}</dd><dt>Current task</dt><dd>{live?w.current_task?.join(', ') || 'Idle':p.provisioning}</dd><dt>Session duration</dt><dd>{live&&w.session_duration_sec!=null?Math.floor(w.session_duration_sec/60)+' min':'Not measured'}</dd><dt>Rotation target</dt><dd>30 active minutes · safe task boundary</dd><dt>Last confirmed shutdown</dt><dd>{w?.last_shutdown?new Date(w.last_shutdown).toLocaleString():'Not recorded'}</dd></dl>
    {live&&w.telemetry?.gpus?.map((g:any)=><div key={g.index} className="text-xs border-t border-zinc-800 pt-2"><p>Device {g.index}: {g.name}</p><p>Utilization {g.utilization_percent ?? '?'}% · VRAM {g.memory_used_mib ?? '?'} / {g.memory_total_mib ?? '?'} MiB</p></div>)}
    {w?.error&&<p className="text-xs text-amber-300">{w.error}</p>}
   </article>;
  })}</div>
  {!data&&<p className="text-sm text-zinc-400">Reading actual worker state. Viewing this panel never activates a GPU.</p>}
 </section>;
}
