import urllib.request, json
r = urllib.request.urlopen('http://localhost:8000/api/baskets/Aerospace_and_Defense')
data = json.load(r)
for d in data[-5:]:
    print(f"Date: {d['Date']} Close: {d['Close']:.2f} Upper: {d['Upper_Target']} Lower: {d['Lower_Target']} B_High: {d['B_Rot_High']} B_Low: {d['B_Rot_Low']} BO_High: {d['BO_B_Rot_High']} BO_Low: {d['BO_B_Rot_Low']}")
