import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

export const cellxgeneCatalog: ApiCatalog = {
    name: "CELLxGENE Discover",
    baseUrl: "https://api.cellxgene.cziscience.com/curation/v1",
    version: "v1",
    auth: "none",
    endpointCount: 10,
    notes:
        "- CELLxGENE Discover (CZI) hosts single-cell RNA-seq collections & datasets submitted by the community.\n" +
        "- PREFER targeted `/collections/{collection_id}` detail lookups over `/collections` list (list is large — can be 1MB+).\n" +
        "- When listing collections, responses may be large and slow — expect higher latency; consider staging.\n" +
        "- Datasets are contained within collections. Each dataset has an `explorer_url`, `assets` (H5AD, RDS downloads), and rich metadata.\n" +
        "- `dataset_version_id` (immutable) vs `dataset_id` (mutable canonical) — most lookups accept either.\n" +
        "- Filters on /collections support `curator`, `owner`, `visibility` (PUBLIC / PRIVATE).\n" +
        "- Docs: https://api.cellxgene.cziscience.com/curation/ui/ (OpenAPI / Swagger).",
    endpoints: [
        {
            method: "GET",
            path: "/collections/{collection_id}",
            summary: "Get full metadata for a single collection (preferred first call)",
            description:
                "Returns collection metadata (name, description, contact, publisher metadata, links) plus the full list of datasets with their sample metadata (tissue, disease, assay, organism, cell count).",
            category: "collection",
            pathParams: [
                { name: "collection_id", type: "string", required: true, description: "Collection UUID (e.g. 'db468083-041c-41ca-8f6f-bf991a070adf')" },
            ],
            featured: true,
            usageHint: "Preferred first call — much smaller than the full /collections list.",
        },
        {
            method: "GET",
            path: "/collections/{collection_id}/datasets/{dataset_id}",
            summary: "Get detailed metadata for a single dataset in a collection",
            category: "collection",
            pathParams: [
                { name: "collection_id", type: "string", required: true, description: "Collection UUID" },
                { name: "dataset_id", type: "string", required: true, description: "Dataset UUID (canonical, mutable)" },
            ],
        },
        {
            method: "GET",
            path: "/collections/{collection_id}/versions",
            summary: "List historical versions of a collection (time-travel / provenance)",
            category: "collection",
            pathParams: [
                { name: "collection_id", type: "string", required: true, description: "Collection UUID" },
            ],
        },
        {
            method: "GET",
            path: "/collections",
            summary: "List all public collections (LARGE — prefer detail lookup if you know the ID)",
            description:
                "Returns a list of every public collection. Response can be 1MB+ and trigger staging. Use this only when you do not have a specific collection_id. Supports curator/owner/visibility filters.",
            category: "collection",
            queryParams: [
                { name: "curator", type: "string", required: false, description: "Filter by curator name" },
                { name: "owner", type: "string", required: false, description: "Filter by owner user ID" },
                { name: "visibility", type: "string", required: false, description: "PUBLIC or PRIVATE", enum: ["PUBLIC", "PRIVATE"] },
            ],
            usageHint: "Large response — expect staging. Allow extra time (timeout ~60s).",
        },
        {
            method: "GET",
            path: "/datasets",
            summary: "List published datasets across all collections (schema version metadata)",
            category: "dataset",
            queryParams: [
                { name: "schema_version", type: "string", required: false, description: "Filter by CELLxGENE schema version (e.g. '5.0.0')" },
            ],
            usageHint: "Large response — expect staging.",
        },
        {
            method: "GET",
            path: "/datasets/{dataset_id}",
            summary: "Get canonical dataset metadata (latest version) by canonical dataset UUID",
            category: "dataset",
            pathParams: [
                { name: "dataset_id", type: "string", required: true, description: "Canonical dataset UUID (mutable)" },
            ],
        },
        {
            method: "GET",
            path: "/datasets/{dataset_id}/versions",
            summary: "List historical versions of a dataset",
            category: "dataset",
            pathParams: [
                { name: "dataset_id", type: "string", required: true, description: "Canonical dataset UUID" },
            ],
        },
        {
            method: "GET",
            path: "/datasets/{dataset_version_id}/assets",
            summary: "List downloadable assets for a dataset version (H5AD, RDS, raw.h5ad)",
            description:
                "Each asset has a `filetype`, `filesize`, and `url` you can download for local analysis.",
            category: "dataset",
            pathParams: [
                { name: "dataset_version_id", type: "string", required: true, description: "Immutable dataset version UUID" },
            ],
        },
        {
            method: "GET",
            path: "/datasets/{dataset_version_id}",
            summary: "Get metadata for a specific (historical) dataset version",
            category: "dataset",
            pathParams: [
                { name: "dataset_version_id", type: "string", required: true, description: "Immutable dataset version UUID" },
            ],
        },
        {
            method: "GET",
            path: "/collections/{collection_id}/datasets/{dataset_id}/versions",
            summary: "List versions of a dataset scoped to a collection",
            category: "collection",
            pathParams: [
                { name: "collection_id", type: "string", required: true, description: "Collection UUID" },
                { name: "dataset_id", type: "string", required: true, description: "Canonical dataset UUID" },
            ],
        },
    ],
};
