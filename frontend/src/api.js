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
    if (res.status === 204) return null; // no content (DELETE etc.)
    return res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Authorized JSON helper.
const authJson = (token, body) => ({
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

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

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export async function login(username, password) {
  return request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export async function fetchMe(token) {
  return request("/api/auth/me", { headers: authJson(token) });
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------
export async function fetchJourneys(token) {
  return request("/api/journeys", { headers: authJson(token) });
}

export async function fetchJourney(id, token) {
  return request(`/api/journeys/${id}`, { headers: authJson(token) });
}

export async function createJourney(payload, token) {
  return request("/api/journeys", {
    method: "POST",
    headers: authJson(token, payload),
  });
}

export async function updateJourney(id, payload, token) {
  return request(`/api/journeys/${id}`, {
    method: "PUT",
    headers: authJson(token, payload),
  });
}

export async function deleteJourney(id, token) {
  return request(`/api/journeys/${id}`, {
    method: "DELETE",
    headers: authJson(token),
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
export async function adminUsers(token) {
  return request("/api/admin/users", { headers: authJson(token) });
}

export async function adminCreateUser(body, token) {
  return request("/api/admin/users", {
    method: "POST",
    headers: authJson(token, body),
  });
}

export async function adminUpdateUser(id, body, token) {
  return request(`/api/admin/users/${id}`, {
    method: "PATCH",
    headers: authJson(token, body),
  });
}

export async function adminDeleteUser(id, token) {
  return request(`/api/admin/users/${id}`, {
    method: "DELETE",
    headers: authJson(token),
  });
}

export async function adminFamilies(token) {
  return request("/api/admin/families", { headers: authJson(token) });
}

export async function adminCreateFamily(name, token) {
  return request("/api/admin/families", {
    method: "POST",
    headers: authJson(token, { name }),
  });
}

export async function adminUpdateFamily(id, body, token) {
  return request(`/api/admin/families/${id}`, {
    method: "PATCH",
    headers: authJson(token, body),
  });
}

export async function adminDeleteFamily(id, token) {
  return request(`/api/admin/families/${id}`, {
    method: "DELETE",
    headers: authJson(token),
  });
}