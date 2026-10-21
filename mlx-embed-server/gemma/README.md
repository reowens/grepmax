# Optional EmbeddingGemma 2 on Apple Silicon

The `gemma2` tier is an experimental text-only BF16 backend with 768-dimensional
vectors and a 256-token total limit. Granite Small remains the default. Gemma
requires a separate local index, HTTP port and Python environment; it never falls
back to Granite or ONNX and does not run a gmax daemon or watcher.

The measured Mac evaluation used about 1.1 GiB after loading and peaked at about
2.3 GiB while building its frozen index. Actual use depends on text and batch size;
requests are capped at 16 texts. The qualified checkpoint contains 271,002,648
persisted text values. No audio, vision or generative model is loaded.

## Prepare a local artifact

Use Apple Silicon, Node 22.12 or newer, Python 3.13 and `uv`. Obtain revision
`1a4ffddb7905d3f63486748deabe091a01fb6201` of
[`mlx-community/embeddinggemma-2-bf16`](https://huggingface.co/mlx-community/embeddinggemma-2-bf16/tree/1a4ffddb7905d3f63486748deabe091a01fb6201)
in a local directory, including its tokenizer metadata. The source checkpoint's
SHA256 must be `ffaf2604b011ad0634022529bac930a4f6a2feba22687d8d5890434d186b459c`.
The preparer streams only text tensors without importing a model. Source and output
must be separate directories under the same explicit root, without symlinks.

```sh
GMAX_PACKAGE="$(npm root -g)/grepmax"
python3 "$GMAX_PACKAGE/mlx-embed-server/prepare_gemma.py" \
  --root /absolute/model-workspace \
  --source /absolute/model-workspace/original \
  --output /absolute/model-workspace/text-bf16
```

An already prepared artifact can be reused if it matches every digest in
`mlx-embed-server/gemma-contract.json` and contains exactly those files and their parent directories. Extra weights, dense-head files and tokenizer overrides are rejected. Startup verifies the weights, configuration,
tokenizer and tensor inventory before constructing the text model. It refuses an
unverified artifact and never downloads a substitute.

## Start the embedding service

Starting this command loads the text model. In an agent session, obtain any
repository-required model-load approval first. Choose a free loopback port other
than 8100, 8101 or 8079. Keep the command in its own terminal; Ctrl-C stops it.

```sh
export MLX_EMBED_MODEL=mlx-community/embeddinggemma-2-bf16
export GMAX_GEMMA_MODEL_PATH=/absolute/model-workspace/text-bf16
export MLX_EMBED_PORT=18100
GMAX_PACKAGE="$(npm root -g)/grepmax"
uv run --locked --project "$GMAX_PACKAGE/mlx-embed-server/gemma" \
  python "$GMAX_PACKAGE/mlx-embed-server/server.py"
```

The separate lock pins MLX 0.32.3, Transformers 5.20.2 and the qualified MLX-VLM
revision. The ordinary Granite environment is unchanged. The service binds only
127.0.0.1 and exits after 30 idle minutes.

## Build and query the separate index

In another terminal, inside the repository to index:

```sh
export GMAX_GEMMA_PROFILE=1
export GMAX_HOME="$HOME/.gmax-gemma2"
export MLX_EMBED_PORT=18100
gmax config --model-tier gemma2 --embed-mode gpu
gmax add .
gmax "where is the request handler?" --agent
```

`GMAX_HOME` must differ from the normal `~/.gmax` home. Keep these three variables
set for each Gemma command. The explicit profile flag prevents daemon startup even before configuration is complete. Explicit `GMAX_NO_AUTOSTART=1`, marker files and machine safety stops still block heavy work; this profile does not override them. Run `gmax index` after changing source files; watchers,
HTTP serve and daemon restart are unavailable in this profile. Do not change an
existing Granite profile into a Gemma profile. Model changes preserve old indexes
and block incompatible searches until a separate rebuild is explicitly requested.

Gemma dense documents use `title: project/file | text: content`. Code queries use
`task: code retrieval | query: ...`; explicit documentation requests use
`task: question answering | query: ...`. The shipped contract freezes this routing,
normalization and tokenizer identity. ColBERT receives the original text. File-title
inputs disable content-only embedding reuse. Contract or dimension mismatches fail
closed rather than returning vectors from another model.

## Return to Small

Stop the separate embedding service with Ctrl-C, then leave the Gemma shell or run:

```sh
unset GMAX_GEMMA_PROFILE GMAX_HOME MLX_EMBED_PORT GMAX_GEMMA_MODEL_PATH MLX_EMBED_MODEL
gmax config
gmax "where is the request handler?" --agent
```

This returns to the original home, model and existing index. No copy or conversion
of the Small index is needed. Keep the Gemma home for later comparison, or remove
that explicitly chosen directory after its commands and embedding service stop.
