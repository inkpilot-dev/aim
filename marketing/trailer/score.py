#!/usr/bin/env python3
"""Synthesises the A.I.M. trailer score (original, generated from scratch): drones, pulses, braams,
risers and a final major-key swell, aligned to the picture's hit points. Output: out/score.wav"""
import numpy as np, wave, os

SR = 44100
DUR = 58.0
N = int(SR * DUR)
rng = np.random.default_rng(20261110)
L = np.zeros(N); R = np.zeros(N); REV_L = np.zeros(N); REV_R = np.zeros(N)

def t_arr(d): return np.arange(int(SR * d)) / SR
def note(n): return 440.0 * 2 ** ((n - 69) / 12)  # midi → Hz

def saw(f, d, detune=0.0, harm=28):
    t = t_arr(d); out = np.zeros_like(t)
    for df in ((0.0,) if detune == 0 else (-detune, 0.0, detune)):
        ff = f * (1 + df); k = 1
        while k <= harm and ff * k < SR * 0.45:
            out += np.sin(2 * np.pi * ff * k * t + k * 0.7) / k; k += 1
    return out * (0.6 if detune == 0 else 0.25)

def lowpass(x, fc, order=2):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X / np.sqrt(1 + (f / fc) ** (2 * order)), len(x))
def highpass(x, fc, order=2):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR); f[0] = 1e-9
    return np.fft.irfft(X / np.sqrt(1 + (fc / f) ** (2 * order)), len(x))

def env(d, a, r, curve=3.0):
    t = t_arr(d); e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) * curve / max(r, 1e-4))
    return e
def swell(d, a, s, r):
    t = t_arr(d); e = np.ones_like(t)
    e = np.where(t < a, (t / a) ** 1.6, e); tail = t > (d - r)
    e[tail] *= ((d - t[tail]) / r) ** 1.4
    return e * s

def add(sig, t0, gain=1.0, pan=0.0, rev=0.0, wide=False):
    i = int(t0 * SR)
    if i >= N: return
    sig = sig[: N - i]; l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
    sr_ = sig
    if wide:  # Haas widening: the right channel arrives 13 ms later and slightly darker
        dly = int(0.013 * SR); sr_ = np.concatenate([np.zeros(dly), sig])[: len(sig)]
    L[i:i + len(sig)] += sig * gain * l; R[i:i + len(sig)] += sr_ * gain * r
    if rev: REV_L[i:i + len(sig)] += sig * gain * rev * l; REV_R[i:i + len(sig)] += sr_ * gain * rev * r

# ── instruments ──
def sub_boom(amp=1.0, d=2.6):
    t = t_arr(d); f = 34 + 46 * np.exp(-t * 9)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.tanh(np.sin(ph) * 2.2) * np.exp(-t * 1.9) * amp

def braam(root=26, d=3.2, amp=1.0):
    x = saw(note(root), d, 0.006) + 0.8 * saw(note(root + 12), d, 0.008) + 0.5 * saw(note(root + 19), d, 0.008) + 0.35 * saw(note(root + 24), d, 0.01)
    t = t_arr(d)
    x = lowpass(x, 900, 2) * (0.75 + 0.25 * np.sin(2 * np.pi * 5.2 * t))
    x = np.tanh(x * 3.0) * np.minimum(1, t / 0.025) * np.exp(-t * 1.25)
    return x * amp

def noise_hit(d=1.8, fc=5000, amp=1.0):
    x = rng.standard_normal(int(SR * d)); x = highpass(lowpass(x, fc, 1), 300, 1)
    return x * env(d, 0.004, d, 4.5) * amp

def tick(amp=1.0, f0=190):
    d = 0.5; t = t_arr(d); f = f0 * 0.5 + f0 * 0.5 * np.exp(-t * 26)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 11)
    click = highpass(rng.standard_normal(len(t)), 2500, 1) * np.exp(-t * 180) * 0.5
    return (body + click) * amp

