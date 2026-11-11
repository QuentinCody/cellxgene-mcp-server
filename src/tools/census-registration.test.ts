import { expect, it, vi } from "vitest";
import { McpServer } from "@bio-mcp/shared/mcp";
import { createApiProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { detectArrays, inferSchema } from "@bio-mcp/shared/staging/schema-inference";
import { registerCodeMode } from "./code-mode";
import { registerQueryData } from "./query-data";
import { registerGetSchema } from "./get-schema";
import { createCellxgeneApiFetch } from "../lib/api-adapter";
import { cellxgeneCatalog } from "../spec/catalog";

const release = "2025-11-08";
const uri = `s3://cellxgene-census-public-us-west-2/cell-census/${release}/soma/`;
const desc = { release_build: release, soma: { uri } };
const body = { operation: "expression", release, corpus: "census_data", organism: "homo_sapiens", obs_joinids: [10], var_joinids: [2] };
const raw = { source: "CELLxGENE Census", operation: body.operation, release, corpus: body.corpus, organism: body.organism, soma_uri: uri, release_description: desc, layer: "raw", row_count: 1, truncated: false,
  expression: [{ soma_dim_0: 10, soma_dim_1: 2, soma_data: 1 }], obs: [{ soma_joinid: 10, dataset_id: "fixture", is_primary_data: false }], var: [{ soma_joinid: 2, feature_id: "ENSG01" }],
  datasets: [{ soma_joinid: 101, dataset_id: "fixture", dataset_version_id: "v1", citation: "α".repeat(17000) }], feature_dataset_presence: [{ soma_dim_0: 101, soma_dim_1: 2, soma_data: true }] };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

it("registers both aliases and provides a structured unavailable-backend error", async () => {
  const server = new McpServer({ name: "fixture", version: "1" });
  registerCodeMode(server, { CODE_MODE_LOADER: { get: () => ({}) } } as unknown as Parameters<typeof registerCodeMode>[1]);
  registerQueryData(server, {}); registerGetSchema(server, {});
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools;
  for (const name of ["cellxgene_search", "cellxgene_execute", "cellxgene_query_data", "cellxgene_get_schema"]) {
    expect(tools[name]).toBeDefined(); expect(tools[`mcp_${name}`]).toBeDefined();
  }
  const found = await tools.mcp_cellxgene_search.handler({ query: "/census/query", max_results: 5 }, {});
  expect(found).toMatchObject({ content: expect.any(Array), structuredContent: { success: true } });
  expect(JSON.stringify(found)).toContain("feature_dataset_presence");
  expect(await tools.mcp_cellxgene_query_data.handler({ data_access_id: "cellxgene_fixture", sql: "SELECT 1" }, {})).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: expect.any(Object) });
  const proxy = createApiProxyTool({ apiFetch: createCellxgeneApiFetch(), catalog: cellxgeneCatalog, stagingPrefix: "cellxgene", maxInlineBytes: 30 * 1024 });
  expect(await proxy.handler({ method: "POST", path: "/census/query", body }, { sql: () => [] })).toMatchObject({ __api_error: true, incomplete: true, status: 503 });
  expect(cellxgeneCatalog.endpointCount).toBe(cellxgeneCatalog.endpoints.length);
});

it("stages the complete expression envelope and materializes separate axes/presence tables", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ [release]: desc })).mockResolvedValueOnce(json(raw)));
  const stored: unknown[] = [];
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") {
      stored.push((await request.json() as { data: unknown }).data);
      return json({ success: true, tables_created: ["expression", "obs", "var", "datasets", "feature_dataset_presence"], total_rows: 5, input_rows: 5 });
    }
    return json({ success: true, schema: { tables: { expression: { columns: [{ name: "soma_data" }] } } } });
  } }) } as unknown as DurableObjectNamespace;
  try {
    const proxy = createApiProxyTool({ apiFetch: createCellxgeneApiFetch({ CELLXGENE_CENSUS_URL: "https://census.example/query", CELLXGENE_CENSUS_TOKEN: "fixture-secret" }), catalog: cellxgeneCatalog, doNamespace: namespace, stagingPrefix: "cellxgene", maxInlineBytes: 30 * 1024 });
    expect(await proxy.handler({ method: "POST", path: "/census/query", body }, { sql: () => [] })).toMatchObject({ __staged: true, data_access_id: expect.any(String) });
    expect(JSON.parse(stored[0] as string)).toMatchObject(raw);
    expect(stored[1]).toMatchObject(raw);
    const schema = inferSchema(detectArrays(stored[1]));
    expect(schema.tables.map(table => table.name)).toEqual(["expression", "obs", "var", "datasets", "feature_dataset_presence"]);
  } finally { vi.unstubAllGlobals(); }
});

it("rejects mismatched expression axes instead of joining another release's cells", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ [release]: desc })).mockResolvedValueOnce(json({ ...raw, obs: [{ soma_joinid: 99, dataset_id: "fixture" }] })));
  try {
    await expect(createCellxgeneApiFetch({ CELLXGENE_CENSUS_URL: "https://census.example/query", CELLXGENE_CENSUS_TOKEN: "fixture-secret" })({ method: "POST", path: "/census/query", body })).rejects.toThrow("axes");
  } finally { vi.unstubAllGlobals(); }
});

it.each([{ __staged: true, data_access_id: "fixture" }, { __api_error: true, status: 503 }])("recipe returns discovery failure/staging handles %#", async handle => {
  const run = new Function("api", `return (async () => { ${cellxgeneCatalog.workflows![0].code} })()`);
  const api = { get: vi.fn().mockResolvedValue(handle), post: vi.fn() };
  expect(await run(api)).toEqual(handle);
  expect(api.post).not.toHaveBeenCalled();
});
