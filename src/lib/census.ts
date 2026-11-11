import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";

export interface CensusEnv { CELLXGENE_CENSUS_URL?: string; CELLXGENE_CENSUS_TOKEN?: string }
const DIRECTORY = "https://census.cellxgene.cziscience.com/cellxgene-census/v1/release.json";
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function censusError(message: string, status = 400): never { throw Object.assign(new Error(`Census: ${message}`), { status }); }
const requireValue = (test: unknown, message: string) => { if (!test) censusError(message); };
const byteSize = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;

async function boundedJson(url: string, init: RequestInit, limit: number, timeout: number, secret?: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      censusError(`service returned HTTP ${response.status}; verify release, identifiers, filters and backend configuration`, [400, 401, 404, 409, 413, 429, 503, 504].includes(response.status) ? response.status : 502);
    }
    const reader = response.body?.getReader();
    if (!reader) censusError("empty response", 502);
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > limit) censusError("response too large; narrow the selection", 502);
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => undefined); }
    const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (secret && (text.includes(secret) || JSON.stringify(data).includes(secret))) censusError("backend returned credential material", 502);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return { data, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join(""), retrieved_at: new Date().toISOString() };
  } catch (error) {
    if ((error as { status?: number }).status) throw error;
    censusError("service failed, returned invalid JSON or exceeded its deadline", 502);
  } finally { clearTimeout(timer); }
}

export function exactRelease(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) censusError("use an exact release date discovered from /census/releases, not stable/latest");
  return value;
}

export function selectRelease(directory: unknown, release: string) {
  if (!record(directory) || !record(directory[release])) censusError("release unavailable", 404);
  const desc = directory[release];
  if (desc.release_build !== release || !record(desc.soma) || typeof desc.soma.uri !== "string") censusError("invalid release description", 502);
  if ((record(desc.flags) && desc.flags.retracted) || desc.retraction) censusError("release retracted; select its replacement", 409);
  if (!["cellxgene-census-public-us-west-2", "cellxgene-data-public"].some(bucket => desc.soma && record(desc.soma) && desc.soma.uri === `s3://${bucket}/cell-census/${release}/soma/`)) censusError("unsupported provider locator", 502);
  return { description: desc, uri: desc.soma.uri };
}

function joinids(value: unknown, name: string) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 200 && value.every(x => Number.isSafeInteger(x) && x >= 0) && new Set(value).size === value.length, `${name} requires 1..200 distinct safe nonnegative integer IDs`);
  return value as number[];
}

function validateExpression(data: Record<string, unknown>, body: Record<string, unknown>) {
  if (!Array.isArray(data.obs) || !Array.isArray(data.var) || !Array.isArray(data.datasets) || !Array.isArray(data.feature_dataset_presence) || data.layer !== (body.layer ?? "raw") || data.truncated !== false) censusError("expression response lacks axes, dataset presence or complete selection", 502);
  const obs = data.obs as unknown[];
  const vars = data.var as unknown[];
  const sameIds = (rows: unknown[], requested: unknown) => Array.isArray(requested) && rows.length === requested.length && rows.every(row => record(row) && requested.includes(row.soma_joinid)) && new Set(rows.map(row => (row as Record<string, unknown>).soma_joinid)).size === rows.length;
  if (!sameIds(obs, body.obs_joinids) || !sameIds(vars, body.var_joinids)) censusError("expression axes do not match requested selection", 502);
  const datasets = data.datasets as unknown[];
  if (!datasets.every(row => record(row) && Number.isSafeInteger(row.soma_joinid) && typeof row.dataset_id === "string") || !obs.every(row => record(row) && datasets.some(dataset => record(dataset) && dataset.dataset_id === row.dataset_id))) censusError("missing dataset provenance", 502);
  const axisCheck = (rows: unknown[], first: unknown[], second: unknown[]) => rows.every(row => record(row) && first.includes(row.soma_dim_0) && second.includes(row.soma_dim_1) && (typeof row.soma_data === "number" || typeof row.soma_data === "boolean"));
  if (!axisCheck(data.expression as unknown[], body.obs_joinids as unknown[], body.var_joinids as unknown[]) || !axisCheck(data.feature_dataset_presence as unknown[], datasets.map(row => (row as Record<string, unknown>).soma_joinid), body.var_joinids as unknown[])) censusError("sparse matrix contains out-of-selection coordinates", 502);
}

