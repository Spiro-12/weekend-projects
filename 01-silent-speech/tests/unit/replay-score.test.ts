import { describe, expect, it } from 'vitest';
import { matchWindow, overlap, Scoreboard, verdict } from '../../web/src/panels/replay/score';

const W = [
  { t0: 1, t1: 4, label: 'help' },
  { t0: 6, t1: 9, label: 'none' },
  { t0: 11, t1: 15, label: 'text_mom' },
];
const pred = (label: string, accepted: boolean, confidence = accepted ? 0.9 : 0.3) => ({ label, accepted, confidence });

describe('verdict', () => {
  it('a sentence is right only when accepted with the right label', () => {
    expect(verdict('help', pred('help', true))).toBe('right');
    expect(verdict('help', pred('text_mom', true))).toBe('wrong');
    expect(verdict('help', pred('help', false))).toBe('unsure'); // right guess, too unsure to act: not right
    expect(verdict('help', pred('none', false))).toBe('unsure');
  });
  it('none is right when nothing is accepted, wrong when anything fires', () => {
    expect(verdict('none', pred('none', false))).toBe('right');
    expect(verdict('none', pred('help', false))).toBe('right');
    expect(verdict('none', pred('help', true))).toBe('wrong');
  });
});

describe('matchWindow', () => {
  it('finds the exact window', () => {
    expect(matchWindow(W, 6, 9)).toBe(1);
    expect(matchWindow(W, 11, 15)).toBe(2);
  });
  it('tolerates small differences but not a different press', () => {
    expect(matchWindow(W, 1.1, 3.9)).toBe(0);
    expect(matchWindow(W, 2, 3)).toBe(-1); // a short visitor press inside a take
    expect(matchWindow(W, 0, 10)).toBe(-1); // one long press over two takes
    expect(matchWindow(W, 4.5, 5.5)).toBe(-1); // between takes
    expect(matchWindow(W, 1, 2.5)).toBe(-1); // take cut short (tab switched)
  });
  it('zero length windows only match exactly', () => {
    expect(matchWindow([{ t0: 2, t1: 2, label: 'x' }], 2, 2)).toBe(0);
    expect(matchWindow([{ t0: 2, t1: 2, label: 'x' }], 2, 3)).toBe(-1);
  });
  it('overlap', () => {
    expect(overlap(0, 2, 1, 3)).toBe(1);
    expect(overlap(0, 1, 2, 3)).toBe(0);
  });
});

describe('Scoreboard', () => {
  it('marks windows through a loop and summarizes', () => {
    const b = new Scoreboard();
    b.setPass(0, W);
    b.update(0.5);
    expect(b.of(0).map((w) => w.state)).toEqual(['upcoming', 'upcoming', 'upcoming']);
    b.update(2);
    expect(b.of(0)[0].state).toBe('now');
    expect(b.focus()?.idx).toBe(0);
    expect(b.clip('c1', 1, 4, true)?.idx).toBe(0);
    expect(b.of(0)[0].state).toBe('waiting');
    expect(b.prediction('c1', pred('help', true))?.state).toBe('right');
    b.update(7);
    b.clip('c2', 6, 9, true);
    b.prediction('c2', pred('call_back', true, 0.7));
    expect(b.of(0)[1]).toMatchObject({ state: 'wrong', predicted: 'call_back', confidence: 0.7 });
    expect(b.summary()).toEqual({ right: 1, wrong: 1, unsure: 0, scored: 2, total: 3, done: false });
    // third take never got a clip (interrupted): skipped, not scored, and the loop is done
    b.update(15 + 1.4);
    expect(b.of(0)[2].state).toBe('skipped');
    expect(b.summary()).toEqual({ right: 1, wrong: 1, unsure: 0, scored: 2, total: 3, done: true });
    expect(b.focus()?.idx).toBe(2);
  });

  it('a clip that matches no window is ignored, and a window is only claimed once', () => {
    const b = new Scoreboard();
    b.setPass(0, W);
    expect(b.clip('mine', 2, 3, true)).toBeNull();
    expect(b.prediction('mine', pred('help', true))).toBeNull();
    b.clip('c1', 1, 4, true);
    expect(b.clip('again', 1, 4, true)).toBeNull();
  });

  it('no model: unscored; a model that threw: unscored', () => {
    const b = new Scoreboard();
    b.setPass(0, W);
    expect(b.clip('c1', 1, 4, false)?.state).toBe('unscored');
    b.clip('c2', 6, 9, true);
    b.noPrediction('c2');
    expect(b.of(0)[1].state).toBe('unscored');
    expect(b.summary().scored).toBe(0);
  });

  it('keeps the previous loop for late clips and "last loop", forgets older ones', () => {
    const b = new Scoreboard();
    const shift = (d: number) => W.map((w) => ({ ...w, t0: w.t0 + d, t1: w.t1 + d }));
    b.setPass(0, W);
    b.setPass(1, shift(20));
    b.clip('late', 11, 15, true); // pass 0's last take finishing after the seam
    b.prediction('late', pred('text_mom', true));
    expect(b.summary(0).right).toBe(1);
    expect(b.summary(1).scored).toBe(0);
    b.setPass(2, shift(40));
    expect(b.windows.some((w) => w.pass === 0)).toBe(false);
    expect(b.of(1)).toHaveLength(3);
    b.setPass(1, W); // going back is ignored
    expect(b.pass).toBe(2);
  });
});
