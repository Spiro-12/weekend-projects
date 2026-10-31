import csv, sys, numpy as np
from scipy.signal import butter, filtfilt
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import squareform
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
d = sys.argv[1]
rows = list(csv.DictReader(open(f'{d}/Headphone.csv')))
t = np.array([float(r['seconds_elapsed']) for r in rows])
X = np.array([[float(r[c]) for c in ['rotationRateX','rotationRateY','rotationRateZ','accelerationX','accelerationY','accelerationZ']] for r in rows])
ann = np.array([float(r['seconds_elapsed']) for r in csv.DictReader(open(f'{d}/Annotation.csv'))]); rel = ann-ann[0]
off = float(np.load(f'{d}/align.npy')[0]); M = off + rel
fs=50; b,a = butter(2,1.0,'highpass',fs=fs); Xh = filtfilt(b,a,X,axis=0)
L=64
def seg(m, lo=0.1, hi=3.0):
    s = Xh[(t>=m+lo)&(t<m+hi)]
    idx = np.linspace(0, len(s)-1, L)
    return np.stack([np.interp(idx, np.arange(len(s)), s[:,c]) for c in range(6)])
S = np.array([seg(m) for m in M])
mu = S.transpose(1,0,2).reshape(6,-1).mean(1)[:,None]; sd = S.transpose(1,0,2).reshape(6,-1).std(1)[:,None]
Z = (S-mu)/sd
def dtw(A,B,r=6):
    n=A.shape[1]; D=np.full((n+1,n+1),np.inf); D[0,0]=0
    for i in range(1,n+1):
        for j in range(max(1,i-r),min(n,i+r)+1):
            c=((A[:,i-1]-B[:,j-1])**2).sum(); D[i,j]=c+min(D[i-1,j],D[i,j-1],D[i-1,j-1])
    return D[n,n]
N=len(Z); Dm=np.zeros((N,N))
for i in range(N):
    for j in range(i+1,N): Dm[i,j]=Dm[j,i]=dtw(Z[i],Z[j])
talk = list(range(6,18))  # markers 7..18
# label free: split the 12 talking clips into 2 clusters
cl = fcluster(linkage(squareform(Dm[np.ix_(talk,talk)]),'average'), 2, 'maxclust')
print("label free 2-way split of markers 7..18:", dict(zip([i+1 for i in talk], cl.tolist())))
def loo(labels, idx):
    ok=0
    for i in idx:
        others=[j for j in idx if j!=i]; nn=min(others, key=lambda j: Dm[i,j]); ok += labels[nn]==labels[i]
    return ok/len(idx)
for name, lab in {
  'H1 still=2-6, text=7-12, volume=13-18': {**{i:'still' for i in range(1,6)}, **{i:'text' for i in range(6,12)}, **{i:'vol' for i in range(12,18)}},
  'H2 still=2-6, text=7-11, volume=12-16': {**{i:'still' for i in range(1,6)}, **{i:'text' for i in range(6,11)}, **{i:'vol' for i in range(11,16)}},
}.items():
    idx=sorted(lab); print(f"{name}: 1-NN leave one out accuracy {loo(lab, idx):.2f} on {len(idx)} clips (chance {1/3:.2f})")
    two=[i for i in idx if lab[i]!='still']; print(f"   text vs volume only: {loo(lab, two):.2f} on {len(two)} clips (chance 0.50)")
plt.figure(figsize=(6,5)); plt.imshow(Dm, cmap='viridis'); plt.colorbar(label='DTW distance'); plt.xticks(range(N), range(1,N+1), fontsize=7); plt.yticks(range(N), range(1,N+1), fontsize=7)
plt.title('How different each clip is (dark = similar)'); plt.tight_layout(); plt.savefig(sys.argv[2], dpi=110)
print("nearest neighbor of each talking clip:", {i+1: int(min([j for j in talk if j!=i], key=lambda j: Dm[i,j]))+1 for i in talk})
for name, lab in {
  'CONTROL wrong labels, time-contiguous: A=7-9,13-15 B=10-12,16-18': {**{i:'A' for i in [6,7,8,12,13,14]}, **{i:'B' for i in [9,10,11,15,16,17]}},
  'CONTROL wrong labels, alternating: A=odd B=even': {i:('A' if i%2 else 'B') for i in range(6,18)},
}.items():
    idx=sorted(lab); print(f"{name}: {loo(lab, idx):.2f} (chance 0.50)")
print("mean DTW dist within text %.0f, within volume %.0f, text-vs-volume %.0f" % (
  Dm[np.ix_(range(6,12),range(6,12))][np.triu_indices(6,1)].mean(), Dm[np.ix_(range(12,18),range(12,18))][np.triu_indices(6,1)].mean(), Dm[np.ix_(range(6,12),range(12,18))].mean()))
