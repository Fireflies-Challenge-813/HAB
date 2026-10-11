"""Download the 12 PACE OCI Level-2 passes used in this project.

Requires a free NASA Earthdata account (https://urs.earthdata.nasa.gov).
earthaccess asks for your username and password on first run, or reads them
from the environment variables EARTHDATA_USERNAME and EARTHDATA_PASSWORD.
Never commit credentials to the repository.

Usage:
    pip install earthaccess
    python data/download_pace.py
"""
import os
import earthaccess

# pass timestamp (UTC) -> role
PASSES = {
    "20241011T091915": "analysis",   # calm date
    "20241030T083958": "analysis",
    "20241203T082912": "analysis",
    "20241209T083745": "analysis",
    "20250123T082632": "analysis",
    "20250406T084057": "analysis",
    "20251002T085136": "analysis",
    "20251025T090903": "analysis",   # calm date
    "20251116T085559": "analysis",
    "20260214T084831": "analysis",
    "20260314T084316": "analysis",
    "20250324T091204": "test",       # held-out test date
}
PRODUCTS = {"AOP": "PACE_OCI_L2_AOP", "BGC": "PACE_OCI_L2_BGC", "IOP": "PACE_OCI_L2_IOP"}
BBOX = (51.2, 19.0, 63.0, 27.03)     # study area plus the extended test area (lon_min, lat_min, lon_max, lat_max)

OUT = os.path.join(os.path.dirname(__file__), "PACE")

earthaccess.login()
for ts, role in PASSES.items():
    day = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}"
    for kind, short_name in PRODUCTS.items():
        results = earthaccess.search_data(short_name=short_name, temporal=(day, day), bounding_box=BBOX)
        match = [r for r in results if ts in r.data_links()[0]]
        if not match:
            print(f"Not found: {ts} {kind}")
            continue
        folder = os.path.join(OUT, "analysis", "raw", kind) if role == "analysis" else os.path.join(OUT, "test", kind)
        os.makedirs(folder, exist_ok=True)
        earthaccess.download(match, folder)
        print(f"Downloaded {ts} {kind} -> {folder}")
