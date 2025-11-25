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
  const { API_TOKEN, OPENAI_API_KEY } = locals.runtime.env;

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

  const { scrapedData, leadId } = body;
  if (!scrapedData || typeof scrapedData !== "object") {
    return new Response(JSON.stringify({ error: "Missing or invalid scrapedData" }), { 
      status: 400, 
      headers: jsonHeaders
    });
  }

  if (leadId && (typeof leadId !== "string" && typeof leadId !== "number")) {
    return new Response(JSON.stringify({ error: "Invalid leadId (optional)" }), { 
      status: 400, 
      headers: jsonHeaders
    });
  }

  // Step 1: Prep input for OpenAI (trim to ~4K tokens; use primary markdown for concision)
  const primaryContent = scrapedData.primary?.markdown || scrapedData.primary?.text || "";
  const inputText = primaryContent.length > 4000 
    ? primaryContent.substring(0, 4000) + "\n\n[Truncated for brevity; full site scraped if needed]" 
    : primaryContent;

  // Optional: Append multi-page context if shallow (e.g., /about text)
  let fullContext = inputText;
  if (scrapedData.allPages && scrapedData.allPages.length > 1) {
    const secondaryTexts = scrapedData.allPages
      .filter((p: any) => p.depth > 0)
      .slice(0, 2)  // Top 2 sub-pages
      .map((p: any) => p.text?.substring(0, 500) || "")  // Short excerpts
      .join("\n\n--- Sub-page ---\n\n");
    fullContext += `\n\nAdditional pages context:\n${secondaryTexts}`;
  }

  // Step 2: OpenAI Prompt (your template: Lead-qual JSON focus)
  const prompt = `Analyze this website content for lead qualification in a B2B SaaS context. Extract key insights only—be concise, factual, and structured.

Website URL: ${scrapedData.inputUrl}
Title: ${scrapedData.primary?.title || "N/A"}
Description: ${scrapedData.primary?.description || "N/A"}

Content to analyze:
${fullContext}

Instructions:
- Industry/Sector: Primary business focus (e.g., "Digital Marketing").
- Services/Products: Bullet list of 3-5 core offerings (e.g., ["SEO Optimization", "PPC Ads"]).
- Target Audience: Demographics/niches (e.g., "SMB e-commerce owners, 25-45yo").
- Value Proposition: 1-sentence unique selling point.
- Contact Signals: Any emails, forms, or outreach hooks (or "None detected").
- Full Summary: 150-200 word overview tying it all (for quick read).

Output STRICT JSON only—no extra text. Schema:
{
  "industry": "string",
  "services": ["string", ...],
  "audience": "string",
  "valueProp": "string",
  "contactInfo": "string|null",
  "fullSummary": "string"
}`;

  // Step 3: Call OpenAI (gpt-4o-mini, max 500 output tokens for cost)
  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5-nano",
        messages: [
          { role: "system", content: "You are a precise lead qualification analyst. Respond with valid JSON only." },
          { role: "user", content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.3,  // Low for factual consistency
        response_format: { type: "json_object" }  // Enforces JSON
      }),
    });

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.json();
      throw new Error(errorData.error?.message || "OpenAI API failed");
    }

    const openaiData = await openaiResponse.json();
    const rawSummary = openaiData.choices[0]?.message?.content;

    // Parse JSON (with fallback if malformed)
    let summary;
    try {
      summary = JSON.parse(rawSummary);
    } catch (parseErr) {
      throw new Error(`JSON parse failed: ${parseErr.message}. Raw: ${rawSummary.substring(0, 200)}...`);
    }

    // Validate schema basics (MVP safety)
    if (!summary.industry || !Array.isArray(summary.services)) {
      throw new Error("Invalid summary structure from OpenAI");
    }

    const responseData = {
      success: true,
      summary,
      leadId,  // Echo back for Framer/Supabase
      inputTokenEstimate: Math.floor(fullContext.length / 4),  // Rough; ~$0.0001
    };

    console.log(`Generated summary for ${scrapedData.inputUrl}: Industry=${summary.industry}`);

    return Response.json(responseData, { status: 200, headers: jsonHeaders });
  } catch (err: any) {
    console.error("Concision error:", err);
    return Response.json({ 
      error: `Summary generation failed: ${err.message}`,
      leadId  // Echo for retry context
    }, { status: 500, headers: jsonHeaders });
  }
}
