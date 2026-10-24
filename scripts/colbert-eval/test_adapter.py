#!/usr/bin/env python3
"""Model-free adapter tests. No real model, tokenizer, runtime or network calls."""

import sys
sys.dont_write_bytecode = True

import builtins
import copy
import io
import json
import math
import os
from pathlib import Path
import random
import socket
import subprocess
import unittest
from unittest import mock

import adapter


def contract():
    return {"modelId": adapter.MODEL_ID, "revision": "a" * 40,
            "weightsSha256": "b" * 64, "tokenizerSha256": "c" * 64,
            "projectionSha256": "d" * 64, "backend": "torch-cpu", "precision": "float32",
            "dimensions": 48, "queryMaxTokens": 32, "documentMaxTokens": 512,
            "preparation": "gmax-token-ids-v1", "normalization": "per-token-l2",
            "documentStorage": "int8-per-document-maxabs-127"}


def item(identity="q1", kind="query", ids=None, mask=None):
    ids = [50281, 50368, 50282] if ids is None else ids
    return {"id": identity, "kind": kind, "inputIds": ids,
            "attentionMask": [1] * len(ids) if mask is None else mask}


def request():
    return {"schemaVersion": 1, "requestId": "synthetic-01", "operation": "validate",
            "contract": contract(), "inputs": [item()]}


def frame(value):
    return (json.dumps(value, separators=(",", ":")) + "\n").encode()


def row(*values):
    return list(values) + [0.0] * (48 - len(values))


def metadata():
    return (
        {"model_type": "modernbert", "hidden_size": 256},
        [{"idx": 0, "name": "0", "path": "", "type": "sentence_transformers.models.Transformer"},
         {"idx": 1, "name": "1", "path": "1_Dense", "type": "pylate.models.Dense.Dense"},
         {"idx": 2, "name": "2", "path": "2_Dense", "type": "pylate.models.Dense.Dense"}],
        [{"in_features": 256, "out_features": 512, "bias": False,
          "activation_function": "torch.nn.modules.linear.Identity"},
         {"in_features": 512, "out_features": 48, "bias": False,
          "activation_function": "torch.nn.modules.linear.Identity"}],
    )


def projection_hashes():
    # Public source metadata only; no checkpoint bytes were fetched for this test.
    return dict(zip(adapter.PROJECTION_FILES, (
        "fdedbe7da07dafae623a002bcde227e767b8129da964fd90a3da301e3c7f929f",
        "cbd910c4bc2a0338f58f08b4a840770b38bceda90eb1c433233cbf227121bee1",
        "d0e3d51270eb8bef21c3f321b2848ebfc2894d5e93fde02f7f09a8c7308748f0",
        "8e724279af3acf91c20d4a4dd33c6bd272f80b02095ff969e8a3f3de6432175c",
    )))