def riser(d, f0=70, f1=1500, amp=1.0):
    t = t_arr(d); k = t / d; out = np.zeros_like(t)
    for mult, a in ((1, 1.0), (1.5, 0.6), (2.01, 0.5), (3.02, 0.3)):
        f = f0 * mult * (f1 / f0) ** (k ** 1.6)
        out += a * np.sin(2 * np.pi * np.cumsum(f) / SR)
    nz = highpass(rng.standard_normal(len(t)), 900, 1) * 0.55
    out = (out * 0.35 + nz * k) * (k ** 2.2) * (0.8 + 0.2 * np.sin(2 * np.pi * (4 + 10 * k) * t))
    return out * amp

def chug(f, amp=1.0):
    d = 0.26; x = lowpass(saw(f, d, 0.004), 520, 2)
    return np.tanh(x * 2.4) * env(d, 0.004, 0.2, 4.0) * amp

def pluck(f, amp=1.0, d=0.9):
    t = t_arr(d); x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t) + 0.12 * np.sin(2 * np.pi * 3 * f * t)
    return x * np.exp(-t * 5.5) * np.minimum(1, t / 0.004) * amp

def pad(notes, d, a=1.2, r=1.6, fc=1400, amp=1.0):
    x = sum(saw(note(n), d, 0.007, 20) for n in notes) / max(1, len(notes))
    return lowpass(x, fc, 2) * swell(d, a, 1.0, r) * amp

def bell(f, amp=1.0, d=3.0):
    t = t_arr(d); x = np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 2.01 * t) * np.exp(-t * 3) + 0.25 * np.sin(2 * np.pi * f * 3.02 * t) * np.exp(-t * 5)
    return x * np.exp(-t * 1.6) * np.minimum(1, t / 0.003) * amp

# ── arrangement ──
# Opening drone (D), builds through the questions.
t = t_arr(10.2)
drone = (np.sin(2 * np.pi * 36.71 * t) * 0.9 + np.sin(2 * np.pi * 73.42 * t) * 0.45 * (0.7 + 0.3 * np.sin(2 * np.pi * 0.11 * t)))
drone += lowpass(saw(note(38), 10.2, 0.006, 16), 320, 2) * 0.5 * (0.6 + 0.4 * np.sin(2 * np.pi * 0.07 * t + 1))
dr_env = np.minimum(1, t / 3.0) * np.where(t > 10.05, np.maximum(0, (10.2 - t) / 0.15), 1)
add(drone * dr_env * (0.45 + 0.55 * np.minimum(1, t / 9.5) ** 2), 0.0, 0.13, 0, rev=0.25)
add(pad([62, 69], 7.0, 2.5, 2.0, 900), 0.4, 0.07, 0, rev=0.6, wide=True)
# "Click. Scroll. Type. Repeat."
for i, tt in enumerate((3.9, 4.6, 5.3, 6.0)):
    add(tick(0.5 + 0.17 * i, 170 - 12 * i), tt, 0.6, (-0.3, 0.3, -0.15, 0.0)[i], rev=0.35)
    add(sub_boom(0.25 + 0.1 * i, 1.2), tt, 0.4)
# riser into the reveal, with a breath of silence before the hit
add(riser(2.55, 60, 1700), 7.5, 0.42, 0, rev=0.3)

def hit(tt, amp=1.0, root=26):
    add(braam(root, 3.4, amp), tt, 0.62, 0, rev=0.55)
    add(sub_boom(amp, 2.8), tt, 0.95)
    add(noise_hit(2.0, 6000, amp), tt, 0.28, 0, rev=0.7)

hit(10.2, 1.0)
for tt in (15.5, 19.0, 22.5): hit(tt, 0.62)
hit(26.0, 0.5); hit(33.0, 0.55, 29)

# pulse: each section between hits is subdivided evenly (≈ sixteenth notes)
def pulse(t0, t1, root_midi, amp, period=0.2917):
    n = max(1, round((t1 - t0) / period)); step = (t1 - t0) / n
    for i in range(n):
        acc = 1.0 if i % 4 == 0 else (0.72 if i % 2 == 0 else 0.5)
        add(chug(note(root_midi), acc), t0 + i * step, amp * 0.62, 0.08 * ((i % 2) * 2 - 1), rev=0.12)
    return step
