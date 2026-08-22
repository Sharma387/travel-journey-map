/** Fetch with an optional AbortSignal and a default timeout. */
async function request(url, options, timeoutMs = 60_000) {
  const hasExternalSignal = Boolean(options?.signal);
  const controller = new AbortController();
  // Only start our own timeout when the caller didn't supply a signal;
  // otherwise the caller controls cancellation.
  const timer = hasExternalSignal ? null : setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: options?.signal || controller.signal });
    if (!res.ok) {
      let detail = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      } catch {
        /* preserve default message */
      }
      throw new Error(detail);
    }
    return res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function parseItinerary({ file, text }, signal) {
  const body = new FormData();
  if (file) {
    body.append("file", file);
  } else {
    body.append("text", text);
  }
  return request("/api/parse-itinerary", { method: "POST", body, signal }, 120_000);
}

export async function geocodeStops(stops, signal) {
  return request(
    "/api/geocode",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stops }),
      signal,
    },
    120_000,
  );
}

export async function geocodeLocations(locations, signal) {
  return request(
    "/api/geocode",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locations }),
      signal,
    },
    120_000,
  );
}

export async function searchLocations(query, signal) {
  return request(
    "/api/search-location",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal,
    },
    30_000,
  );
}