"""Explicit hybrid acceleration; audio DSP and BigVGAN retain their CPU path."""
from dataclasses import fields, is_dataclass
import json


def _map_tensors(value, device):
    import torch
    if isinstance(value, torch.Tensor):
        # DirectML rejects inference tensors. The clone is deliberately made
        # inside inference_mode(False), including upstream CFM-decorated inputs.
        return value.detach().clone().to(device)
    if is_dataclass(value) and not isinstance(value, type):
        return type(value)(**{f.name: _map_tensors(getattr(value, f.name), device) for f in fields(value)})
    if isinstance(value, tuple):
        return tuple(_map_tensors(v, device) for v in value)
    if isinstance(value, list):
        return [_map_tensors(v, device) for v in value]
    if isinstance(value, dict):
        return {k: _map_tensors(v, device) for k, v in value.items()}
    return value


def offload_module(module, device):
    """Keep the upstream caller's CPU contract; synchronize real GPU outputs."""
    import torch
    with torch.inference_mode(False), torch.no_grad():
        module.to(device)
        for child in module.modules():
            # Seed-VC Transformer caches are not registered buffers.
            for name in ('freqs_cis', 'causal_mask'):
                value = getattr(child, name, None)
                if isinstance(value, torch.Tensor):
                    setattr(child, name, value.to(device))
    original = module.forward

    def forward(*args, **kwargs):
        with torch.inference_mode(False), torch.no_grad():
            result = original(*_map_tensors(args, device), **_map_tensors(kwargs, device))
            return _map_tensors(result, 'cpu')

    module.forward = forward



def chunked_attention(query, key, value, mask, *, chunk_size=128, **kwargs):
    """Exact attention via bounded matmul/softmax, avoiding native DML SDPA."""
    import math
    import torch
    if kwargs.get('is_causal') or kwargs.get('dropout_p', 0) != 0:
        raise ValueError('Bounded Seed-VC attention requires noncausal inference without dropout')
    scale = kwargs.get('scale')
    if scale is None:
        scale = 1.0 / math.sqrt(query.size(-1))
    chunks = []
    for start in range(0, query.size(-2), chunk_size):
        stop = start + chunk_size
        part_mask = mask
        if mask is not None and mask.size(-2) != 1:
            part_mask = mask[..., start:stop, :]
        scores = (query[..., start:stop, :] * scale) @ key.transpose(-2, -1)
        if part_mask is not None:
            scores = scores.masked_fill(~part_mask, float('-inf')) if part_mask.dtype == torch.bool else scores + part_mask
        weights = torch.nan_to_num(torch.softmax(scores, dim=-1), nan=0.0)
        chunks.append(weights @ value)
    return torch.cat(chunks, dim=-2)


def install_bounded_attention():
    from torch.nn import functional as F
    original = F.scaled_dot_product_attention
    if getattr(original, '_seed_vc_bounded', False):
        return
    def attention(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, **kwargs):
        options = dict(dropout_p=dropout_p, is_causal=is_causal, **kwargs)
        if query.device.type == 'privateuseone' and not is_causal and dropout_p == 0:
            return chunked_attention(query, key, value, attn_mask, **options)
        return original(query, key, value, attn_mask=attn_mask, **options)
    attention._seed_vc_bounded = True
    F.scaled_dot_product_attention = attention

def enable_directml(models, *, device_index=0, expected_name=None):
    import torch_directml
    from transformers import WhisperModel
    if not 0 <= device_index < torch_directml.device_count():
        raise RuntimeError('Configured DirectML GPU is not available')
    name = torch_directml.device_name(device_index).rstrip('\x00').strip()
    if expected_name and name != expected_name:
        raise RuntimeError(f'DirectML GPU changed: expected {expected_name}, found {name}')
    torch_directml.disable_tiled_resources(True)
    device = torch_directml.device(device_index)
    install_bounded_attention()
    encoders = [cell.cell_contents.encoder for cell in models[1].__closure__ or ()
                if isinstance(cell.cell_contents, WhisperModel)]
    if len(encoders) != 1:
        raise RuntimeError('Seed-VC Whisper encoder could not be identified for DirectML')
    offload_module(encoders[0], device)
    offload_module(models[0].cfm.estimator, device)
    print('SEED_VC_EXECUTION ' + json.dumps({
        'provider': 'DirectML', 'gpu_index': device_index, 'gpu_name': name,
        'gpu_components': ['whisper', 'diffusion'],
        'cpu_components': ['audio_dsp', 'rmvpe', 'campplus', 'length_regulator', 'bigvgan', 'attention_nonfinite_cleanup'],
    }), flush=True)
    # No automatic retry on CPU: a GPU failure remains visible and cancellable.
