// CORS headers for the browser -> Edge Function calls.
//
// supabase.functions.invoke() sends Authorization + apikey headers, which makes
// the browser fire a CORS preflight (OPTIONS). Handle that and echo the headers
// the SDK sends. For a POC we allow any origin; tighten to the platform's origin
// for production.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
