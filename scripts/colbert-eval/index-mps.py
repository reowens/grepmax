#!/usr/bin/env python3
"""Owned stdin/stdout MPS arm for the selected disposable indexing comparison."""
import base64
import contextlib
import gc
import importlib.util
import json
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from adapter import local_only_runtime_plan
spec = importlib.util.spec_from_file_location('mac_smoke', HERE / 'mac-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def main(root):
    lock, contract, _, _ = smoke.prepare(root)
    import torch
    from pylate import models
    from safetensors.torch import load_file
    smoke.require(torch.backends.mps.is_available() and os.environ.get('PYTORCH_ENABLE_MPS_FALLBACK') == '0', 'MPS/fallback requirement failed')
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    config = lambda name: json.loads((root / 'model' / name).read_text())
    plan = local_only_runtime_plan(contract, str(root / 'model'), config('config.json'), config('modules.json'), [config('1_Dense/config.json'), config('2_Dense/config.json')])
    kwargs = plan['kwargs']
    kwargs.update(truncation=False)
    kwargs['model_kwargs'].update(attn_implementation='eager', torch_dtype=torch.float32)
    kwargs['config_kwargs'].update(reference_compile=False)
    with contextlib.redirect_stdout(sys.stderr):
        model = models.ColBERT(**kwargs).to(device='cpu', dtype=torch.float32).eval()
    try:
        expected = {}
        for name, prefix in [('model.safetensors', '0.auto_model.'), ('1_Dense/model.safetensors', '1.'), ('2_Dense/model.safetensors', '2.')]:
            expected.update({prefix+k: v for k, v in load_file(str(root/'model'/name)).items()})
        params = dict(model.named_parameters())
        smoke.require(set(params) == set(expected) and all(torch.equal(params[k].detach(), v) for k, v in expected.items()), 'Loaded parameter values differ')
        del params, expected
        model.to('mps')
        smoke.require(all(p.device.type == 'mps' and p.dtype == torch.float32 for p in model.parameters()), 'Parameter placement differs')
        print(json.dumps(dict(ok=True, ready=True)), file=sys.__stdout__, flush=True)
        for line in sys.stdin.buffer:
            smoke.require(len(line) <= 1024*1024, 'Oversized input frame')
            job = json.loads(line)
            if job.get('command') == 'close':
                break
            b, width = job['shape']
            smoke.require(1 <= b <= 16 and 3 <= width <= 512 and len(job['ids']) == b*width and len(job['mask']) == b*width, 'Input shape differs')
            feed = {'input_ids': torch.tensor(job['ids'], device='mps', dtype=torch.int64).reshape(b, width),
                    'attention_mask': torch.tensor(job['mask'], device='mps', dtype=torch.int64).reshape(b, width)}
            with torch.inference_mode():
                output = model.forward(feed)['token_embeddings']
            torch.mps.synchronize()
            smoke.require(output.device.type == 'mps' and output.dtype == torch.float32 and tuple(output.shape) == (b,width,48), 'Output shape/device differs')
            smoke.require(torch.mps.current_allocated_memory() <= 6*1024**3, 'Metal allocation ceiling exceeded')
            data = output.detach().cpu().numpy()
            smoke.require(bool(__import__('numpy').isfinite(data).all()), 'Nonfinite output')
            print(json.dumps(dict(ok=True, shape=[b,width,48], data=base64.b64encode(data.astype('<f4').tobytes()).decode())), file=sys.__stdout__, flush=True)
    finally:
        del model
        gc.collect()
        torch.mps.empty_cache()


if __name__ == '__main__':
    with contextlib.redirect_stdout(sys.stderr):
        main(Path(sys.argv[1]).resolve(strict=True))
