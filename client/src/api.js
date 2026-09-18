const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one message. messageId is generated once by the caller and reused on
 * every retry, so a retry can never run the message twice on the server.
 *   409 → the server is still working on it: wait and ask again
 *   network error → retry the same request
 */
export async function sendChatMessage({ sessionId, messageId, text }, { maxWaitMs = 180_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, messageId, text }),
      });
    } catch (err) {
      if (attempt < 2 && Date.now() < deadline) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    }

    if (res.status === 409 && Date.now() < deadline) {
      await sleep(Number(res.headers.get("Retry-After") || 2) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Chat request failed: ${res.status}`);
    return res.json();
  }
}

export async function fetchSessionHistory(sessionId) {
  const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`History request failed: ${res.status}`);
  return res.json();
}

export async function fetchGraph() {
  const res = await fetch("/api/graph");

  if (!res.ok) {
    throw new Error(`Graph request failed: ${res.status}`);
  }

  return res.json();
}
