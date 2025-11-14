import { validateApiTokenResponse } from "@/lib/api";

// Helper for CORS Responses
function createCorsResponse(body, status, request) {
  console.log("createCorsResponse called with request:", !!request); // Debug: Confirm param presence
  const origin = request?.headers?.get('Origin') || 'https://fulfilled-tasks-456737.framer.app'; // Null-safe + fallback
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin', // For caching
    'Content-Type': 'application/json',
  };
  console.log(`Response origin set to: ${origin}`); // Log for tail
  return new Response(body ? JSON.stringify(body) : null, { status, headers: corsHeaders });
}

export async function OPTIONS({ request }) {
  console.log("OPTIONS handler called with origin:", request.headers.get('Origin')); // Debug: Trace preflight
  return createCorsResponse(null, 204, request); // Preflight with dynamic origin
}

export async function POST({ locals, request }) {
  console.log("POST handler called with origin:", request.headers.get('Origin')); // Debug: Trace main request
  const { API_TOKEN, APIFY_TOKEN } = locals.runtime.env;

  const invalidTokenResponse = await validateApiTokenResponse(request, API_TOKEN);
  if (invalidTokenResponse) {
    return createCorsResponse({ error: "Invalid token" }, invalidTokenResponse.status, request);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return createCorsResponse({ error: "Invalid JSON body" }, 400, request);
  }

  const { username } = body;
  if (!username || typeof username !== "string") {
    return createCorsResponse({ error: "Missing or invalid username" }, 400, request);
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
    return createCorsResponse({ error: errorData.error?.message || "Apify run failed" }, apifyResponse.status, request);
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
    return createCorsResponse({ error: `Run failed with status: ${status}` }, 500, request);
  }

  const resultsRes = await fetch(
    `https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items`,
    {
      headers: { Authorization: `Bearer ${APIFY_TOKEN}` },
    }
  );

  if (!resultsRes.ok) {
    return createCorsResponse({ error: "Failed to fetch results" }, 500, request);
  }

  const results = await resultsRes.json();

  if (!results || results.length === 0) {
    return createCorsResponse({ error: "No profile found for username" }, 404, request);
  }

  const profile = results[0];
  const extracted = {
    username: profile.username,
    profilePicture: profile.profilePicUrlHD || profile.profilePicUrl,
    followersCount: profile.followersCount,
    restricted: profile.private || false,
  };

  return createCorsResponse({ success: true, data: extracted }, 200, request);
}
