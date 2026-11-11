import type { ApiEndpoint, WorkflowRecipe } from "@bio-mcp/shared/codemode/catalog";

export const censusEndpoints: ApiEndpoint[] = [
  { method: "GET", path: "/census/releases", category: "Census", summary: "Discover actual Census releases, alias targets, retractions and source locators",
    responseShape: "{ directory, source_url, retrieved_at, response_sha256, note }", usageHint: "Public metadata; no backend required. Resolve stable/latest to a dated release and inspect flags. This is Census availability, not Discover dataset versions or the Python package version." },
  { method: "POST", path: "/census/query", category: "Census", summary: "Query bounded cell/gene metadata, expression or spatial data using a configured Census backend", featured: true,
    body: { contentType: "application/json", description: "Required: operation ('schema'|'datasets'|'obs'|'var'|'expression'|'scenes'|'spatial'), release (exact YYYY-MM-DD), corpus ('census_data'|'census_spatial_sequencing'). organism is required except schema/datasets; discover exact species keys. obs/var: filters?: [{column,op:'eq'|'in'|'gte'|'lte',value}], max_rows?:1..1000 (default100), after_joinid?:number. datasets: dataset_ids?:string[], max_rows?, after_joinid?; catalog spans all corpora. expression: obs_joinids:number[], var_joinids:number[], layer?:'raw'|'normalized'; 1..200 distinct IDs per axis, maximum20,000 pairs; spatial has raw only. scenes: max_rows?, after_scene_id?:string. spatial: scene_id:string, obs_joinids:number[]. No user URIs, code or raw SQL." },
    responseShape: "{ source, operation, release, corpus, organism, soma_uri, release_description, runtime, retrieved_at, _census, ...operationResult }",
    usageHint: "Adapter-owned route, not a Discover REST endpoint. Requires host CELLXGENE_CENSUS_URL/TOKEN and Python Census/TileDB-SOMA service. Query schema first. All soma_joinid values are scoped to release/corpus/species. Metadata pages carry rows,row_count,truncated,next_after_joinid. Expression has expression,obs,var,datasets,feature_dataset_presence arrays: soma_dim_0/1 axis mappings are explicit. A sparse absence is zero only when dataset-feature presence is true. is_primary_data is retained, never silently filtered. Spatial scenes/locations preserve source units and spot geometry. No image bytes. Keep complete provenance and staging/error handles; inspect schema after staging to join the separate arrays. Byte-limit failures require narrower selections." },
];

export const censusWorkflows: WorkflowRecipe[] = [{
  title: "Discover a Census release and its species before expression queries",
  description: "Resolve the current stable alias once and inspect the release's available organisms. Further queries use its exact date.",
  keywords: ["Census", "expression", "spatial", "release", "species"],
  code: `const releases = await api.get("/census/releases");
if (!releases?.directory || releases.__staged || releases.__api_error) return releases;
const release = releases.directory.stable;
if (typeof release !== "string") return { releases, error: "Inspect release aliases before continuing" };
const schema = await api.post("/census/query", { operation: "schema", release, corpus: "census_data" });
// Retain schema/error/staging handle. Discover obs/var columns for a returned species,
// then query bounded pages and use their soma_joinid values for expression selection.
return { releases, schema };`,
}];