export function censusRequest(body: unknown): Record<string, unknown> & { operation: string; release: string } {
  if (!record(body)) censusError("POST body must be an object");
  const { op, release } = validateCensusOperation(body);
  if (body.dataset_ids !== undefined) requireValue(Array.isArray(body.dataset_ids) && body.dataset_ids.length > 0 && body.dataset_ids.length <= 200 && body.dataset_ids.every(x => typeof x === "string" && /^[a-f0-9-]{36}$/i.test(x)), "invalid dataset_ids");
  validateCensusFilters(body);
  if (op === "expression") {
    const obs = joinids(body.obs_joinids, "obs_joinids");
    const vars = joinids(body.var_joinids, "var_joinids");
    requireValue(obs.length * vars.length <= 20000, "selection exceeds 20,000 cell-gene pairs");
    requireValue(body.layer === undefined || ["raw", "normalized"].includes(String(body.layer)), "unknown expression layer");
    requireValue(!(body.corpus === "census_spatial_sequencing" && body.layer === "normalized"), "spatial Census has no normalized layer");
  }
  if (op === "spatial" || op === "scenes") {
    requireValue(body.corpus === "census_spatial_sequencing", "spatial operation requires spatial corpus");
    if (op === "spatial") {
      joinids(body.obs_joinids, "obs_joinids");
      requireValue(typeof body.scene_id === "string" && /^[A-Za-z0-9_.-]{1,200}$/.test(body.scene_id), "invalid scene_id");
    } else if (body.after_scene_id !== undefined) requireValue(typeof body.after_scene_id === "string" && body.after_scene_id.length <= 200, "invalid scene cursor");
  }
  requireValue(byteSize(body) <= 63 * 1024, "request too large");
  return { ...body, operation: op, release };
}

function validateCensusFilters(body: Record<string, unknown>) {
  if (body.filters !== undefined) {
    requireValue(Array.isArray(body.filters) && body.filters.length <= 12, "filters must be an array of at most 12 predicates");
    for (const filter of body.filters as unknown[]) {
      if (!record(filter) || Object.keys(filter).sort().join(",") !== "column,op,value" || typeof filter.column !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(filter.column) || !["eq", "in", "gte", "lte"].includes(String(filter.op))) censusError("invalid typed filter");
      const values = filter.op === "in" ? filter.value : [filter.value];
      requireValue(Array.isArray(values) && values.length > 0 && values.length <= 200 && values.every(x => typeof x === "boolean" || (typeof x === "string" && x.length <= 1000) || (typeof x === "number" && Number.isFinite(x) && (!Number.isInteger(x) || Number.isSafeInteger(x)))), "invalid filter value");
    }
  }
}

function validateCensusOperation(body: Record<string, unknown>) {
  const extra: Record<string, string[]> = {
    schema: [], datasets: ["dataset_ids", "max_rows", "after_joinid"], obs: ["filters", "max_rows", "after_joinid"], var: ["filters", "max_rows", "after_joinid"],
    expression: ["obs_joinids", "var_joinids", "layer"], scenes: ["max_rows", "after_scene_id"], spatial: ["scene_id", "obs_joinids"],
  };
  const op = body.operation;
  if (typeof op !== "string" || !Object.prototype.hasOwnProperty.call(extra, op)) censusError("unknown Census operation");
  for (const key of Object.keys(body)) if (!["operation", "release", "corpus", "organism", ...extra[op]].includes(key)) censusError(`unsupported field ${key}`);
  const release = exactRelease(body.release);
  requireValue(["census_data", "census_spatial_sequencing"].includes(String(body.corpus)), "choose an explicit corpus");
  requireValue(op !== "datasets" || body.organism === undefined, "dataset catalog spans all species; organism is not a dataset filter");
  if (!["schema", "datasets"].includes(op) || body.organism !== undefined) requireValue(typeof body.organism === "string" && /^[a-z]+(?:_[a-z]+)+$/.test(body.organism), "organism must be a key discovered from schema");
  if (body.max_rows !== undefined) requireValue(Number.isSafeInteger(body.max_rows) && Number(body.max_rows) >= 1 && Number(body.max_rows) <= 1000, "max_rows must be 1..1000");
  if (body.after_joinid !== undefined) requireValue(Number.isSafeInteger(body.after_joinid) && Number(body.after_joinid) >= 0, "invalid after_joinid");
  return { op, release };
}

