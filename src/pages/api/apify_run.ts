import { validateApiTokenResponse } from "@/lib/api";

export async function POST({ locals, request }) {
  const { API_TOKEN, APIFY_TOKEN } = locals.runtime.env; // DB for optional caching/logging

  const invalidTokenResponse = await validateApiTokenResponse(
    request,
    API_TOKEN,
  );
  if (invalidTokenResponse) return invalidTokenResponse;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { username } = body;
  if (!username || typeof username !== "string") {
    return Response.json({ error: "Missing or invalid username" }, { status: 400 });
  }

  // Optimized Apify input: Minimal profile scrape, no posts
  const apifyInput = {
    search: username,
    searchType: "profile",
    searchLimit: 1, // Single match
    resultsType: "details", // Full profile metadata
    resultsLimit: 1, // Skip posts to minimize time/cost
    proxy: { useApifyProxy: true }, // Anti-block essential
  };

  // Step 1: Run the actor
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
    return Response.json(
      { error: errorData.error?.message || "Apify run failed" },
      { status: apifyResponse.status }
    );
  }

  const runData = await apifyResponse.json();
  const runId = runData.data.id;

  // Step 2: Poll for completion (5s intervals, max ~2 mins for light runs)
  let status = "RUNNING";
  let maxAttempts = 24; // Reduced for faster fails on minimal scrapes
  while (status === "RUNNING" && maxAttempts-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}`,
      {
        headers: { Authorization: `Bearer ${APIFY_TOKEN}` },
      }
    );
    const statusData = await statusRes.json();
    status = statusData.data.status;
  }

  if (status !== "SUCCEEDED") {
    return Response.json({ error: `Run failed with status: ${status}` }, { status: 500 });
  }

  // Step 3: Fetch minimal results
  const resultsRes = await fetch(
    `https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items`,
    {
      headers: { Authorization: `Bearer ${APIFY_TOKEN}` },
    }
  );
  if (!resultsRes.ok) {
    return Response.json({ error: "Failed to fetch results" }, { status: 500 });
  }
  const results = await resultsRes.json();

  if (!results || results.length === 0) {
    return Response.json({ error: "No profile found for username" }, { status: 404 });
  }

  // Step 4: Extract essentials (use HD pic for quality)
  const profile = results[0];
  const extracted = {
    username: profile.username,
    profilePicture: profile.profilePicUrlHD || profile.profilePicUrl, // Fallback to low-res
    followersCount: profile.followersCount,
    restricted: profile.private || false, // Insight flag for partial data
  };

  // Optional: Cache in D1 (uncomment for prod)
  // await DB.prepare("INSERT OR REPLACE INTO instagram_cache (username, data, timestamp) VALUES (?, ?, ?)")
  //   .bind(username, JSON.stringify(extracted), Date.now()).run();

  return Response.json({ success: true, data: extracted }, { status: 200 });
}
