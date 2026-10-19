import {createClient} from '@supabase/supabase-js';
import {cloudAccountsEnabled} from './account-provider.ts';
export const supabase=!cloudAccountsEnabled&&import.meta.env.VITE_SUPABASE_URL&&import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  ?createClient(import.meta.env.VITE_SUPABASE_URL,import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY):undefined;
