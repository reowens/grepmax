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

    def test_gemma_contract_rejection_and_normalized_output_without_a_model(self):
        class SyntheticVectors:
            def __init__(self, values): self.values = values
            def astype(self, _dtype): return self
            def tolist(self): return self.values
        server = self.server
        with patch.object(server, "IS_GEMMA", True), patch.object(server, "MODEL_ID", server.GEMMA_MODEL_ID), patch.object(server, "MAX_BATCH", 16):
            base = {"texts": ["query"], "expected_model": server.GEMMA_MODEL_ID}
            for contract in [None, "wrong"]:
                response = self.client.post("/embed", json={**base, "expected_contract": contract})
                self.assertEqual(response.status_code, 409)
            self.assertEqual(self.client.post("/embed", json={**base, "texts": ["query"]*17, "expected_contract": server.CONTRACT_DIGEST}).status_code, 413)
            with patch.object(server, "embed_texts", return_value=SyntheticVectors([[1.0]+[0.0]*767])):
                response = self.client.post("/embed", json={**base, "expected_contract": server.CONTRACT_DIGEST})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["contract"], server.CONTRACT_DIGEST)
                self.assertEqual(response.json()["dim"], 768)
            with patch.object(server, "embed_texts", return_value=SyntheticVectors([[0.0]*768])):
                self.assertEqual(self.client.post("/embed", json={**base, "expected_contract": server.CONTRACT_DIGEST}).status_code, 500)

    def test_does_not_load_a_model_for_contract_checks(self):
        self.assertIsNone(self.server.model)
        self.assertIsNone(self.server.tokenizer)


if __name__ == "__main__":
    unittest.main()
