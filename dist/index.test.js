import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { interpolateTrack } from './interpolator.js';
import { hueToSynthParams, midiToFrequency } from './synth.js';
import { render } from './renderer.js';
test('interpolateTrack - linear interpolation', () => {
    const points = [
        { t: 0, y: 60, size: 0.5 },
        { t: 1, y: 72, size: 1.0 },
    ];
    const result = interpolateTrack(points, 0.5);
    assert.ok(result !== null);
    assert.equal(result.y, 66);
    assert.equal(result.size, 0.75);
});
test('interpolateTrack - out of bounds returns null', () => {
    const points = [
        { t: 1, y: 60, size: 0.5 },
        { t: 2, y: 72, size: 1.0 },
    ];
    assert.equal(interpolateTrack(points, 0.5), null);
    assert.equal(interpolateTrack(points, 2.5), null);
});
test('interpolateTrack - single point', () => {
    const points = [{ t: 1, y: 60, size: 0.5 }];
    const result = interpolateTrack(points, 1);
    assert.ok(result !== null);
    assert.equal(result.y, 60);
    assert.equal(result.size, 0.5);
});
test('hueToSynthParams - returns valid parameters', () => {
    const params = hueToSynthParams(180);
    assert.ok(params.brightness >= 0 && params.brightness <= 1);
    assert.ok(params.thickness >= 0 && params.thickness <= 1);
    assert.ok(params.noise >= 0 && params.noise <= 1);
});
test('hueToSynthParams - wraps hue values', () => {
    const params1 = hueToSynthParams(0);
    const params2 = hueToSynthParams(360);
    const params3 = hueToSynthParams(720);
    assert.equal(params1.brightness, params2.brightness);
    assert.equal(params1.brightness, params3.brightness);
});
test('midiToFrequency - A4 = 440Hz', () => {
    const freq = midiToFrequency(69);
    assert.ok(Math.abs(freq - 440) < 0.01);
});
test('midiToFrequency - C4', () => {
    const freq = midiToFrequency(60);
    assert.ok(Math.abs(freq - 261.63) < 0.01);
});
test('render - simple score produces valid output', () => {
    const score = {
        sampleRate: 44100,
        duration: 0.1,
        seed: 42,
        tracks: [
            {
                id: 'test-track',
                hue: 180,
                channel: 0,
                points: [
                    { t: 0, y: 60, size: 0.5 },
                    { t: 0.1, y: 72, size: 0.3 },
                ],
            },
        ],
    };
    const result = render(score);
    assert.equal(result.buffers.length, 1);
    assert.ok(result.buffers[0].length > 0);
    assert.equal(result.sampleRate, 44100);
    assert.ok(result.duration >= 0.1);
    assert.equal(result.eventReport.length, 1);
    assert.ok(result.wav.length > 44);
});
test('render - multi-track score', () => {
    const score = {
        sampleRate: 44100,
        duration: 0.1,
        tracks: [
            {
                id: 'track-1',
                hue: 120,
                channel: 0,
                points: [{ t: 0, y: 60, size: 0.5 }, { t: 0.1, y: 60, size: 0.5 }],
            },
            {
                id: 'track-2',
                hue: 240,
                channel: 1,
                points: [{ t: 0, y: 72, size: 0.3 }, { t: 0.1, y: 72, size: 0.3 }],
            },
        ],
    };
    const result = render(score);
    assert.equal(result.buffers.length, 2);
    assert.equal(result.eventReport.length, 2);
});
test('render - empty gaps produce silence', () => {
    const score = {
        sampleRate: 44100,
        duration: 1.0,
        tracks: [
            {
                id: 'gapped-track',
                hue: 0,
                channel: 0,
                points: [
                    { t: 0.0, y: 60, size: 0.5 },
                    { t: 0.1, y: 60, size: 0.5 },
                ],
            },
        ],
    };
    const result = render(score);
    const buffer = result.buffers[0];
    const midPoint = Math.floor(buffer.length / 2);
    const hasSilence = buffer[midPoint] === 0;
    assert.ok(hasSilence);
});
test('render - peak normalization prevents clipping', () => {
    const score = {
        sampleRate: 44100,
        duration: 0.1,
        tracks: [
            {
                id: 'loud-track-1',
                hue: 0,
                channel: 0,
                points: [{ t: 0, y: 60, size: 1.0 }, { t: 0.1, y: 60, size: 1.0 }],
            },
            {
                id: 'loud-track-2',
                hue: 180,
                channel: 0,
                points: [{ t: 0, y: 64, size: 1.0 }, { t: 0.1, y: 64, size: 1.0 }],
            },
        ],
    };
    const result = render(score);
    const buffer = result.buffers[0];
    const peak = Math.max(...Array.from(buffer).map(Math.abs));
    assert.ok(peak <= 1.0);
});
//# sourceMappingURL=index.test.js.map