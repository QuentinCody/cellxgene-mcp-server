"""Native local SOMA smoke test; skipped until the required runtime is installed."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
import pyarrow as pa
sys.path.insert(0, str(Path(__file__).parent))
import query


@unittest.skipUnless(importlib.util.find_spec('tiledbsoma'), 'Native TileDB-SOMA runtime unavailable')
class NativeTests(unittest.TestCase):
    def test_native_dataframe_and_sparse_selection(self):
        import tiledbsoma as soma
        with tempfile.TemporaryDirectory() as root:
            df_uri = str(Path(root) / 'obs')
            frame_schema = pa.schema([('soma_joinid', pa.int64()), ('cell_type', pa.large_string())])
            with soma.DataFrame.create(df_uri, schema=frame_schema, domain=[(0, 100)]) as frame:
                frame.write(pa.Table.from_pylist([{'soma_joinid':10,'cell_type':'neuron'}, {'soma_joinid':20,'cell_type':'neuron'}], schema=frame_schema))
            with soma.DataFrame.open(df_uri) as frame:
                rows, truncated = query.read_frame(frame, 1, [{'column':'cell_type','op':'eq','value':'neuron'}])
                self.assertTrue(truncated)
                self.assertEqual(rows[0]['soma_joinid'], 10)
                self.assertEqual(query.exact_rows(frame, [20])[0]['soma_joinid'], 20)
            x_uri = str(Path(root) / 'X')
            with soma.SparseNDArray.create(x_uri, type=pa.float32(), shape=(101, 11)) as matrix:
                matrix.write(pa.Table.from_pydict({'soma_dim_0':[10], 'soma_dim_1':[2], 'soma_data':[7.0]}, schema=pa.schema([('soma_dim_0',pa.int64()),('soma_dim_1',pa.int64()),('soma_data',pa.float32())])))
            with soma.SparseNDArray.open(x_uri) as matrix:
                self.assertEqual(query.sparse_rows(matrix, [10], [2], 1)[0]['soma_data'], 7.0)


if __name__ == '__main__':
    unittest.main()
