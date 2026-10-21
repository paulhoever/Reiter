import test from 'node:test';
import assert from 'node:assert/strict';
import {TabGroup, windowRect, barRect, pointInRect} from '../reiter@hoever.cc/group.js';

test('erstes Mitglied wird aktiv', () => {
    const g = new TabGroup(['a', 'b']);
    assert.equal(g.active, 'a');
    assert.equal(g.size, 2);
});

test('step ist zyklisch', () => {
    const g = new TabGroup(['a', 'b', 'c']);
    g.step(-1);
    assert.equal(g.active, 'c');
    g.step(1);
    assert.equal(g.active, 'a');
});

test('selectNth ist 1-basiert und ignoriert Überlauf', () => {
    const g = new TabGroup(['a', 'b']);
    g.selectNth(2);
    assert.equal(g.active, 'b');
    g.selectNth(9);
    assert.equal(g.active, 'b');
});

test('remove des aktiven Tabs wählt den Nachbarn, Auflösung unter 2', () => {
    const g = new TabGroup(['a', 'b', 'c']);
    g.select('b');
    assert.equal(g.remove('b'), false);
    assert.equal(g.active, 'c');
    assert.equal(g.remove('c'), true);
    assert.equal(g.active, 'a');
});

test('move ordnet um und meldet Änderung', () => {
    const g = new TabGroup(['a', 'b', 'c']);
    let n = 0;
    g.onChange = () => n++;
    g.move('a', 2);
    assert.deepEqual(g.members, ['b', 'c', 'a']);
    assert.equal(n, 1);
});

test('doppeltes add wird ignoriert', () => {
    const g = new TabGroup(['a']);
    g.add('a');
    assert.equal(g.size, 1);
});

test('Geometrie: Fenster unter der Leiste, maximiert auf Arbeitsbereich', () => {
    const frame = {x: 100, y: 50, width: 800, height: 600};
    const work = {x: 0, y: 32, width: 1920, height: 1048};
    assert.deepEqual(windowRect(frame, work, false), {x: 100, y: 82, width: 800, height: 568});
    assert.deepEqual(windowRect(frame, work, true), {x: 0, y: 64, width: 1920, height: 1016});
    assert.deepEqual(barRect(frame, work, false), {x: 100, y: 50, width: 800, height: 32});
    assert.ok(pointInRect(150, 60, barRect(frame, work, false)));
    assert.ok(!pointInRect(150, 90, barRect(frame, work, false)));
});
