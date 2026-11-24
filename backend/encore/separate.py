"""Run the Demucs CLI with a WAV writer that does not depend on torchaudio's I/O backend.

Demucs 4.0.1 writes its stems with ``torchaudio.save``. Since torchaudio 2.9 that call needs the
separate ``torchcodec`` package (and matching FFmpeg libraries), so a fresh torch install breaks
separation with "TorchCodec is required for save_with_torchcodec". Encore only needs 16-bit PCM
WAV stems (ffmpeg re-encodes them afterwards), which the standard library writes just fine.

Usage: ``python -m encore.separate <demucs args>``, same arguments as ``python -m demucs``.
"""
from __future__ import annotations

import wave
from pathlib import Path
from typing import Any


def save_wav(path: Any, wav: Any, sample_rate: int, encoding: str = "PCM_S",
             bits_per_sample: int = 16, **_: Any) -> None:
    """Drop-in for ``torchaudio.save`` as Demucs calls it: tensor (channels, samples), floats in [-1, 1]."""
    if Path(str(path)).suffix.lower() != ".wav" or encoding != "PCM_S" or bits_per_sample != 16:
        raise ValueError(f"encore.separate only writes 16-bit PCM WAV, got {path} {encoding}/{bits_per_sample}")
    import torch

    pcm = (wav.detach().cpu().float().clamp(-1, 1) * 32767).round().to(torch.int16)
    if pcm.dim() == 1:
        pcm = pcm.unsqueeze(0)
    with wave.open(str(path), "wb") as f:
        f.setnchannels(pcm.shape[0])
        f.setsampwidth(2)
        f.setframerate(int(sample_rate))
        f.writeframes(pcm.t().contiguous().numpy().astype("<i2").tobytes())  # interleaved, little endian


def main() -> None:
    import torchaudio

    torchaudio.save = save_wav  # demucs.audio calls ta.save, i.e. this module attribute
    from demucs.separate import main as demucs_main

    demucs_main()


if __name__ == "__main__":
    main()