export async function censusFetch(request: Parameters<ApiFetchFn>[0], env: CensusEnv) {
  const [path, search] = request.path.split("?");
  if (search || Object.keys(request.params ?? {}).length) censusError("Census operations accept POST body options; release discovery has no query options");
  if (path === "/census/releases") {
    if (request.method.toUpperCase() !== "GET" || request.body !== undefined) censusError("release discovery requires GET without a body");
    const result = await boundedJson(DIRECTORY, {}, 512 * 1024, 15_000);
    if (!record(result.data)) censusError("invalid release directory", 502);
    return { source: "CELLxGENE Census", directory: result.data, source_url: DIRECTORY, retrieved_at: result.retrieved_at, response_sha256: result.sha256,
      note: "Resolve aliases to an exact release date for queries. Keep retraction flags and source locators; weekly release retention differs from LTS." };
  }
  if (path !== "/census/query" || request.method.toUpperCase() !== "POST") censusError("unsupported Census route/method", 404);
  const body = censusRequest(request.body);
  if (!env.CELLXGENE_CENSUS_URL || !env.CELLXGENE_CENSUS_TOKEN) censusError("query backend is not configured (CELLXGENE_CENSUS_URL/TOKEN); Discover metadata and Census release discovery remain available", 503);
  let url: URL;
  try { url = new URL(env.CELLXGENE_CENSUS_URL); } catch { censusError("invalid host backend configuration", 503); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/query") censusError("invalid host backend configuration", 503);
  const directory = await boundedJson(DIRECTORY, {}, 512 * 1024, 15_000);
  return await readCensusResult(directory, body, url, env);
}

async function readCensusResult(directory: { data: unknown; sha256: string; retrieved_at: string; }, body: Record<string, unknown> & { operation: string; release: string; }, url: URL, env: CensusEnv) {
  const selected = selectRelease(directory.data, body.release);
  const result = await boundedJson(url.href, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.CELLXGENE_CENSUS_TOKEN}` }, body: JSON.stringify({ ...body, expected_soma_uri: selected.uri }) }, 2 * 1024 * 1024, 35000, env.CELLXGENE_CENSUS_TOKEN);
  const data = result.data;
  if (!record(data) || data.source !== "CELLxGENE Census" || data.operation !== body.operation || data.release !== body.release || data.corpus !== body.corpus || (data.organism ?? null) !== (body.organism ?? null) || data.soma_uri !== selected.uri || !record(data.release_description) || data.release_description.release_build !== body.release) censusError("backend returned mismatched release/species/corpus provenance", 502);
  const rows = data[body.operation === "expression" ? "expression" : body.operation === "spatial" ? "locations" : "rows"];
  if (body.operation !== "schema" && (!Array.isArray(rows) || data.row_count !== rows.length || typeof data.truncated !== "boolean" || rows.length > (body.operation === "expression" ? 20000 : body.operation === "spatial" ? (body.obs_joinids as number[]).length : Number(body.max_rows ?? 100)))) censusError("invalid bounded result", 502);
  if (body.operation === "expression") validateExpression(data, body);
  if ("_census" in data) censusError("backend response collides with transport provenance", 502);
  return { ...data, _census: { release_directory_url: DIRECTORY, directory_sha256: directory.sha256, response_sha256: result.sha256, retrieved_at: result.retrieved_at } };
}
