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

// Helper: Run Apify actor and poll for results
async function runApifyActor(apifyInput, APIFY_TOKEN) {
  // Step 1: Run the actor
  const apifyResponse = await fetch(
    "https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=" + APIFY_TOKEN,
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
    throw new Error(errorData.error?.message || "Apify run failed");
  }

  const runData = await apifyResponse.json();
  const runId = runData.data.id;

  // Step 2: Poll for completion (8s intervals, max 5 mins)
  let status = "RUNNING";
  let maxAttempts = 40; // 40 × 8s = 320s
  while (status === "RUNNING" && maxAttempts-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    try {
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`,
        {
          headers: { 
            "Authorization": `Bearer ${APIFY_TOKEN}`,  // Fallback if token query param fails
          },
        }
      );
      if (!statusRes.ok) {
        throw new Error(`Status check failed: ${statusRes.status}`);
      }
      const statusData = await statusRes.json();
      status = statusData.data.status;
    } catch (err) {
      throw new Error(`Polling error: ${err.message}`);
    }
  }

  if (status !== "SUCCEEDED") {
    throw new Error(`Run failed with status: ${status}`);
  }

  // Step 3: Fetch results
  const resultsRes = await fetch(
    `https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items?token=${APIFY_TOKEN}`,
    {
      headers: { 
        "Authorization": `Bearer ${APIFY_TOKEN}`,
      },
    }
  );
  if (!resultsRes.ok) {
    throw new Error(`Failed to fetch results: ${resultsRes.status}`);
  }
  return await resultsRes.json();
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

  try {
    // Run 1: Profile + Recent Posts
    const postsInput = {
      search: username,
      searchType: "user",
      resultsType: "posts",
      resultsLimit: 7,  // Matches your sample
    };
    const postsResults = await runApifyActor(postsInput, APIFY_TOKEN);
    if (!postsResults || postsResults.length === 0) {
      throw new Error("No profile/posts data found");
    }
    const profile = postsResults[0];  // Assume first item is profile

    // Run 2: Recent Reels
    let recentReels = [];
    try {
      const reelsInput = {
        search: username,
        searchType: "user",
        resultsType: "reels",
        resultsLimit: 3,  // As specified
      };
      const reelsResults = await runApifyActor(reelsInput, APIFY_TOKEN);
      recentReels = reelsResults || [];
    } catch (reelsErr) {
      console.warn(`Reels scrape failed (continuing): ${reelsErr.message}`);
    }

    // Extract Profile Basics
    const extracted = {
      username: profile.username,
      followersCount: profile.followersCount,
      followsCount: profile.followsCount || null,
      biography: profile.biography || "",
      externalUrl: profile.externalUrl || null,
      profilePicUrl: profile.profilePicUrl,
      profilePicUrlHD: profile.profilePicUrlHD,
      private: profile.private || false,
      verified: profile.verified || false,
      postsCount: profile.postsCount || 0,
      isBusinessAccount: profile.isBusinessAccount || false,
      businessCategoryName: profile.businessCategoryName || null,
      relatedProfiles: profile.relatedProfiles || [],  // From your sample
    };

    // Extract Recent Posts Metrics (likes, comments; aggregate for qual signals)
    const recentPosts = (profile.latestPosts || []).map((post: any) => ({
      id: post.id,
      shortCode: post.shortCode,
      caption: post.caption || "",
      likesCount: post.likesCount || 0,
      commentsCount: post.commentsCount || 0,
      videoViewCount: post.videoViewCount || null,  // Proxy for shares/views on videos
      timestamp: post.timestamp,
      type: post.type,  // e.g., "Image", "Video", "Sidecar"
    }));
    const postsMetrics = {
      recentPosts,
      aggregates: recentPosts.length > 0 ? {
        avgLikes: Math.round(recentPosts.reduce((sum: number, p: any) => sum + (p.likesCount || 0), 0) / recentPosts.length),
        totalComments: recentPosts.reduce((sum: number, p: any) => sum + (p.commentsCount || 0), 0),
        postTypes: [...new Set(recentPosts.map((p: any) => p.type))],
      } : null,
    };

    // Extract Recent Reels Metrics
    const recentReelsExtracted = recentReels.map((reel: any) => ({
      id: reel.id,
      shortCode: reel.shortCode,
      caption: reel.caption || "",
      likesCount: reel.likesCount || 0,
      commentsCount: reel.commentsCount || 0,
      videoViewCount: reel.videoViewCount || null,  // Views
      videoDuration: reel.videoDuration || null,
      timestamp: reel.timestamp,
    }));

    // Combine
    const fullData = {
      ...extracted,
      postsMetrics,
      recentReels: recentReelsExtracted,
    };

    // Upload Profile Picture (unchanged)
    let uploadMessage = null;
    let uploadSuccess = true;
    try {
      await uploadProfilePicture(
        profile.profilePicUrlHD || profile.profilePicUrl,
        `${username}_pfp.jpg`,
        locals.runtime.env
      );
      uploadMessage = "Profile picture uploaded successfully";
    } catch (err: any) {
      uploadSuccess = false;
      uploadMessage = `Profile picture upload failed: ${err.message}`;
      console.error("Supabase upload error:", err);
    }

    return Response.json({ 
      success: true, 
      data: fullData, 
      upload: { success: uploadSuccess, message: uploadMessage }
    }, { status: 200, headers: jsonHeaders });

  } catch (err: any) {
    console.error("Instagram scrape failed:", err);
    return Response.json({ error: err.message }, { status: 500, headers: jsonHeaders });
  }
}
