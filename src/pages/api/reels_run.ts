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
  if (!username || typeof username !== "string" || !leadId || typeof leadId !== "number") {
    return new Response(JSON.stringify({ error: "Missing/invalid username or leadId" }), { 
      status: 400, 
      headers: jsonHeaders 
    });
  }

  // Apify Input: Per your sample—user reels feed, limit 2 recent (no hashtag; use "user" type implicitly via directUrls)
  const apifyInput = {
    directUrls: [`https://www.instagram.com/${username}/`],
    resultsLimit: 2,
    resultsType: "reels",
    isUserReelFeedURL: true,  // Explicit for reels endpoint
    searchType: "user",  // Corrected from sample's "hashtag"
    proxy: { useApifyProxy: true },  // Anti-block
  };

  // Step 1: Run the instagram-scraper actor
  const apifyResponse = await fetch(
    `https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${APIFY_TOKEN}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(apifyInput),
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

  // Step 2: Poll for completion (8s intervals, ~5min max; <50 subreqs)
  let status = "RUNNING";
  let maxAttempts = 40;
  while (status === "RUNNING" && maxAttempts-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    try {
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`,
        { headers: { "Authorization": `Bearer ${APIFY_TOKEN}` } }
      );
      if (!statusRes.ok) throw new Error(`Status check failed: ${statusRes.status}`);
      const statusData = await statusRes.json();
      status = statusData.data.status;
    } catch (err) {
      return Response.json({ error: `Polling error: ${err.message}` }, { status: 500, headers: jsonHeaders });
    }
  }

  if (status !== "SUCCEEDED") {
    // Graceful: Don't fail the chain; just set has_reels=false
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_reels: false, reels: [], ER_avg: null }).eq('id', leadId);
    return Response.json({ success: false, error: `Run status: ${status}—reels skipped` }, { status: 200, headers: jsonHeaders });
  }

  // Step 3: Fetch results (reels array)
  try {
    const resultsRes = await fetch(
      `https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items?token=${APIFY_TOKEN}`,
      { headers: { "Authorization": `Bearer ${APIFY_TOKEN}` } }
    );
    if (!resultsRes.ok) {
      throw new Error(`Results fetch failed: ${resultsRes.status}`);
    }
    const results = await resultsRes.json();

    if (!results || results.length === 0) {
      // Graceful skip
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await supabase.from("leads").update({ has_reels: false, reels: [], ER_avg: null }).eq('id', leadId);
      return Response.json({ success: false, error: "No reels found—private or inactive?" }, { status: 200, headers: jsonHeaders });
    }

    // Step 4: Extract & Compute (per your sample output; cap at 2)
    const reels = results.slice(0, 2).map((reel: any) => {
      const views = reel.videoPlayCount || 0;
      const likes = reel.likesCount || 0;
      const comments = reel.commentsCount || 0;
      const ctr = views > 0 ? ((likes + comments) / views) * 100 : 0;  // ER proxy; round to 2 decimals later in UI

      return {
        id: reel.id,
        url: reel.url,
        ctr: Number(ctr.toFixed(2)),  // Pre-compute for cache
        likesCount: likes,
        commentsCount: comments,
        videoPlayCount: views,
        timestamp: reel.timestamp,  // ISO for sorting
        // Extras if needed: caption, musicInfo, etc.—add to schema later
      };
    });

    // Compute lead-level avg ER (simple mean; null if all zero)
    const totalEngagement = reels.reduce((sum: number, r: any) => sum + r.likesCount + r.commentsCount, 0);
    const totalViews = reels.reduce((sum: number, r: any) => sum + r.videoPlayCount, 0);
    const ER_avg = totalViews > 0 ? Number(((totalEngagement / totalViews) * 100).toFixed(2)) : null;

    // Step 5: Supabase UPSERT (update existing lead by id)
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { error: updateError } = await supabase
      .from("leads")
      .update({ 
        reels: reels,  // JSONB array
        ER_avg,
        has_reels: true 
      })
      .eq('id', leadId);

    if (updateError) {
      console.error("Supabase update error:", updateError);
      return Response.json({ error: `Cache failed: ${updateError.message}` }, { status: 500, headers: jsonHeaders });
    }

    console.log(`Cached ${reels.length} reels for lead ${leadId}; ER_avg: ${ER_avg}%`);

    return Response.json({ 
      success: true, 
      data: { reels, ER_avg },  // Echo for debug; optional
      leadId  // For chain confirmation
    }, { status: 200, headers: jsonHeaders });
  } catch (err: any) {
    return Response.json({ error: `Processing error: ${err.message}` }, { status: 500, headers: jsonHeaders });
  }
}
