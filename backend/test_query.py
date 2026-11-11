"""Behavioral tests use real Arrow tables and a fixture SOMA interface.

These establish adapter semantics, not native TileDB execution or live Census access.
"""
import io
from email.message import Message
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import pyarrow as pa

sys.path.insert(0, str(Path(__file__).parent))
import query
import serve

RELEASE = "2025-11-08"
URI = f"s3://cellxgene-census-public-us-west-2/cell-census/{RELEASE}/soma/"
BASE = {"operation": "obs", "release": RELEASE, "corpus": "census_data", "organism": "homo_sapiens", "expected_soma_uri": URI}
DESC = {"release_build": RELEASE, "soma": {"uri": URI}, "flags": {"lts": True}}


class Frame:
    def __init__(self, rows, indexes=("soma_joinid",)):
        self.table = pa.Table.from_pylist(rows)
        self.schema = self.table.schema
        self.index_column_names = indexes
        self.calls = []
        self.metadata = {}

    def read(self, **kwargs):
        self.calls.append(kwargs)
        rows = self.table.to_pylist()
        coords = kwargs.get("coords")
        if coords:
            for name, ids in zip(self.index_column_names, coords):
                if isinstance(ids, list):
                    rows = [row for row in rows if row[name] in ids]
        if kwargs.get("value_filter"):
            # Test-only evaluation of generated predicates over fixed fixtures.
            rows = [row for row in rows if eval(kwargs["value_filter"], {"__builtins__": {}}, row)]
        rows.sort(key=lambda row: tuple(row[name] for name in self.index_column_names))
        return iter([pa.Table.from_pylist(rows, schema=self.schema)])


class Group(dict):
    metadata = {"fixture": "source metadata"}
    def __getattr__(self, name):
        return self[name]


class Sparse:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []
    def read(self, *, coords, result_order):
        self.calls.append(coords)
        selected = [row for row in self.rows if row['soma_dim_0'] in coords[0] and row['soma_dim_1'] in coords[1]]
        return SimpleNamespace(tables=lambda: iter([pa.Table.from_pylist(selected, schema=pa.schema([('soma_dim_0', pa.int64()), ('soma_dim_1', pa.int64()), ('soma_data', pa.float64())]))]))


def fixture():
    obs = Frame([{"soma_joinid": 10, "dataset_id": "d1", "is_primary_data": True, "cell_type": "neuron", "disease": None}, {"soma_joinid": 20, "dataset_id": "d2", "is_primary_data": False, "cell_type": "neuron", "disease": "normal"}])
    var = Frame([{"soma_joinid": 2, "feature_id": "ENSG001", "feature_name": "G1"}, {"soma_joinid": 5, "feature_id": "ENSG002", "feature_name": "G2"}])
    expression = Sparse([{"soma_dim_0": 10, "soma_dim_1": 2, "soma_data": 7.0}])
    presence = Sparse([{"soma_dim_0": 101, "soma_dim_1": 2, "soma_data": 1.0}, {"soma_dim_0": 101, "soma_dim_1": 5, "soma_data": 1.0}, {"soma_dim_0": 202, "soma_dim_1": 2, "soma_data": 1.0}])
    exp = Group(obs=obs, ms=Group(RNA=Group(var=var, X=Group(raw=expression), feature_dataset_presence_matrix=presence)))
    datasets = Frame([{"soma_joinid": 101, "dataset_id": "d1", "dataset_version_id": "version1", "citation": "DOI1"}, {"soma_joinid": 202, "dataset_id": "d2", "dataset_version_id": "version2", "citation": "DOI2"}])
    census = Group(census_data=Group(homo_sapiens=exp), census_info=Group(datasets=datasets))
    return census, exp


