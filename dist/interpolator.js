export function interpolateTrack(points, time) {
    if (points.length === 0) {
        return null;
    }
    const sorted = [...points].sort((a, b) => a.t - b.t);
    if (time < sorted[0].t || time > sorted[sorted.length - 1].t) {
        return null;
    }
    if (sorted.length === 1) {
        return { y: sorted[0].y, size: sorted[0].size };
    }
    let i = 0;
    while (i < sorted.length - 1 && sorted[i + 1].t <= time) {
        i++;
    }
    if (i === sorted.length - 1) {
        return { y: sorted[i].y, size: sorted[i].size };
    }
    const p0 = sorted[i];
    const p1 = sorted[i + 1];
    const t = (time - p0.t) / (p1.t - p0.t);
    return {
        y: p0.y + (p1.y - p0.y) * t,
        size: p0.size + (p1.size - p0.size) * t,
    };
}
export function getTrackDuration(points) {
    if (points.length === 0)
        return 0;
    return Math.max(...points.map(p => p.t));
}
//# sourceMappingURL=interpolator.js.map