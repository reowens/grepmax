#!/usr/bin/env python3
"""Fixed MPS document arm for the explicitly selected frozen 30-question screen."""
import contextlib
import gc
import json
import os
from pathlib import Path
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from adapter import local_only_runtime_plan
import importlib.util
spec = importlib.util.spec_from_file_location('mac_smoke', HERE / 'mac-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
prepare, require, digest = smoke.prepare, smoke.require, smoke.digest


def main(root):
    lock, contract, _, versions = prepare(root)
    import torch
    import numpy as np
    from pylate import models
    from safetensors.torch import load_file
    require(torch.backends.mps.is_available(), 'MPS unavailable')
    require(os.environ.get('PYTORCH_ENABLE_MPS_FALLBACK') == '0', 'Fallback must remain disabled')
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    config = lambda name: json.loads((root / 'model' / name).read_text())
    plan = local_only_runtime_plan(contract, str(root / 'model'), config('config.json'), config('modules.json'),
                                   [config('1_Dense/config.json'), config('2_Dense/config.json')])
    kwargs = plan['kwargs']
    kwargs.update(truncation=False)
    kwargs['model_kwargs'].update(attn_implementation='eager', torch_dtype=torch.float32)
    kwargs['config_kwargs'].update(reference_compile=False)
    model = models.ColBERT(**kwargs).to(device='cpu', dtype=torch.float32).eval()
    try:
        expected = {}
        for name, prefix in [('model.safetensors', '0.auto_model.'), ('1_Dense/model.safetensors', '1.'), ('2_Dense/model.safetensors', '2.')]:
            expected.update({prefix + k: v for k, v in load_file(str(root / 'model' / name)).items()})
        params = dict(model.named_parameters())
        require(set(params) == set(expected) and all(torch.equal(params[k].detach(), v) for k, v in expected.items()), 'Loaded checkpoint differs')
        del params, expected
        model.to(device='mps')
        require(all(p.device.type == 'mps' and p.dtype == torch.float32 for p in model.parameters()), 'Placement/dtype mismatch')
        count, token_rows = 0, 0
        started = time.perf_counter()
        with Path('document-inputs.jsonl').open() as source, Path('mps-documents.f32').open('xb') as output:
            batch = []
            def flush():
                nonlocal count, token_rows
                width = max(len(i['inputIds']) for i in batch)
                feed = {'input_ids': torch.tensor([i['inputIds'] + [50283] * (width - len(i['inputIds'])) for i in batch], dtype=torch.int64, device='mps'),
                        'attention_mask': torch.tensor([i['attentionMask'] + [0] * (width - len(i['inputIds'])) for i in batch], dtype=torch.int64, device='mps')}
                with torch.inference_mode():
                    vectors = model.forward(feed)['token_embeddings']
                require(vectors.device.type == 'mps' and vectors.dtype == torch.float32 and tuple(vectors.shape) == (len(batch), width, 48), 'Invalid output')
                torch.mps.synchronize()
                require(torch.mps.current_allocated_memory() <= 6 * 1024 ** 3, 'Metal allocation ceiling exceeded')
                raw = vectors.detach().cpu().numpy()
                require(bool(np.isfinite(raw).all()), 'Nonfinite output')
                for i, item in enumerate(batch):
                    rows = len(item['inputIds'])
                    output.write(raw[i, :rows].astype('<f4').tobytes())
                    token_rows += rows
                count += len(batch)
                if count % 512 == 0:
                    print(f'MPS documents {count}/12717', file=sys.stderr, flush=True)
                batch.clear()
            for line in source:
                item = json.loads(line)
                require(3 <= len(item['inputIds']) <= 512 and len(item['inputIds']) == len(item['attentionMask']), 'Input bounds mismatch')
                batch.append(item)
                if len(batch) == 16:
                    flush()
            if batch:
                flush()
        require(count == 12717, 'Incomplete document corpus')
        report = dict(ok=True, inferencePerformed=True, documents=count, tokenRows=token_rows, versions=versions,
                      inputsSha256=digest(Path('document-inputs.jsonl')), outputSha256=digest(Path('mps-documents.f32')),
                      seconds=time.perf_counter() - started, backend='MPS', precision='float32', batchSize=16,
                      modelRevision=contract['revision'], weightsSha256=contract['weightsSha256'])
        Path('mps-result.json').write_text(json.dumps(report, indent=2) + '\n')
    finally:
        del model
        gc.collect()
        torch.mps.empty_cache()


if __name__ == '__main__':
    with contextlib.redirect_stdout(sys.stderr):
        main(Path(sys.argv[1]).resolve(strict=True))
