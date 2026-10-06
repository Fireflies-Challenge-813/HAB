# Fireflies---813-Challenge

Arab Youth Space Hackathon 2026 (Challenge 813) participation. Early warning system for phytoplanktons in the Arabian gulf utlizing hyperspectral and multispectral imagery.

## Start here

| You are… | Read |
|---|---|
| Anyone on the team | `docs/PROJECT.md`: the idea, the decisions and the limits |
| Working on data or the pipeline | `docs/DATA_CONTRACT.md`, then `docs/PIPELINE_GUIDE.md` |
| Working on the dashboard | `docs/DATA_CONTRACT.md`, then `docs/DASHBOARD_SPEC.md` |
| Claude Code | `CLAUDE.md` is loaded automatically |

-Verify the finalized decisions in docs/PROJECT.md  
-Check docs/PIPELINE_GUIDE.md` if it matches your framework and conventions  
-Follow docs/DATA_CONTRACT.md for variable names and file formats 

## Try the data tools

```bash
pip install -r pipeline/requirements.txt
python pipeline/make_mock_data.py            # writes mock data into data/
python pipeline/validate_contract.py data    # must end with PASS
```

## Dashboard Instructions

Coming soon
