# Census query service

This service runs the Python Census/TileDB-SOMA query path used by the Worker's `/census/query` adapter. It is separate from Discover REST. **Native runtime and live Census acceptance are pending**: the development environment has PyArrow but cannot obtain the Census/TileDB-SOMA wheels. Fixture tests are not a native integration verdict.

Provider references: [Census data releases](https://chanzuckerberg.github.io/cellxgene-census/cellxgene_census_docsite_data_release_info.html), [Python API](https://chanzuckerberg.github.io/cellxgene-census/python-api.html), [spatial tutorial](https://chanzuckerberg.github.io/cellxgene-census/notebooks/api_demo/census_spatial.html), [Census schema](https://github.com/chanzuckerberg/cellxgene-census/blob/main/docs/cellxgene_census_schema.md), [TileDB-SOMA read implementation](https://github.com/single-cell-data/TileDB-SOMA/blob/2.3.0/apis/python/src/tiledbsoma/_dataframe.py).

## Provisioning

Use Python 3.12 in an isolated deployment environment. The proposed runtime pins are in `requirements.txt`; they still require a successful dependency resolution, native tests and a real release query before deployment. No packages were installed during implementation.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m unittest discover -p 'test_*.py'
# Set CELLXGENE_CENSUS_TOKEN through your secret manager (at least 32 characters).
.venv/bin/python serve.py --host 127.0.0.1 --port 8099
```

Expose only `/query` behind HTTPS with request/queue limits. Set the Worker environment `CELLXGENE_CENSUS_URL=https://<backend-host>/query` and its secret `CELLXGENE_CENSUS_TOKEN` to the same token. Queries use public Census data; the token protects your compute service. Error diagnostics are sanitized before reaching the Worker.

Each request runs in a fresh subprocess with a 30-second kill deadline, with one request processed at a time. Enforce a memory limit at the container boundary: result limits and the requested 4 MiB initial TileDB buffer do not bound native library memory or total scan cost. TileDB-SOMA's documented `batch_size` argument is currently ignored, so this implementation does not claim it caps native batches. Arrow batches are sliced before converting rows to Python. Large scans should run offline; the service returns an error instead of partial expression values when it exceeds its deadline or byte budget.

## Query contract

The Worker validates the official release directory, then sends the request with an `expected_soma_uri`. The backend independently reads that directory, rejects unavailable/retracted releases or changed locators, and opens only recognized official dated S3 paths. The directory hash identifies observed metadata bytes; it is not a checksum of the entire Census data corpus. Queries never accept arbitrary URIs, Python code, raw SQL or free-form filter expressions.

Required fields: `operation`, exact date `release`, and `corpus` (`census_data` or `census_spatial_sequencing`). `organism` is required except initial `schema` discovery and the all-species `datasets` catalog. Discover available organism keys per release; do not assume only human/mouse or that a species exists in both corpora.

- `schema`: with no organism, returns corpus/species discovery and dataset schema; with an organism, returns actual obs/var schemas, layers and spatial mapping schema.
- `datasets`: pages the release's all-corpus dataset catalog; optional `dataset_ids`, `max_rows` and `after_joinid`. Dataset versions and citations remain intact. `organism` is rejected because it would imply an unsupported species filter.
- `obs` / `var`: optional typed `filters` (`column`, `op` = `eq/in/gte/lte`, `value`), `max_rows` (default 100, maximum 1,000), and `after_joinid`. Predicates use observed Arrow column types. Pages retain all columns, nulls and duplicate biological observations; `truncated` uses a one-row lookahead, with a join-ID cursor. Counts describe the returned page, not the whole cohort.
- `expression`: explicit `obs_joinids` and `var_joinids` (1–200 distinct safe integer IDs each; at most 20,000 pairs), and optional `layer` (`raw` by default). Missing IDs or unavailable layers are errors. Spatial expression has no normalized layer. Results carry separate `expression`, `obs`, `var`, `datasets`, and `feature_dataset_presence` arrays, with explicit sparse matrix axes. Missing sparse expression entries mean zero **only where dataset-feature presence is true**. Other missing combinations were not included in the dataset. The adapter does not aggregate, normalize or filter `is_primary_data` implicitly.
- `scenes`: pages scene identifiers for spatial data using `max_rows` and `after_scene_id`.
- `spatial`: exact `scene_id` plus `obs_joinids`; returns native locations, obs, scene-presence mappings, missing-location IDs, coordinate axis names, and complete scene/location metadata (including source coordinate-space and spot-geometry metadata). It does not infer physical units, transform coordinates or download images.

Requests are limited to 64 KiB and output to 2 MiB. Unsafe JavaScript integers and nonfinite floats are encoded as strings. Join IDs belong to one release/corpus/organism; never join them across these boundaries. Native SDK compatibility, actual schema coverage, spatial mappings/units, throughput and Worker-to-backend staging must be validated against real data before calling the integration verified.

Embedding search is optional in the audit and remains deferred. It needs separate model/release compatibility and vector-search validation; no embedding endpoint is advertised by this service.
