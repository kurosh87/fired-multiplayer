import {useEffect,useState} from 'react';
import {createAuthClient} from 'better-auth/react';
import {supabase} from './legacy-account-client.ts';
import {cloudAccountsEnabled} from './account-provider.ts';
export {cloudAccountsEnabled} from './account-provider.ts';
import {AccountSessionCache,type AccountCredential} from './lib/account-session-cache.ts';

export const cloudAccounts=createAuthClient({basePath:'/api/cloud/auth'});
export const accountCredentials=new AccountSessionCache();
export type AccountSession={user:{id:string;email?:string}};
type CloudData=Awaited<ReturnType<typeof cloudAccounts.getSession>>['data'];
function credential(data:CloudData):AccountCredential|null{
  return data?.user?.id&&data.session?.token?{owner:data.user.id,token:data.session.token,expiresAt:Date.parse(String(data.session.expiresAt)),emailVerified:data.user.emailVerified}:null;
}
export const accountsConfigured=()=>cloudAccountsEnabled||Boolean(supabase);
export async function cloudSessionToken(){
  return accountCredentials.token(async()=>{
    const result=await cloudAccounts.getSession();if(result.error)throw new Error(result.error.message??'Account services are unavailable.');
    return credential(result.data);
  });
}
function useCloudSession(){
  const {data,isPending,refetch}=cloudAccounts.useSession();
  useEffect(()=>{if(!isPending)accountCredentials.observe(credential(data));},[data,isPending]);
  return {session:data?.user?.id?{user:{id:data.user.id,email:data.user.email}}:null,isPending,recovery:location.pathname==='/account/recovery'&&new URLSearchParams(location.search).has('token'),refresh:refetch};
}
function useLegacySession(){
  const [state,setState]=useState<{session:AccountSession|null;isPending:boolean;recovery:boolean}>({session:null,isPending:Boolean(supabase),recovery:false});
  useEffect(()=>{
    if(!supabase)return;let current=true,events=0;
    void supabase.auth.getSession().then(({data})=>{if(current&&!events)setState({session:data.session,isPending:false,recovery:false});});
    const {data}=supabase.auth.onAuthStateChange((event,next)=>{events++;if(current)setState({session:next,isPending:false,recovery:event==='PASSWORD_RECOVERY'});});
    return()=>{current=false;data.subscription.unsubscribe();};
  },[]);
  return {...state,refresh:async()=>{if(supabase){const {data}=await supabase.auth.getSession();setState(value=>({...value,session:data.session,isPending:false}));}}};
}
// Provider selection is fixed for the lifetime of this build. App calls one
// top-level hook; its selected implementation never changes between renders.
export const useAccountSession=cloudAccountsEnabled?useCloudSession:useLegacySession;

export async function accountAction(view:'login'|'signup'|'reset'|'recovery',email:string,password:string){
  if(cloudAccountsEnabled){
    const result=view==='signup'?await cloudAccounts.signUp.email({name:'Trainer',email,password,callbackURL:location.origin})
      :view==='reset'?await cloudAccounts.requestPasswordReset({email,redirectTo:location.origin+'/account/recovery'})
      :view==='recovery'?await cloudAccounts.resetPassword({newPassword:password,token:new URLSearchParams(location.search).get('token')??''})
      :await cloudAccounts.signIn.email({email,password});
    if(result.error)throw new Error(result.error.message??'Account request failed.');
    if(!result.data||typeof result.data!=='object'
      ||(['signup','login'].includes(view)&&typeof (result.data as {user?:{id?:unknown}}).user?.id!=='string')
      ||(['reset','recovery'].includes(view)&&(result.data as {status?:unknown}).status!==true))
      throw new Error('The account service returned an invalid response. Please try again.');
    return;
  }
  if(!supabase)throw new Error('Account services need configuration before sign-in is available.');
  const result=view==='signup'?await supabase.auth.signUp({email,password,options:{emailRedirectTo:location.origin}})
    :view==='reset'?await supabase.auth.resetPasswordForEmail(email,{redirectTo:location.origin+'/account/recovery'})
    :view==='recovery'?await supabase.auth.updateUser({password})
    :await supabase.auth.signInWithPassword({email,password});
  if(result.error)throw result.error;
}
export async function signOutAccount(){
  const result=cloudAccountsEnabled?await cloudAccounts.signOut():await supabase?.auth.signOut();
  if(result?.error)throw new Error(result.error.message??'Sign out failed.');
  if(cloudAccountsEnabled)accountCredentials.clear();
}

export async function cloudAccountRequest<T>(path:string,body:unknown):Promise<T>{
  const response=await fetch('/api/cloud/'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new Error(data.message??'Account request failed.');return data;
}
