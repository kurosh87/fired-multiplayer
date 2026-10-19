import assert from 'node:assert/strict';
import WebSocket from 'ws';

/** Real protocol client. No clock or game-state injection. */
export class RestartPlayClient{
  readonly socket:WebSocket;
  readonly messages:any[]=[];
  private pending:{resolve:(value:any)=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
  constructor(base:string,origin:string){
    this.socket=new WebSocket(base.replace('http:','ws:')+'/api/play',{origin});
    this.socket.on('message',raw=>{
      const message=JSON.parse(raw.toString());this.messages.push(message);
      const pending=this.pending;this.pending=undefined;
      if(pending){clearTimeout(pending.timer);pending.resolve(message);}
    });
    this.socket.on('close',()=>{
      const pending=this.pending;this.pending=undefined;
      if(pending){clearTimeout(pending.timer);pending.reject(new Error('The test API connection closed.'));}
    });
    this.socket.on('error',()=>{});
  }
  async open(token:string,sessionId:string):Promise<void>{
    await new Promise<void>((resolve,reject)=>{this.socket.once('open',resolve);this.socket.once('error',reject);});
    assert.equal((await this.request({type:'authenticate',protocol:1,token,sessionId})).type,'ready');
  }
  request(body:unknown):Promise<any>{
    assert(!this.pending,'The qualification client supports one in-flight request.');
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending=undefined;reject(new Error('The test API response timed out.'));},10000);
      this.pending={resolve,reject,timer};this.socket.send(JSON.stringify(body));
    });
  }
  terminate():void{this.socket.terminate();}
}
