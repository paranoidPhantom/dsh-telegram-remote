/** Own asynchronous work for exactly one plugin activation. */
export class RuntimeLifecycle {
  #tasks=new Set();
  #cleanups=[];
  #closing;
  constructor(onError=()=>{}){this.controller=new AbortController();this.onError=onError;}
  get signal(){return this.controller.signal;}
  own(cleanup){if(this.signal.aborted){cleanup();return;}this.#cleanups.push(cleanup);}
  launch(operation){
    if(this.signal.aborted)return Promise.resolve();
    const task=Promise.resolve(operation).catch(error=>{if(!this.signal.aborted)this.onError(error);}).finally(()=>this.#tasks.delete(task));
    this.#tasks.add(task);return task;
  }
  close(){
    if(this.#closing)return this.#closing;
    // Abort BEFORE awaiting resources, so a blocked getUpdates cannot outlive unload.
    this.controller.abort();
    const cleanups=this.#cleanups.splice(0).reverse().map(fn=>{try{return Promise.resolve(fn());}catch(e){return Promise.reject(e);}});
    this.#closing=Promise.allSettled([...cleanups,...this.#tasks]).then(()=>{});
    return this.#closing;
  }
}
