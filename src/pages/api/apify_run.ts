import { validateApiTokenResponse } from "@/lib/api";
import { createClient } from '@supabase/supabase-js';

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

const SUPABASE_URL = "https://vyiyzapirdkiateytpwo.supabase.co";

export async function uploadProfilePicture(imageUrl: string, storagePath: string, env: Env) {
  // Create Supabase client on-the-fly (service_role key bypasses RLS – safe in Worker only)
  const supabase = createClient(SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  // Download the image
  const imageResponse = await fetch(imageUrl);

  if (!imageResponse.ok || imageResponse.body === null) {
    throw new Error(`Failed to download image: ${imageResponse.status} ${imageResponse.statusText}`);
  }

  const contentType = imageResponse.headers.get("content-type") ?? "image/jpeg";

  // Stream directly, zero full buffering in memory
  const { data, error } = await supabase.storage
    .from("profile_pictures")
    .upload(storagePath, imageResponse.body, {
      contentType,
      upsert: true,               // change to false if you don't want overwrite
      duplex: "half",             // required when passing a ReadableStream in some runtimes
    });

  if (error) {
    // Duplicate error is common on upsert – you can ignore it if you used upsert: true
    if (error.message.includes("Duplicate")) {
      console.log("File already exists (upsert succeeded)");
      return;
    }
    throw error;
  }

  console.log("Upload successful", data);
}

// Main function
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
      { status: apifyResponse.status, headers: jsonHeaders }
    );
  }

  const runData = await apifyResponse.json();
  const runId = runData.data.id;

  // Step 2: Poll for completion (10s intervals, max 5 mins to stay under subrequest limits)
  let status = "RUNNING";
  let maxAttempts = 40; // 40 × 8s = 320s, ~42 subrequests total <50 limit
  while (status === "RUNNING" && maxAttempts-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 8000)); // Increased interval
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

    // Step 4: Extract essentials + upload profile picture
    const profile = results[0];
    
    let uploadMessage = null;
    let uploadSuccess = true;
    
    try {
      await uploadProfilePicture(
        profile.profilePicUrlHD || profile.profilePicUrl,
        `${username}_pfp.jpg`,
        locals.runtime.env   // ← fixed: was "env"
      );
      uploadMessage = "Profile picture uploaded successfully";
    } catch (err: any) {
      uploadSuccess = false;
      uploadMessage = `Profile picture upload failed: ${err.message}`;
      // We deliberately continue — the core data is still valid
      console.error("Supabase upload error:", err);
    }
    
    const extracted = {
      username: profile.username,
      followersCount: profile.followersCount,
      restricted: profile.isPrivate || false, // Maps to private flag
      verified: profile.isVerified || false, // New: Verified status
      biography: profile.biography || "", // New: Bio text
      profilePicture: profile.profilePicUrlHD || profile.profilePicUrl,
      // relatedProfiles intentionally omitted here
      externalUrl: profile.externalUrl || null,  // ← New: Cache the external link (null if missing)
    };

    const relatedAccounts = profile.relatedProfiles
      ? { relatedAccounts: profile.relatedProfiles }
      : { relatedAccounts: [] };

    // Optional: Cache in D1 (uncomment for prod)
    // await DB.prepare("INSERT OR REPLACE INTO instagram_cache (username, data, timestamp) VALUES (?, ?, ?)")
    //   .bind(username, JSON.stringify(extracted), Date.now()).run();

    // In success return
    return Response.json({ success: true, data: extracted, relatedAccounts, upload: { success: uploadSuccess, message: uploadMessage }}, { status: 200, headers: jsonHeaders });
  } catch (err) {
    return Response.json({ error: `Results processing error: ${err.message}` }, { status: 500, headers: jsonHeaders });
  }
}
