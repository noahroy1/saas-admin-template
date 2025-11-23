import { validateApiTokenResponse } from "@/lib/api";
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = "https://vyiyzapirdkiateytpwo.supabase.co";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',  // for prod tighten
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Vary': 'Origin',  // Busts caches on origin changes
};

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders });  // Handles preflight
}

export async function POST({ locals, request }) {
  const { API_TOKEN, APIFY_TOKEN } = locals.runtime.env;
  
  if (invalidTokenResponse) {
    return new Response(invalidTokenResponse.body, {
      status: invalidTokenResponse.status,
      headers: jsonHeaders
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: jsonHeaders
    });
  }
  const { username } = body;
  
  if (!username || typeof username !== "string") {
    return new Response(JSON.stringify({ error: "Missing or invalid username" }), {
      status: 400,
      headers: jsonHeaders
    });
  }
  
  const apifyInput = {
    usernames: [username],
    proxy: { useApifyProxy: true },
  };
  
  const apifyResponse = await fetch(
    // "Actor URL"
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(apifyInput)
    }
  );
  
  if (!apifyResponse.ok) {
    const errorData = await apifyResponse.json();
    return Response.json(
      { error: errorData.error?.message || "Apify run failed" },
      { status: apifyResponse.status, headers: jsonHeaders }
    );
  }
  
  const runData = await apifyResponse.json();
  const runId = runData.data.id;
  
  let status = "RUNNING";
  let maxAttempts = 40;
  while (status === "RUNNING" && maxAttempts-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    try {
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}`,
        {
          headers: { Authorization: `Bearer ${APIFY_TOKEN}` },
        }
      );
      if (!statusRes.ok) {
        throw new Error(`Status check failed: ${statusRes.status}`);
      }
      const statusData = await statusRes.json();
      status = statusData.data.status;
    } catch (err) {
      return Response.json({ error: `Polling error: ${err.message}` }, { status: 500, headers: jsonHeaders });
    }
  }
  
  if (status !== "SUCCEEDED") {
    return Response.json({ error: `Run failed with status: ${status}` }, { status: 500, headers: jsonHeaders });
  }
  
  try {
    const resultsRes = await fetch(
      // "https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items"
      {
        headers: { Authorization: `Bearer ${APIFY_TOKEN}` },
      }
    );
    if (!resultsRes.ok) {
      return Response.json({ error: `Failed to fetch results: ${resultsRes.status}` }, { status: 400, headers: jsonHeaders });
    }
    const results = await resultsRes.json();
  
    if (!results || results.length === 0) {
      return Response.json({ error: "No profile found for username" }, { status: 400, headers: jsonHeaders });
    }
    const profile = results[0];

    let uploadMessage = null;
    let uploadSuccess: true;
  
    // Upload to Supabase here
  
    const extracted = {
      // fields
    };
  
    return Response.json({ success: true, data: extracted, upload: { success: uploadSuccess, message: uploadMessage }}, { status: 200, headers: jsonHeaders });
  } catch (err) {
    return Response.json({ error: `Results processing error: ${err.message}` }, { status: 500, headers: jsonHeaders });
  }
}












