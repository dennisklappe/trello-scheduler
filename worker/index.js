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

        // Get the schedule to find its minute index
        const scheduleData = await env.TRELLO_SCHEDULES.get(key);
        if (scheduleData) {
          const schedule = JSON.parse(scheduleData);
          const scheduledTimestamp = new Date(schedule.scheduledTime).getTime();
          const minuteKey = `minute_${Math.floor(scheduledTimestamp / 60000)}`;

          // Remove from minute index
          const minuteData = await env.TRELLO_SCHEDULES.get(minuteKey);
          if (minuteData) {
            const scheduleKeys = JSON.parse(minuteData);
            const updatedKeys = scheduleKeys.filter(k => k !== key);
            if (updatedKeys.length > 0) {
              await env.TRELLO_SCHEDULES.put(minuteKey, JSON.stringify(updatedKeys), {
                expirationTtl: 7 * 24 * 60 * 60
              });
            } else {
              // If no more schedules for this minute, delete the index
              await env.TRELLO_SCHEDULES.delete(minuteKey);
            }
          }
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

        // Use scheduled timestamp as part of the key for direct lookup
        const scheduledTimestamp = new Date(scheduledTime).getTime();
        const key = `schedule_${scheduledTimestamp}_${Math.random().toString(36).substr(2, 9)}`;

        // Store the schedule data
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

        // Add to minute index for efficient lookup
        const minuteKey = `minute_${Math.floor(scheduledTimestamp / 60000)}`;
        const existingMinute = await env.TRELLO_SCHEDULES.get(minuteKey);
        const scheduleKeys = existingMinute ? JSON.parse(existingMinute) : [];
        scheduleKeys.push(key);

        await env.TRELLO_SCHEDULES.put(minuteKey, JSON.stringify(scheduleKeys), {
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
  const currentMinute = Math.floor(now / 60000);
  const processed = [];
  const errors = [];

  // Look up schedules for the current minute (no list operation!)
  const minuteKey = `minute_${currentMinute}`;
  const minuteData = await env.TRELLO_SCHEDULES.get(minuteKey);

  if (!minuteData) {
    // No schedules for this minute
    return {
      processed: 0,
      errors: 0,
      details: { processed: [], errors: [] },
      timestamp: new Date().toISOString(),
      minute: currentMinute
    };
  }

  const scheduleKeys = JSON.parse(minuteData);
  const remainingKeys = [];

  // Process each scheduled item for this minute
  for (const key of scheduleKeys) {
    const data = await env.TRELLO_SCHEDULES.get(key);
    if (!data) continue;

    const schedule = JSON.parse(data);
    const scheduledTime = new Date(schedule.scheduledTime).getTime();

    // Double-check if it's time to post (in case of slight timing differences)
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
            errors.push({ key, error: errorText });
            remainingKeys.push(key); // Keep in index to retry
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
            errors.push({ key, error: errorText });
            remainingKeys.push(key); // Keep in index to retry
            continue;
          }
        }

        // Delete the processed schedule
        await env.TRELLO_SCHEDULES.delete(key);
        processed.push(key);
      } catch (error) {
        errors.push({ key, error: error.message });
        remainingKeys.push(key); // Keep in index to retry
      }
    } else {
      // Not time yet, keep it in the index
      remainingKeys.push(key);
    }
  }

  // Update or delete the minute index based on remaining schedules
  if (remainingKeys.length > 0) {
    await env.TRELLO_SCHEDULES.put(minuteKey, JSON.stringify(remainingKeys), {
      expirationTtl: 7 * 24 * 60 * 60
    });
  } else {
    // No more schedules for this minute, clean up the index
    await env.TRELLO_SCHEDULES.delete(minuteKey);
  }

  // Also check the previous minute in case of timing edge cases
  const previousMinute = currentMinute - 1;
  const prevMinuteKey = `minute_${previousMinute}`;
  const prevMinuteData = await env.TRELLO_SCHEDULES.get(prevMinuteKey);

  if (prevMinuteData) {
    const prevScheduleKeys = JSON.parse(prevMinuteData);
    const prevRemainingKeys = [];

    for (const key of prevScheduleKeys) {
      const data = await env.TRELLO_SCHEDULES.get(key);
      if (!data) continue;

      const schedule = JSON.parse(data);
      const scheduledTime = new Date(schedule.scheduledTime).getTime();

      if (scheduledTime <= now) {
        try {
          // Process the schedule (same logic as above)
          if (schedule.comment) {
            const commentUrl = `https://api.trello.com/1/cards/${schedule.cardId}/actions/comments`;
            const params = new URLSearchParams({
              key: env.TRELLO_API_KEY,
              token: schedule.trelloToken,
              text: schedule.comment
            });

            const commentResponse = await fetch(`${commentUrl}?${params}`, {
              method: 'POST',
              headers: { 'Accept': 'application/json' }
            });

            if (!commentResponse.ok) {
              const errorText = await commentResponse.text();
              errors.push({ key, error: errorText });
              prevRemainingKeys.push(key);
              continue;
            }
          }

          if (schedule.markComplete !== undefined) {
            const cardUrl = `https://api.trello.com/1/cards/${schedule.cardId}`;
            const params = new URLSearchParams({
              key: env.TRELLO_API_KEY,
              token: schedule.trelloToken,
              dueComplete: schedule.markComplete
            });

            const updateResponse = await fetch(`${cardUrl}?${params}`, {
              method: 'PUT',
              headers: { 'Accept': 'application/json' }
            });

            if (!updateResponse.ok) {
              const errorText = await updateResponse.text();
              errors.push({ key, error: errorText });
              prevRemainingKeys.push(key);
              continue;
            }
          }

          await env.TRELLO_SCHEDULES.delete(key);
          processed.push(key);
        } catch (error) {
          errors.push({ key, error: error.message });
          prevRemainingKeys.push(key);
        }
      } else {
        prevRemainingKeys.push(key);
      }
    }

    if (prevRemainingKeys.length > 0) {
      await env.TRELLO_SCHEDULES.put(prevMinuteKey, JSON.stringify(prevRemainingKeys), {
        expirationTtl: 7 * 24 * 60 * 60
      });
    } else {
      await env.TRELLO_SCHEDULES.delete(prevMinuteKey);
    }
  }

  const result = {
    processed: processed.length,
    errors: errors.length,
    details: { processed, errors },
    timestamp: new Date().toISOString(),
    minute: currentMinute
  };

  return result;
}