// Cloudflare Worker: /api/oai_run.ts
// Chains after website_run + reels_run: Fetches lead data, prompts gpt-5-nano, parses JSON, UPSERTs analysis to Supabase.
// Trigger: In Dashboard.tsx addLead, after website/reels: fetch('/api/oai_run', { body: JSON.stringify({ leadId }) })

import { validateApiTokenResponse } from "@/lib/api";
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'https://esm.sh/openai@4'; // Or pin to compat version

// CORS headers (reuse from others)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',  // Tighten for prod
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
  if (!leadId || typeof leadId !== "number") {
    return new Response(JSON.stringify({ error: "Missing/invalid leadId" }), { 
      status: 400, 
      headers: jsonHeaders 
    });
  }

  // Step 1: Fetch lead data from Supabase
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: lead, error: fetchError } = await supabase
    .from("leads")
    .select("raw_data, reels, website_data, ER_avg")
    .eq('id', leadId)
    .single();

  if (fetchError || !lead) {
    return Response.json({ error: `Lead fetch failed: ${fetchError?.message || 'Not found'}` }, { status: 404, headers: jsonHeaders });
  }

  const { raw_data: profile, reels, website_data, ER_avg } = lead;
  if (!profile || !reels || !website_data) {
    // Graceful: Skip if incomplete chain
    await supabase.from("leads").update({ ai_analysis_complete: false }).eq('id', leadId);
    return Response.json({ success: false, error: "Incomplete data—rerun chain" }, { status: 200, headers: jsonHeaders });
  }

  // Step 2: Hydrate prompt
  const systemPrompt = `You are a lead qualification expert for e-commerce Instagram influencers. Analyze the provided profile, reels engagement, and website content. Extract:
- summary: Concise 2-3 sentence overview of the brand/niche fit (e.g., "Fashion brand targeting Gen Z with sustainable apparel").
- prices: Array of detected product prices (numbers only, e.g., [29.99, 49.99]; infer from text if explicit).
- pricesLow: Array of low-end prices (e.g., sale/outlet items) or null if none.
- niche: Single word or short phrase (e.g., "sustainable fashion").
- otherContact: Any non-Instagram contacts (email/phone) or "none".

Respond ONLY with strict JSON: {"summary": "...", "prices": [num, ...], "pricesLow": [num, ...] | null, "niche": "...", "otherContact": "..."}. No extra text.`;

  const userPrompt = `
Profile: ${JSON.stringify(profile)} (bio: ${profile.biography}, followers: ${profile.followersCount}, verified: ${profile.verified}).
Reels (top 2, ER: ${ER_avg}%): ${JSON.stringify(reels)}.
Website (primary page text): ${website_data.primary?.text?.substring(0, 2000) || 'N/A'}...
Full context: Infer pricing/niche from bio, captions implied in reels, and site content (e.g., shop pages).`;

  // Step 3: Call OpenAI
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-5-nano',  // Confirm/fallback to 'gpt-4o-mini'
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },  // Enforces JSON
      temperature: 0.1,  // Low for structured output
      max_tokens: 500,
    });

    const responseContent = completion.choices[0]?.message?.content;
    if (!responseContent) {
      throw new Error('No response from OpenAI');
    }

    // Step 4: Parse/validate JSON
    let analysis;
    try {
      analysis = JSON.parse(responseContent);
      // Basic validation (add Zod if needed)
      if (!analysis.summary || !Array.isArray(analysis.prices) || typeof analysis.niche !== 'string') {
        throw new Error('Invalid schema');
      }
    } catch (parseErr) {
      throw new Error(`JSON parse failed: ${parseErr.message}`);
    }

    // Step 5: UPSERT to Supabase
    const { error: updateError } = await supabase
      .from("leads")
      .update({ 
        summary: analysis.summary,
        prices: analysis.prices,
        pricesLow: analysis.pricesLow,
        niche: analysis.niche,
        otherContact: analysis.otherContact,
        ai_analysis_complete: true 
      })
      .eq('id', leadId);

    if (updateError) {
      console.error("Supabase update error:", updateError);
      return Response.json({ error: `Cache failed: ${updateError.message}` }, { status: 500, headers: jsonHeaders });
    }

    console.log(`AI analysis cached for lead ${leadId}: niche=${analysis.niche}`);

    return Response.json({ 
      success: true, 
      data: analysis, 
      leadId 
    }, { status: 200, headers: jsonHeaders });

  } catch (err: any) {
    // Graceful: Mark incomplete
    await supabase.from("leads").update({ ai_analysis_complete: false }).eq('id', leadId);
    return Response.json({ error: `AI processing error: ${err.message}` }, { status: 500, headers: jsonHeaders });
  }
}
