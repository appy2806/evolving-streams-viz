import json
from pathlib import Path
import numpy as np
import zarr
import h5py

# --- config ---
N_STREAMS   = 200
N_PARTICLES = 1000
SEED        = 42069

EVOLV_ZARR = "/mnt/d/Research/firesims_metaldiff/m12i_res7100/GC_streams/streams_posvel_integ5Gyr_to_nsnap600.zarr"
EVOLV_KEY  = "unperturb"
STATIC_H5  = "/mnt/d/Research/others/ella/MWPotential22_streams.h5"
STATIC_KEY = "part_xv"

OUT_DIR = Path("/home/aarora/vizs/evolving-streams-viz/data")
OUT_DIR.mkdir(parents=True, exist_ok=True)

rng = np.random.default_rng(SEED)

def pick(n_streams_avail, n_particles_avail):
    s_idx = np.sort(rng.choice(n_streams_avail, N_STREAMS, replace=False))
    p_idx = np.sort(rng.choice(n_particles_avail, N_PARTICLES, replace=False))
    return s_idx, p_idx

def to_bin(pos_xyz, out_path):
    # pos_xyz: (N, M, 3) -> flat (N*M, 3) float32, C-order
    flat = np.ascontiguousarray(pos_xyz.reshape(-1, 3), dtype=np.float32)
    flat.tofile(out_path)
    return flat

manifest = {"seed": SEED, "units": "kpc", "models": {}}
bounds_all = []

# --- evolving (zarr) ---
zg = zarr.open_group(EVOLV_ZARR, mode="r")
z = zg[EVOLV_KEY]
assert z.shape[2] == 6, f"unexpected coords: {z.shape}"
s_idx, p_idx = pick(z.shape[0], z.shape[1])
sub = z.oindex[s_idx]                 # (N, 10000, 6), reads only selected streams
pos = sub[:, p_idx, :3]               # (N, M, 3)
flat = to_bin(pos, OUT_DIR / "evolving.bin")
manifest["models"]["evolving"] = {
    "file": "evolving.bin", "n_streams": N_STREAMS,
    "n_particles": N_PARTICLES, "n_points": int(flat.shape[0]),
    "label": "Evolving asymmetric host (m12i)",
}
bounds_all.append(flat)

# --- static (hdf5) ---
with h5py.File(STATIC_H5, "r") as f:
    d = f[STATIC_KEY]
    assert d.shape[2] == 6, f"unexpected coords: {d.shape}"
    s_idx, p_idx = pick(d.shape[0], d.shape[1])
    sub = d[np.sort(s_idx)]            # (N, 10000, 6)
    pos = sub[:, np.sort(p_idx), :3]   # (N, M, 3)
flat = to_bin(pos, OUT_DIR / "static.bin")
manifest["models"]["static"] = {
    "file": "static.bin", "n_streams": N_STREAMS,
    "n_particles": N_PARTICLES, "n_points": int(flat.shape[0]),
    "label": "Static symmetric host (MWPotential2022)",
}
bounds_all.append(flat)

# --- shared bounds for camera framing ---
allpts = np.concatenate(bounds_all, axis=0)
manifest["bounds"] = {
    "min": allpts.min(axis=0).tolist(),
    "max": allpts.max(axis=0).tolist(),
    "radius_kpc": float(np.percentile(np.linalg.norm(allpts, axis=1), 99)),
}
(OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
print("wrote:", sorted(p.name for p in OUT_DIR.glob("*")))
for m in manifest["models"].values():
    nbytes = m["n_points"] * 3 * 4
    print(f'{m["file"]}: {m["n_points"]} pts, {nbytes/1e6:.2f} MB')
print("bounds:", manifest["bounds"])
