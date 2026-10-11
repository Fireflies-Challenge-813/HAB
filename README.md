# Fireflies---813-Challenge

Arab Youth Space Hackathon 2026 (Challenge 813) participation. Early warning system for phytoplanktons in the Arabian gulf utlizing hyperspectral and multispectral imagery.

## Start here

| You are… | Read |
|---|---|
| Anyone on the team | `docs/PROJECT.md`: the idea, the decisions and the limits |
| Working on data or the pipeline | `docs/DATA_CONTRACT.md`, then `docs/PIPELINE_GUIDE.md` |
| Working on the dashboard | `docs/DATA_CONTRACT.md`, then `docs/DASHBOARD_SPEC.md` |
| Claude Code | `CLAUDE.md` is loaded automatically |

-Verify the finalized decisions in [docs/PROJECT.md](docs/PROJECT.md)  
-Check [PIPELINE_GUIDE.md](docs/PIPELINE_GUIDE.md) if it matches your framework and conventions  
-Follow [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md) for variable names and file formats 

## Try the data tools

```bash
pip install -r pipeline/requirements.txt
python pipeline/import_map_export.py <export folder>   # the data team's export into data/
python pipeline/validate_contract.py data              # must end with PASS
python pipeline/make_mock_data.py                      # mock data into mock-data/, for the dashboard's checks
```

## Dashboard

Live: https://fireflies-challenge-813.github.io/HAB/ (published by GitHub Actions on every push to main).

To run it locally:

```bash
cd web
npm install
npm run dev        # http://127.0.0.1:5173/
```