class ValidationTests(unittest.TestCase):
    def assertRefusal(self, value, code=None):
        result = adapter.handle_request(value)
        self.assertIs(result["ok"], False)
        self.assertIs(result["inferencePerformed"], False)
        self.assertEqual(set(result), {"schemaVersion", "requestId", "ok", "inferencePerformed", "error"})
        self.assertEqual(set(result["error"]), {"code", "message"})
        self.assertRegex(result["error"]["code"], r"^[a-z0-9_]{1,80}$")
        self.assertTrue(0 < len(result["error"]["message"]) <= 500)
        if code:
            self.assertEqual(result["error"]["code"], code)
        return result

    def test_success_exact_wire_shape(self):
        self.assertEqual(adapter.handle_frame(frame(request())), {
            "schemaVersion": 1, "requestId": "synthetic-01", "ok": True,
            "operation": "validate", "inferencePerformed": False, "ids": ["q1"], "dimensions": 48})

    def test_malformed_envelope(self):
        for value in (None, [], 1, "validate", {}, {"schemaVersion": 1}):
            with self.subTest(value=value):
                self.assertRefusal(value, "invalid_request")
        for key in request():
            value = request()
            del value[key]
            self.assertRefusal(value, "invalid_request")
        value = request()
        value["unexpected"] = True
        self.assertRefusal(value, "invalid_request")

    def test_schema_and_identifier_bounds(self):
        for bad in (0, 2, True, "1", None, 1.5):
            value = request()
            value["schemaVersion"] = bad
            self.assertRefusal(value, "unsupported_schema")
        for bad in (None, "", "a" * 81, "space here", "λ", "\n", "\ud800", 3, True):
            value = request()
            value["requestId"] = bad
            result = self.assertRefusal(value, "invalid_request_id")
            self.assertIsNone(result["requestId"])
        value = request()
        value["requestId"] = "a" * 80
        self.assertTrue(adapter.handle_request(value)["ok"])

    def test_integral_json_numbers_follow_js_validator(self):
        value = request()
        value["schemaVersion"] = 1.0
        value["contract"]["dimensions"] = 48.0
        value["inputs"][0]["inputIds"] = [0.0, 2147483647.0]
        value["inputs"][0]["attentionMask"] = [0.0, 1.0]
        self.assertTrue(adapter.handle_request(value)["ok"])
        self.assertEqual(adapter.validate_request(value)[1][0].input_ids, (0, 2147483647))

    def test_inference_and_unknown_operations_always_refuse(self):
        for operation in ("infer", "load", "encode", "VALIDATE", None, [], True):
            value = request()
            value["operation"] = operation
            self.assertRefusal(value, "inference_disabled")

    def test_execution_fields_and_environment_cannot_bypass_gate(self):
        with mock.patch.dict(os.environ, {"GMAX_ALLOW_INFERENCE": "1", "HF_HUB_OFFLINE": "0",
                                          "COLBERT_EVAL_EXECUTE": "1"}):
            for operation in ("infer", "validate"):
                value = request()
                value.update(operation=operation, executionPermission=True,
                             verifiedLocalArtifactLocation="/tmp/not-a-real-model")
                self.assertRefusal(value, "invalid_request")
        for args in ((), ({"runtimeQualified": True},), (None, True, "/tmp/model")):
            with self.assertRaisesRegex(adapter.AdapterError, "disabled"):
                adapter.load_local_runtime(*args, execute=True, allow_inference=True)

    def test_contract_exact_fields_and_model(self):
        for field in contract():
            value = request()
            del value["contract"][field]
            self.assertRefusal(value, "invalid_contract")
        for bad in (None, [], "model", {**contract(), "other": 1}):
            value = request()
            value["contract"] = bad
            self.assertRefusal(value, "invalid_contract")
        value = request()
        value["contract"]["modelId"] = "other/model"
        self.assertRefusal(value, "unsupported_model")

    def test_immutable_revision_and_artifact_hashes(self):
        for bad in ("main", "a" * 39, "A" * 40, "g" * 40, None, 2):
            value = request()
            value["contract"]["revision"] = bad
            self.assertRefusal(value, "invalid_revision")
        for field in ("weightsSha256", "tokenizerSha256", "projectionSha256"):
            for bad in ("", "a" * 63, "A" * 64, "z" * 64, None, [], 0):
                value = request()
                value["contract"][field] = bad
                self.assertRefusal(value, "invalid_artifact_hash")

    def test_backend_precision_and_dimensions(self):
        for backend in ("torch-cpu", "torch-mps"):
            for precision in ("float16", "float32"):
                value = request()
                value["contract"].update(backend=backend, precision=precision)
                self.assertTrue(adapter.handle_request(value)["ok"])
        for field, bad in (("backend", "auto"), ("precision", "int8")):
            value = request()
            value["contract"][field] = bad
            self.assertRefusal(value, "unsupported_backend")
        for field, bad in (("dimensions", 128), ("dimensions", True), ("dimensions", "48"),
                           ("queryMaxTokens", 48), ("documentMaxTokens", 513),
                           ("preparation", "pylate"), ("normalization", "none"),
                           ("documentStorage", "int8-per-channel")):
            value = request()
            value["contract"][field] = bad
            self.assertRefusal(value, "incompatible_contract")

    def test_input_counts_fields_identity_and_kind(self):
        for bad in (None, (), {}, [], [item()] * 65):
            value = request()
            value["inputs"] = bad
            self.assertRefusal(value, "invalid_inputs")
        for bad in (None, [], {"id": "x"}, {**item(), "text": "not accepted"}):
            value = request()
            value["inputs"] = [bad]
            self.assertRefusal(value, "invalid_input")
        for bad in ("", "bad id", "é", "x" * 81, None, True):
            value = request()
            value["inputs"][0]["id"] = bad
            self.assertRefusal(value, "invalid_input_id")
        value = request()
        value["inputs"] *= 2
        self.assertRefusal(value, "invalid_input_id")
        for bad in ("doc", "QUERY", None, True, []):
            value = request()
            value["inputs"][0]["kind"] = bad
            self.assertRefusal(value, "invalid_input_kind")

    def test_token_boundaries_and_malformed_masks(self):
        for ids in ([], None, (), "abc", [True], [-1], [2**31], [1.2], ["1"], [math.inf], [math.nan], [1] * 33):
            value = request()
            value["inputs"][0]["inputIds"] = ids
            self.assertRefusal(value, "invalid_tokens")
        for mask in (None, (), "111", [], [1], [1, 1, 1, 1], [True, 1, 1], [-1, 1, 1],
                     [2, 1, 1], [0.5, 1, 1], [math.inf, 1, 1], ["1", 1, 1]):
            value = request()
            value["inputs"][0]["attentionMask"] = mask
            self.assertRefusal(value, "invalid_mask")
        value = request()
        value["inputs"] = [item("doc", "document", [1] * 513)]
        self.assertRefusal(value, "invalid_tokens")

    def test_exact_ids_masks_snapshot_and_order(self):
        value = request()
        value["inputs"] = [item("z", ids=[50281, 50368, 50284, 50282], mask=[1, 0, 1, 0]),
                           item("a", "document", [0, 2147483647], [0, 0])]
        before = copy.deepcopy(value)
        validated = adapter.validate_request(value)[1]
        self.assertEqual(value, before)
        self.assertEqual(validated[0].input_ids, (50281, 50368, 50284, 50282))
        self.assertEqual(validated[0].attention_mask, (1, 0, 1, 0))
        self.assertEqual(validated[1].attention_mask, (0, 0))
        self.assertEqual(adapter.handle_request(value)["ids"], ["z", "a"])
        value["inputs"][0]["inputIds"][0] = 3
        self.assertEqual(validated[0].input_ids[0], 50281)

    def test_synthetic_64_input_boundary_set_batches_1_8_16(self):
        # These arrays stand in for prepared inputs; they do not prove tokenizer parity.
        value = request()
        value["inputs"] = [item("case-%02d" % index,
                                "query" if index % 2 == 0 else "document",
                                [50284] * (32 if index % 2 == 0 else 512)) for index in range(64)]
        inputs = adapter.validate_request(value)[1]
        self.assertEqual(adapter.handle_request(value)["ids"], [entry["id"] for entry in value["inputs"]])
        for size in (1, 8, 16):
            restored = []
            for offset in range(0, 64, size):
                batch = adapter.pad_batch(inputs[offset:offset + size])
                for index, length in enumerate(batch.lengths):
                    self.assertEqual(batch.input_ids[index][:length], inputs[offset + index].input_ids)
                    self.assertEqual(batch.attention_mask[index][:length], inputs[offset + index].attention_mask)
                restored.extend(batch.ids)
            self.assertEqual(tuple(restored), tuple(entry.id for entry in inputs))

    def test_validation_has_no_import_network_or_filesystem_calls(self):
        value, encoded = request(), frame(request())
        missing = {name for name in ("torch", "pylate", "transformers", "tokenizers", "numpy") if name not in sys.modules}
        # Import-time stdlib loading is outside this boundary. After import, both
        # object and JSONL validation must survive with all these operations denied.
        with mock.patch.object(builtins, "open", side_effect=AssertionError("filesystem")), \
             mock.patch.object(io, "open", side_effect=AssertionError("filesystem")), \
             mock.patch.object(os, "open", side_effect=AssertionError("filesystem")), \
             mock.patch.object(os, "stat", side_effect=AssertionError("filesystem")), \
             mock.patch.object(os, "listdir", side_effect=AssertionError("filesystem")), \
             mock.patch.object(os, "scandir", side_effect=AssertionError("filesystem")), \
             mock.patch.object(socket, "socket", side_effect=AssertionError("network")), \
             mock.patch.object(socket, "create_connection", side_effect=AssertionError("network")), \
             mock.patch.object(subprocess, "Popen", side_effect=AssertionError("process")), \
             mock.patch.object(builtins, "__import__", side_effect=AssertionError("import")):
            self.assertTrue(adapter.handle_request(value)["ok"])
            self.assertTrue(adapter.handle_frame(encoded)["ok"])
            value["operation"] = "infer"
            self.assertFalse(adapter.handle_request(value)["ok"])
        self.assertTrue(missing.isdisjoint(sys.modules))

    def test_errors_do_not_echo_input_or_tracebacks(self):
        value = request()
        value["contract"]["modelId"] = "PRIVATE_SOURCE_OR_WEIGHT_CONTENT"
        result = self.assertRefusal(value)
        encoded = json.dumps(result)
        self.assertNotIn("PRIVATE_SOURCE", encoded)
        self.assertNotIn("Traceback", encoded)