class QueryTests(unittest.TestCase):
    def test_pagination_looks_ahead_and_retains_nulls_and_ids(self):
        census, exp = fixture()
        body = {**BASE, "max_rows": 1}
        first = query.query_open(census, body)
        self.assertTrue(first['truncated'])
        self.assertEqual(first['next_after_joinid'], 10)
        second = query.query_open(census, {**body, "after_joinid": 10})
        self.assertFalse(second['truncated'])
        self.assertFalse(second['rows'][0]['is_primary_data'])
        self.assertIsNone(first['rows'][0]['disease'])
        self.assertEqual(exp.obs.calls[0]['result_order'], 'row-major')

    def test_expression_preserves_axes_presence_and_dataset_versions(self):
        census, exp = fixture()
        result = query.query_open(census, {**BASE, "operation": "expression", "obs_joinids": [20, 10], "var_joinids": [5, 2]})
        self.assertEqual(result['row_count'], 1)
        self.assertEqual(result['expression'][0]['soma_data'], 7)
        self.assertEqual(result['datasets'][1]['dataset_version_id'], 'version2')
        self.assertEqual(exp.ms['RNA']['feature_dataset_presence_matrix'].calls[0], ([101, 202], [5, 2]))
        self.assertEqual(len(result['feature_dataset_presence']), 3)
        self.assertFalse(result['truncated'])
        self.assertIn('zero only', result['interpretation'])
        self.assertFalse(result['obs'][1]['is_primary_data'])

    def test_all_zero_selection_keeps_axes_and_presence(self):
        census, _ = fixture()
        result = query.query_open(census, {**BASE, "operation": "expression", "obs_joinids": [20], "var_joinids": [2]})
        self.assertEqual(result['expression'], [])
        self.assertEqual(len(result['feature_dataset_presence']), 1)
        self.assertEqual(result['row_count'], 0)

    def test_missing_ids_fail_instead_of_zero_filling(self):
        census, _ = fixture()
        with self.assertRaisesRegex(query.QueryError, 'do not exist'):
            query.query_open(census, {**BASE, "operation": "expression", "obs_joinids": [999], "var_joinids": [2]})

    def test_missing_layer_is_not_silently_raw(self):
        census, _ = fixture()
        with self.assertRaisesRegex(query.QueryError, 'Layer is unavailable'):
            query.query_open(census, {**BASE, "operation": "expression", "obs_joinids": [10], "var_joinids": [2], "layer": "normalized"})

    def test_schema_discovers_species_and_source_fields(self):
        census, _ = fixture()
        self.assertEqual(query.query_open(census, {**BASE, 'operation': 'schema', 'organism': None})['organisms'], ['homo_sapiens'])
        result = query.query_open(census, {**BASE, 'operation': 'schema'})
        self.assertIn('feature_id', [field['name'] for field in result['var_schema']])

    def test_unavailable_species_or_corpus_fails(self):
        census, _ = fixture()
        for change in [{'organism': 'mus_musculus'}, {'corpus': 'census_spatial_sequencing'}]:
            with self.subTest(change=change), self.assertRaises(query.QueryError):
                query.query_open(census, {**BASE, **change})

    def test_typed_predicates_validate_schema_and_escaping(self):
        _, exp = fixture()
        value = "a' or soma_joinid > 0 or cell_type == 'b"
        generated = query.predicate(exp.obs, [{'column':'cell_type','op':'eq','value':value}])
        self.assertFalse(eval(generated, {'__builtins__': {}}, {'cell_type':'neuron'}))
        with self.assertRaises(query.QueryError):
            query.predicate(exp.obs, [{'column':'unknown','op':'eq','value':'x'}])
        with self.assertRaises(query.QueryError):
            query.predicate(exp.obs, [{'column':'is_primary_data','op':'eq','value':'false'}])

    def test_spatial_retains_units_geometry_presence_and_missing_locations(self):
        census, exp = fixture()
        location = Frame([{'x': 4.5, 'y': 9.5, 'soma_joinid': 10}], indexes=('x','y','soma_joinid'))
        location.metadata = {'soma_geometry_type':'radius','soma_geometry':3.0,'soma_coordinate_space':'[{"name":"x","unit":"pixels"},{"name":"y","unit":"pixels"}]'}
        location.axis_names = ('x', 'y')
        exp['spatial'] = Group(scene1=Group(obsl=Group(loc=location)))
        exp['obs_spatial_presence'] = Frame([{'soma_joinid':10,'scene_id':'scene1','data':True}])
        census['census_spatial_sequencing'] = Group(homo_sapiens=exp)
        body = {**BASE, 'corpus':'census_spatial_sequencing', 'operation':'spatial', 'scene_id':'scene1', 'obs_joinids':[10,20]}
        result = query.query_open(census, body)
        self.assertEqual(result['locations'][0]['x'], 4.5)
        self.assertEqual(result['missing_location_joinids'], [20])
        self.assertEqual(result['coordinate_axes'], ['x','y'])
        self.assertIn('pixels', result['location_metadata']['soma_coordinate_space'])
        self.assertEqual(result['location_metadata']['soma_geometry'], 3.0)
        self.assertEqual(location.calls[0]['coords'], (slice(None),slice(None),[10,20]))
        scenes = query.query_open(census, {**BASE, 'corpus':'census_spatial_sequencing', 'operation':'scenes'})
        self.assertEqual(scenes['rows'], [{'scene_id':'scene1'}])

    def test_release_resolution_preserves_description_and_rejects_retraction(self):
        def fetch(_url, timeout):
            return io.BytesIO(json.dumps({RELEASE:DESC}).encode())
        desc, digest = query.release_description(RELEASE, URI, fetch)
        self.assertEqual(desc, DESC)
        self.assertEqual(len(digest), 64)
        with self.assertRaisesRegex(query.QueryError, 'locator changed'):
            query.release_description(RELEASE, URI+'wrong', fetch)
        with self.assertRaisesRegex(query.QueryError, 'retracted'):
            query.release_description(RELEASE, URI, lambda *_a, **_kw: io.BytesIO(json.dumps({RELEASE:{**DESC, 'flags':{'retracted':True}}}).encode()))

    def test_validation_rejects_unsupported_or_unbounded_requests(self):
        cases = [{'release':'latest'}, {'release':'2025-02-30'}, {'max_rows':1001}, {'max_rows':True}, {'organism':'../file'}, {'url':'file:///x'}, {'operation':'expression','obs_joinids':[1,1],'var_joinids':[2]}, {'operation':'expression','obs_joinids':list(range(200)),'var_joinids':list(range(200))}, {'operation':'expression','obs_joinids':[1],'var_joinids':[2],'corpus':'census_spatial_sequencing','layer':'normalized'}]
        for change in cases:
            with self.subTest(change=change), self.assertRaises(query.QueryError):
                query.validate({**BASE, **change})

    def test_precision_encoding_and_byte_limit(self):
        self.assertEqual(query.safe({'big':2**60,'missing':None,'nan':float('nan')}), {'big':str(2**60),'missing':None,'nan':'nan'})
        with self.assertRaisesRegex(query.QueryError, '2 MiB'):
            query.encode({'text':'α' * 1100000})

    def test_service_kills_timed_out_subprocess_and_masks_diagnostics(self):
        with patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('query',30)):
            self.assertEqual(serve.run_query(b'{}')[0], 504)
        with patch.object(subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout=b'secret')):
            self.assertNotIn('secret', str(serve.run_query(b'{}')))

    def test_http_auth_and_framing_reject_before_compute(self):
        token = "fixture-secret-token-for-census-service"
        Handler = serve.handler(token)
        for auth, lengths, expected in [("wrong", ["2"], 401), (f"Bearer {token}", ["65537"], 413), (f"Bearer {token}", ["2", "2"], 400)]:
            instance = object.__new__(Handler)
            instance.path = "/query"
            instance.headers = Message()
            instance.headers["Authorization"] = auth
            for length in lengths:
                instance.headers["Content-Length"] = length
            instance.rfile = io.BytesIO(b"{}")
            responses = []
            instance.send_json = lambda status, data: responses.append((status, data))
            with patch.object(serve, "run_query") as runner:
                instance.do_POST()
                runner.assert_not_called()
            self.assertEqual(responses[0][0], expected)

    def test_query_envelope_uses_exact_official_uri_and_runtime_versions(self):
        census, _ = fixture()
        class Context:
            def __enter__(self): return census
            def __exit__(self, *_args): pass
        opener = SimpleNamespace(open_soma=lambda **kw: Context())
        with patch.object(query, 'release_description', return_value=(DESC,'a'*64)), patch.dict(sys.modules, {'cellxgene_census':opener}), patch.object(query.importlib.metadata, 'version', return_value='fixture'):
            result = query.query(BASE)
        self.assertEqual(result['soma_uri'], URI)
        self.assertEqual(result['release'], RELEASE)
        self.assertEqual(result['corpus'], 'census_data')
        self.assertEqual(result['runtime']['tiledbsoma'], 'fixture')


if __name__ == '__main__':
    unittest.main()
