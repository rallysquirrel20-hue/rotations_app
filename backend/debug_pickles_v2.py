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
            print(f"File: {fn}, Type: {type(data)}")
            if isinstance(data, dict):
                print(f"  Len: {len(data)}, Keys: {list(data.keys())[:3]}")
            else:
                try:
                    print(f"  Content snippet: {str(data)[:100]}")
                except:
                    pass
            print("-" * 20)
