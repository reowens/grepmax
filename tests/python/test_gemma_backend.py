"""Artifact rejection and header checks without model/framework imports."""
import importlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mlx-embed-server"))
backend = importlib.import_module("gemma_backend")


class GemmaArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        self.header = {"language_model.fixture": {"dtype": "BF16", "shape": [2], "data_offsets": [0, 4]}}
        self.write_weights()
        (self.directory / "config.json").write_text(json.dumps({"model_type": "embedding_gemma2", "audio_config": None, "vision_config": None}))
        (self.directory / "tokenizer.json").write_text('{}')
        self.contract = {"files": {name: backend.file_digest(self.directory/name) for name in ["model.safetensors", "config.json", "tokenizer.json"]}, "tensorCount": 1, "persistedValues": 2}
        self.patcher = patch.object(backend, "CONTRACT", self.contract)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def write_weights(self):
        h=json.dumps(self.header).encode()
        (self.directory / "model.safetensors").write_bytes(struct.pack('<Q',len(h))+h+b'\x00'*4)

    def test_accepts_a_verified_text_only_inventory(self):
        self.assertEqual(backend.validate_artifact(self.directory), self.directory)

    def test_changed_tokenizer_is_rejected(self):
        (self.directory/'tokenizer.json').write_text('{"changed":true}')
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            backend.validate_artifact(self.directory)

    def test_modality_config_and_weights_are_rejected_even_with_matching_file_hashes(self):
        for change in ["config", "weights"]:
            with self.subTest(change=change):
                if change == "config":
                    (self.directory/'config.json').write_text(json.dumps({"model_type":"embedding_gemma2","vision_config":{}}))
                else:
                    (self.directory/'config.json').write_text(json.dumps({"model_type":"embedding_gemma2"}))
                    self.header['vision_tower.fixture']=self.header.pop('language_model.fixture')
                    self.write_weights()
                for name in self.contract['files']:
                    self.contract['files'][name]=backend.file_digest(self.directory/name)
                with self.assertRaises(ValueError): backend.validate_artifact(self.directory)

    def test_refuses_aliases(self):
        link=self.directory/'alias';link.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(ValueError): backend.validate_artifact(link)

    def test_refuses_before_any_model_import_when_path_is_unconfigured(self):
        with patch.object(backend.platform,'system',return_value='Darwin'),patch.object(backend.platform,'machine',return_value='arm64'),patch.dict(backend.os.environ,{'MLX_EMBED_PORT':'18100'},clear=True):
            with self.assertRaisesRegex(ValueError,'GMAX_GEMMA_MODEL_PATH'): backend.load_text_model()


if __name__ == '__main__': unittest.main()
