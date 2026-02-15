/**
 * Supabase Client
 * 
 * Creates and exports a Supabase client using the service_role key.
 * Service role bypasses Row Level Security — appropriate for server-side
 * functions that handle their own authorization logic.
 * 
 * NEVER expose the service_role key to the browser/client.
 * All our code runs in Vercel serverless functions (server-side only).
 */

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
        'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
        'Set them in .env.local (dev) or Vercel environment variables (prod).'
    );
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});

module.exports = { supabase };
