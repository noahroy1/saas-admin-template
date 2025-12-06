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

  const { externalUrl, leadId } = body;
  if (!externalUrl || typeof externalUrl !== "string" || !leadId || typeof leadId !== "string") {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_website: false, website_data: null }).eq('id', leadId);
    return Response.json({ success: false, error: "Missing/invalid externalUrl or leadId-website skipped" }, { status: 200, headers: jsonHeaders });
  }

  // fix startUrl as: if `${externalUrl}/collections` returns 404, retry with only ${externalUrl}
  
  let startUrl = externalUrl.endswith('/') ? externalUrl : externalUrl + '/';
  if (!startUrl.includes('collections')) {
    startUrl += 'collections/';
  }

  // Apify input
  const apifyInput = {
    startUrls: [{ url: startUrl }],
    proxy: { useApifyProxy: true },
    maxCrawlPages: 2,
    maxCrawlDepth: 1,
    saveMarkdown: false,
    saveHtml: false,
    saveScreenshots: false,
    blockMedia: true,
    removeElementsCssSelector: "nav, footer, script, style, noscript, svg, img[src^='data:'], [role=\"alert\"], [role=\"banner\"], [role=\"dialog\"], [role=\"alertdialog\"], [role=\"region\"][aria-label*=\"skip\" i], [aria-modal=\"true\"]",
    htmlTransformer: "none",
  };

  // Step 1: Run actor (Bearer)
  let apifyResponse;
  try {
    apifyResponse = await fetch(
      "https://api.apify.com/v2/acts/apify~website-content-crawler/runs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${APIFY_TOKEN}`,  // ← Added; removed ?token=
        },
        body: JSON.stringify(apifyInput),
      }
    );
  } catch (fetchErr) {
    console.error("Apify run fetch error:", fetchErr);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_website: false, website_data: null }).eq('id', leadId);
    return Response.json({ success: false, error: `Fetch failed: ${fetchErr.message}—website skipped` }, { status: 200, headers: jsonHeaders });
  }
  

  if (!apifyResponse.ok) {
    const errorData = await apifyResponse.json().catch(() => ({}));  // Safe parse
    console.error("Apify run error:", errorData);  // ← Log for CF tail
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_website: false, website_data: null }).eq('id', leadId);
    return Response.json({ success: false, error: errorData.error?.message || "Apify run failed - website skipped" }, { status: 200, headers: jsonHeaders });
  }

  const runData = await apifyResponse.json();
  const runId = runData.data.id;
  console.log("Apify run started:", runId);  // ← Debug

  // Step 2: Poll (Bearer)
  let status = "RUNNING";
  let maxAttempts = 40;
  while (status === "RUNNING" && maxAttempts-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    try {
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}`,  // ← No ?token=
        {
          headers: { 
            "Authorization": `Bearer ${APIFY_TOKEN}`,
          },
        }
      );
      if (!statusRes.ok) {
        const errData = await statusRes.json().catch(() => ({}));
        console.error("Status poll error:", statusRes.status, errData);  // ← Log
        throw new Error(`Status check failed: ${statusRes.status}`);
      }
      const statusData = await statusRes.json();
      status = statusData.data.status;
      console.log("Poll status:", status);  // ← Debug (runs ~5x typically)
    } catch (err) {
      console.error("Polling error:", err);  // ← Log
      status = "FAILED";
    }
  }

  if (status !== "SUCCEEDED") {
    console.error("Run failed:", status);  // ← Log
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_website: false, website_data: null }).eq('id', leadId);
    return Response.json({ success: false, error: `Run failed with status: ${status} - website skipped` }, { status: 200, headers: jsonHeaders });
  }

  // Step 3: Fetch results (header only)
  let results;
  try {
    const defaultDatasetId = runData.data.defaultDatasetId;
    if (!defaultDatasetId) {
      throw new Error("No defaultDatasetId in run response");  // ← Explicit check
    }
    console.log("Fetching dataset:", defaultDatasetId);  // ← Debug

    const resultsRes = await fetch(
      `https://api.apify.com/v2/datasets/${defaultDatasetId}/items`,  // ← No ?token=
      {
        headers: { 
          "Authorization": `Bearer ${APIFY_TOKEN}`,
        },
      }
    );

    if (!resultsRes.ok) {
      const errData = await resultsRes.json().catch(() => ({}));
      console.error("Results fetch error:", resultsRes.status, errData);
      throw new Error(`Failed to fetch results: ${resultsRes.status} - ${errData.error?.message || "Unknown"}`);
    }

    results = await resultsRes.json();
    console.log("Results count:", results?.length || 0);
  } catch (err) {
    console.error("Results fetch error:", err);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_website: false, website_data: null }).eq('id', leadId);
    return Response.json({ success: false, error: `Results error: ${err.message}—website skipped` }, { status: 200, headers: jsonHeaders });
  }

  if (!results || results.length === 0) {
    console.warn("No pages scraped");
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("leads").update({ has_website: false, website_data: null }).eq('id', leadId);
    return Response.json({ success: false, error: "No pages scraped—website skipped" }, { status: 200, headers: jsonHeaders });
  }

    // Step 4: Extract (unchanged; structure matches docs)
    // must determine what is actually required here ***
  const extractedPages = results.map((page: any) => ({
    url: page.url || page['#url'] || '',  // ← Fallback for prefix (rare)
    loadedUrl: page.crawl?.loadedUrl || page.url,
    depth: page.crawl?.depth || 0,
    title: page.metadata?.title || "",
    description: page.metadata?.description || "",
    author: page.metadata?.author || null,
    keywords: page.metadata?.keywords || null,
    language: page.metadata?.languageCode || "en",
    text: page.text || page['#text'] || "",  // ← Fallback
    markdown: page.markdown || page['#markdown'] || "",
    screenshotUrl: page.screenshotUrl || null,
  }));

  const primaryPage = extractedPages.find((p: any) => p.depth === 0) || extractedPages[0];
  const website_data = {
    inputUrl: externalUrl,
    pagesCount: extractedPages.length,
    primary: primaryPage,
    allPages: extractedPages,
  };

  console.log(`Scraped ${extractedPages.length} pages from ${externalUrl}`);  // ← Existing

    // Step 5: Supabase UPSERT
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { error: updateError } = await supabase
    .from("leads")
    .update({
      website_data,
      has_website: true
    })
    .eq('id', leadId);

  if (updateError) {
    console.error("Supabase update error:", updateError);
    return Response.json({ error: `Cache failed: ${updateError.message}` }, { status: 500, headers: jsonHeaders });
  }

  console.log(`Cached website_data for lead ${leadId}: ${website_data.pageCount} pages`);
    
  return Response.json({ 
    success: true, 
    data: website_data,
    leadId
  }, { status: 200, headers: jsonHeaders });
}
