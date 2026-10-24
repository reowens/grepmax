#!/usr/bin/env python3
"""One local original-17M CPU/MPS forward experiment. --ready loads no model."""
import argparse
import contextlib
import gc
import hashlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import sys
import time
import traceback

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from adapter import local_only_runtime_plan, validate_inputs


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(65536), b''):
            h.update(block)
    return h.hexdigest()


def prepare(root):
    require(Path(sys.prefix).resolve() == (root / 'venv').resolve(), 'Use the isolated experiment Python')
    lock = json.loads((HERE / 'runtime-lock.json').read_text())
    versions = {name: importlib.metadata.version(name) for name in lock['mockApiVersions']}
    require(versions == lock['mockApiVersions'], 'Installed direct versions differ from selected pins')
    for name, expected in lock['model']['artifacts'].items():
        p = root / 'model' / name
        require(not p.is_symlink() and p.is_file(), f'Missing/nonregular artifact: {name}')
        require(p.stat().st_size == expected['bytes'] and digest(p) == expected['sha256'], f'Artifact mismatch: {name}')
    payload = json.loads((root / 'inputs.json').read_text())
    contract = dict(modelId=lock['model']['modelId'], revision=lock['model']['revision'],
                    weightsSha256=lock['model']['artifacts']['model.safetensors']['sha256'],
                    tokenizerSha256=lock['model']['artifacts']['tokenizer.json']['sha256'],
                    projectionSha256=lock['model']['projectionSha256'], backend='torch-cpu', precision='float32',
                    dimensions=48, queryMaxTokens=32, documentMaxTokens=512,
                    preparation='gmax-token-ids-v1', normalization='per-token-l2',
                    documentStorage='int8-per-document-maxabs-127')
    validate_inputs([{k: item[k] for k in ('id', 'kind', 'inputIds', 'attentionMask')}
                     for item in payload['inputs']], contract)
    inputs = [{k: item[k] for k in ('id', 'kind', 'inputIds', 'attentionMask')} for item in payload['inputs']]
    require(len(inputs) == 64, 'Exactly 64 frozen inputs required')
    require(payload['tokenizerArtifactSha256'] == contract['tokenizerSha256'], 'Tokenizer input identity mismatch')
    return lock, contract, inputs, versions


