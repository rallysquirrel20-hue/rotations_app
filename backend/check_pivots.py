import urllib.request, json
r = urllib.request.urlopen('http://localhost:8000/api/baskets/Aerospace_and_Defense')
data = json.load(r)
print(f"{'Date':<12} | {'Close':<8} | {'Res_P':<8} | {'Sup_P':<8} | {'Up_Rot':<6} | {'Dn_Rot':<6}")
print("-" * 60)
for d in data[-20:]:
    print(f"{d['Date']:<12} | {d['Close']:<8.2f} | {str(d['Resistance_Pivot']):<8.4} | {str(d['Support_Pivot']):<8.4} | {str(d['Is_Up_Rotation']):<6} | {str(d['Is_Down_Rotation']):<6}")
