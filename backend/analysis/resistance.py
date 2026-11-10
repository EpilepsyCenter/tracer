"""Series resistance (Rs), input resistance (Rin), and membrane capacitance (Cm).

Method:
1. Baseline = mean current in the baseline cursor window
2. Peak = min or max (whichever deviates more from baseline) in the first
   few ms of the pulse cursor window. Rs = |V_step| / |I_peak - baseline|.
3. Steady-state = mean of the last 20% of the pulse window.
   Rin = |V_step| / |I_steady - baseline|.
4. Exponential fit to the DECAY from peak to steady-state. This gives tau.
   Cm = tau / Rs.

The fit starts FROM the measured peak (not from t=0 of the pulse), so it
only models the decay and is not confused by the 1–2 sample delay between
the command onset and the cell's response.
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import curve_fit
from .base import AnalysisBase, register_analysis


def _single_exp(t, a, tau, offset):
    return a * np.exp(-t / tau) + offset


def _bi_exp(t, a1, tau1, a2, tau2, offset):
    return a1 * np.exp(-t / tau1) + a2 * np.exp(-t / tau2) + offset


class ResistanceAnalysis(AnalysisBase):
    name = "resistance"
    description = "Series resistance, input resistance, and membrane capacitance from test pulse"

    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict:
        v_step = params.get("v_step", 5.0)
        baseline_start = params.get("baselineStart", 0)
        baseline_end = params.get("baselineEnd", 0.01)
        pulse_start = params.get("peakStart", 0.01)
        pulse_end = params.get("peakEnd", 0.05)
        n_exp = params.get("n_exp", 1)
        fit_duration_ms = params.get("fit_duration_ms", 5.0)

        bl_i0 = max(0, int(baseline_start * sampling_rate))
        bl_i1 = min(len(data), int(baseline_end * sampling_rate))
        p_i0 = max(0, int(pulse_start * sampling_rate))
        p_i1 = min(len(data), int(pulse_end * sampling_rate))

        # Baseline
        i_baseline = float(np.mean(data[bl_i0:bl_i1]))

        # Baseline-subtracted pulse region
        pulse_data = data[p_i0:p_i1] - i_baseline
        if len(pulse_data) < 10:
            return {"error": "Pulse region too short"}

        # ---- Find the actual peak ----
        # Search in the first 5 ms (or half the pulse, whichever is shorter)
        peak_search = min(int(0.005 * sampling_rate), len(pulse_data) // 2)
        if peak_search < 2:
            peak_search = len(pulse_data) // 4
        search_window = pulse_data[:peak_search]

        if abs(np.min(search_window)) > abs(np.max(search_window)):
            peak_offset = int(np.argmin(search_window))
            peak_current = float(search_window[peak_offset])
        else:
            peak_offset = int(np.argmax(search_window))
            peak_current = float(search_window[peak_offset])

        # ---- Steady-state (last 20%) ----
        ss_start = int(0.8 * len(pulse_data))
        i_steady = float(np.mean(pulse_data[ss_start:]))

        # ---- Rs and Rin ----
        rs = abs(v_step / peak_current) * 1000 if abs(peak_current) > 1e-10 else None
        rin = abs(v_step / i_steady) * 1000 if abs(i_steady) > 1e-10 else None

        result = {
            "baseline": i_baseline,
            "peak_current": float(peak_current + i_baseline),
            "peak_time_ms": float(peak_offset / sampling_rate * 1000),
            "steady_state_current": float(i_steady + i_baseline),
            "rs": rs,
            "rin": rin,
        }

        # ---- Fit the DECAY from peak onward ----
        fit = self._fit_decay(
            pulse_data, peak_offset, sampling_rate, fit_duration_ms, n_exp
        )
        if fit is not None:
            result.update(fit)
            # Cm from the charging time constant of Rs in series with
            # Rm || Cm: tau = Cm * Rs * Rm / (Rs + Rm), so
            #   Cm = tau * (Rs + Rm) / (Rs * Rm) = tau * Rin / (Rs * (Rin - Rs))
            # with Rin = |V| / I_ss = Rs + Rm. (tau ms, R MOhm -> nF; x1000 -> pF.)
            # tau / Rs alone leaves out the Rm term and reads low by
            # Rm / (Rs + Rm). It is the fallback when Rin is missing or
            # not larger than Rs (no valid Rm).
            if rs is not None and rs > 0 and fit.get("tau") is not None:
                if rin is not None and rin > rs:
                    cm = fit["tau"] * rin / (rs * (rin - rs)) * 1000
                else:
                    cm = fit["tau"] / rs * 1000
                if 0.1 < cm < 2000:
                    result["cm"] = float(cm)

        return result

    def _fit_decay(
        self,
        pulse_data: np.ndarray,
        peak_offset: int,
        sr: float,
        fit_duration_ms: float,
        n_exp: int,
    ) -> dict | None:
        """Fit exponential decay starting FROM the measured peak.

        The fit region is [peak_offset, peak_offset + fit_duration_ms].
        Time axis is zeroed at the peak position.
        """
        fit_samples = int(fit_duration_ms / 1000 * sr)
        end = min(peak_offset + fit_samples, len(pulse_data))
        if end - peak_offset < 5:
            return None

        y = pulse_data[peak_offset:end].copy()
        t = np.arange(len(y)) / sr * 1000  # ms, starting at 0 = peak

        tau_max = fit_duration_ms * 0.9

        try:
            if n_exp == 1:
                a0 = y[0] - y[-1]
                popt, pcov = curve_fit(
                    _single_exp, t, y,
                    p0=[a0, min(1.0, tau_max / 3), float(y[-1])],
                    maxfev=10000,
                    bounds=([-np.inf, 0.01, -np.inf], [np.inf, tau_max, np.inf]),
                )
                fitted = _single_exp(t, *popt)
                tau_ms = float(popt[1])
                perr = np.sqrt(np.diag(pcov))

                result = {
                    "fit_type": "mono_exp",
                    "fit_amplitude": float(popt[0]),
                    "tau": tau_ms,
                    "tau_err": float(perr[1]),
                    "fit_offset": float(popt[2]),
                }

            else:
                a0 = y[0] - y[-1]
                popt, pcov = curve_fit(
                    _bi_exp, t, y,
                    p0=[a0 * 0.7, min(0.3, tau_max / 5), a0 * 0.3, min(2.0, tau_max / 2), float(y[-1])],
                    maxfev=10000,
                    bounds=([-np.inf, 0.01, -np.inf, 0.01, -np.inf],
                            [np.inf, tau_max, np.inf, tau_max, np.inf]),
                )
                fitted = _bi_exp(t, *popt)
                # Sort fast first
                if popt[1] > popt[3]:
                    popt = np.array([popt[2], popt[3], popt[0], popt[1], popt[4]])
                perr = np.sqrt(np.diag(pcov))
                tau_ms = float(
                    (abs(popt[0]) * popt[1] + abs(popt[2]) * popt[3])
                    / (abs(popt[0]) + abs(popt[2]))
                )

                result = {
                    "fit_type": "bi_exp",
                    "fit_a_fast": float(popt[0]),
                    "tau_fast": float(popt[1]),
                    "fit_a_slow": float(popt[2]),
                    "tau_slow": float(popt[3]),
                    "tau": tau_ms,
                    "fit_offset": float(popt[4]),
                }

            # R²
            ss_res = float(np.sum((y - fitted) ** 2))
            ss_tot = float(np.sum((y - np.mean(y)) ** 2))
            result["fit_r_squared"] = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0

            # Fitted curve for overlay — time is relative to peak position,
            # so the frontend needs to add peak_offset / sr to get absolute time.
            result["fit_time_ms"] = t.tolist()
            result["fit_values"] = fitted.tolist()
            result["fit_start_offset"] = int(peak_offset)  # samples from pulse_start

            return result

        except (RuntimeError, ValueError):
            return None


register_analysis(ResistanceAnalysis())
