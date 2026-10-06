"""Opt-in HTTP compatibility checks using the locked MLX environment, without model loads.

Run GMAX_TEST_MLX=1 <locked-venv>/bin/python -m unittest discover -s tests/python.
Ordinary CI runs the standard-library audit tests and skips these Apple Silicon checks.
"""

import importlib
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


@unittest.skipUnless(os.environ.get("GMAX_TEST_MLX") == "1", "requires the locked MLX environment")
class MlxHttpCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mlx-embed-server"))
        cls.server = importlib.import_module("server")
        from fastapi.testclient import TestClient
        # No context manager: do not run the lifespan that loads model weights.
        cls.client = TestClient(cls.server.app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_health_keeps_the_model_identity_contract(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["model"], self.server.MODEL_ID)
        self.assertEqual(response.json()["status"], "ok")

    def test_rejects_invalid_oversized_and_wrong_model_requests(self):
        for payload, status in [
            ({}, 422),
            ({"texts": ["text"] * (self.server.MAX_BATCH + 1)}, 413),
            ({"texts": ["text"], "expected_model": "different-model"}, 409),
        ]:
            with self.subTest(payload=payload):
                self.assertEqual(self.client.post("/embed", json=payload).status_code, status)

    def test_serializes_embedding_vectors_through_real_asgi_and_pydantic(self):
        import numpy as np
        with patch.object(self.server, "embed_texts", return_value=np.array([[0.6, 0.8]])) as embed:
            response = self.client.post("/embed", json={"texts": ["sample"], "expected_model": self.server.MODEL_ID})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"vectors": [[0.6, 0.8]], "dim": 2, "model": self.server.MODEL_ID})
            embed.assert_called_once_with(["sample"])

    def test_does_not_load_a_model_for_contract_checks(self):
        self.assertIsNone(self.server.model)
        self.assertIsNone(self.server.tokenizer)


if __name__ == "__main__":
    unittest.main()
