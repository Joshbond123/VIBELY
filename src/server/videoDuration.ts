export const VIDEO_FPS=24;
export const MIN_VIDEO_SECONDS=25;
export const MAX_VIDEO_SECONDS=40;

// Reserve one frame below 40s so AAC muxing cannot push container duration over it.
export function planVideoFrames(targetSeconds=26, sceneCount=3):number[] {
  if(!Number.isFinite(targetSeconds) || !Number.isInteger(sceneCount) || sceneCount<1)throw new Error('Invalid video timeline');
  const frames=Math.min(959,Math.max(600,Math.round(targetSeconds*VIDEO_FPS)));
  const each=Math.floor(frames/sceneCount);
  return Array.from({length:sceneCount},(_,i)=>i===sceneCount-1?frames-each*(sceneCount-1):each);
}

export function assertActualVideoDuration(actual:number, minimum=MIN_VIDEO_SECONDS):number {
  if(!Number.isFinite(actual) || actual<minimum || actual>MAX_VIDEO_SECONDS)
    throw new Error(`Actual rendered duration ${actual}s violates ${minimum}–40s policy; artifact retained, not marked completed`);
  return actual;
}