pulse(10.9, 15.5, 38, 0.6); pulse(15.5, 19.0, 38, 0.8); pulse(19.0, 22.5, 38, 0.9); pulse(22.5, 26.0, 38, 1.0)
pulse(26.0, 29.5, 38, 1.0); pulse(29.5, 33.0, 34, 1.0); pulse(33.0, 36.0, 41, 1.05); pulse(36.0, 39.0, 36, 1.1)
pulse(39.0, 44.4, 38, 1.2, 0.1458)

# harmony: Dm → Bb → F → C, then tension, then D major at the title
add(pad([50, 57, 62, 65], 5.5, 1.5, 1.2), 10.4, 0.30, 0, rev=0.5, wide=True)
add(pad([50, 57, 62, 65], 10.6, 1.0, 1.0), 15.5, 0.34, 0, rev=0.5, wide=True)
add(pad([50, 57, 62, 65, 69], 3.7, 0.8, 0.8), 26.0, 0.40, 0, rev=0.5, wide=True)
add(pad([46, 53, 58, 62, 65], 3.7, 0.8, 0.8), 29.5, 0.40, 0, rev=0.5, wide=True)
add(pad([41, 53, 57, 60, 65], 3.2, 0.7, 0.7), 33.0, 0.44, 0, rev=0.5, wide=True)
add(pad([48, 52, 55, 60, 64], 3.2, 0.7, 0.7), 36.0, 0.44, 0, rev=0.5, wide=True)
add(pad([50, 57, 62, 65, 68], 5.4, 0.6, 0.15, 2200), 39.0, 0.40, 0, rev=0.4, wide=True)

# arpeggio from the split scene onward
def arp(t0, t1, notes, amp, period=0.2917):
    n = max(1, round((t1 - t0) / period)); step = (t1 - t0) / n
    for i in range(n):
        add(pluck(note(notes[i % len(notes)]), 1.0), t0 + i * step, amp, 0.5 * np.sin(i * 1.3), rev=0.5)
arp(26.0, 29.5, [74, 77, 81, 77, 86, 81, 77, 74], 0.13); arp(29.5, 33.0, [70, 74, 77, 74, 82, 77, 74, 70], 0.13)
arp(33.0, 36.0, [72, 77, 81, 77, 84, 81, 77, 72], 0.15); arp(36.0, 39.0, [72, 76, 79, 76, 84, 79, 76, 72], 0.15)
arp(39.0, 44.4, [74, 77, 81, 86, 89, 86, 81, 77], 0.15, 0.1458)

# montage: a hit per word, accelerating, then the big riser and a hard cut
for tt, a in ((39.0, 0.6), (40.2, 0.62), (41.2, 0.64), (42.0, 0.66), (42.6, 0.7)):
    add(sub_boom(a, 1.4), tt, 0.9); add(tick(0.9, 150), tt, 0.8, 0, rev=0.4); add(noise_hit(0.9, 7000, a), tt, 0.2, 0, rev=0.5)
for i, tt in enumerate((43.10, 43.32, 43.54, 43.74, 43.92, 44.08, 44.22)):
    add(tick(0.55 + 0.06 * i, 230 + 25 * i), tt, 0.7, 0.4 * ((i % 2) * 2 - 1), rev=0.2)
add(riser(3.2, 80, 2600, 1.0), 41.2, 0.62, 0, rev=0.25)

# the rule: near silence, two notes
add(pluck(note(50), 1.0, 2.6), 44.9, 0.30, -0.1, rev=0.9); add(pluck(note(57), 1.0, 2.6), 45.5, 0.26, 0.1, rev=0.9)
add(pluck(note(62), 1.0, 2.6), 46.1, 0.20, 0.0, rev=0.9)
add(riser(1.25, 110, 900, 0.8), 46.5, 0.42, 0, rev=0.4)

