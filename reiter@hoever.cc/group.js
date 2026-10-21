// SPDX-License-Identifier: GPL-3.0-or-later
// Group logic without Shell imports: members, active tab, geometry.
// Windows are arbitrary objects here; the Shell side supplies adapters (extension.js).

export const TAB_BAR_HEIGHT = 32;

export class TabGroup {
    constructor(windows = []) {
        this.members = [];
        this.active = null;
        this.onChange = null;
        for (const w of windows)
            this.add(w);
    }

    get size() {
        return this.members.length;
    }

    has(win) {
        return this.members.includes(win);
    }

    add(win, index = this.members.length) {
        if (this.has(win))
            return;
        this.members.splice(Math.min(index, this.members.length), 0, win);
        if (!this.active)
            this.active = win;
        this._changed();
    }

    // Returns true if the group should be dissolved afterwards (< 2 members).
    remove(win) {
        const i = this.members.indexOf(win);
        if (i < 0)
            return this.size < 2;
        this.members.splice(i, 1);
        if (this.active === win)
            this.active = this.members[Math.min(i, this.members.length - 1)] ?? null;
        this._changed();
        return this.size < 2;
    }

    select(win) {
        if (!this.has(win) || this.active === win)
            return;
        this.active = win;
        this._changed();
    }

    // delta: +1 next tab, -1 previous tab, wrapping around.
    step(delta) {
        if (this.size < 2)
            return;
        const i = this.members.indexOf(this.active);
        this.select(this.members[(i + delta + this.size) % this.size]);
    }

    // n is 1-based (Alt+1..9).
    selectNth(n) {
        const win = this.members[n - 1];
        if (win)
            this.select(win);
    }

    move(win, toIndex) {
        const i = this.members.indexOf(win);
        if (i < 0)
            return;
        this.members.splice(i, 1);
        this.members.splice(Math.max(0, Math.min(toIndex, this.members.length)), 0, win);
        this._changed();
    }

    _changed() {
        this.onChange?.(this);
    }
}

// Frame of the window below the bar. `frame` is the group frame including the bar,
// `work` the monitor's work area. Maximized: window = work area minus the bar.
export function windowRect(frame, work, maximized, barHeight = TAB_BAR_HEIGHT) {
    const base = maximized ? work : frame;
    return {
        x: base.x,
        y: base.y + barHeight,
        width: base.width,
        height: Math.max(1, base.height - barHeight),
    };
}

// The bar occupies the top barHeight px of the group frame.
export function barRect(frame, work, maximized, barHeight = TAB_BAR_HEIGHT) {
    const base = maximized ? work : frame;
    return {x: base.x, y: base.y, width: base.width, height: barHeight};
}

export function pointInRect(px, py, r) {
    return px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height;
}
