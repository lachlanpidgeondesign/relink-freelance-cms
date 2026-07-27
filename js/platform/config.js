// Supabase project configuration.
//
// These two values identify the project and are safe to ship in client code:
// the publishable key is a PUBLIC key whose only power is bounded by Row-Level
// Security (RLS). The real secrets (service-role/secret key, Puzzlr API key)
// never live here — they stay in Edge Function secrets, server-side.
//
// Exported as named constants (rather than hardcoded into client.js) so swapping
// projects — or reading them from an injected global later — touches one place.
export const SUPABASE_URL = 'https://fqzjsfqybuqmisbhvhaf.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_rih6cMhLOQxUHczhR9PKHQ_P5OQUqII';