# title: the biggest hit, resolving to D major
hit(47.8, 1.15)
add(noise_hit(4.5, 9000, 1.0), 47.8, 0.22, 0, rev=0.9)
add(pad([38, 50, 57, 62, 66, 69], 9.0, 0.25, 3.6, 2400), 47.8, 0.78, 0, rev=0.6, wide=True)
add(np.sin(2 * np.pi * 36.71 * t_arr(8.5)) * swell(8.5, 0.3, 1.0, 3.5), 47.8, 0.30)
add(pad([74, 78, 81], 8.0, 1.6, 3.2, 4200), 48.4, 0.22, 0, rev=0.8, wide=True)
tt = t_arr(7.0); shimmer = (np.sin(2 * np.pi * note(86) * tt) + np.sin(2 * np.pi * note(90) * tt) * 0.7 + np.sin(2 * np.pi * note(93) * tt) * 0.5) * (0.5 + 0.5 * np.sin(2 * np.pi * 6.1 * tt)) * swell(7.0, 2.0, 1.0, 3.0)
add(shimmer, 48.6, 0.05, 0.2, rev=0.9, wide=True)
for i, n in enumerate((74, 78, 81, 86)): add(bell(note(n), 1.0), 48.5 + i * 0.42, 0.14, (-0.4, 0.3, -0.2, 0.4)[i], rev=0.9)
add(bell(note(86), 1.0, 3.5), 52.2, 0.2, 0.0, rev=0.9); add(bell(note(93), 1.0, 3.5), 52.2, 0.1, 0.2, rev=0.9)
add(sub_boom(0.5, 2.4), 55.3, 0.8); add(bell(note(74), 1.0, 2.5), 55.3, 0.07, 0, rev=0.9)

# ── reverb (convolution with decaying noise) ──
def reverb(x, seed):
    r = np.random.default_rng(seed); d = 3.4; tt = t_arr(d)
    ir = r.standard_normal(len(tt)) * np.exp(-tt * 2.1) * np.minimum(1, tt / 0.012)
    ir = highpass(lowpass(ir, 5200, 1), 180, 1); ir /= np.sqrt(np.sum(ir ** 2))
    n = len(x) + len(ir) - 1; m = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(ir, m), m)[: len(x)]
L += reverb(REV_L, 1) * 0.55; R += reverb(REV_R, 2) * 0.55

# hard cut into the silence before "One rule" (keep a short natural tail)
cut = np.ones(N); i0, i1 = int(44.4 * SR), int(44.85 * SR)
cut[i0:i1] = np.linspace(1, 0.03, i1 - i0) ** 2; cut[i1:int(46.4 * SR)] = 0.0009
ramp0, ramp1 = int(46.4 * SR), int(47.0 * SR); cut[ramp0:ramp1] = np.linspace(0.03, 1, ramp1 - ramp0) ** 2
# the three soft notes and the swell live above the ducked bed: re-add them dry after ducking
bedL, bedR = L * cut, R * cut
L[:] = 0; R[:] = 0; REV_L[:] = 0; REV_R[:] = 0
add(pluck(note(50), 1.0, 2.6), 44.9, 0.13, -0.1, rev=1.0); add(pluck(note(57), 1.0, 2.6), 45.5, 0.11, 0.1, rev=1.0); add(pluck(note(62), 1.0, 2.6), 46.1, 0.09, 0.0, rev=1.0)
softL = L + reverb(REV_L, 3) * 0.6; softR = R + reverb(REV_R, 4) * 0.6
mixL, mixR = bedL + softL, bedR + softR

# ── master ──
fade = np.ones(N); f0 = int(56.6 * SR); fade[f0:] = np.linspace(1, 0, N - f0) ** 1.5
fin = np.minimum(1, np.arange(N) / (0.4 * SR))
mix = np.stack([mixL, mixR], 1) * (fade * fin)[:, None]
mix = highpass(mix[:, 0], 24, 2), highpass(mix[:, 1], 24, 2)
mix = np.stack(mix, 1)
peak = np.percentile(np.abs(mix), 99.9); mix = np.tanh(mix / peak * 1.15) / np.tanh(1.15)
mix = mix / np.max(np.abs(mix)) * 0.94
os.makedirs('out', exist_ok=True)
with wave.open('out/score.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mix * 32767).astype('<i2').tobytes())
rms = np.sqrt(np.mean(mix ** 2)); print(f'score.wav {DUR:.0f}s peak {np.max(np.abs(mix)):.2f} rms {rms:.3f}')
