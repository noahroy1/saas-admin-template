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

  const { externalUrl } = body;
  if (!externalUrl || typeof externalUrl !== "string") {
    return new Response(JSON.stringify({ error: "Missing or invalid externalUrl" }), { 
      status: 400, 
      headers: jsonHeaders
    });
  }

  // Optimized Apify input: Single start URL, limited pages for efficiency (business sites rarely need deep crawls)
  // Defaults from your schema, but cap maxCrawlPages to 10 to avoid overload/costs
  const apifyInput = {
    startUrls: [{ url: externalUrl }],
    proxy: { useApifyProxy: true },
    maxCrawlPages: 10,  // ← Slimmed from 9999999 for MVP (adjust if needed)
    maxCrawlDepth: 2,   // ← Reasonable for site trees
    saveMarkdown: true,
    saveHtml: false,    // Skip HTML to reduce payload
    saveScreenshots: false,  // Skip for now (add if visual concision needed)
    blockMedia: true,
    removeElementsCssSelector: "nav, footer, script, style, noscript, svg, img[src^='data:'], [role=\"alert\"], [role=\"banner\"], [role=\"dialog\"], [role=\"alertdialog\"], [role=\"region\"][aria-label*=\"skip\" i], [aria-modal=\"true\"]",
    htmlTransformer: "readableText",  // Ensures clean text
    // Other defaults: aggressivePrune: false, expandIframes: true, etc. (omitted for brevity; add if custom)
  };

  // Step 1: Run the actor
  const apifyResponse = await fetch(
    "https://api.apify.com/v2/acts/apify~website-content-crawler/runs?token=" + APIFY_TOKEN,  // ← Token appended as per your link
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

  // Step 2: Poll for completion (same as Instagram: 8s intervals, ~5 min max)
  let status = "RUNNING";
  let maxAttempts = 40;  // 40 × 8s = 320s
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
      return Response.json({ error: `Polling error: ${err.message}` }, { status: 500, headers: jsonHeaders });
    }
  }

  if (status !== "SUCCEEDED") {
    return Response.json({ error: `Run failed with status: ${status}` }, { status: 500, headers: jsonHeaders });
  }

  // Step 3: Fetch results (dataset items)
  try {
    const resultsRes = await fetch(
      `https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items?token=${APIFY_TOKEN}`,
      {
        headers: { 
          "Authorization": `Bearer ${APIFY_TOKEN}`,
        },
      }
    );
    if (!resultsRes.ok) {
      return Response.json({ error: `Failed to fetch results: ${resultsRes.status}` }, { status: 500, headers: jsonHeaders });
    }
    const results = await resultsRes.json();

    if (!results || results.length === 0) {
      return Response.json({ error: "No pages scraped from URL" }, { status: 404, headers: jsonHeaders });
    }

    // Step 4: Extract essentials for OpenAI concision
    // Focus: Primary page (depth 0) + summaries of others; aggregate text/markdown for prompt feeding
    // Unnecessary fields (e.g., full crawl obj) omitted; cleaned for brevity
    const extractedPages = results.map((page: any) => ({
      url: page.url,
      loadedUrl: page.crawl?.loadedUrl || page.url,
      depth: page.crawl?.depth || 0,
      title: page.metadata?.title || "",
      description: page.metadata?.description || "",
      author: page.metadata?.author || null,
      keywords: page.metadata?.keywords || null,
      language: page.metadata?.languageCode || "en",
      text: page.text || "",  // Cleaned readable text (ideal for concision)
      markdown: page.markdown || "",  // Full structured content
      screenshotUrl: page.screenshotUrl || null,  // If enabled later
    }));

    // Aggregate for easy OpenAI input: Concat primary text/markdown, with pages array for details
    const primaryPage = extractedPages.find((p: any) => p.depth === 0) || extractedPages[0];
    const fullText = primaryPage.text;
    const fullMarkdown = primaryPage.markdown;
    const aggregated = {
      inputUrl: externalUrl,
      pagesCount: extractedPages.length,
      primary: primaryPage,
      allPages: extractedPages,  // Full array if multi-page analysis needed
      // For OpenAI: Feed fullMarkdown or fullText directly into prompt
    };

    console.log(`Scraped ${extractedPages.length} pages from ${externalUrl}`);

    return Response.json({ 
      success: true, 
      data: aggregated 
    }, { status: 200, headers: jsonHeaders });
  } catch (err) {
    return Response.json({ error: `Results processing error: ${err.message}` }, { status: 500, headers: jsonHeaders });
  }

  // Auto-chain to concision if flagged
  const url = new URL(request.url);
  if (url.searchParams.get('autoConcise') === 'true') {
    try {
      const conciseRes = await fetch('https://saas-admin-template.noahroyy1.workers.dev/api/concise_run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': request.headers.get('Authorization') || `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify({ scrapedData: aggregated }),
      });

      if (conciseRes.ok) {
        const conciseData = await conciseRes.json();
        if (conciseData.success) {
          return Response.json({
            success: true,
            scrapedData: aggregated,
            conciseData: conciseData.summary
          }, { status: 200, headers: jsonHeaders });
        }
      }
      console.warn('Auto-concise failed; returning scraped data');
    } catch (chainErr) {
      console.error('Chain error:', chainErr);
    }
  }
  return Response.json({ success: true, data: aggregated }, { status: 200, headers: jsonHeaders });
}
