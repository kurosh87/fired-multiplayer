export type AccountCredential={owner:string;token:string;expiresAt:number;emailVerified:boolean};

/** In-memory credentials only. Authorization remains a server database check.
 * A logout/account switch invalidates an outstanding session fetch. */
export class AccountSessionCache {
  private value:AccountCredential|null=null;
  private epoch=0;
  private pending?:{epoch:number;promise:Promise<string>};
  get generation(){return this.epoch;}
  observe(value:AccountCredential|null){
    if(value?.owner!==this.value?.owner||value?.token!==this.value?.token||value?.emailVerified!==this.value?.emailVerified)this.epoch++;
    this.value=value;
  }
  clear(){this.value=null;this.epoch++;}
  async token(load:()=>Promise<AccountCredential|null>,now:()=>number=Date.now):Promise<string>{
    if(this.value&&this.value.expiresAt>now()+1000&&this.value.emailVerified)return this.value.token;
    if(this.pending?.epoch===this.epoch)return this.pending.promise;
    const epoch=this.epoch;
    const promise=(async()=>{
      const value=await load();
      if(this.epoch!==epoch&&this.value?.token!==value?.token)throw new Error('Your signed-in account changed. Try again.');
      if(!value||!value.token||!Number.isFinite(value.expiresAt)||value.expiresAt<=now())throw new Error('Please sign in again.');
      if(!value.emailVerified)throw new Error('Confirm your email before playing online.');
      this.observe(value);return value.token;
    })();
    const request={epoch,promise};this.pending=request;
    try{return await promise;}finally{if(this.pending===request)this.pending=undefined;}
  }
}
