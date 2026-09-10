"""Worker de génération Stable Audio 3 pour l'arc musical (issue #122).

Piloté par tools/music-gen.mjs, jamais lancé à la main. Reçoit un plan JSON sur
stdin, rend une ligne JSON par morceau sur stdout.

Deux raisons de ne pas utiliser la CLI `stable-audio` fournie en amont :

1. Le modèle `medium` pèse 1.4B et met plus longtemps à charger qu'à générer.
   La CLI recharge à chaque appel ; ici on charge UNE fois pour N morceaux.
2. Sa sauvegarde passe par torchaudio.save() → torchcodec, qui n'est pas
   installé dans cet environnement. On écrit le WAV avec soundfile.

Entrée (stdin) :
  {"model": "medium", "duration": 90, "steps": 8, "cfg_scale": 1.0,
   "jobs": [{"id": "race5-0a3f", "prompt": "...", "seed": 41221, "out": "/abs/path.wav"}]}

Sortie (stdout, une ligne JSON par morceau) :
  {"id": ..., "ok": true, "out": ..., "sampleRate": 44100, "genS": 12.3}
  {"id": ..., "ok": false, "error": "..."}
"""

import json
import os
import sys
import time


def log(msg):
    # Les traces vont sur stderr : stdout est réservé au protocole JSON.
    print(f"[music-gen.py] {msg}", file=sys.stderr, flush=True)


def main():
    plan = json.load(sys.stdin)
    jobs = plan.get("jobs", [])
    if not jobs:
        log("aucun morceau à générer")
        return 0

    import torch
    import soundfile as sf
    from stable_audio_3 import StableAudioModel

    model_id = plan.get("model", "medium")
    duration = float(plan.get("duration", 90))
    steps = int(plan.get("steps", 8))
    cfg_scale = float(plan.get("cfg_scale", 1.0))

    log(f"cuda/hip disponible : {torch.cuda.is_available()}")
    t0 = time.time()
    model = StableAudioModel.from_pretrained(model_id)
    sample_rate = model.model.sample_rate
    log(f"modèle « {model_id} » chargé en {time.time() - t0:.1f} s, {sample_rate} Hz")

    for job in jobs:
        out = job["out"]
        # Reprise : un morceau déjà produit n'est jamais regénéré. La règle
        # write-once du dépôt commence ici.
        if os.path.exists(out) and os.path.getsize(out) > 0:
            print(json.dumps({"id": job["id"], "ok": True, "out": out,
                              "sampleRate": sample_rate, "skipped": True}), flush=True)
            continue
        try:
            t = time.time()
            audio = model.generate(
                prompt=job["prompt"],
                duration=duration,
                steps=steps,
                cfg_scale=cfg_scale,
                seed=int(job["seed"]),
            )
            # [batch, channels, samples] → [samples, channels] pour soundfile.
            wav = audio[0].detach().to(torch.float32).cpu().numpy().T
            os.makedirs(os.path.dirname(out), exist_ok=True)
            tmp = out + ".part"
            # format explicite : le suffixe .part empêche soundfile de le deviner
            sf.write(tmp, wav, sample_rate, subtype="PCM_16", format="WAV")
            os.replace(tmp, out)
            print(json.dumps({"id": job["id"], "ok": True, "out": out,
                              "sampleRate": sample_rate,
                              "genS": round(time.time() - t, 2)}), flush=True)
        except Exception as exc:  # un morceau raté ne doit pas tuer le lot
            log(f"{job['id']} : {exc}")
            print(json.dumps({"id": job["id"], "ok": False, "error": str(exc)}), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
