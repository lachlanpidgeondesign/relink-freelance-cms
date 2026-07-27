// The one and only Supabase client instance for the whole app.
//
// No build step / bundler here, so the SDK is imported as a plain ES module from
// the esm.sh CDN rather than an npm install. Every other module imports THIS
// `supabase` — we never create a second client (multiple clients would each hold
// their own auth session and fight over token refresh).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
