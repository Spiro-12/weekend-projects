import csv, sys, numpy as np
from scipy.signal import butter, filtfilt, welch, find_peaks
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
rows = list(csv.DictReader(open(sys.argv[1])))
t = np.array([float(r['seconds_elapsed']) for r in rows]); t -= t[0]
rr = np.array([[float(r[c]) for c in ['rotationRateX','rotationRateY','rotationRateZ']] for r in rows])
acc = np.array([[float(r[c]) for c in ['accelerationX','accelerationY','accelerationZ']] for r in rows])
fs = 1/np.median(np.diff(t))
# Is the 50 Hz real? Compare power above vs below 12.5 Hz (interpolated 25 Hz data has almost nothing above 12.5)
f, P = welch(rr[:,0], fs=fs, nperseg=256)
hi = P[(f>13)&(f<24)].sum(); lo = P[(f>1)&(f<12)].sum()
print("fs %.1f Hz  | power 13-24 Hz / 1-12 Hz = %.3f" % (fs, hi/lo))
for name, x in [('rr', rr), ('acc', acc)]:
    for i in range(3):
        f, P = welch(x[:,i], fs=fs, nperseg=256)
        print(f"  {name}[{i}] hi/lo power {P[(f>13)&(f<24)].sum()/P[(f>1)&(f<12)].sum():.3f}")
b, a = butter(2, 1.0, 'highpass', fs=fs)
rrh = filtfilt(b, a, rr, axis=0); acch = filtfilt(b, a, acc, axis=0)
w = int(0.3*fs)
def rms(x): 
    e = (x**2).sum(1); return np.sqrt(np.convolve(e, np.ones(w)/w, mode='same'))
er, ea = rms(rrh), rms(acch)
base_r, base_a = np.median(er), np.median(ea)
print("baseline rr %.4f acc %.4f" % (base_r, base_a))
# segment: energy above 3x baseline, merge gaps < 0.6 s, keep > 0.5 s
act = er > 3*base_r
segs=[]; i=0; n=len(t)
while i<n:
    if act[i]:
        j=i
        while j<n and act[j]: j+=1
        segs.append([t[i], t[j-1]]); i=j
    else: i+=1
merged=[]
for s in segs:
    if merged and s[0]-merged[-1][1] < 0.6: merged[-1][1]=s[1]
    else: merged.append(s)
merged=[s for s in merged if s[1]-s[0] > 0.5]
print("active segments (rr energy > 3x baseline):", len(merged))
for s in merged:
    m = (t>=s[0])&(t<=s[1])
    print("  %5.1f-%5.1fs  dur %.1fs  peak rr %.2fx  peak acc %.2fx" % (s[0], s[1], s[1]-s[0], er[m].max()/base_r, ea[m].max()/base_a))
fig, ax = plt.subplots(4,1, figsize=(14,9), sharex=True)
ax[0].plot(t, rrh); ax[0].set_ylabel('rotation (rad/s)\nhigh passed'); ax[0].legend(['x','y','z'], loc='upper right', fontsize=8)
ax[1].plot(t, acch); ax[1].set_ylabel('acceleration\nhigh passed'); ax[1].legend(['x','y','z'], loc='upper right', fontsize=8)
ax[2].plot(t, er/base_r, color='tab:red'); ax[2].axhline(3, ls='--', color='gray'); ax[2].set_ylabel('jaw energy\n(x baseline)')
ax[3].plot(t, ea/base_a, color='tab:purple'); ax[3].axhline(3, ls='--', color='gray'); ax[3].set_ylabel('accel energy\n(x baseline)')
for s in merged:
    for a_ in ax: a_.axvspan(s[0], s[1], color='orange', alpha=0.15)
ax[3].set_xlabel('seconds'); fig.suptitle('AirPods Pro 3 head motion while silently mouthing (orange = detected activity)')
fig.tight_layout(); fig.savefig(sys.argv[2], dpi=110)
np.save('/tmp/sl_data/segs.npy', np.array(merged))