class FramingTests(unittest.TestCase):
    def test_malformed_json_utf8_duplicates_and_multiple_lines(self):
        cases = ((b"", "frame_too_large"), (b"\xff\n", "invalid_utf8"),
                 (b"[]\n", "invalid_frame"), (b"1\n", "invalid_frame"),
                 (b"{\n", "invalid_json"), (b"{}\n{}\n", "invalid_frame"),
                 (b'{"x":NaN}\n', "invalid_json"), (b'{"x":Infinity}\n', "invalid_json"),
                 (b'{"x":1,"x":2}\n', "invalid_json"))
        for encoded, code in cases:
            with self.subTest(code=code, encoded=encoded[:30]):
                result = adapter.handle_frame(encoded)
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["code"], code)
        # Python versions differ in decoder recursion handling. Either refusal is
        # safe: the nested array is not a request object, even when parseable.
        nested = adapter.handle_frame(b"[" * 2000 + b"]" * 2000)
        self.assertFalse(nested["ok"])
        self.assertIn(nested["error"]["code"], ("invalid_frame", "invalid_json"))
        self.assertTrue(adapter.handle_frame(frame(request()).rstrip(b"\n") + b"\r\n")["ok"])

    def test_limit_includes_newline_and_reads_are_bounded(self):
        encoded = frame(request())
        exact = encoded[:-1] + b" " * (adapter.MAX_FRAME_BYTES - len(encoded)) + b"\n"
        self.assertEqual(len(exact), adapter.MAX_FRAME_BYTES)
        self.assertTrue(adapter.handle_frame(exact)["ok"])
        self.assertEqual(adapter.handle_frame(exact + b" ")["error"]["code"], "frame_too_large")
        source = io.BytesIO(b"x" * (adapter.MAX_FRAME_BYTES + 2) + b"\n" + encoded)
        output = io.StringIO()
        self.assertEqual(adapter.serve(source, output), 1)
        self.assertEqual(source.tell(), adapter.MAX_FRAME_BYTES + 1)
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["error"]["code"], "frame_too_large")

    def test_jsonl_continues_after_recoverable_bad_request(self):
        output = io.StringIO()
        source = io.BytesIO(frame(request()) + b"{bad}\n" + frame(request()))
        self.assertEqual(adapter.serve(source, output), 0)
        self.assertEqual([json.loads(line)["ok"] for line in output.getvalue().splitlines()], [True, False, True])

    def test_cli_validation_protocol_and_disabled_flags(self):
        path = str(Path(__file__).with_name("adapter.py"))
        result = subprocess.run([sys.executable, "-B", path], input=frame(request()), capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout), adapter.handle_request(request()))
        value = request()
        value["operation"] = "infer"
        result = subprocess.run([sys.executable, "-B", path], input=frame(value), capture_output=True, timeout=10)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "inference_disabled")
        result = subprocess.run([sys.executable, "-B", path, "--infer"], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertNotIn(b"Traceback", result.stderr)


class PaddingAndMathTests(unittest.TestCase):
    def test_padding_preserves_zero_masks_and_trims_only_added_positions(self):
        inputs = adapter.validate_inputs([item("z", ids=[4, 5, 6], mask=[1, 0, 1]),
                                          item("a", "document", [7], [0])], contract())
        batch = adapter.pad_batch(inputs)
        self.assertEqual(batch.ids, ("z", "a"))
        self.assertEqual(batch.input_ids, ((4, 5, 6), (7, 50283, 50283)))
        self.assertEqual(batch.attention_mask, ((1, 0, 1), (0, 0, 0)))
        vectors = [[row(1), row(2), row(3)], [row(4), row(5), row(6)]]
        restored = adapter.restore_batch_rows(batch, batch.ids, vectors)
        self.assertEqual(tuple(map(len, restored)), (3, 1))
        self.assertEqual(restored[0][1], tuple(row(2)))
        self.assertEqual(restored[1][0], tuple(row(4)))

    def test_padding_rejects_wrong_token_and_forged_inputs(self):
        inputs = adapter.validate_request(request())[1]
        for bad in (None, [], (), [item()]):
            with self.assertRaises(adapter.AdapterError):
                adapter.pad_batch(bad)
        for pad in (0, 50284, True):
            with self.assertRaises(adapter.AdapterError):
                adapter.pad_batch(inputs, pad)
        with self.assertRaises(adapter.AdapterError):
            adapter.pad_batch((adapter.PreparedInput("x", "query", (True,), (1,)),))

    def test_output_shape_order_and_nonfinite_refusal(self):
        batch = adapter.pad_batch(adapter.validate_inputs([item("z"), item("a")], contract()))
        vectors = [[row(1)] * 3, [row(2)] * 3]
        for ids, data in ((["a", "z"], vectors), (["z", "z"], vectors),
                          (batch.ids, vectors[:1]), (batch.ids, [[row(1)], vectors[1]]),
                          (batch.ids, [[[1] * 47] * 3, vectors[1]]),
                          (batch.ids, [[row(math.nan)] * 3, vectors[1]])):
            with self.assertRaises(adapter.AdapterError):
                adapter.restore_batch_rows(batch, ids, data)

    def test_normalization_zeros_and_unit_rows(self):
        result = adapter.normalize_rows([row(3, 4), row(0), row(-3, -4)])
        self.assertEqual(result[0][:2], (0.6, 0.8))
        self.assertEqual(result[1], (0.0,) * 48)
        self.assertEqual(result[2][:2], (-0.6, -0.8))
        self.assertAlmostEqual(sum(value * value for value in result[0]), 1.0)

    def test_bad_dimensions_zero_length_nonfinite_and_overflow(self):
        for data in ([], None, [[1] * 47], [row(True)], [row("1")], [row(math.nan)],
                     [row(math.inf)], [row(-math.inf)], [row(1e308)], [row(10 ** 1000)]):
            for function in (adapter.normalize_rows, adapter.quantize_document):
                with self.subTest(data=str(data)[:40], function=function.__name__):
                    with self.assertRaises(adapter.AdapterError):
                        function(data)
        with self.assertRaises(adapter.AdapterError):
            adapter.normalize_rows([row(1)], 128)

    def test_document_maxabs_scale_zero_and_determinism(self):
        source = [row(3, 4), row(-1)]
        result = adapter.quantize_document(source)
        self.assertEqual(result.scale, 1.0)  # Whole document, not per row or per column.
        self.assertEqual(result.values[:2], (76, 102))
        self.assertEqual(result.values[48], -127)
        self.assertEqual((result.rows, result.dimensions, len(result.values)), (2, 48, 96))
        self.assertEqual(result, adapter.quantize_document(source))
        zero = adapter.quantize_document([row(0)])
        self.assertEqual(zero.scale, 1.0)
        self.assertEqual(zero.values, (0,) * 48)
        single = adapter.quantize_document([row(3, 4)])
        self.assertEqual(single.scale, 0.8)
        self.assertEqual(single.values[:2], (95, 127))

    def test_js_half_rounding_and_float32_staging(self):
        source = [row(1), row(-1, math.sqrt(3)), row(1, math.sqrt(3))]
        result = adapter.quantize_document(source)
        self.assertEqual(result.values[48], -63)  # Math.round(-63.5), not Python round.
        self.assertEqual(result.values[96], 64)
        single = adapter.quantize_document([row(1, 1)])
        self.assertEqual(single.scale, 1 / math.sqrt(2))  # Before Float32Array rounding.
        self.assertNotEqual(single.scale, adapter._float32(single.scale))
        self.assertTrue(all(-127 <= value <= 127 for value in result.values))

    def test_seeded_finite_math_and_reconstruction_error(self):
        rng = random.Random(17)
        source = [[rng.uniform(-5, 5) for _ in range(48)] for _ in range(12)]
        quantized = adapter.quantize_document(source)
        normalized = adapter.normalize_rows([[adapter._float32(x) for x in values] for values in source])
        for index, value in enumerate(x for values in normalized for x in values):
            reconstructed = quantized.values[index] / 127 * quantized.scale
            self.assertLessEqual(abs(value - reconstructed), quantized.scale / 254 + 1e-7)


class RuntimePreparationTests(unittest.TestCase):
    def test_projection_layout_requires_both_layers_and_exact_config(self):
        self.assertEqual(adapter.check_projection_layout(*metadata()), ((256, 512), (512, 48)))
        for mutation in ("missing", "reverse", "duplicate_path", "wrong_dim", "activation", "bias", "encoder", "bool_idx"):
            config, modules, projections = metadata()
            if mutation == "missing":
                projections.pop()
            elif mutation == "reverse":
                modules.reverse()
            elif mutation == "duplicate_path":
                modules[2]["path"] = "2_Dense/2_Dense"
            elif mutation == "wrong_dim":
                projections[1]["out_features"] = 128
            elif mutation == "activation":
                projections[0]["activation_function"] = "torch.nn.Tanh"
            elif mutation == "bias":
                projections[0]["bias"] = True
            elif mutation == "bool_idx":
                modules[1]["idx"] = True
            else:
                config["hidden_size"] = 768
            with self.subTest(mutation=mutation), self.assertRaises(adapter.AdapterError):
                adapter.check_projection_layout(config, modules, projections)

    def test_parent_projection_recipe_and_missing_or_extra_file_refusal(self):
        hashes = projection_hashes()
        digest = adapter.projection_chain_digest(hashes)
        self.assertEqual(digest, "5e55d448ebdb0dcb824f8e8226e991deb7a072f75433bfa34ad38b6609b67e2b")
        self.assertEqual(digest, adapter.projection_chain_digest(dict(reversed(list(hashes.items())))))
        for path in hashes:
            missing = dict(hashes)
            del missing[path]
            with self.assertRaises(adapter.AdapterError):
                adapter.projection_chain_digest(missing)
        extra = {**hashes, "2_Dense/2_Dense/model.safetensors": "a" * 64}
        with self.assertRaises(adapter.AdapterError):
            adapter.projection_chain_digest(extra)
        changed = {**hashes, "2_Dense/model.safetensors": "a" * 64}
        self.assertNotEqual(digest, adapter.projection_chain_digest(changed))

    def test_artifact_identity_checks_are_declarative_only(self):
        expected = contract()
        fields = ("modelId", "revision", "weightsSha256", "tokenizerSha256", "projectionSha256")
        observed = {field: expected[field] for field in fields}
        self.assertTrue(adapter.check_artifact_identity(expected, observed))
        for field in fields:
            changed = {**observed, field: "wrong"}
            with self.assertRaises(adapter.AdapterError):
                adapter.check_artifact_identity(expected, changed)
        del observed["projectionSha256"]
        with self.assertRaises(adapter.AdapterError):
            adapter.check_artifact_identity(expected, observed)

    def test_device_checks_refuse_fallback_missing_and_precision_mismatch(self):
        expected = contract()
        def check(devices=("cpu",), input_device="cpu", output_device="cpu",
                  dtypes=("float32",), output_dtype="float32", **kwargs):
            return adapter.check_actual_device(expected, devices, input_device, output_device,
                                               dtypes, output_dtype, **kwargs)
        self.assertEqual(check(), "cpu")
        for args in (((),), (("mps",),), (("cpu", "mps"),), (("cpu",), "mps"),
                     (("cpu",), "cpu", "mps"), (("cpu",), "cpu", "cpu", ("float16",))):
            with self.assertRaises(adapter.AdapterError):
                check(*args)
        expected["backend"] = "torch-mps"
        with self.assertRaises(adapter.AdapterError):
            check(("cpu",))
        with self.assertRaises(adapter.AdapterError):
            check(("mps",), "mps", "mps")
        with self.assertRaises(adapter.AdapterError):
            check(("mps",), "mps", "mps", mps_available=True, fallback_disabled=False)
        self.assertEqual(check(("mps",), "mps", "mps", mps_available=True, fallback_disabled=True), "mps")
        # This final assertion tests only supplied labels, never actual MPS execution.

    def test_local_only_plan_is_inert_and_cannot_load_even_when_forged(self):
        with mock.patch.object(builtins, "open", side_effect=AssertionError("filesystem")), \
             mock.patch.object(socket, "socket", side_effect=AssertionError("network")):
            plan = adapter.local_only_runtime_plan(contract(), "/private/synthetic-artifact", *metadata())
        self.assertFalse(plan["runtimeQualified"])
        self.assertFalse(plan["inferenceEnabled"])
        self.assertTrue(plan["kwargs"]["local_files_only"])
        self.assertFalse(plan["kwargs"]["trust_remote_code"])
        self.assertNotIn("embedding_size", plan["kwargs"])
        self.assertEqual(plan["kwargs"]["skiplist_words"], [])
        for field in ("model_kwargs", "tokenizer_kwargs", "config_kwargs"):
            self.assertTrue(plan["kwargs"][field]["local_files_only"])
        plan.update(runtimeQualified=True, inferenceEnabled=True)
        with self.assertRaises(adapter.AdapterError):
            adapter.load_local_runtime(plan)
        for bad in (None, "", "relative/path", "https://huggingface.co/model", "//server/share", "/bad\x00path"):
            with self.assertRaises(adapter.AdapterError):
                adapter.local_only_runtime_plan(contract(), bad, *metadata())


if __name__ == "__main__":
    unittest.main(verbosity=2)
