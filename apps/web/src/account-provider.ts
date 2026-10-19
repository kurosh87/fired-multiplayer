const provider=import.meta.env.VITE_ACCOUNT_PROVIDER??'supabase';
if(!['better-auth','supabase'].includes(provider))throw new Error('Choose a supported account provider.');
export const cloudAccountsEnabled=provider==='better-auth';
