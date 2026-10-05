// Static, dependency-free plot of numeric offline speech-control measurements.
import { readFileSync, writeFileSync } from "node:fs";

if (process.argv.length !== 4) throw new Error("usage: plot_speech_trace.mjs INPUT.json OUTPUT.svg");
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const bins = input.bins;
if (!Array.isArray(bins) || bins.length < 2 || bins.length > 600 ||
    bins.some((row) => !Number.isFinite(row.tMs) || !Number.isFinite(row.durationMs))) {
  throw new Error("invalid trace data");
}
const width = 1200;
const height = 760;
const left = 82;
const right = width - 32;
const plotWidth = right - left;
const duration = Math.max(...bins.map((row) => row.tMs + row.durationMs)) / 1000;
const x = (seconds) => left + seconds / duration * plotWidth;
const db = (rms) => 20 * Math.log10(Math.max(rms, 0.00001));
const panels = [
  { top: 90, bottom: 255, min: -75, max: 0, title: "Pegel · dBFS",
    series: [
      ["Eingang", "originalRms", "#2563eb", db],
      ["Ausgang", "enhancedRms", "#dc2626", db],
      ["Rauschschätzung", "noiseRms", "#64748b", db],
    ] },
  { top: 317, bottom: 482, min: -12, max: 15, title: "Native AGC2-Verstärkung · dB",
    series: [
      ["Wirksam", "gainDb", "#dc2626", (v) => v],
    ] },
  { top: 544, bottom: 709, min: 0, max: 1, title: "Sprachsignal / Gate · Anteil",
    series: [
      ["Sprachwahrscheinlichkeit", "speechProbability", "#2563eb", (v) => v],
      ["Vom Gate angenommen", "acceptedFraction", "#dc2626", (v) => v],
    ] },
];
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`;
svg += `<title id="title">Sprachregelung mit Balkongeräusch und 90 Sekunden Sprechpause</title>`;
svg += `<desc id="desc">Drei Zeitreihen zeigen Pegel, Verstärkung und Sprachentscheidung vor und nach einer langen geräuschgefüllten Pause. Gleiche Teststimme und gleiches Rauschen werden vor und nach der Pause verwendet.</desc>`;
svg += `<rect width="${width}" height="${height}" fill="#ffffff"/>`;
svg += `<text x="${left}" y="35" font-family="sans-serif" font-size="22" fill="#172033">Balkongeräusch: identische Stimme vor und nach 90 s Pause</text>`;
for (const panel of panels) {
  const y = (value) => panel.bottom - (value - panel.min) / (panel.max - panel.min) * (panel.bottom - panel.top);
  svg += `<text x="${left}" y="${panel.top - 22}" font-family="sans-serif" font-size="16" fill="#172033">${escape(panel.title)}</text>`;
  svg += `<rect x="${left}" y="${panel.top}" width="${plotWidth}" height="${panel.bottom - panel.top}" fill="none" stroke="#cbd5e1"/>`;
  for (const tick of [panel.min, (panel.min + panel.max) / 2, panel.max]) {
    const yp = y(tick);
    svg += `<line x1="${left}" x2="${right}" y1="${yp}" y2="${yp}" stroke="#e2e8f0"/>`;
    svg += `<text x="${left - 10}" y="${yp + 4}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#475569">${Number.isInteger(tick) ? tick : tick.toFixed(1)}</text>`;
  }
  for (const [start, end, label] of [[26, 30, "vor"], [120, 124, "nach"]]) {
    const x1 = x(start);
    const x2 = x(end);
    svg += `<rect x="${x1}" y="${panel.top}" width="${x2 - x1}" height="${panel.bottom - panel.top}" fill="#fbbf24" opacity="0.14"/>`;
    if (panel === panels[0]) svg += `<text x="${(x1 + x2) / 2}" y="${panel.top + 15}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#92400e">${label}</text>`;
  }
  for (const [label, key, color, transform] of panel.series) {
    if (bins.some((row) => !Number.isFinite(row[key]))) throw new Error(`invalid ${key}`);
    const points = bins.map((row) => `${x((row.tMs + row.durationMs / 2) / 1000).toFixed(1)},${Math.max(panel.top, Math.min(panel.bottom, y(transform(row[key])))).toFixed(1)}`).join(" ");
    svg += `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
    const index = panel.series.findIndex((item) => item[0] === label);
    const legendX = panel.series.length === 2
      ? right - 480 + index * 265
      : right - 455 + index * 156;
    svg += `<line x1="${legendX}" x2="${legendX + 20}" y1="${panel.top - 17}" y2="${panel.top - 17}" stroke="${color}" stroke-width="3"/>`;
    svg += `<text x="${legendX + 25}" y="${panel.top - 13}" font-family="sans-serif" font-size="12" fill="#334155">${escape(label)}</text>`;
  }
  for (let tick = 0; tick <= duration; tick += 20) {
    const xp = x(tick);
    svg += `<line x1="${xp}" x2="${xp}" y1="${panel.bottom}" y2="${panel.bottom + 5}" stroke="#64748b"/>`;
    svg += `<text x="${xp}" y="${panel.bottom + 19}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#475569">${tick}</text>`;
  }
}
svg += `<text x="${(left + right) / 2}" y="${height - 9}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#475569">Zeit · Sekunden</text>`;
svg += `</svg>`;
writeFileSync(process.argv[3], svg, { flag: "wx" });
