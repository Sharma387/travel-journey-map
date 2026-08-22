"""Quick smoke test for the backend (run: .venv/bin/python smoke_test.py).

Exercises every endpoint without requiring the network: the LLM is expected to be
down (fallback parser), and geocoding is tested via the SQLite cache + a stub
geolocator. When an LLM is reachable the parse endpoint uses it — the test
passes either way.
"""
import io
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402
from geocoder import Geocoder, _normalize  # noqa: E402

client = TestClient(main.app)

# 1. health
r = client.get("/api/health")
assert r.status_code == 200 and r.json()["status"] == "ok", r.text
print("health OK ->", r.json()["llm"])

# 2. parse raw text (LLM down -> heuristic fallback)
itinerary = """Day 1 - June 3: Landed in Lisbon, walked Alfama.
June 4: Sintra, Pena Palace all morning.
Day 5 - June 7: Flew to Barcelona, Sagrada Familia at 3pm."""
r = client.post("/api/parse-itinerary", data={"text": itinerary})
assert r.status_code == 200, r.text
body = r.json()
assert body["stops"], body
# llm_used may be True (LLM reachable) or False (fallback)
print("parse text OK ->", len(body["stops"]), "stops, llm_used =", body["llm_used"])

# 3. parse CSV (structured passthrough path)
csv_bytes = b'Location,Date,Notes\n"Paris, France",2024-09-10,Eiffel Tower\n"Rome, Italy",2024-09-12,Colosseum\n'
r = client.post("/api/parse-itinerary", files={"file": ("trip.csv", csv_bytes, "text/csv")})
assert r.status_code == 200, r.text
body = r.json()
assert body["source_type"] == "csv" and len(body["stops"]) == 2
first = body["stops"][0]
assert first["location"] == "Paris, France"
assert first["exact_location"] == "Paris, France"
assert first["start_date"] == "2024-09-10"
assert first["end_date"] == "2024-09-10"
assert first["category"] == "Past"  # 2024-09-10 < today
print("parse csv OK ->", first)

# 4. parse XLSX (structured passthrough via pandas)
import pandas as pd  # noqa: E402
buf = io.BytesIO()
pd.DataFrame({"Location": ["Kyoto, Japan"], "Date": ["2024-11-01"], "Notes": ["Temples"]}).to_excel(buf, index=False)
r = client.post(
    "/api/parse-itinerary",
    files={"file": ("trip.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
)
assert r.status_code == 200, r.text
assert r.json()["stops"][0]["location"] == "Kyoto, Japan"
print("parse xlsx OK")

# 5. unsupported file type -> 400
r = client.post("/api/parse-itinerary", files={"file": ("pic.png", b"\x89PNG\r\n", "image/png")})
assert r.status_code == 400, r.text
print("unsupported type OK -> 400")

# 6. geocode: cached hit (no network)
tmp = tempfile.mktemp(suffix=".db")
g = Geocoder(delay=0, db_path=tmp)
g._store(_normalize("Testville"), "Testville", 1.5, 2.5, "Testville, Testland", True)
res = g.geocode_many(["Testville"])
assert res[0]["found"] and res[0]["cached"] and res[0]["lat"] == 1.5
print("geocode cached OK ->", res[0])

# 7. geocode: not-found path (stub geolocator, no network)
class NotFoundGeolocator:
    def geocode(self, *a, **k):
        return None

g2 = Geocoder(delay=0, db_path=tmp)
g2._geolocator = NotFoundGeolocator()
res = g2.geocode_many(["ZZZ-no-such-place-98765"])
assert not res[0]["found"] and res[0]["error"]
print("geocode not-found OK ->", res[0]["error"])

# 8. geocode endpoint (stub geolocator injected into app instance)
main.geocoder._geolocator = NotFoundGeolocator()
r = client.post("/api/geocode", json={"locations": ["Atlantis"]})
assert r.status_code == 200
assert r.json()["results"][0]["found"] is False
r = client.post("/api/geocode", json={"location": "Atlantis"})
assert r.status_code == 200 and len(r.json()["results"]) == 1
print("geocode endpoint OK")

# 9. geocode endpoint: bad request
r = client.post("/api/geocode", json={})
assert r.status_code == 400, r.text
print("geocode empty OK -> 400")

# 10. geocode stops path: feasibility/velocity check flags a same-day jump
#     Auckland (-36.85, 174.76) -> Hamilton OH (39.4, -84.56) = ~13 400 km
#     13 400 / max(0, 8) ≈ 1675 km/h > 900  --> is_ambiguous: True.
#     Uses a temp DB + stub geolocator so the real cache is not polluted.
orig_geocoder = main.geocoder
main.geocoder = Geocoder(delay=0, db_path=tempfile.mktemp(suffix=".db"))
main.geocoder._geolocator = NotFoundGeolocator()
try:
    r = client.post(
        "/api/geocode",
        json={
            "stops": [
                {
                    "order": 1,
                    "location": "Auckland",
                    "exact_location": "Auckland, New Zealand",
                    "start_date": "2024-01-01",
                    "end_date": "2024-01-01",
                    "lat": -36.85,
                    "lng": 174.76,
                },
                {
                    "order": 2,
                    "location": "Hamilton",
                    "exact_location": "Hamilton, Ohio, USA",
                    "start_date": "2024-01-01",
                    "end_date": "2024-01-01",
                    "lat": 39.4,
                    "lng": -84.56,
                },
            ]
        },
    )
finally:
    main.geocoder = orig_geocoder
assert r.status_code == 200, r.text
body = r.json()
feas = body["feasibility"]
assert len(feas) == 2
assert feas[0]["is_ambiguous"] is False
assert feas[1]["is_ambiguous"] is True, feas
assert feas[1]["warning"], feas
assert feas[1]["candidates"] == ["Hamilton"], feas[1]["candidates"]
# results preserved the supplied coordinates without network calls
assert body["results"][1]["lat"] == 39.4 and body["results"][1]["lng"] == -84.56
print("geocode stops + feasibility OK ->", feas[1]["warning"][:90], "…")

print("\nALL BACKEND SMOKE TESTS PASSED")
