import { validateApiTokenResponse } from "@/lib/api";

// CORS headers constant for reuse
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

  const { username } = body;
  if (!username || typeof username !== "string") {
    return new Response(JSON.stringify({ error: "Missing or invalid username" }), { 
      status: 400, 
      headers: jsonHeaders
    });
  }

  // Optimized Apify input: Direct profile scrape via usernames array
  const apifyInput = {
    usernames: [username], // Array as per schema (singleton for now)
    proxy: { useApifyProxy: true }, // Anti-block essential
  };

  // Step 1: Run the actor (profile-specific ID)
  const apifyResponse = await fetch(
    "https://api.apify.com/v2/acts/dSCLg0C3YEZ83HzYX/runs",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
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

  // Step 2: Poll for completion (10s intervals, max 5 mins to stay under subrequest limits)
  let status = "RUNNING";
  let maxAttempts = 30; // 30 × 10s = 300s, ~32 subrequests total <50 limit
  while (status === "RUNNING" && maxAttempts-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 10000)); // Increased interval
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

  // Step 3: Fetch minimal results
  try {
    const resultsRes = await fetch(
      `https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items`,
      {
        headers: { Authorization: `Bearer ${APIFY_TOKEN}` },
      }
    );
    if (!resultsRes.ok) {
      return Response.json({ error: `Failed to fetch results: ${resultsRes.status}` }, { status: 500, headers: jsonHeaders });
    }
    const results = await resultsRes.json();

    if (!results || results.length === 0) {
      return Response.json({ error: "No profile found for username" }, { status: 404, headers: jsonHeaders });
    }

    // Step 4: Extract essentials (updated for new fields; HD pic priority)
    const profile = results[0];
    const extracted = {
      username: profile.username,
      profilePicture: profile.profilePicUrlHD || profile.profilePicUrl, // Fallback to low-res
      followersCount: profile.followersCount,
      restricted: profile.isPrivate || false, // Maps to private flag
      verified: profile.isVerified || false, // New: Verified status
      biography: profile.biography || "", // New: Bio text
    };

    // Optional: Cache in D1 (uncomment for prod)
    // await DB.prepare("INSERT OR REPLACE INTO instagram_cache (username, data, timestamp) VALUES (?, ?, ?)")
    //   .bind(username, JSON.stringify(extracted), Date.now()).run();

    // In success return
    return Response.json({ success: true, data: extracted }, { status: 200, headers: jsonHeaders });
  } catch (err) {
    return Response.json({ error: `Results processing error: ${err.message}` }, { status: 500, headers: jsonHeaders });
  }
}
