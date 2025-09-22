/**
 * Trello Comment Scheduler - Cloudflare Worker
 * Author: Dennis Klappe
 * Website: https://klappe.dev
 * GitHub: https://github.com/dennisklappe/
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Add a test endpoint to manually trigger processing
    if (url.pathname === '/process' && request.method === 'GET') {
      const result = await processScheduledComments(env);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/cancel' && request.method === 'POST') {
      try {
        const data = await request.json();
        const { key, trelloToken } = data;

        if (!key || !trelloToken) {
          return new Response(JSON.stringify({ error: 'Missing required fields' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Delete the scheduled item from KV storage
        await env.TRELLO_SCHEDULES.delete(key);

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/schedule' && request.method === 'POST') {
      try {
        const data = await request.json();
        const { cardId, comment, scheduledTime, markComplete, trelloToken } = data;

        if (!cardId || !scheduledTime || !trelloToken) {
          return new Response(JSON.stringify({ error: 'Missing required fields' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Store in KV with timestamp as key for easy sorting
        const key = `schedule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await env.TRELLO_SCHEDULES.put(key, JSON.stringify({
          cardId,
          comment,
          scheduledTime,
          markComplete,
          trelloToken,
          created: new Date().toISOString()
        }), {
          expirationTtl: 7 * 24 * 60 * 60 // Expire after 7 days
        });

        return new Response(JSON.stringify({ success: true, key }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    // Run every minute
    ctx.waitUntil(processScheduledComments(env));
  }
};

async function processScheduledComments(env) {
  const now = Date.now();
  const processed = [];
  const pending = [];
  const errors = [];

  // List all scheduled items
  const list = await env.TRELLO_SCHEDULES.list();

  for (const key of list.keys) {
    const data = await env.TRELLO_SCHEDULES.get(key.name);
    if (!data) continue;

    const schedule = JSON.parse(data);
    const scheduledTime = new Date(schedule.scheduledTime).getTime();

    // If it's time to post
    if (scheduledTime <= now) {
      try {
        // Post comment if provided
        if (schedule.comment) {
          const commentUrl = `https://api.trello.com/1/cards/${schedule.cardId}/actions/comments`;

          // Use URL parameters for Trello API authentication
          const params = new URLSearchParams({
            key: env.TRELLO_API_KEY,
            token: schedule.trelloToken,
            text: schedule.comment
          });

          const commentResponse = await fetch(`${commentUrl}?${params}`, {
            method: 'POST',
            headers: {
              'Accept': 'application/json'
            }
          });

          if (!commentResponse.ok) {
            const errorText = await commentResponse.text();
            errors.push({ key: key.name, error: errorText });
            continue;
          }
        }

        // Update card completion status if specified
        if (schedule.markComplete !== undefined) {
          const cardUrl = `https://api.trello.com/1/cards/${schedule.cardId}`;

          // Use URL parameters for Trello API authentication
          const params = new URLSearchParams({
            key: env.TRELLO_API_KEY,
            token: schedule.trelloToken,
            dueComplete: schedule.markComplete
          });

          const updateResponse = await fetch(`${cardUrl}?${params}`, {
            method: 'PUT',
            headers: {
              'Accept': 'application/json'
            }
          });

          if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            errors.push({ key: key.name, error: errorText });
            continue;
          }
        }

        // Delete the processed schedule
        await env.TRELLO_SCHEDULES.delete(key.name);
        processed.push(key.name);
      } catch (error) {
        errors.push({ key: key.name, error: error.message });
      }
    } else {
      pending.push({ key: key.name, scheduledTime: schedule.scheduledTime });
    }
  }

  const result = {
    processed: processed.length,
    pending: pending.length,
    errors: errors.length,
    details: { processed, pending, errors },
    timestamp: new Date().toISOString()
  };

  return result;
}