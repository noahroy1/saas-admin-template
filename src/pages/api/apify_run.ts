import { validateApiTokenResponse } from "@/lib/api";

export async function POST({ locals, request }) {
  const { API_TOKEN, APIFY_TOKEN } = locals.runtime.env; // DB not needed here, but available if you extend for logging

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

  // Apify input: Scrape X profile for the given username (e.g., https://x.com/grok)
  const apifyInput = {
    startUrls: [`https://instagram.com/${username}`],
    proxy: { useApifyProxy: true }, // Required for reliable scraping; uses your Apify account's proxy
    addUserInfo: true, // Optional: Enrich tweets with user metadata
    // Extend here: e.g., onlyUserInfo: true for profile-only (faster)
  };

  // Step 1: Run the Apify actor
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

  // Step 2: Poll for completion (5s intervals, max ~5 mins)
  let status = "RUNNING";
  let maxAttempts = 60;
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

  // Step 3: Fetch results from dataset
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

  // Optional: Log to D1 for admin visibility (uncomment if DB bound)
  // await DB.prepare("INSERT INTO apify_runs (username, run_id, results_count) VALUES (?, ?, ?)")
  //   .bind(username, runId, results.length)
  //   .run();

  return Response.json({ success: true, runId, results }, { status: 200 });
}
