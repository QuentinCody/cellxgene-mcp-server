# cellxgene-mcp-server

MCP server wrapping the [CELLxGENE Discover](https://cellxgene.cziscience.com/) curation API — browse single-cell RNA-seq collections and datasets contributed by the community.

- **Base URL**: `https://api.cellxgene.cziscience.com/curation/v1`
- **OpenAPI / Swagger**: https://api.cellxgene.cziscience.com/curation/ui/
- **Port** (dev): `8882`
- **Auth**: none (public)

All functionality is exposed through Code Mode: `cellxgene_search` (discover endpoints) and `cellxgene_execute` (run JavaScript in a V8 isolate). Large responses (e.g. `/collections`) auto-stage to `CELLXGENE_DATA_DO`; query with `cellxgene_query_data` and inspect schemas via `cellxgene_get_schema`.
