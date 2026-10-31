import csv, sys, numpy as np
from scipy.signal import butter, filtfilt
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
d = sys.argv[1]
rows = list(csv.DictReader(open(f'{d}/Headphone.csv')))
t = np.array([float(r['seconds_elapsed']) for r in rows])
g = lambda cs: np.array([[float(r[c]) for c in cs] for r in rows])
rr = g(['rotationRateX','rotationRateY','rotationRateZ']); acc = g(['accelerationX','accelerationY','accelerationZ']); att = g(['pitch','roll','yaw'])
fs = 1/np.median(np.diff(t)); print("fs", round(fs,1), "dur", round(t[-1]-t[0],1), "gaps>60ms", int((np.diff(t)>0.06).sum()))
ann = np.array([float(r['seconds_elapsed']) for r in csv.DictReader(open(f'{d}/Annotation.csv'))])
rel = ann - ann[0]
print("marker gaps:", np.round(np.diff(rel),2))
b,a = butter(2,[2,8],'bandpass',fs=fs); x = filtfilt(b,a,rr,axis=0)
w=int(0.25*fs); e = np.sqrt(np.convolve((x**2).sum(1), np.ones(w)/w, 'same'))
# candidate offsets: first marker happens at t0 in [t[0], t[-1]-rel[-1]]
cands = np.arange(t[0], t[-1]-rel[-1], 0.02)
def win_energy(off, lo=0.3, hi=2.8):
    return np.array([e[(t>=off+m+lo)&(t<off+m+hi)].mean() for m in rel])
# score: activity right after markers should be bursty -> maximize contrast between post-marker window and pre-marker window
scores=[]
for off in cands:
    post = win_energy(off, 0.2, 2.5); pre = np.array([e[(t>=off+m-0.8)&(t<off+m-0.05)].mean() if (t<off+m-0.05).any() else np.nan for m in rel])
    scores.append(np.nanmean(post - pre))
scores=np.array(scores); best = cands[np.nanargmax(scores)]
print("best offset (first marker at t=%.2fs), score %.4f; score range %.4f..%.4f" % (best, np.nanmax(scores), np.nanmin(scores), np.nanmax(scores)))
np.save(f'{d}/align.npy', np.array([best]))
E = win_energy(best); base = np.percentile(e, 20)
print("per-marker energy after marker (x quiet baseline):"); print(np.round(E/base,1))
fig, ax = plt.subplots(2,1, figsize=(15,6), sharex=True)
ax[0].plot(t, e/base); ax[0].set_ylabel('jaw band energy (x quiet)')
for i,m in enumerate(rel): 
    for A in ax: A.axvline(best+m, color='r', lw=0.8)
    ax[0].text(best+m, ax[0].get_ylim()[1]*0.9, str(i+1), fontsize=8, color='r')
ax[1].plot(t, np.degrees(att[:,:2]-np.median(att[:,:2],0))); ax[1].set_ylabel('head pitch/roll (deg)'); ax[1].set_xlabel('s')
fig.tight_layout(); fig.savefig(sys.argv[2], dpi=100)
