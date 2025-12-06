// Cloudflare Worker: /api/oai_run.ts
// Chains after website_run + reels_run: Fetches lead, prompts gpt-4o-mini, parses JSON, UPSERTs {openai: analysis} to Supabase.
// Trigger: FE button post-profile (e.g., "Qualify Lead" → fetch('/api/oai_run', { body: JSON.stringify({ leadId }) }))

import { validateApiTokenResponse } from "@/lib/api";
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai'; // ESM compat for Workers

// CORS (consistent with siblings)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',  // Tighten to your Framer domain in prod
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
  const { API_TOKEN, OPENAI_API_KEY, SUPABASE_SERVICE_ROLE_KEY } = locals.runtime.env;

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

  const { leadId } = body;
  if (!leadId || typeof leadId !== "string") {  // Changed: string, not number
    return new Response(JSON.stringify({ error: "Missing/invalid leadId" }), { 
      status: 400, 
      headers: jsonHeaders 
    });
  }

  // Step 1: Fetch lead (service role bypasses RLS)
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: lead, error: fetchError } = await supabase
    .from("leads")
    .select("raw_data, reels, website_data, er_avg, openai")  // Include existing openai for idempotency
    .eq('id', leadId)
    .single();

  if (fetchError || !lead) {
    return Response.json({ error: `Lead fetch failed: ${fetchError?.message || 'Not found'}` }, { status: 404, headers: jsonHeaders });
  }

  const { raw_data: profile, reels, website_data, er_avg, openai: existingOpenai } = lead;
  if (existingOpenai && Object.keys(existingOpenai).length > 0) {
    return Response.json({ success: true, data: existingOpenai, leadId, cached: true }, { status: 200, headers: jsonHeaders });
  }

  // Graceful if incomplete: Proceed with what's available (e.g., no website → prices=[])
  const hasReels = !!reels && reels.length > 0;
  const hasWebsite = !!website_data && website_data.pagesCount > 0;
  if (!profile) {
    await supabase.from("leads").update({ ai_analysis_complete: false, openai: { summary: null, prices: [], pricesLow: "", niche: null, otherContact: "" } }).eq('id', leadId);
    return Response.json({ success: false, error: "No profile data—rerun apify_run first" }, { status: 200, headers: jsonHeaders });
  }

  // Step 2: Hydrate prompt (refine later; focuses on e-comm signals)
  const systemPrompt = `You are a lead qualification expert for Instagram e-commerce influencers. Analyze the profile bio/followers, reels engagement, and website text for brand fit. Extract precisely:
- summary: 2-3 sentence overview (e.g., "Sustainable fashion brand targeting millennials via TikTok-style reels").
- prices: Array of product prices as strings from site/bio (e.g., ["$29.99", "$49.99"]; infer/compare from HTML text; empty [] if none).
- pricesLow: Array of discounted/low-end prices as strings (e.g., ["$19.99"]; "" if none detected).
- niche: Short phrase (e.g., "eco-friendly apparel").
- otherContact: Non-IG contacts (e.g., "hello@brand.com") or "".

Respond ONLY with strict JSON: {"summary": "str", "prices": ["str", ...], "pricesLow": ["str", ...] | "", "niche": "str", "otherContact": "str"}. No extras.`;

  const userPrompt = `
Profile: ${JSON.stringify(profile)} (bio: ${profile.biography || 'N/A'}, followers: ${profile.followersCount || 0}, verified: ${profile.verified || false}, externalUrl: ${profile.externalUrl || 'N/A'}).
${hasReels ? `Reels (top ${reels.length}, er_avg: ${er_avg || 0}%): ${JSON.stringify(reels)}.` : 'No reels data.'}
${hasWebsite ? `Website (text from ${website_data.pagesCount} pages): ${website_data.primary?.text?.substring(0, 1500) || website_data.allPages?.[0]?.text?.substring(0, 1500) || 'N/A'}...` : 'No website data.'}
Infer niche from bio/reels captions; prices from site shop text (catch "$X.XX" patterns); prioritize engagement for summary.`;

  // Step 3: OpenAI call
  let analysis;
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 400,
    });

    const responseContent = completion.choices[0]?.message?.content;
    if (!responseContent) {
      throw new Error('Empty OpenAI response');
    }

    analysis = JSON.parse(responseContent);
    if (typeof analysis.summary !== 'string' ||
        !Array.isArray(analysis.prices) ||
        (analysis.pricesLow !== "" && !Array.isArray(analysis.pricesLow)) ||
        typeof analysis.niche !== 'string' ||
        typeof analysis.otherContact !== 'string') {
      throw new Error('Schema mismatch');
    }
    if (analysis.pricesLow === "") analysis.pricesLow = [];
  } catch (err: any) {
    console.error("OpenAI error:", err);
    const fallback = { summary: null, prices: [], pricesLow: [], niche: null, otherContact: "" };
    await supabase.from("leads").update({ openai: fallback, ai_analysis_complete: false }).eq('id', leadId);
    return Response.json({ success: false, error: `AI error: ${err.message}-analysis skipped`, data: fallback }, { status: 200, headers: jsonHeaders });
  }

  // Step 4: UPSERT
  const { error: updateError } = await supabase
    .from("leads")
    .update({
      openai: analysis,
      ai_analysis_complete: true
    })
    .eq('id', leadId);

  if (updateError) {
    console.error("Supabase update error:", updateError);
    return Response.json({ error: `Cache failed: ${updateError.message}` }, { status: 500, headers: jsonHeaders });
  }

  console.log(`AI analysis cached for lead ${leadId}: niche="${analysis.niche}", prices=${analysis.prices.length} items`);

  return Response.json({
    success: true,
    data: analysis,
    leadId
  }, { status: 200, headers: jsonHeaders });
}
