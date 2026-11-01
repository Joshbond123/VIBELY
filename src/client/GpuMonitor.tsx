import React,{useEffect,useState} from 'react';
export function GpuMonitor(){
 const [workers,setWorkers]=useState<any[]>([]);const [error,setError]=useState('');
 useEffect(()=>{
  let alive=true;let controller:AbortController|undefined;
  async function refresh(){
   controller?.abort();controller=new AbortController();
   try{const r=await fetch('/api/gpu',{signal:controller.signal});if(!r.ok)throw new Error(`Telemetry HTTP ${r.status}`);const d=await r.json();if(alive){setWorkers(d.workers || []);setError('');}}
   catch(e:any){if(alive && e.name!=='AbortError'){setError('Live telemetry unavailable');setWorkers(old=>old.map(w=>({...w,telemetry:null,telemetry_is_live:false})));}}
  }
  refresh();const timer=setInterval(refresh,6000);return()=>{alive=false;clearInterval(timer);controller?.abort();};
 },[]);
 const value=(n:any,unit='')=>typeof n==='number'?`${n}${unit}`:'Unavailable';
 return <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4" data-testid="gpu-monitor">
  <div><h2 className="font-bold">GPU lifecycle &amp; live monitoring</h2><p className="text-xs text-zinc-400">Kaggle allocates accelerators on demand. Idle browsing and caption analysis never start a GPU. Cold-start time and quota depend on Kaggle.</p></div>
  {error && <p className="text-sm text-amber-300">{error} — previous measurements are not shown as live.</p>}
  <div className="grid md:grid-cols-2 gap-4">{workers.map(w=><article key={w.service_id} className="border border-zinc-700 rounded-xl p-4 space-y-3">
   <div className="flex justify-between"><strong>{w.service_id==='minimax_h3_ref2va'?'Video GPU':'Music GPU'}</strong><span className={w.status==='ON'?'text-emerald-400':'text-zinc-300'}>{w.status}</span></div>
   <p className="text-sm">{w.gpu_name || 'GPU not allocated'}{w.status==='OFF' && w.gpu_name?' (last detected)':''}</p>
   <dl className="text-xs grid grid-cols-2 gap-2"><dt>Availability</dt><dd>{w.availability}</dd><dt>Active GPU jobs</dt><dd>{w.active_jobs ?? 'Not measured'} · {w.queued_or_leased_jobs} pending leases</dd><dt>Current task</dt><dd>{w.status==='OFF'?'Inactive':w.current_task?.join(', ') || 'Waiting for worker'}</dd><dt>Session duration</dt><dd>{w.session_duration_sec==null?(w.status==='OFF'?'Inactive':'Not measured'):`${w.session_duration_sec}s`}</dd><dt>Last shutdown</dt><dd>{w.last_shutdown?new Date(w.last_shutdown).toLocaleString():'Not recorded'}</dd><dt>Measurement</dt><dd>{w.telemetry_is_live?new Date(w.telemetry.measured_at*1000).toLocaleTimeString():w.status==='OFF'?'GPU OFF — no live measurements':'No live measurement'}</dd></dl>
   {w.telemetry_is_live && w.telemetry.gpus?.map((g:any)=><div key={g.index} className="text-xs border-t border-zinc-800 pt-2 space-y-1"><p>GPU {g.index}: {g.name}</p><p>Utilization: {value(g.utilization_percent,'%')} · VRAM: {value(g.memory_used_mib)} / {value(g.memory_total_mib,' MiB')}</p><p>Temperature: {value(g.temperature_c,' °C')}</p></div>)}
   {w.error && <p className="text-xs text-amber-300">{w.error}</p>}
  </article>)}</div>
 </section>;
}
