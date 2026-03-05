import pickle
from pathlib import Path

BASE_DIR = Path.home() / "Documents" / "Python_Outputs" / "Data_Storage"
files = [
    "beta_universes_500.pkl",
    "dividend_universes_500.pkl",
    "momentum_universes_500.pkl",
    "risk_adj_momentum_500.pkl"
]

for fn in files:
    p = BASE_DIR / fn
    if p.exists():
        with open(p, 'rb') as f:
            data = pickle.load(f)
            print(f"File: {fn}")
            if isinstance(data, dict):
                keys = list(data.keys())
                print(f"  Keys (first 2): {keys[:2]}")
                first_val = data[keys[0]]
                if isinstance(first_val, dict):
                    print(f"  Inner Keys: {list(first_val.keys())}")
            print("-" * 20)
