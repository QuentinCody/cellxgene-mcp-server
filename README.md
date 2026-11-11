# cellxgene-mcp-server

MCP server wrapping the [CELLxGENE Discover](https://cellxgene.cziscience.com/) curation API — browse single-cell RNA-seq collections and datasets contributed by the community.

- **Base URL**: `https://api.cellxgene.cziscience.com/curation/v1`
- **OpenAPI / Swagger**: https://api.cellxgene.cziscience.com/curation/ui/
- **Port** (dev): `8882`
- **Auth**: public Discover/release metadata; Census compute requires a configured host backend and token.

All functionality is exposed through Code Mode: `cellxgene_search` (discover endpoints) and `cellxgene_execute` (run JavaScript in a V8 isolate). Large responses (e.g. `/collections`) auto-stage to `CELLXGENE_DATA_DO`; query with `cellxgene_query_data` and inspect schemas via `cellxgene_get_schema`.

Each tool also has its `mcp_cellxgene_<tool>` alias. Responses over 30 KiB use canonical staging.

## Census analysis

`GET /census/releases` reads the public release directory without a backend. `POST /census/query` adds cell/gene metadata, sparse expression and spatial queries through a separately hosted Python Census/TileDB-SOMA service. These are adapter routes, separate from Discover REST; existing collection/dataset and asset access remains available.

Select an exact dated release, inspect its available organisms and schemas, query small obs/var pages, then select expression by their join IDs. Keep release, corpus and species together. Expression results preserve dataset versions, citations and feature-presence matrices so unmeasured genes remain distinguishable from measured zeros. Spatial results retain scene mappings, source coordinates and metadata.

Staged expression, cell/gene metadata, datasets and presence matrices have separate tables. Inspect the schema before joining them; an empty sparse array may have no materialized table. Retain the complete source envelope and any failure/staging handles in workflows.

These additions are **local and undeployed**. The native runtime is absent in the current environment, and no backend is configured automatically. Unconfigured queries return an explicit unavailable error. See [backend provisioning, limits and pending acceptance](backend/README.md). Fixture tests do not establish native SDK compatibility or live Census correctness. Optional embedding search remains deferred.

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from CELLxGENE Discover / Census and stays under the terms of that source: Datasets mostly CC BY 4.0.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
