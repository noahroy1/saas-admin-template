import { validateApiTokenResponse } from "@/lib/api";

export async function OPTIONS({ request }) {
  console.log("OPTIONS called - origin:", request?.headers?.get('Origin')); // Debug: Trace preflight
  const origin = request?.headers?.get('Origin') || 'https://fulfilled-tasks-456737.framer.app'; // Null-safe fallback
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
  console.log(`OPTIONS response origin set to: ${origin}`); // Log for tail
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST({ locals, request }) {
  console.log("POST called - origin:", request.headers.get('Origin')); // Debug: Trace main request
  const { API_TOKEN, APIFY_TOKEN } = locals.runtime.env;

  const origin = request.headers.get('Origin') || 'https://fulfilled-tasks-456737.framer.app'; // Fallback
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
  console.log(`POST response origin set to: ${origin}`); // Log for tail

  const invalidTokenResponse = await validateApiTokenResponse(request, API_TOKEN);
  if (invalidTokenResponse) {
    return new Response(JSON.stringify({ error: "Invalid token" }), { status: invalidTokenResponse.status, headers: corsHeaders });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: corsHeaders });
  }

  const { username } = body;
  if (!username || typeof username !== "string") {
    return new Response(JSON.stringify({ error: "Missing or invalid username" }), { status: 400, headers: corsHeaders });
  }

  // Optimized Apify input: Minimal profile scrape, no posts
  const apifyInput = {
    search: username,
    searchType: "user",
    searchLimit: 1,
    resultsType: "details",
    resultsLimit: 1,
    proxy: { useApifyProxy: true },
  };

  const apifyResponse = await fetch(
    "https://api.apify.com/v2/acts/apify~instagram-scraper/runs",
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
    return new Response(JSON.stringify({ error: errorData.error?.message || "Apify run failed" }), { status: apifyResponse.status, headers: corsHeaders });
  }

  const runData = await apifyResponse.json();
  const runId = runData.data.id;

  // Step 2: Poll for completion (2s intervals, max ~40s)
  let status = "RUNNING";
  let maxAttempts = 20;
  while (status === "RUNNING" && maxAttempts-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}`,
        {
          headers: { Authorization: `Bearer ${APIFY_TOKEN}` },
        }
      );
      const statusData = await statusRes.json();
      status = statusData.data.status;
    } catch (err) {
      console.error("Status fetch error:", err);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  if (status !== "SUCCEEDED") {
    return new Response(JSON.stringify({ error: `Run failed with status: ${status}` }), { status: 500, headers: corsHeaders });
  }

  const resultsRes = await fetch(
    `https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items`,
    {
      headers: { Authorization: `Bearer ${APIFY_TOKEN}` },
    }
  );

  if (!resultsRes.ok) {
    return new Response(JSON.stringify({ error: "Failed to fetch results" }), { status: 500, headers: corsHeaders });
  }

  const results = await resultsRes.json();

  if (!results || results.length === 0) {
    return new Response(JSON.stringify({ error: "No profile found for username" }), { status: 404, headers: corsHeaders });
  }

  const profile = results[0];
  const extracted = {
    username: profile.username,
    profilePicture: profile.profilePicUrlHD || profile.profilePicUrl,
    followersCount: profile.followersCount,
    restricted: profile.private || false,
  };

  return new Response(JSON.stringify({ success: true, data: extracted }), { status: 200, headers: corsHeaders });
}
