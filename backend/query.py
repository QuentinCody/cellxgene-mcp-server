"""Bounded Census metadata, sparse expression and spatial queries.

The service accepts identifiers and typed predicates, never Python/SQL/URIs.
Run through serve.py for a killable wall-clock limit and one-query concurrency.
"""
from datetime import date, datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import re
import sys
from urllib.request import urlopen

DIRECTORY = "https://census.cellxgene.cziscience.com/cellxgene-census/v1/release.json"
MAX_OUTPUT = 2 * 1024 * 1024
MAX_INPUT = 64 * 1024
CORPORA = ("census_data", "census_spatial_sequencing")


class QueryError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def require(condition, message, status=400):
    if not condition:
        raise QueryError(message, status)


def integer(value, name, minimum=0, maximum=2**53 - 1):
    require(type(value) is int and minimum <= value <= maximum, f"Invalid {name}")
    return value


def ids(value, name):
    require(isinstance(value, list) and 0 < len(value) <= 200, f"{name} requires 1..200 join IDs")
    require(len({integer(x, name) for x in value}) == len(value), f"Duplicate {name}")
    return value


def validate_selected_cells(body, operation):
    if operation in ("expression", "spatial"):
        ids(body.get("obs_joinids"), "obs_joinids")
    if operation == "expression":
        ids(body.get("var_joinids"), "var_joinids")
        require(len(body["obs_joinids"]) * len(body["var_joinids"]) <= 20000, "Selection exceeds 20,000 cell-gene pairs")
        require(body.get("layer", "raw") in ("raw", "normalized"), "Unsupported expression layer")
        require(not (body["corpus"] == "census_spatial_sequencing" and body.get("layer") == "normalized"), "Spatial Census has no normalized layer")
    if operation == "scenes":
        require(body["corpus"] == "census_spatial_sequencing", "Scene discovery requires spatial corpus")
        require(isinstance(body.get("after_scene_id", ""), str) and len(body.get("after_scene_id", "")) <= 200, "Invalid scene cursor")
    if operation == "spatial":
        require(body["corpus"] == "census_spatial_sequencing", "Spatial operation requires spatial corpus")
        require(isinstance(body.get("scene_id"), str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", body["scene_id"]), "Invalid scene_id")


def validate(body):
    require(isinstance(body, dict), "Request must be an object")
    common = {"operation", "release", "corpus", "organism", "expected_soma_uri"}
    extras = {
        "schema": set(), "scenes": {"max_rows", "after_scene_id"}, "datasets": {"dataset_ids", "max_rows", "after_joinid"},
        "obs": {"filters", "max_rows", "after_joinid"}, "var": {"filters", "max_rows", "after_joinid"},
        "expression": {"obs_joinids", "var_joinids", "layer"},
        "spatial": {"scene_id", "obs_joinids"},
    }
    operation = body.get("operation")
    require(isinstance(operation, str) and operation in extras, "Unknown operation")
    require(not set(body) - common - extras[operation], "Unknown request fields")
    release = body.get("release")
    require(isinstance(release, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", release), "Use an exact release date, not an alias")
    try:
        date.fromisoformat(release)
    except ValueError as exc:
        raise QueryError("Invalid release date") from exc
    require(body.get("corpus") in CORPORA, "Choose census_data or census_spatial_sequencing")
    organism = body.get("organism")
    require(operation != "datasets" or organism is None, "Dataset catalog spans all species; organism is not a dataset filter")
    if operation not in ("schema", "datasets") or organism is not None:
        require(isinstance(organism, str) and re.fullmatch(r"[a-z]+(?:_[a-z]+)+", organism), "Use an organism key from schema discovery")
    require(isinstance(body.get("expected_soma_uri"), str), "Release locator is required")
    if operation in ("obs", "var", "datasets", "scenes"):
        integer(body.get("max_rows", 100), "max_rows", 1, 1000)
        if "after_joinid" in body:
            integer(body["after_joinid"], "after_joinid")
    if "filters" in body:
        require(isinstance(body["filters"], list) and len(body["filters"]) <= 12, "filters must be an array of at most 12 predicates")
    if operation == "datasets" and "dataset_ids" in body:
        values = body["dataset_ids"]
        require(isinstance(values, list) and 0 < len(values) <= 200 and all(isinstance(x, str) and re.fullmatch(r"[a-fA-F0-9-]{36}", x) for x in values), "Invalid dataset_ids")
    validate_selected_cells(body, operation)
    return body


def safe(value):
    """Preserve precision and missingness across the JSON/JavaScript boundary."""
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return str(value) if abs(value) > 2**53 - 1 else value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, dict):
        return {str(k): safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [safe(v) for v in value]
    if hasattr(value, "item"):
        return safe(value.item())
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise QueryError(f"Unsupported source value type: {type(value).__name__}", 502)


def encode(value):
    data = json.dumps(safe(value), ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    require(len(data) <= MAX_OUTPUT, "Result exceeds 2 MiB; narrow the selection", 413)
    return data


def release_description(release, expected, fetch=urlopen):
    with fetch(DIRECTORY, timeout=15) as response:
        raw = response.read(512 * 1024 + 1)
    require(len(raw) <= 512 * 1024, "Release directory too large", 502)
    directory = json.loads(raw)
    desc = directory.get(release)
    require(isinstance(desc, dict) and desc.get("release_build") == release, "Release unavailable", 404)
    require(not desc.get("flags", {}).get("retracted") and not desc.get("retraction"), "Release retracted", 409)
    uri = desc.get("soma", {}).get("uri")
    require(uri == expected, "Release locator changed; rediscover release", 409)
    require(isinstance(uri, str) and uri in (
        f"s3://cellxgene-census-public-us-west-2/cell-census/{release}/soma/",
        f"s3://cellxgene-data-public/cell-census/{release}/soma/",
    ), "Unsupported provider locator", 502)
    return desc, hashlib.sha256(raw).hexdigest()


def schema(frame):
    return [{"name": field.name, "type": str(field.type), "nullable": field.nullable} for field in frame.schema]


def literal(value, kind):
    import pyarrow as pa
    if pa.types.is_dictionary(kind):
        kind = kind.value_type
    if pa.types.is_string(kind) or pa.types.is_large_string(kind):
        require(isinstance(value, str) and len(value) <= 1000, "String predicate required")
        return repr(value)
    if pa.types.is_boolean(kind):
        require(type(value) is bool, "Boolean predicate required")
        return repr(value)
    if pa.types.is_integer(kind):
        require(type(value) is int and abs(value) <= 2**53 - 1, "Safe integer predicate required")
        return str(value)
    if pa.types.is_floating(kind):
        require(type(value) in (int, float) and math.isfinite(value), "Finite numeric predicate required")
        return str(value)
    raise QueryError("Unsupported predicate column type")


def predicate(frame, filters, after=None):
    require(isinstance(filters, list) and len(filters) <= 12, "filters must contain at most 12 typed predicates")
    parts = []
    for entry in filters:
        require(isinstance(entry, dict) and set(entry) == {"column", "op", "value"}, "Invalid predicate")
        column, op, value = entry["column"], entry["op"], entry["value"]
        require(isinstance(column, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", column) and column in frame.schema.names, "Unknown filter column")
        kind = frame.schema.field(column).type
        require(op in ("eq", "in", "gte", "lte"), "Unsupported predicate operator")
        if op == "in":
            require(isinstance(value, list) and 0 < len(value) <= 200, "in requires 1..200 values")
            expression = "[" + ", ".join(literal(v, kind) for v in value) + "]"
        else:
            expression = literal(value, kind)
        parts.append(f"({column} {dict(eq='==', gte='>=', lte='<=', **{'in': 'in'})[op]} {expression})")
    if after is not None:
        integer(after, "after_joinid")
        parts.append(f"(soma_joinid > {after})")
    return " and ".join(parts) or None


def collect(iterator, limit):
    rows = []
    size = 0
    for table in iterator:
        # Arrow slicing avoids converting an unbounded native batch to Python.
        for row in table.slice(0, limit + 1 - len(rows)).to_pylist():
            rows.append(row)
            size += len(encode(row))
            require(size <= MAX_OUTPUT, "Rows exceed 2 MiB; narrow the selection", 413)
        if len(rows) > limit:
            return rows[:limit], True
    return rows, False


def read_frame(frame, limit, filters=None, after=None, joinids=None):
    kwargs = {"result_order": "row-major", "value_filter": predicate(frame, [] if filters is None else filters, after)}
    if joinids is not None:
        require("soma_joinid" in frame.index_column_names, "Source join ID is not indexed", 502)
        kwargs["coords"] = tuple(joinids if name == "soma_joinid" else slice(None) for name in frame.index_column_names)
    return collect(frame.read(**kwargs), limit)


def exact_rows(frame, joinids):
    rows, truncated = read_frame(frame, len(joinids), joinids=joinids)
    require(not truncated and {row["soma_joinid"] for row in rows} == set(joinids), "Some requested join IDs do not exist in this release/species/corpus", 404)
    return rows


def sparse_rows(array, first, second, limit):
    if not first or not second:
        return []
    rows, truncated = collect(array.read(coords=(first, second), result_order="row-major").tables(), limit)
    require(not truncated, "Sparse result exceeds selection bound", 502)
    return rows


def source_datasets(census, obs):
    dataset_ids = sorted({row["dataset_id"] for row in obs})
    datasets, truncated = read_frame(census["census_info"]["datasets"], len(dataset_ids), [{"column": "dataset_id", "op": "in", "value": dataset_ids}])
    require(not truncated and {row["dataset_id"] for row in datasets} == set(dataset_ids), "Incomplete dataset provenance", 502)
    return datasets


def expression(census, experiment, body):
    obs = exact_rows(experiment.obs, body["obs_joinids"])
    var = exact_rows(experiment.ms["RNA"].var, body["var_joinids"])
    datasets = source_datasets(census, obs)
    measurement = experiment.ms["RNA"]
    layer = body.get("layer", "raw")
    require(layer in measurement.X, "Layer is unavailable in this release", 404)
    rows = sparse_rows(measurement.X[layer], body["obs_joinids"], body["var_joinids"], 20000)
    presence = sparse_rows(measurement["feature_dataset_presence_matrix"], [row["soma_joinid"] for row in datasets], body["var_joinids"], 40000)
    return {"expression": rows, "obs": obs, "var": var, "datasets": datasets, "feature_dataset_presence": presence,
            "layer": layer, "truncated": False, "row_count": len(rows), "selection": {"obs_joinids": body["obs_joinids"], "var_joinids": body["var_joinids"]},
            "matrix_axes": {"expression": ["obs.soma_joinid", "var.soma_joinid"], "feature_dataset_presence": ["datasets.soma_joinid", "var.soma_joinid"]},
            "interpretation": "Sparse soma_data values; missing expression entries are zero only where feature_dataset_presence is true. Absent presence entries mean feature not included in that dataset. No aggregation, normalization or duplicate-cell removal is performed."}


def spatial(census, experiment, body):
    scene_id = body["scene_id"]
    require("spatial" in experiment and scene_id in experiment.spatial, "Scene unavailable", 404)
    scene = experiment.spatial[scene_id]
    location = scene.obsl["loc"]
    obs = exact_rows(experiment.obs, body["obs_joinids"])
    locations, truncated = read_frame(location, len(obs), joinids=body["obs_joinids"])
    mapping = experiment["obs_spatial_presence"]
    links, links_truncated = read_frame(mapping, len(obs), [{"column": "scene_id", "op": "eq", "value": scene_id}], joinids=body["obs_joinids"])
    require(not truncated and not links_truncated, "Spatial source has unexpected duplicate join IDs", 502)
    return {"locations": locations, "obs": obs, "datasets": source_datasets(census, obs), "scene_presence": links, "scene_id": scene_id,
            "row_count": len(locations), "truncated": False, "missing_location_joinids": sorted(set(body["obs_joinids"]) - {row["soma_joinid"] for row in locations}),
            "schema": schema(location), "scene_metadata": dict(scene.metadata), "location_metadata": dict(location.metadata),
            "coordinate_axes": list(location.axis_names),
            "interpretation": "Coordinates retain source axis names and full location metadata, including provider coordinate-space metadata. No image bytes, coordinate transforms or inferred physical units."}


def query_open(census, body):
    corpus = body["corpus"]
    require(corpus in census, "Corpus unavailable in this release", 404)
    operation = body["operation"]
    organisms = list(census[corpus].keys())
    if operation == "datasets":
        frame = census["census_info"]["datasets"]
        filters = [{"column": "dataset_id", "op": "in", "value": body["dataset_ids"]}] if "dataset_ids" in body else []
    else:
        if operation == "schema" and not body.get("organism"):
            return {"organisms": organisms, "corpora": [name for name in CORPORA if name in census], "metadata": dict(census.metadata), "datasets_schema": schema(census["census_info"]["datasets"])}
        require(body["organism"] in organisms, "Organism unavailable in this corpus/release", 404)
        experiment = census[corpus][body["organism"]]
        if operation == "schema":
            return {"obs_schema": schema(experiment.obs), "var_schema": schema(experiment.ms["RNA"].var), "layers": list(experiment.ms["RNA"].X.keys()), "metadata": dict(experiment.metadata), "spatial_available": "spatial" in experiment,
                    "spatial_mapping_schema": schema(experiment["obs_spatial_presence"]) if "obs_spatial_presence" in experiment else None}
        if operation == "scenes":
            require("spatial" in experiment, "Spatial scenes unavailable", 404)
            names = sorted(name for name in experiment.spatial.keys() if name > body.get("after_scene_id", ""))
            selected = names[:body.get("max_rows", 100)]
            truncated = len(names) > len(selected)
            return {"rows": [{"scene_id": name} for name in selected], "row_count": len(selected), "truncated": truncated, "next_after_scene_id": selected[-1] if truncated else None}
        if operation == "expression":
            return expression(census, experiment, body)
        if operation == "spatial":
            return spatial(census, experiment, body)
        frame = experiment.obs if operation == "obs" else experiment.ms["RNA"].var
        filters = body.get("filters", [])
    rows, truncated = read_frame(frame, body.get("max_rows", 100), filters, body.get("after_joinid"))
    return {"rows": rows, "schema": schema(frame), "row_count": len(rows), "truncated": truncated,
            "next_after_joinid": rows[-1]["soma_joinid"] if truncated and rows else None,
            "scope": "All-corpus dataset catalog; dataset membership in a species/corpus must be checked in obs" if operation == "datasets" else "Filtered page, ordered by soma_joinid; not an exact total",
            "filters_applied": filters, "after_joinid": body.get("after_joinid")}


def query(body):
    validate(body)
    try:
        import cellxgene_census
    except ImportError as exc:
        raise QueryError("Census runtime is not installed", 503) from exc
    desc, directory_hash = release_description(body["release"], body["expected_soma_uri"])
    with cellxgene_census.open_soma(uri=desc["soma"]["uri"], tiledb_config={"py.init_buffer_bytes": 4 * 1024**2}) as census:
        result = query_open(census, body)
    result.update({"source": "CELLxGENE Census", "operation": body["operation"], "release": body["release"], "corpus": body["corpus"], "organism": body.get("organism"),
                   "release_description": desc, "soma_uri": desc["soma"]["uri"], "release_directory_sha256": directory_hash,
                   "retrieved_at": datetime.now(timezone.utc).isoformat(),
                   "runtime": {name: importlib.metadata.version(name) for name in ("cellxgene-census", "tiledbsoma")},
                   "encoding": "Unsafe JS integers and nonfinite floats are strings; missing values remain null. soma_joinid values are scoped to release, corpus and organism."})
    encode(result)
    return result


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        require(len(raw) <= MAX_INPUT, "Request too large", 413)
        data = query(json.loads(raw))
        output = {"status": 200, "data": data}
    except QueryError as exc:
        output = {"status": exc.status, "error": str(exc)}
    except Exception:
        output = {"status": 502, "error": "Census runtime or source query failed"}
    # The service strips this small process-protocol wrapper before HTTP output.
    encoded = json.dumps(safe(output), ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    if len(encoded) > MAX_OUTPUT + 1024:
        encoded = encode({"status": 413, "error": "Result exceeds 2 MiB; narrow the selection"})
    sys.stdout.buffer.write(encoded)


if __name__ == "__main__":
    main()
