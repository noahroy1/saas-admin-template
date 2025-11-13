import type { Context } from '@astrojs/cloudflare'; // Or your env type

export const POST = async (context: Context) => {
  // Your code from before: Validate key, parse body, call Apify, poll, return JSON
  const callerKey = context.request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!callerKey || callerKey !== context.locals.runtime.env.YOUR_APP_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
  // ... (rest of the Apify logic, using context.locals.runtime.env.APIFY_TOKEN for secrets)
};
import { Hono } from 'hono'; // Already in template

const app = new Hono(); // Your existing app instance

// New route: Secure with your app's API key (e.g., from D1 or header)
app.post('/api/apify-run', async (c) => {
  // Step 1: Validate caller's key (your web app's auth—e.g., from header or D1 lookup)
  const callerKey = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!callerKey || callerKey !== c.env.YOUR_APP_SECRET_KEY) { // Or query D1 for user-specific
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Step 2: Parse input from Framer (e.g., { actorId: 'your-actor', input: { startUrls: [...] } })
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const { actorId, input = {}, options = { timeout: 3600 } } = body;

  if (!actorId) return c.json({ error: 'Missing actorId' }, 400);

  // Step 3: Call Apify (Bearer auth, JSON body)
  const apifyResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.APIFY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input, ...options }),
  });

  if (!apifyResponse.ok) {
    const error = await apifyResponse.json();
    // Handle specifics: 429? Retry logic below
    return c.json({ error: error.error?.message || 'Apify failed' }, apifyResponse.status);
  }

  const runData = await apifyResponse.json();
  const runId = runData.data.id;

  // Step 4: Poll for completion (Apify runs async—poll /runs/{runId} every 5s, max 5 mins)
  let status = 'RUNNING';
  let maxAttempts = 60; // ~5 mins
  while (status === 'RUNNING' && maxAttempts-- > 0) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5s backoff
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${c.env.APIFY_TOKEN}` },
    });
    const statusData = await statusRes.json();
    status = statusData.data.status;
  }

  if (status !== 'SUCCEEDED') {
    return c.json({ error: `Run failed: ${status}` }, 500);
  }

  // Step 5: Fetch results (from defaultDatasetId)
  const resultsRes = await fetch(`https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items`, {
    headers: { 'Authorization': `Bearer ${c.env.APIFY_TOKEN}` },
  });
  const results = await resultsRes.json();

  // Optional: Log to D1 for admin dashboard
  await c.env.DB.prepare('INSERT INTO apify_runs (run_id, caller_key, results_count) VALUES (?, ?, ?)')
    .bind(runId, callerKey, results.length).run();

  return c.json({ success: true, runId, results });
});

// Global error handler for 429 (rate limit)
app.onError((err, c) => {
  if (c.req.method === 'POST' && c.req.url.includes('/api/apify-run')) {
    // Exponential backoff stub—implement full retry in prod
    return c.json({ error: 'Rate limited—retry later' }, 429);
  }
  return c.json({ error: err.message }, 500);
});

export default app;