def run(root, execute, state):
    lock, contract, inputs, versions = prepare(root)
    import torch
    from pylate import models
    require(torch.backends.mps.is_available(), 'MPS unavailable; no CPU substitution')
    require(os.environ.get('PYTORCH_ENABLE_MPS_FALLBACK') == '0', 'MPS fallback must be disabled before import')
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    config = lambda name: json.loads((root / 'model' / name).read_text())
    plan = local_only_runtime_plan(contract, str(root / 'model'), config('config.json'), config('modules.json'),
                                   [config('1_Dense/config.json'), config('2_Dense/config.json')])
    kwargs = plan['kwargs']
    kwargs.update(truncation=False)
    kwargs['model_kwargs'].update(attn_implementation='eager', torch_dtype=torch.float32)
    kwargs['config_kwargs'].update(reference_compile=False)
    inspect.signature(models.ColBERT).bind_partial(**kwargs)
    ready = dict(ok=True, inferencePerformed=False, modelConstructed=False, inputs=len(inputs),
                 versions=versions, mpsAvailable=True, modelRevision=contract['revision'],
                 inputsSha256=digest(root / 'inputs.json'), dependenciesSha256=digest(root / 'requirements.lock'))
    if not execute:
        return ready

    import numpy as np
    from safetensors.torch import load_file
    load_started = time.perf_counter()
    state['modelConstructionAttempted'] = True
    model = models.ColBERT(**kwargs).to(device='cpu', dtype=torch.float32).eval()
    state['modelConstructed'] = True
    expected = {}
    for name, prefix in [('model.safetensors', '0.auto_model.'), ('1_Dense/model.safetensors', '1.'),
                         ('2_Dense/model.safetensors', '2.')]:
        expected.update({prefix + k: v for k, v in load_file(str(root / 'model' / name), device='cpu').items()})
    params = dict(model.named_parameters())
    require(set(params) == set(expected), 'Actual model parameter names differ from artifact chain')
    require(all(torch.equal(params[k].detach().cpu(), v) for k, v in expected.items()), 'Constructor did not load exact checkpoint values')
    require(tuple(params['1.linear.weight'].shape) == (512, 256) and tuple(params['2.linear.weight'].shape) == (48, 512), 'Projection chain differs')
    del expected, params
    load_seconds = time.perf_counter() - load_started
    references, results, parity = {}, [], []

    def sync(device):
        if device == 'mps':
            torch.mps.synchronize()
            require(torch.mps.current_allocated_memory() <= 6 * 1024 ** 3, 'Metal allocation ceiling exceeded')

    def forward(batch, device):
        width = max(len(item['inputIds']) for item in batch)
        ids = [list(item['inputIds']) + [50283] * (width - len(item['inputIds'])) for item in batch]
        masks = [list(item['attentionMask']) + [0] * (width - len(item['attentionMask'])) for item in batch]
        feed = {'input_ids': torch.tensor(ids, dtype=torch.int64, device=device),
                'attention_mask': torch.tensor(masks, dtype=torch.int64, device=device)}
        state['inferencePerformed'] = True
        with torch.inference_mode():
            output = model.forward(feed)['token_embeddings']
        require(output.device.type == device and output.dtype == torch.float32, 'Actual output device/dtype mismatch')
        require(tuple(output.shape) == (len(batch), width, 48) and bool(torch.isfinite(output).all().item()), 'Malformed/nonfinite token vectors')
        sync(device)
        raw = output.detach().cpu().numpy()
        return [raw[i, :len(item['inputIds'])].copy() for i, item in enumerate(batch)]

    def compare(reference, actual, label):
        require(reference.shape == actual.shape, 'Vector shape mismatch')
        a, b = reference.astype(np.float64), actual.astype(np.float64)
        na, nb = np.linalg.norm(a, axis=1), np.linalg.norm(b, axis=1)
        require(bool(np.all((na == 0) == (nb == 0))), 'Zero-vector disagreement')
        nonzero = (na > 0) & (nb > 0)
        cosine = np.sum(a[nonzero] * b[nonzero], axis=1) / (na[nonzero] * nb[nonzero])
        worst = float(cosine.min()) if cosine.size else 1.0
        parity.append(dict(label=label, minTokenCosine=worst, maxAbsoluteDifference=float(np.max(np.abs(a - b)))))
        require(worst >= 0.999, f'Raw token cosine below 0.999: {label}')

    try:
        for device in ('cpu', 'mps'):
            model.to(device=device, dtype=torch.float32)
            require(all(p.device.type == device and p.dtype == torch.float32 for p in model.parameters()), 'Parameter placement mismatch')
            forward(inputs[:1], device)  # One warm-up, excluded from measured passes.
            for batch_size in (1, 8, 16):
                for repetition in (1, 2):
                    sync(device)
                    started = time.perf_counter()
                    rows = []
                    for start in range(0, len(inputs), batch_size):
                        rows.extend(forward(inputs[start:start + batch_size], device))
                    sync(device)
                    elapsed = time.perf_counter() - started
                    if device == 'cpu' and batch_size == 1 and repetition == 1:
                        references = {item['id']: row for item, row in zip(inputs, rows)}
                        np.savez('cpu-reference.npz', **references)
                    for item, row in zip(inputs, rows):
                        compare(references[item['id']], row, f'{device}/batch{batch_size}/pass{repetition}/{item["id"]}')
                    results.append(dict(device=device, batchSize=batch_size, repetition=repetition, seconds=elapsed,
                                        inputs=len(inputs), effectiveTokens=sum(len(i['inputIds']) for i in inputs)))
                    np.savez(f'{device}-batch{batch_size}-pass{repetition}.npz', **{i['id']: r for i, r in zip(inputs, rows)})
        report = dict(ready, inferencePerformed=True, modelConstructed=True, loadSeconds=load_seconds,
                      measurements=results, parity=parity, minTokenCosine=min(p['minTokenCosine'] for p in parity),
                      scope='Original-weight FP32 raw forward CPU/MPS; not ONNX-int8, ranking, tokenizer cross-runtime or storage compatibility',
                      limits='Parent monitors aggregate process RSS/CPU/disk/swap. Metal allocation shares unified memory; not added twice. Device labels and fallback=0 do not prove operation-level absence of every internal CPU fallback.')
        Path('result.json').write_text(json.dumps(report, indent=2) + '\n')
        return dict(ok=True, inferencePerformed=True, modelConstructed=True, minTokenCosine=report['minTokenCosine'],
                    resultPath=str(Path('result.json').resolve()), measurements=len(results))
    finally:
        del model, references
        gc.collect()
        torch.mps.empty_cache()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', required=True)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--ready', action='store_true')
    mode.add_argument('--execute', action='store_true')
    args = p.parse_args()
    state = dict(inferencePerformed=False, modelConstructed=False, modelConstructionAttempted=False)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = run(Path(args.root).resolve(strict=True), args.execute, state)
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        result = dict(ok=False, **state, error=dict(type=type(error).__name__, message=str(error)[:500]))
    print(json.dumps(result, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()
