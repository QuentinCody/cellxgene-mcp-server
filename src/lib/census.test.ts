import { afterEach, expect, it, vi } from "vitest";
import { createCellxgeneApiFetch } from "./api-adapter";
import { censusRequest, selectRelease } from "./census";

const release = "2025-11-08";
const uri = `s3://cellxgene-census-public-us-west-2/cell-census/${release}/soma/`;
const desc = { release_build: release, soma: { uri }, flags: { lts: true } };
const directory = { stable: release, latest: "2025-11-17", [release]: desc };
const env = { CELLXGENE_CENSUS_URL: "https://census.example/query", CELLXGENE_CENSUS_TOKEN: "fixture-token-private-value" };
const body = { operation: "obs", release, corpus: "census_data", organism: "homo_sapiens" };
const payload = { source: "CELLxGENE Census", ...body, soma_uri: uri, release_description: desc, rows: [{ soma_joinid: 1, dataset_id: "fixture", is_primary_data: false }], row_count: 1, truncated: true, next_after_joinid: 1 };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const query = (data = payload) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(directory)).mockResolvedValueOnce(json(data)));
  return createCellxgeneApiFetch(env)({ method: "POST", path: "/census/query", body });
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("discovers raw release aliases/retractions without a backend", async () => {
  const native = { ...directory, "2025-11-04": { release_build: "2025-11-04", flags: { retracted: true }, retraction: { reason: "fixture" } } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(native)));
  expect(await createCellxgeneApiFetch()({ method: "GET", path: "/census/releases" })).toMatchObject({ data: { directory: native, response_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
});

it("hashes the complete UTF-8 release response including a BOM", async () => {
  const raw = `\uFEFF${JSON.stringify(directory)}`;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(raw)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const expected = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  expect(await createCellxgeneApiFetch()({ method: "GET", path: "/census/releases" })).toMatchObject({ data: { directory, response_sha256: expected } });
});

it("passes a release-checked query with only the host token and preserves native rows", async () => {
  expect(await query()).toMatchObject({ data: { ...payload, _census: { response_sha256: expect.any(String) } } });
  const call = vi.mocked(fetch).mock.calls[1];
  expect(call[0]).toBe(env.CELLXGENE_CENSUS_URL);
  expect(call[1]).toMatchObject({ redirect: "manual", headers: { Authorization: `Bearer ${env.CELLXGENE_CENSUS_TOKEN}` } });
  expect(JSON.parse(call[1]?.body as string)).toEqual({ ...body, expected_soma_uri: uri });
});

it.each(["release", "corpus", "organism", "soma_uri", "operation"])("rejects mismatched %s", async field => {
  await expect(query({ ...payload, [field]: "wrong" })).rejects.toMatchObject({ status: 502 });
});

it.each([
  { release: "latest" }, { release: "2025-02-30" }, { organism: "../file" }, { max_rows: 1001 }, { after_joinid: -1 },
  { operation: "__proto__" }, { expected_soma_uri: "file:///tmp/x" }, { filters: "raw expression" },
  { filters: [{ column: "x", op: "eq", value: null }] }, { filters: [{ column: "x", op: "in", value: [] }] },
  { filters: [{ column: "x", op: "eq", value: 2 ** 60 }] },
  { operation: "expression", obs_joinids: [1, 1], var_joinids: [2] },
  { operation: "expression", obs_joinids: [1], var_joinids: [2], layer: "scaled" },
  { operation: "expression", corpus: "census_spatial_sequencing", obs_joinids: [1], var_joinids: [2], layer: "normalized" },
])("rejects malformed or unbounded selection %#", change => {
  expect(() => censusRequest({ ...body, ...change })).toThrow();
});

it("keeps typed string values literal and boolean choices explicit", () => {
  const filters = [{ column: "cell_type", op: "eq", value: "x' or true" }, { column: "is_primary_data", op: "eq", value: false }];
  expect(censusRequest({ ...body, filters }).filters).toEqual(filters);
});

it("fails clearly when backend is absent without network calls", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await expect(createCellxgeneApiFetch()({ method: "POST", path: "/census/query", body })).rejects.toMatchObject({ status: 503 });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["http://census.example/query", "https://user:secret@census.example/query", "https://census.example/query?key=secret", "https://census.example/not-query"])("rejects invalid backend URL %s", async url => {
  await expect(createCellxgeneApiFetch({ ...env, CELLXGENE_CENSUS_URL: url })({ method: "POST", path: "/census/query", body })).rejects.toMatchObject({ status: 503 });
});

it("rejects retracted, mismatched or off-provider release locators", () => {
  expect(() => selectRelease({ [release]: { ...desc, flags: { retracted: true } } }, release)).toThrow("retracted");
  expect(() => selectRelease({ [release]: { ...desc, release_build: "other" } }, release)).toThrow();
  expect(() => selectRelease({ [release]: { ...desc, soma: { uri: "s3://other/bucket" } } }, release)).toThrow();
});

it("does not leak a backend diagnostic or escaped secret", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(directory)).mockResolvedValueOnce(new Response(env.CELLXGENE_CENSUS_TOKEN, { status: 500 })));
  await expect(createCellxgeneApiFetch(env)({ method: "POST", path: "/census/query", body })).rejects.toThrow("HTTP 500");
  const encodedSecret = env.CELLXGENE_CENSUS_TOKEN.split("").map(x => `\\u${x.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(directory)).mockResolvedValueOnce(new Response(`{"secret":"${encodedSecret}"}`)));
  await expect(createCellxgeneApiFetch(env)({ method: "POST", path: "/census/query", body })).rejects.toThrow("credential material");
});

it("rejects oversized backend responses and retains timeout semantics", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(directory)).mockResolvedValueOnce(new Response('"' + "α".repeat(1100000) + '"')));
  await expect(createCellxgeneApiFetch(env)({ method: "POST", path: "/census/query", body })).rejects.toThrow("too large");
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))));
  const failure = expect(createCellxgeneApiFetch()({ method: "GET", path: "/census/releases" })).rejects.toMatchObject({ status: 502 });
  await vi.advanceTimersByTimeAsync(15000); await failure;
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps Discover metadata working independently", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ dataset_version_id: "fixture" })));
  expect(await createCellxgeneApiFetch()({ method: "GET", path: "/datasets/fixture" })).toMatchObject({ data: { dataset_version_id: "fixture" } });
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("api.cellxgene.cziscience.com/curation/v1/datasets/fixture");
});
