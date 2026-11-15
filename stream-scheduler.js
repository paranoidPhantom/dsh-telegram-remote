/** Coalesce fast tokens without waiting for silence. Slow delivery never builds a queue. */
export function createStreamScheduler({deliver,onError=()=>{},intervalMs=250,setTimer=setTimeout,clearTimer=clearTimeout}) {
  const cells=new Map();let closed=false;
  function cell(id){if(!cells.has(id))cells.set(id,{timer:null,pending:null,boundaries:[],inFlight:false,final:false});return cells.get(id);}
  async function drain(id,c){
    c.timer=null;if(closed||c.inFlight||(!c.pending&&!c.boundaries.length))return;
    const boundary=c.boundaries.shift();const view=boundary??c.pending;if(!boundary)c.pending=null;c.inFlight=true;
    try{await deliver(id,view);}catch(error){onError(error);}finally{c.inFlight=false;if((c.pending||c.boundaries.length)&&!closed)arm(id,c,c.boundaries.length||c.pending?.final?0:intervalMs);}
  }
  function arm(id,c,delay){if(c.timer!==null||c.inFlight||closed)return;c.timer=setTimer(()=>void drain(id,c),delay);}
  return {
    push(id,view,{immediate=false}={}){
      if(closed)return;const c=cell(id);
      // A newer turn can reopen a finalized lane; stale callbacks cannot overwrite it.
      if(c.turn!==undefined&&view.turn<c.turn)return;
      if(view.turn!==c.turn){if(c.pending?.final)c.boundaries.push(c.pending);c.pending=null;c.turn=view.turn;c.final=false;}
      if(c.final&&!view.final)return;
      c.pending=view;if(view.final)c.final=true;
      if(immediate||view.final){if(c.timer!==null){clearTimer(c.timer);c.timer=null;}arm(id,c,0);}else arm(id,c,intervalMs);
    },
    close(){closed=true;for(const c of cells.values())if(c.timer!==null)clearTimer(c.timer);cells.clear();}
  };
}
