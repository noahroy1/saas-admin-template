// Cloudflare Worker: /api/reels_run.ts (or .js; deploy via wrangler)
// Mirrors apify_run.txt structure: Validates token, runs Apify instagram-scraper, polls, extracts/computes,
// then UPSERTs to Supabase leads (by leadId for precision post-profile chain).
// Chain trigger: In Dashboard.tsx addLead, after insert: fetch('/api/reels_run', { body: JSON.stringify({ username, leadId: insertedLead[0].id }) })

import { validateApiTokenResponse } from "@/lib/api";
import { createClient } from '@supabase/supabase-js';

// CORS headers constant for reuse
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',  // Tighten for prod
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Vary': 'Origin',
};

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders });
}

const SUPABASE_URL = "https://vyiyzapirdkiateytpwo.supabase.co";

export async function POST({ locals, request }) {
  const { API_TOKEN, APIFY_TOKEN, SUPABASE_SERVICE_ROLE_KEY } = locals.runtime.env;

  const invalidTokenResponse = await validateApiTokenResponse(request, API_TOKEN);
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

  const { username, leadId } = body;
  if (!username || typeof username !== "string" || !leadId || typeof leadId !== "string") {  // Changed: string, not number
    return new Response(JSON.stringify({ error: "Missing/invalid username or leadId" }), { 
      status: 400, 
      headers: jsonHeaders 
    });
  }

  // Apify input: user reels feed, limit 2 recent
  const apifyInput = {
    directUrls: [`https://www.instagram.com/${username}/`],
    resultsLimit: 2,
    resultsType: "reels",
    isUserReelFeedURL: true,  // Explicit for reels endpoint
    searchType: "user",  // Corrected from sample's "hashtag"
    proxy: { useApifyProxy: true },  // Anti-block
  };

  let apifyResponse;
  try {
      apifyResponse = await fetch(
      "https://api.apify.com/v2/acts/apify~instagram-scraper/runs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${APIFY_TOKEN}`,
        },
        body: JSON.stringify(apifyInput),
      }
    );
  } catch (fetchErr) {
    console.error("Apify run fetch error:", fetchErr);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    await supabase.from("leads").update({ has_reels: false, reels: [], er_avg: null }).eq('id', leadId);
    return Response.json({ success: false, error: `Fetch failed: ${fetchErr.message}-reels skipped` }, { status: 200, headers: jsonHeaders });
  }

  if (!apifyResponse.ok) {
    const errorData = await apifyResponse.json().catch(() => ({}));
    console.error("Apify run error:", errorData);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_reels: false, reels: [], er_avg: null }).eq('id', leadId);
    return Response.json({ success: false, error: errorData.error?.message || "Apify run failed-reels skipped" }, { status: 200, headers: jsonHeaders });
  }

  const runData = await apifyResponse.json();
  const runId = runData.data.id;

  // Step 2: Poll for completion (8s intervals, ~5min max; <50 subreqs)
  let status = "RUNNING";
  let maxAttempts = 40;
  while (status === "RUNNING" && maxAttempts-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    try {
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}`,
        { 
          headers: { "Authorization": `Bearer ${APIFY_TOKEN}` } 
        }
      );
      if (!statusRes.ok) throw new Error(`Status check failed: ${statusRes.status}`);
      const statusData = await statusRes.json();
      status = statusData.data.status;
    } catch (err) {
      console.error("Polling error:", err);
      status = "FAILED";
    }
  }

  if (status !== "SUCCEEDED") {
    // Graceful: Don't fail the chain; just set has_reels=false
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_reels: false, reels: [], er_avg: null }).eq('id', leadId);
    return Response.json({ success: false, error: `Run status: ${status}—reels skipped` }, { status: 200, headers: jsonHeaders });
  }

  // Step 3: Fetch results (reels array)
  let results;
  try {
    const resultsRes = await fetch(
      `https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items`,
      { 
        headers: { "Authorization": `Bearer ${APIFY_TOKEN}` } 
      }
    );
    if (!resultsRes.ok) {
      throw new Error(`Results fetch failed: ${resultsRes.status}`);
    }
    results = await resultsRes.json();
  } catch (err) {
    console.error("Results fetch error:", err);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_reels: false, reels: [], er_avg: null }).eq('id', leadId);
    return Response.json({ success: false, error: `Results error: ${err.message}—reels skipped` }, { status: 200, headers: jsonHeaders });
  }

  if (!results || results.length === 0) {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_reels: false, reels: [], er_avg: null }).eq('id', leadId);
    return Response.json({ success: false, error: "No reels found—private or inactive?" }, { status: 200, headers: jsonHeaders });
  }

  // Step 4: Extract and Compute (cap at 2)
  const reels = results.slice(0, 2).map((reel: any) => {
    const views = reel.videoPlayCount || 0;
    const likes = reel.likesCount || 0;
    const comments = reel.commentsCount || 0;
    const ctr = views > 0 ? ((likes + comments) / views) * 100 : 0;

    return {
      id: reel.id,
      url: reel.url,
      ctr: Number(ctr.toFixed(2)),
      likesCount: likes,
      commentsCount: comments,
      videoPlayCount: views,
      timestamp, reel.timestamp,
    };
  });

  const totalEngagement = reels.reduce((sum: number, r: any) => sum + r.likesCount + r.commentsCount, 0);
  const totalViews = reels.reduce((sum: number, r: any) => sum + r.videoPlayCount, 0);
  const er_avg = totalViews > 0 ? Number(((totalEngagement / totalViews) * 100).toFixed(2)) : null;

  // Step 5: Supabase UPSERT
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { error: updateError } = await supabase
    .from("leads")
    .update({
      reels,
      er_avg,
      has_reels: true
    })
    .eq('id', leadId);

  if (updateError) {
    console.error("Supabase update error:", updateError);
    return Response.json({ error: `Cache failed: ${updateError.message}` }, { status: 500, headers: jsonHeaders });
  }

  console.log(`Cached ${reels.length} reels for lead ${leadId}; ER_avg: ${er_avg%}`);

  return Response.json({
    success: true,
    data: { reels, er_avg },
    leadId
  }, { status: 200, headers: jsonHeaders });
}
