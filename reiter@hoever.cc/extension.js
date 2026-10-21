// SPDX-License-Identifier: GPL-3.0-or-later
// Reiter: bundles windows of different apps into one group with a shared tab bar.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {TabGroup, TAB_BAR_HEIGHT} from './group.js';

// Height of the filler strip below the window; it fills the gap at the rounded window corners.
const FILL_HEIGHT = 16;
const DRAG_THRESHOLD = 8;
const EDGE = 8;
// Corner radius of app windows (libadwaita); the corner pieces cover everything outside this curve.
const CORNER = 12;
const MIN_W = 240;
const MIN_H = 160;
// Sidebar: its width selects the layout (icons / icon + text / preview).
const SIDE_MIN = 48;
const SIDE_MAX = 420;
const SIDE_TEXT_MIN = 100;
const SIDE_PREVIEW_MIN = 200;
const THUMB_MIN = 96;
const THUMB_MAX = 320;
const THUMB_RATIO = 0.625;
const HOVER_W = 280;
const OVER_KEYS = ['side', 'sideW', 'compact', 'hover', 'top', 'thumbW'];
const CFG_KEYS = ['compact', 'bar-side', 'sidebar-width', 'hover-preview', 'top-preview', 'preview-width', 'pinned'];

export default class ReiterExtension extends Extension {
    enable() {
        // A single settings object: getSettings() returns a new one each call, and its signals would be lost.
        this._settings = this.getSettings();
        this._groups = new Set();
        this._bars = new Map(); // TabGroup -> St.BoxLayout
        this._colors = new WeakMap(); // window -> measured bar colors
        this._ids = [];
        this._timers = new Set();
        this._dropTimer = 0;
        this._hover = null;
        this._hoverTimer = 0;
        // Overview: a group shows up as one window (the active one); hidden members are left out.
        this._inject = new InjectionManager();
        const self = this;
        this._inject.overrideMethod(Workspace.Workspace.prototype, '_isOverviewWindow', orig =>
            function (window) {
                const w = window.get_meta_window?.() ?? window;
                const g = self._groups && self._groupOf(w);
                if (g && g.active !== w)
                    return false;
                return orig.call(this, window);
            });
        this._loadCfg();
        this._cfgId = this._settings.connect('changed', (_s, key) => {
            if (!CFG_KEYS.includes(key))
                return;
            this._loadCfg();
            for (const g of this._groups) {
                g._cfg = null;
                this._sync(g);
            }
        });

        this._wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._layoutSaved = false;
        if (this._settings.get_string('saved-button-layout'))
            this._restoreButtonLayout();
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._ifaceId = this._iface.connect('changed::color-scheme', () => this._restyle());

        this._ids.push([global.display, global.display.connect('notify::focus-window',
            () => this._onFocus())]);
        // The bar has to follow its window in the stacking order.
        this._ids.push([global.display, global.display.connect('restacked',
            () => this._restack())]);
        // Dropping a window on the bar adds it to the group.
        this._ids.push([global.display, global.display.connect('grab-op-begin',
            (_d, win, op) => this._onGrabBegin(win, op))]);
        this._ids.push([global.display, global.display.connect('grab-op-end',
            (_d, win, op) => this._onGrabEnd(win, op))]);

        // Attention: a window asks for attention, or its app sends a notification, while it is only a
        // hidden tab in a group -> show a dot on the tab.
        for (const sig of ['window-demands-attention', 'window-marked-urgent'])
            this._ids.push([global.display, global.display.connect(sig, (_d, w) => this._attend(w))]);
        const watchSource = src => {
            this._ids.push([src, src.connect('notification-added', () => this._attendApp(src))]);
        };
        Main.messageTray.getSources().forEach(watchSource);
        this._ids.push([Main.messageTray, Main.messageTray.connect('source-added', (_t, src) => watchSource(src))]);

        // Rules from the preferences: new windows of matching apps are moved into the group.
        this._ids.push([global.display, global.display.connect('window-created',
            (_d, w) => this._onCreated(w))]);

        Main.wm.addKeybinding('group-with-previous', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._groupFocusedWithNext());
    }

    disable() {
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = null;
        Main.wm.removeKeybinding('group-with-previous');
        this._inject.clear();
        this._inject = null;
        this._settings.disconnect(this._cfgId);
        this._hoverHide();
        this._stopDropWatch();
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        this._iface.disconnect(this._ifaceId);
        this._iface = null;
        for (const g of [...this._groups])
            this._dissolve(g);
        if (this._layoutSaved)
            this._restoreButtonLayout();
        this._wm = null;
        this._settings = null;
        this._groups = null;
        this._bars = null;
        this._ids = null;
    }

    // One-shot timer that disable() cleans up.
    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers?.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _loadCfg() {
        const s = this._settings;
        this._cfg = {
            side: s.get_string('bar-side'),
            sideW: Math.max(SIDE_MIN, Math.min(SIDE_MAX, s.get_int('sidebar-width'))),
            compact: s.get_boolean('compact'),
            hover: s.get_boolean('hover-preview'),
            top: s.get_boolean('top-preview'),
            thumbW: Math.max(THUMB_MIN, Math.min(THUMB_MAX, s.get_int('preview-width'))),
        };
    }

    // Settings of a group: defaults from GSettings, overridden by the group's own values (g._over).
    _c(g) {
        if (!g)
            return this._cfg;
        g._cfg ??= {...this._cfg, ...g._over};
        return g._cfg;
    }

    // A group's overrides and name are stored under its app classes ("group-settings", one JSON object per line).
    _overEntries() {
        const out = [];
        for (const l of this._settings.get_strv('group-settings')) {
            try {
                out.push(JSON.parse(l));
            } catch (e) {
                // skip a corrupt line
            }
        }
        return out;
    }

    _loadOver(g) {
        const key = this._groupKeys(g).join(',');
        const e = this._overEntries().find(o => o.keys === key);
        g._okey = e ? key : null;
        g._name = e?.name ?? '';
        g._over = {};
        for (const k of OVER_KEYS)
            if (e && e[k] !== undefined)
                g._over[k] = e[k];
        g._cfg = null;
    }

    _saveOver(g) {
        const key = this._groupKeys(g).join(',');
        const list = this._overEntries().filter(o => o.keys !== key && o.keys !== g._okey);
        if (g._name || Object.keys(g._over).length > 0)
            list.push({keys: key, ...(g._name ? {name: g._name} : {}), ...g._over});
        g._okey = key;
        this._settings.set_strv('group-settings', list.map(o => JSON.stringify(o)));
    }

    _setOver(g, patch) {
        Object.assign(g._over, patch);
        g._cfg = null;
        this._saveOver(g);
        this._sync(g);
    }

    _renameGroup(g) {
        const dlg = new ModalDialog.ModalDialog({destroyOnClose: true});
        dlg.contentLayout.add_child(new St.Label({text: _('Group name'), x_align: Clutter.ActorAlign.START}));
        const entry = new St.Entry({text: g._name ?? '', style: 'min-width: 260px; margin-top: 8px;', can_focus: true});
        dlg.contentLayout.add_child(entry);
        const done = () => {
            g._name = entry.get_text().trim();
            this._saveOver(g);
            this._sync(g);
            dlg.close();
        };
        entry.clutter_text.connect('activate', done);
        dlg.setButtons([
            {label: _('Cancel'), action: () => dlg.close(), key: Clutter.KEY_Escape},
            {label: _('Rename'), action: done, default: true},
        ]);
        dlg.open();
        entry.grab_key_focus();
    }

    // Displayed width of the sidebar. Compact: narrow, and it expands over the app when hovered.
    _dispW(g) {
        const c = this._c(g);
        if (!c.compact)
            return c.sideW;
        return g._expanded ? Math.max(c.sideW, 180) : SIDE_MIN;
    }

    // How tabs are drawn: 'icon' | 'text' | 'preview'. On top, the toggle decides; on the side, the width
    // (narrow = icons) does, and the permanent preview is also the toggle there and needs enough width.
    _mode(g) {
        const c = this._c(g);
        if (c.side === 'top')
            return c.top ? 'preview' : 'text';
        const w = this._dispW(g);
        if (w < SIDE_TEXT_MIN)
            return 'icon';
        return c.top && w >= SIDE_PREVIEW_MIN ? 'preview' : 'text';
    }

    _thumbH(w) {
        return Math.round(w * THUMB_RATIO);
    }

    // Height of the top bar: tabs only, or a preview row above them.
    _topH(g) {
        if (this._c(g).side !== 'top')
            return 0;
        return this._c(g).top ? this._thumbH(this._c(g).thumbW) + TAB_BAR_HEIGHT + 4 : TAB_BAR_HEIGHT;
    }

    _schemeClass() {
        return this._iface.get_string('color-scheme') === 'prefer-dark' ? 'dark' : 'light';
    }

    _restyle() {
        this._colors = new WeakMap();
        for (const [g, bar] of this._bars) {
            this._applyScheme(bar);
            this._applyScheme(g._fill);
            g._corners.forEach(c => c.queue_repaint());
            this._later(600, () => {
                if (this._groups?.has(g))
                    this._applyHeaderColor(g);
            });
        }
    }

    _applyScheme(actor) {
        actor.remove_style_class_name('dark');
        actor.remove_style_class_name('light');
        actor.add_style_class_name(this._schemeClass());
    }

    // Triggered by a shortcut: bundle the focused window with the most recently used other window.
    _groupFocusedWithNext() {
        const focus = global.display.focus_window;
        if (!focus || this._groupOf(focus))
            return;
        const other = global.display.get_tab_list(Meta.TabList.NORMAL, null)
            .find(w => w !== focus && !this._groupOf(w));
        if (!other)
            return;

        this._createGroup(focus, other);
    }

    // Bundle two windows into one group; the larger frame wins, otherwise a large window would
    // be squeezed into a small one.
    _createGroup(focus, other) {
        const area = w => {
            const r = w.get_frame_rect();
            return r.width * r.height;
        };
        const big = area(other) > area(focus) ? other : focus;
        const r = big.get_frame_rect();
        if (focus.is_maximized?.())
            focus.unmaximize();
        if (other.is_maximized?.())
            other.unmaximize();
        // Leave room for the bar above the window.
        const y = Math.max(r.y, global.display.get_monitor_geometry(big.get_monitor()).y +
            this._topH(null) + 32);
        for (const w of [focus, other])
            w.move_resize_frame(false, r.x, y, r.width, r.height);

        const g = new TabGroup([focus, other]);
        g.active = focus;
        this._loadOver(g);
        g.onChange = () => this._sync(g);
        this._groups.add(g);
        this._updateButtonLayout();
        this._buildBar(g);
        // The windows need a moment to pick up the new size.
        this._later(200, () => {
            if (this._groups?.has(g))
                this._sync(g);
        });
    }

    _ruleKey(w) {
        return (w.get_wm_class() ?? w.get_gtk_application_id() ?? '').toLowerCase();
    }

    // Rule = comma-separated list of window classes (wm_class / app ID), e.g. "org.gnome.Calendar, evolution".
    _ruleFor(w) {
        const key = this._ruleKey(w);
        if (!key)
            return null;
        for (const line of [...this._settings.get_strv('rules'), ...this._settings.get_strv('saved-groups')]) {
            const classes = line.split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
            if (classes.includes(key))
                return classes;
        }
        return null;
    }

    _onCreated(w) {
        // wm_class is only set shortly after the window is created.
        this._later(800, () => {
            if (this._groups && w.get_compositor_private() && !this._groupOf(w) &&
                w.get_window_type() === Meta.WindowType.NORMAL)
                this._applyRules(w);
        });
    }

    _applyRules(w) {
        const classes = this._ruleFor(w);
        if (!classes)
            return;
        const mine = this._ruleKey(w);
        const peers = global.display.get_tab_list(Meta.TabList.NORMAL, null)
            .filter(o => o !== w && classes.includes(this._ruleKey(o)) && this._ruleKey(o) !== mine);
        const grouped = peers.find(o => this._groupOf(o));
        if (grouped)
            this._addToGroup(this._groupOf(grouped), w);
        else if (peers.length > 0)
            this._createGroup(w, peers[0]);
        this._launchMissing(w, classes);
    }

    // Saved group: when one member opens, the missing apps are started too; the rule then puts them into the group.
    _launchMissing(w, classes) {
        const line = this._settings.get_strv('saved-groups')
            .find(l => l.split(',').map(c => c.trim().toLowerCase()).includes(this._ruleKey(w)));
        if (!line)
            return;
        this._launching ??= new Map();
        const now = GLib.get_monotonic_time() / 1e6;
        const running = global.display.get_tab_list(Meta.TabList.NORMAL, null).map(o => this._ruleKey(o));
        for (const key of classes) {
            if (running.includes(key) || now - (this._launching.get(key) ?? -999) < 20)
                continue;
            const info = Gio.AppInfo.get_all().find(a =>
                a.get_id()?.toLowerCase() === `${key}.desktop` ||
                a.get_id()?.toLowerCase().replace(/\.desktop$/, '').endsWith(`.${key}`) ||
                a.get_startup_wm_class?.()?.toLowerCase() === key);
            if (!info)
                continue;
            this._launching.set(key, now);
            try {
                info.launch([], null);
            } catch (e) {
                console.error(`Reiter: ${key} nicht startbar: ${e.message}`);
            }
        }
    }

    _groupKeys(g) {
        return [...new Set(g.members.map(m => this._ruleKey(m)).filter(Boolean))].sort();
    }

    _savedIndex(g) {
        const keys = this._groupKeys(g).join(',');
        return this._settings.get_strv('saved-groups').findIndex(l =>
            l.split(',').map(c => c.trim().toLowerCase()).filter(Boolean).sort().join(',') === keys);
    }

    _toggleSaved(g) {
        const list = this._settings.get_strv('saved-groups');
        const i = this._savedIndex(g);
        if (i >= 0)
            list.splice(i, 1);
        else
            list.push(this._groupKeys(g).join(', '));
        this._settings.set_strv('saved-groups', list);
    }

    // Set the tab dot when the window is not the active one in its group (otherwise it is visible anyway).
    _attend(w) {
        const g = w && this._groupOf(w);
        if (!g || g.active === w)
            return;
        g._attn ??= new Set();
        if (g._attn.has(w))
            return;
        g._attn.add(w);
        this._sync(g);
    }

    _attendApp(src) {
        const app = src.app;
        if (!app)
            return;
        const tracker = Shell.WindowTracker.get_default();
        for (const g of this._groups)
            for (const w of g.members)
                if (tracker.get_window_app(w) === app)
                    this._attend(w);
    }

    _isPinned(w) {
        const key = this._ruleKey(w);
        return !!key && this._settings.get_strv('pinned').includes(key);
    }

    _togglePinned(w) {
        const key = this._ruleKey(w);
        if (!key)
            return;
        const list = this._settings.get_strv('pinned');
        const i = list.indexOf(key);
        if (i >= 0)
            list.splice(i, 1);
        else
            list.push(key);
        this._settings.set_strv('pinned', list);
    }

    _groupOf(win) {
        for (const g of this._groups) {
            if (g.has(win))
                return g;
        }
        return null;
    }

    // Quarter square without the quarter circle, in the bar color, drawn over the window: it hides the gray wedge
    // (shadow/border of the app's corner) that would otherwise remain between bar and rounded window corner.
    _makeCorner(g, right) {
        const a = new St.DrawingArea({reactive: false});
        a.set_size(CORNER, CORNER);
        a.connect('repaint', () => {
            const cr = a.get_context();
            const [r, gr, b] = (right ? g._cornerR : g._cornerL) ?? g._rgb ?? (this._schemeClass() === 'dark' ? [46, 46, 50] : [235, 235, 237]);
            cr.setSourceRGB(r / 255, gr / 255, b / 255);
            if (right) {
                cr.translate(CORNER, 0);
                cr.scale(-1, 1);
            }
            cr.moveTo(0, 0);
            cr.lineTo(CORNER, 0);
            // 1 px smaller than the app's radius so that its dark border fringe is covered as well.
            cr.arcNegative(CORNER, CORNER, CORNER - 1, -Math.PI / 2, -Math.PI);
            cr.lineTo(0, CORNER);
            cr.closePath();
            cr.fill();
            cr.$dispose();
        });
        global.window_group.add_child(a);
        return a;
    }

    _buildBar(g) {
        const bar = new St.BoxLayout({style_class: 'reiter-bar', reactive: true});
        const fill = new St.Widget({style_class: 'reiter-fill'});
        this._applyScheme(bar);
        this._applyScheme(fill);
        global.window_group.add_child(fill);
        global.window_group.add_child(bar);
        g._fill = fill;
        g._corners = [false, true].map(right => this._makeCorner(g, right));
        this._bars.set(g, bar);

        // Handle between sidebar and app: sits above the window, otherwise the window's own resize border wins.
        g._handle = new St.Widget({reactive: true});
        global.window_group.add_child(g._handle);
        g._handle.connect('captured-event', (_a, event) => this._handleEvent(g, event));
        g._handle.connect('enter-event', () => {
            this._setCursor({sb: true}, g);
            return Clutter.EVENT_PROPAGATE;
        });
        g._handle.connect('leave-event', () => {
            if (!g._press)
                this._setCursor(null);
            return Clutter.EVENT_PROPAGATE;
        });

        // Dragging the bar moves the whole group.
        bar.connect('captured-event', (_a, event) => this._barEvent(g, event));
        // Resize cursors on the edge zones of the bar
        bar.connect('motion-event', (_a, event) => {
            if (g._press)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            this._setCursor(this._edgeAt(g, x, y), g);
            return Clutter.EVENT_PROPAGATE;
        });
        bar.connect('leave-event', () => {
            if (!g._press)
                this._setCursor(null);
            this._compactSoon(g, false);
            return Clutter.EVENT_PROPAGATE;
        });
        bar.connect('enter-event', () => {
            this._compactSoon(g, true);
            return Clutter.EVENT_PROPAGATE;
        });

        g._ids = [];
        for (const w of g.members)
            this._watch(g, w);
    }

    // Window changes of a member -> sync.
    _watch(g, w) {
        for (const sig of ['position-changed', 'size-changed', 'notify::minimized', 'notify::title',
            'workspace-changed', 'unmanaged']) {
            g._ids.push([w, w.connect(sig, () => {
                if (sig === 'unmanaged')
                    this._onGone(g, w);
                else if (w === g.active)
                    this._sync(g);
            })]);
        }
    }

    _unwatch(g, w) {
        g._ids = g._ids.filter(([obj, id]) => {
            if (obj !== w)
                return true;
            obj.disconnect(id);
            return false;
        });
    }

    _onGone(g, win) {
        if (g.remove(win))
            this._dissolve(g);
    }

    _onFocus() {
        const w = global.display.focus_window;
        const g = w && this._groupOf(w);
        if (g)
            g.select(w);
    }

    // Stack the bar directly above and the filler directly below the active window's actor.
    _restack() {
        for (const [g, bar] of this._bars) {
            const actor = g.active?.get_compositor_private();
            if (!actor || actor.get_parent() !== global.window_group)
                continue;
            // The sidebar sits below the window (its edge runs underneath and fills the window corners).
            if (this._c(g).side === 'top' || (this._c(g).compact && g._expanded))
                global.window_group.set_child_above_sibling(bar, actor);
            else
                global.window_group.set_child_below_sibling(bar, actor);
            global.window_group.set_child_below_sibling(g._fill, actor);
            g._corners.forEach(c => global.window_group.set_child_above_sibling(c, actor));
            global.window_group.set_child_above_sibling(g._handle, actor);
        }
    }

    // --- Dragging the bar ----------------------------------------------------------------------

    // Press takes a grab on the bar so that motion and release reliably arrive here
    // (on the stage only enter/leave arrived). Without a drag, the click is passed on to the button under the pointer.
    _barEvent(g, event) {
        const type = event.type();
        const bar = this._bars.get(g);
        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (g._press)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            let a = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            while (a && !a._win)
                a = a.get_parent();
            const edge = event.get_button() === Clutter.BUTTON_PRIMARY ? this._edgeAt(g, x, y) : null;
            this._hoverHide();
            // A click anywhere on the bar raises the whole group.
            if (!a && g.active)
                Main.activateWindow(g.active);
            if (edge && g.active) {
                g._press = {x, y, dragging: false, win: null, edge, r0: g.active.get_frame_rect(),
                    sw0: this._c(g).sideW, tw0: this._c(g).thumbW,
                    grab: global.stage.grab(bar)};
                return Clutter.EVENT_STOP;
            }
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._barMenu(g, a, x, y);
                return Clutter.EVENT_STOP;
            }
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            let onButton = a;
            if (!onButton) {
                onButton = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                while (onButton && !(onButton instanceof St.Button))
                    onButton = onButton.get_parent();
            }
            const press = {x, y, dragging: false, win: a?._win ?? null};
            if (!a && !onButton) {
                // Empty area of the bar: double-click maximizes, the edge resizes, otherwise move the group.
                // Clutter reports no click count: double-click = second press within 400 ms and 8 px of the first.
                const t = event.get_time();
                const last = g._lastClick;
                g._lastClick = {t, x, y};
                if (last && t - last.t < 400 && Math.hypot(x - last.x, y - last.y) < DRAG_THRESHOLD) {
                    g._lastClick = null;
                    this._toggleMax(g);
                    return Clutter.EVENT_STOP;
                }
            }
            press.grab = global.stage.grab(bar);
            g._press = press;
            return Clutter.EVENT_STOP;
        }
        const press = g._press;
        if (!press)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        if (type === Clutter.EventType.MOTION) {
            if (press.edge) {
                this._resizeTo(g, press, x, y);
                return Clutter.EVENT_STOP;
            }
            if (press.win && !press.moveWin) {
                // Dragging a tab out of the bar detaches the window from the group
                const [bx, by] = bar.get_transformed_position();
                const [bw, bh] = bar.get_transformed_size();
                if (x < bx - 12 || x > bx + bw + 12 || y < by - 12 || y > by + bh + 12) {
                    this._detach(g, press, x, y);
                    press.dragging = true;
                } else if (Math.abs(this._c(g).side === 'top' ? x - press.x : y - press.y) > DRAG_THRESHOLD) {
                    this._reorder(g, press.win, x, y);
                }
                return Clutter.EVENT_STOP;
            }
            if (!press.dragging && Math.hypot(x - press.x, y - press.y) > DRAG_THRESHOLD)
                this._startDrag(g, press, x, y);
            if (press.dragging)
                this._dragTo(g, press, x, y);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            g._press = null;
            press.grab.dismiss();
            if (press.dissolve)
                this._dissolve(g);
            if (press.edge?.sb) {
                const c = this._c(g);
                this._setOver(g, c.side === 'top' ? {thumbW: c.thumbW} : {sideW: c.sideW});
            }
            if (!press.dragging && !press.edge) {
                let a = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                while (a && !(a instanceof St.Button))
                    a = a.get_parent();
                a?.emit('clicked', Clutter.BUTTON_PRIMARY);
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Compact bar: expand/collapse after a short delay so it does not flicker.
    _compactSoon(g, open) {
        if (g._compactTimer)
            GLib.source_remove(g._compactTimer);
        g._compactTimer = 0;
        if (!this._c(g).compact || this._c(g).side === 'top' || !!g._expanded === open)
            return;
        g._compactTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, open ? 150 : 300, () => {
            g._compactTimer = 0;
            if (this._groups?.has(g) && !g._press) {
                g._expanded = open;
                g._animate = true;
                this._sync(g);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _handleEvent(g, event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || g._press || !g.active)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            this._hoverHide();
            g._press = {x, y, dragging: false, win: null, edge: {sb: true}, r0: g.active.get_frame_rect(),
                sw0: this._c(g).sideW, tw0: this._c(g).thumbW, grab: global.stage.grab(g._handle)};
            return Clutter.EVENT_STOP;
        }
        return this._barEvent(g, event);
    }

    _startDrag(g, press, x, y) {
        press.dragging = true;
        const act = g.active;
        if (!act)
            return;
        if (g.maximized) {
            // Like GNOME: dragging out of the maximized state restores the old size, under the pointer.
            const work = act.get_work_area_current_monitor();
            const frac = (x - work.x) / work.width;
            this._toggleMax(g);
            const r = act.get_frame_rect();
            const nx = Math.round(x - frac * r.width);
            act.move_frame(true, nx, y + this._topH(g) / 2);
        }
        const r = act.get_frame_rect();
        press.dx = x - r.x;
        press.dy = y - (r.y - this._topH(g));
    }

    // Tab dragged out: the window leaves the group and follows the pointer; the group is only dissolved
    // on release (the bar holds the grab).
    _detach(g, press, x, y) {
        const w = press.win;
        this._unwatch(g, w);
        const last = g.remove(w);
        const r = w.get_frame_rect();
        press.moveWin = w;
        press.dx = Math.round(r.width / 2);
        press.dy = 16;
        w.get_compositor_private()?.show();
        w.move_frame(true, x - press.dx, y - press.dy);
        Main.activateWindow(w);
        if (last)
            press.dissolve = true;
        else
            this._sync(g);
    }

    // Edge zones of the bar: outside they resize (n/s/w/e), inside (sb) they set the sidebar width or preview size.
    // There are none while maximized.
    _edgeAt(g, x, y) {
        const bar = this._bars.get(g);
        if (!bar || g.maximized)
            return null;
        const [bx, by] = bar.get_transformed_position();
        const [bw, bh] = bar.get_transformed_size();
        const {side} = this._c(g);
        const e = {n: y < by + EDGE, s: false, w: x < bx + EDGE, e: x >= bx + bw - EDGE, sb: false};
        if (side === 'top') {
            e.sb = this._c(g).top && !e.w && !e.e && y >= by + bh - EDGE;
        } else {
            e.s = y >= by + bh - EDGE;
            // Inner edge: the window has its own invisible resize border there, see g._handle.
            if (side === 'left')
                e.e = false;
            else
                e.w = false;
        }
        return (e.n || e.s || e.w || e.e || e.sb) ? e : null;
    }

    _resizeTo(g, press, x, y) {
        const act = g.active;
        if (!act)
            return;
        const e = press.edge;
        const r = press.r0;
        const work = act.get_work_area_current_monitor();
        const dx = x - press.x;
        const dy = y - press.y;
        if (e.sb) {
            this._resizeBar(g, press, dx, dy);
            return;
        }
        let nx = r.x, ny = r.y, nw = r.width, nh = r.height;
        if (e.e)
            nw = Math.max(MIN_W, r.width + dx);
        if (e.w) {
            nw = Math.max(MIN_W, r.width - dx);
            nx = r.x + r.width - nw;
        }
        if (e.n) {
            // The bar sits above the window: its top edge must not leave the work area.
            nh = Math.max(MIN_H, r.height - dy);
            ny = r.y + r.height - nh;
            if (ny < work.y + this._topH(g)) {
                ny = work.y + this._topH(g);
                nh = r.y + r.height - ny;
            }
        }
        if (e.s)
            nh = Math.max(MIN_H, r.height + dy);
        act.move_resize_frame(true, nx, ny, nw, nh);
    }

    // Handle between bar and app: the group's outer edge stays, the app grows or shrinks.
    _resizeBar(g, press, dx, dy) {
        const act = g.active;
        const r = press.r0;
        const c = this._c(g);
        if (c.side === 'top') {
            const tw = Math.max(THUMB_MIN, Math.min(THUMB_MAX, press.tw0 + dy / THUMB_RATIO));
            const grow = this._thumbH(tw) - this._thumbH(press.tw0);
            const nh = Math.max(MIN_H, r.height - grow);
            c.thumbW = Math.round(tw);
            act.move_resize_frame(true, r.x, r.y + r.height - nh, r.width, nh);
        } else {
            const want = Math.max(SIDE_MIN, Math.min(SIDE_MAX, press.sw0 + (c.side === 'left' ? dx : -dx)));
            const d = Math.min(want - press.sw0, r.width - MIN_W);
            c.sideW = press.sw0 + d;
            const nx = c.side === 'left' ? r.x + d : r.x;
            act.move_resize_frame(true, nx, r.y, r.width - d, r.height);
        }
        this._sync(g);
    }

    // Shell 50 no longer has display.set_cursor; the cursor is set on the stage (Clutter.CursorType).
    _setCursor(e, g) {
        const C = Clutter.CursorType;
        let c = C.DEFAULT;
        if (e?.sb) {
            c = this._c(g)?.side === 'top' ? C.N_RESIZE : C.W_RESIZE;
        } else if (e) {
            const v = e.n ? 'N' : e.s ? 'S' : '';
            const h = e.w ? 'W' : e.e ? 'E' : '';
            c = C[`${v}${h}_RESIZE`] ?? C.DEFAULT;
        }
        try {
            global.stage.set_cursor_type(c);
        } catch (err) {
            console.debug(`reiter: Cursor: ${err.message}`);
        }
    }

    // Reorder a tab within the bar: the target slot is the tab under the pointer
    // (comparing midpoints would jump back and forth after the swap).
    _reorder(g, win, x, y) {
        const bar = this._bars.get(g);
        const tabs = g._list.get_children().filter(c => c._win);
        const idx = tabs.findIndex(t => {
            const [tx, ty] = t.get_transformed_position();
            return this._c(g).side === 'top' ? x >= tx && x < tx + t.width : y >= ty && y < ty + t.height;
        });
        if (idx >= 0 && g.members.indexOf(win) !== idx)
            g.move(win, idx);
    }

    // Right-click on the bar (btn = tab under the pointer, otherwise null). HIG: "Close" goes last,
    // no direction words in tab actions.
    _barMenu(g, btn, x, y) {
        const s = this._settings;
        const c = this._c(g);
        const anchor = new St.Widget({width: 1, height: 1});
        Main.uiGroup.add_child(anchor);
        anchor.set_position(x, y);
        const menu = new PopupMenu.PopupMenu(anchor, 0.5, St.Side.TOP);
        const mgr = new PopupMenu.PopupMenuManager(anchor);
        mgr.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);
        const choice = (label, on, fn) => {
            const it = menu.addAction(label, fn);
            it.setOrnament(on ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        };
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(g._name || _('This group')));
        choice(_('Bar on top'), c.side === 'top', () => this._setOver(g, {side: 'top'}));
        choice(_('Bar on the left'), c.side === 'left', () => this._setOver(g, {side: 'left'}));
        choice(_('Bar on the right'), c.side === 'right', () => this._setOver(g, {side: 'right'}));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (c.side !== 'top') {
            const m = this._mode(g);
            choice(_('Icons only'), m === 'icon', () => this._setOver(g, {sideW: 48}));
            choice(_('Icon and text'), m !== 'icon', () => {
                if (c.sideW < SIDE_TEXT_MIN)
                    this._setOver(g, {sideW: 180});
            });
        }
        const pv = new PopupMenu.PopupSwitchMenuItem(_('Always show previews'), c.top);
        pv.connect('toggled', (_i, on) => {
            const patch = {top: on};
            if (on && c.side !== 'top' && c.sideW < SIDE_PREVIEW_MIN)
                patch.sideW = 260;
            this._setOver(g, patch);
        });
        menu.addMenuItem(pv);
        if (c.side !== 'top') {
            const cp = new PopupMenu.PopupSwitchMenuItem(_('Compact (opens on hover)'), c.compact);
            cp.connect('toggled', (_i, on) => {
                g._expanded = false;
                this._setOver(g, {compact: on});
            });
            menu.addMenuItem(cp);
        }
        const hv = new PopupMenu.PopupSwitchMenuItem(_('Preview on hover'), c.hover);
        hv.connect('toggled', (_i, on) => this._setOver(g, {hover: on}));
        menu.addMenuItem(hv);
        menu.addAction(_('Rename group…'), () => this._renameGroup(g));
        menu.addAction(_('Use as default for new groups'), () => {
            s.set_string('bar-side', c.side);
            s.set_int('sidebar-width', c.sideW);
            s.set_int('preview-width', c.thumbW);
            s.set_boolean('compact', c.compact);
            s.set_boolean('top-preview', c.top);
            s.set_boolean('hover-preview', c.hover);
        });
        if (Object.keys(g._over).length > 0)
            menu.addAction(_('Back to default settings'), () => {
                g._expanded = false;
                g._over = {};
                this._setOver(g, {});
            });
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const saved = this._savedIndex(g) >= 0;
        menu.addAction(saved ? _('Forget saved group') : _('Save group'), () => this._toggleSaved(g));
        if (btn) {
            const w = btn._win;
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(this._isPinned(w) ? _('Unpin') : _('Pin'), () => this._togglePinned(w));
            menu.addAction(_('Open in own window'), () => this._release(g, w));
            menu.addAction(_('Close'), () => w.delete(global.get_current_time()));
        }
        menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                this._later(0, () => {
                    menu.destroy();
                    anchor.destroy();
                });
        });
        menu.open();
    }

    // Take the window out of the group without a drag and place it slightly offset.
    _release(g, w) {
        this._unwatch(g, w);
        const last = g.remove(w);
        w.get_compositor_private()?.show();
        const r = w.get_frame_rect();
        w.move_frame(true, r.x + 40, r.y + 40);
        if (last)
            this._dissolve(g);
        else
            this._sync(g);
        Main.activateWindow(w);
    }

    _dragTo(g, press, x, y) {
        if (press.moveWin) {
            press.moveWin.move_frame(true, x - press.dx, y - press.dy);
            return;
        }
        const act = g.active;
        if (!act)
            return;
        const work = act.get_work_area_current_monitor();
        const frameY = Math.max(work.y, y - press.dy);
        act.move_frame(true, x - press.dx, frameY + this._topH(g));
    }

    // --- Dragging windows onto the bar ---------------------------------------------------------

    _barAt(x, y, except = null) {
        for (const [g, bar] of this._bars) {
            if (g === except || !bar.visible)
                continue;
            const [bx, by] = bar.get_transformed_position();
            const [bw, bh] = bar.get_transformed_size();
            if (x >= bx && x < bx + bw && y >= by && y < by + bh)
                return g;
        }
        return null;
    }

    _onGrabBegin(win, op) {
        if (!win || op !== Meta.GrabOp.MOVING || this._groups.size === 0)
            return;
        this._stopDropWatch();
        this._dropTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            const [x, y] = global.get_pointer();
            const over = this._barAt(x, y, this._groupOf(win));
            for (const [g, bar] of this._bars) {
                if (g === over)
                    bar.add_style_class_name('drop');
                else
                    bar.remove_style_class_name('drop');
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onGrabEnd(win, op) {
        if (!win || op !== Meta.GrabOp.MOVING || !this._dropTimer)
            return;
        this._stopDropWatch();
        const [x, y] = global.get_pointer();
        const target = this._barAt(x, y, this._groupOf(win));
        if (target)
            this._addToGroup(target, win);
    }

    _stopDropWatch() {
        if (this._dropTimer) {
            GLib.source_remove(this._dropTimer);
            this._dropTimer = 0;
        }
        for (const bar of this._bars?.values() ?? [])
            bar.remove_style_class_name('drop');
    }

    _addToGroup(g, win) {
        const old = this._groupOf(win);
        if (old === g)
            return;
        if (old) {
            this._unwatch(old, win);
            if (old.remove(win))
                this._dissolve(old);
        }
        if (win.is_maximized?.())
            win.unmaximize();
        this._watch(g, win);
        g.add(win);
        // A group without its own settings adopts those saved for its new app combination.
        if (!g._name && Object.keys(g._over).length === 0)
            this._loadOver(g);
        g.select(win);
        Main.activateWindow(win);
    }

    // --- Group buttons ------------------------------------------------------------------------

    // Group maximize: work area minus the bar (real maximizing would leave no room for it).
    _toggleMax(g) {
        if (!g.active)
            return;
        if (!g.maximized) {
            const r = g.active.get_frame_rect();
            g._restore = {x: r.x, y: r.y, width: r.width, height: r.height};
            g.maximized = true;
        } else {
            g.maximized = false;
            const r = g._restore;
            if (r) {
                for (const w of g.members)
                    w.move_resize_frame(false, r.x, r.y, r.width, r.height);
            }
        }
        this._sync(g);
    }

    _minimizeGroup(g) {
        for (const w of g.members)
            w.minimize();
    }

    // Closing the group closes all windows; a window that asks for confirmation is simply left open.
    _closeGroup(g) {
        const t = global.get_current_time();
        for (const w of [...g.members])
            w.delete(t);
    }

    _winButton(iconName, label, onClick, extraClass = '') {
        const b = new St.Button({
            style_class: `reiter-winbtn ${extraClass}`,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
            accessible_name: label,
            can_focus: true,
        });
        b.connect('clicked', onClick);
        return b;
    }

    // Color of the app's header bar: one pixel at the top center of the window buffer (via a 1x1 PNG and GdkPixbuf,
    // since the Cairo surface in GJS has no getData). Apps differ (flat/white vs. #ebebed).
    _headerColor(win, side = 'mid') {
        try {
            const actor = win.get_compositor_private();
            const fr = win.get_frame_rect();
            const buf = win.get_buffer_rect();
            const clip = new Mtk.Rectangle({
                x: fr.x - buf.x + (side === 'left' ? CORNER + 2 : side === 'right' ? fr.width - CORNER - 3 :
                    Math.floor(fr.width / 2)),
                y: fr.y - buf.y + 3,
                width: 1,
                height: 1,
            });
            const surf = actor.get_image(clip);
            if (!surf)
                return null;
            const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'reiter-px.png']);
            surf.writeToPNG(path);
            const px = GdkPixbuf.Pixbuf.new_from_file(path).get_pixels();
            GLib.unlink(path);
            return [px[0], px[1], px[2]];
        } catch (e) {
            console.debug(`reiter: Farbprobe: ${e.message}`);
            return null;
        }
    }

    // Bar color per window: measured only when the window is new to a group or the color scheme
    // changes (_restyle clears the cache). Switching tabs reuses the value and cross-fades.
    _applyHeaderColor(g) {
        const bar = this._bars.get(g);
        if (!bar || !g.active)
            return;
        let col = this._colors.get(g.active);
        if (!col) {
            const c = this._headerColor(g.active);
            if (!c)
                return;
            // Measure corners separately: e.g. Nautilus has a different color on the left (sidebar) than on the right.
            col = {c, L: this._headerColor(g.active, 'left') ?? c, R: this._headerColor(g.active, 'right') ?? c};
            // Text and hover colors follow the measured header, not the global scheme: an app can force dark in a light shell.
            col.dark = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] < 128;
            this._colors.set(g.active, col);
        }
        this._fadeColor(g, col);
    }

    _paintColor(g, col) {
        g._rgb = col.c;
        g._rgbL = col.L;
        g._rgbR = col.R;
        const side = this._c(g).side;
        const bc = side === 'left' ? col.L : side === 'right' ? col.R : col.c;
        const css = `background-color: rgb(${bc.map(Math.round).join(', ')});`;
        const bar = this._bars.get(g);
        bar?.set_style(css);
        g._fill?.set_style(css);
    }

    // Short cross-fade from the shown color to the new one (about 200 ms); none the first time.
    _fadeColor(g, to) {
        g._fade?.stop();
        g._fade = null;
        if (to.dark !== undefined) {
            for (const a of [this._bars.get(g), g._fill]) {
                if (!a)
                    continue;
                a.remove_style_class_name(to.dark ? 'light' : 'dark');
                a.add_style_class_name(to.dark ? 'dark' : 'light');
            }
        }
        // The corners change immediately; only bar and filler cross-fade.
        g._cornerL = to.L;
        g._cornerR = to.R;
        g._corners?.forEach(k => k.queue_repaint());
        if (!g._rgb) {
            this._paintColor(g, to);
            return;
        }
        const from = {c: g._rgb, L: g._rgbL ?? g._rgb, R: g._rgbR ?? g._rgb};
        if (['c', 'L', 'R'].every(k => from[k].every((v, i) => Math.round(v) === to[k][i])))
            return;
        const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
        const tl = new Clutter.Timeline({duration: 200, actor: this._bars.get(g)});
        tl.connect('new-frame', (_t, ms) => {
            const t = Math.min(1, ms / 200);
            this._paintColor(g, {c: mix(from.c, to.c, t), L: mix(from.L, to.L, t), R: mix(from.R, to.R, t)});
        });
        tl.connect('completed', () => {
            this._paintColor(g, to);
            g._fade = null;
        });
        g._fade = tl;
        tl.start();
    }

    // Group frame: window rectangle and bar rectangle. If something does not fit on the screen, the
    // app is shrunk and the bar stays full size. Sidebars extend under the window (filling its corners).
    _layout(g, rect, work) {
        const {side, compact} = this._c(g);
        const sideW = compact ? SIDE_MIN : this._c(g).sideW;
        if (side === 'top') {
            const h = this._topH(g);
            let wr;
            if (g.maximized) {
                wr = {x: work.x, y: work.y + h, width: work.width, height: Math.max(1, work.height - h)};
            } else {
                const y = Math.max(rect.y, work.y + h);
                wr = {x: rect.x, y, width: rect.width, height: Math.max(1, rect.y + rect.height - y)};
            }
            return {win: wr, bar: {x: wr.x, y: wr.y - h, width: wr.width, height: h}};
        }
        const left = side === 'left';
        let wr;
        if (g.maximized) {
            wr = {x: left ? work.x + sideW : work.x, y: work.y, width: work.width - sideW, height: work.height};
        } else if (left) {
            const x = Math.max(rect.x, work.x + sideW);
            wr = {x, y: rect.y, width: Math.max(1, rect.x + rect.width - x), height: rect.height};
        } else {
            const width = Math.max(1, Math.min(rect.width, work.x + work.width - sideW - rect.x));
            wr = {x: rect.x, y: rect.y, width, height: rect.height};
        }
        // Compact and open: the bar lies over the app (no overlap needed), the outer edge stays.
        const disp = this._dispW(g);
        const open = compact && g._expanded;
        const bx = left ? wr.x - sideW : open ? wr.x + wr.width + sideW - disp : wr.x + wr.width - CORNER;
        return {win: wr, bar: {x: bx, y: wr.y, width: disp + (open ? 0 : CORNER), height: wr.height}};
    }

    _sync(g) {
        const bar = this._bars.get(g);
        if (!bar || !g.active)
            return;
        const act = g.active;
        g._attn?.delete(act);

        // The app maximized itself (own header bar / double-click): redirect to group maximize.
        if (act.is_maximized?.()) {
            act.unmaximize();
            this._toggleMax(g);
            return;
        }

        const work = act.get_work_area_current_monitor();
        const {win: wr, bar: br} = this._layout(g, act.get_frame_rect(), work);
        const top = this._c(g).side === 'top';
        for (const cls of ['side', 'left', 'right'])
            bar.remove_style_class_name(cls);
        if (!top) {
            bar.add_style_class_name('side');
            bar.add_style_class_name(this._c(g).side);
        }
        if (g._animate && bar.width > 0 && bar.width !== br.width) {
            // Compact expand/collapse: the width (and the edge, for right) glides instead of jumping.
            const ox = bar.x, ow = bar.width;
            bar.remove_all_transitions();
            bar.set_position(ox, br.y);
            bar.set_size(ow, br.height);
            bar.clip_to_allocation = true;
            bar.ease({x: br.x, width: br.width, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            bar.set_position(br.x, br.y);
            bar.set_size(br.width, br.height);
        }
        g._animate = false;
        // An expanded compact bar lies over the app: a shadow makes the layer visible.
        if (!top && this._c(g).compact && g._expanded)
            bar.add_style_class_name('expanded');
        else
            bar.remove_style_class_name('expanded');
        // When not expanded, the bar extends CORNER px under the window; there are no tabs there.
        if (!top && !(this._c(g).compact && g._expanded))
            bar.add_style_class_name('overlap');
        else
            bar.remove_style_class_name('overlap');
        // Filler behind the rounded window corners (top only); maximized windows have no rounding.
        g._fill.set_position(br.x, br.y + br.height);
        g._fill.set_size(br.width, FILL_HEIGHT);
        g._fill.opacity = 255;
        if (g.maximized)
            bar.add_style_class_name('max');
        else
            bar.remove_style_class_name('max');

        g._corners[0].set_position(wr.x, wr.y);
        g._corners[1].set_position(wr.x + wr.width - CORNER, wr.y);
        // Detach first, otherwise hiding the old window would hide the bar with it.
        g._bind?.unbind();
        g._bind2?.unbind();
        g._hbind?.unbind();
        g._hbind = null;
        g._cbinds?.forEach(b => b.unbind());
        g._bind = null;
        g._bind2 = null;
        g._cbinds = [];
        for (const w of g.members) {
            const actor = w.get_compositor_private();
            if (!actor)
                continue;
            // Bring all members to the shared geometry, only if they differ (avoids a loop).
            const cur = w.get_frame_rect();
            if (cur.x !== wr.x || cur.y !== wr.y || cur.width !== wr.width || cur.height !== wr.height)
                w.move_resize_frame(false, wr.x, wr.y, wr.width, wr.height);
            if (w === act)
                actor.show();
            else
                actor.hide();
        }

        // Visibility of bar and filler follows the active window (minimize, other workspace).
        const actor = act.get_compositor_private();
        if (actor) {
            g._bind = actor.bind_property('visible', bar, 'visible', GObject.BindingFlags.SYNC_CREATE);
            g._bind2 = actor.bind_property('visible', g._fill, 'visible', GObject.BindingFlags.SYNC_CREATE);
            if (!top && !g.maximized && !this._c(g).compact) {
                const hx = this._c(g).side === 'left' ? wr.x : wr.x + wr.width;
                g._handle.set_position(hx - 4, wr.y + CORNER);
                g._handle.set_size(8, Math.max(1, wr.height - 2 * CORNER));
                g._hbind = actor.bind_property('visible', g._handle, 'visible', GObject.BindingFlags.SYNC_CREATE);
            } else {
                g._handle.hide();
            }
            if (top) {
                g._cbinds = g._corners.map(c =>
                    actor.bind_property('visible', c, 'visible', GObject.BindingFlags.SYNC_CREATE));
            }
        }
        if (!top) {
            g._bind2?.unbind();
            g._bind2 = null;
            g._fill.hide();
            g._corners.forEach(c => c.hide());
        }
        this._restack();
        this._fillBar(g, bar);
        // On the first paint (open animation) the clone is still incomplete: rebuild shortly afterwards.
        if (g._thumbTimer)
            GLib.source_remove(g._thumbTimer);
        g._thumbTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
            g._thumbTimer = 0;
            if (this._groups?.has(g) && this._mode(g) === 'preview')
                this._fillBar(g, bar);
            return GLib.SOURCE_REMOVE;
        });
        // Color only once the window has been drawn at its new size.
        if (g._colorTimer)
            GLib.source_remove(g._colorTimer);
        g._colorTimer = 0;
        if (this._colors.has(g.active)) {
            this._applyHeaderColor(g);
            return;
        }
        g._colorTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            g._colorTimer = 0;
            if (this._groups?.has(g))
                this._applyHeaderColor(g);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Preview of a window, scaled to width tw and cropped to the frame (without shadow).
    // If a window is currently on screen (active tab), a clone only shows the damaged regions (the parent
    // clips by visibility when painting), so use a snapshot that a timer refreshes instead.
    // Hidden windows are shown live as a real clone.
    _thumb(win, tw, g = null) {
        const actor = win.get_compositor_private();
        if (!actor)
            return null;
        const fr = win.get_frame_rect();
        const buf = win.get_buffer_rect();
        const k = tw / fr.width;
        const box = new St.Widget({style_class: 'reiter-thumb', width: tw, height: Math.round(fr.height * k),
            clip_to_allocation: true});
        if (g && win === g.active) {
            box._snapOf = win;
            box._k = k;
            // The snapshot covers the whole actor (with shadow); the frame crops it.
            box._img = new St.Widget({width: Math.round(actor.width * k), height: Math.round(actor.height * k)});
            box._img.set_position(-(fr.x - buf.x) * k, -(fr.y - buf.y) * k);
            box.add_child(box._img);
            g._snaps.push(box);
            this._snapshot(box);
            return box;
        }
        const clone = new Clutter.Clone({source: actor});
        clone.set_scale(k, k);
        clone.set_position(-(fr.x - buf.x) * k, -(fr.y - buf.y) * k);
        box.add_child(clone);
        return box;
    }

    _snapshot(box) {
        const win = box._snapOf;
        const actor = win?.get_compositor_private();
        if (!actor || !actor.visible)
            return;
        try {
            const rect = new Mtk.Rectangle({x: 0, y: 0, width: actor.width, height: actor.height});
            const content = actor.paint_to_content(rect);
            if (content)
                box._img.set_content(content);
        } catch (e) {
            console.debug(`reiter: Schnappschuss: ${e.message}`);
        }
    }

    _hoverHide() {
        if (this._hoverTimer) {
            GLib.source_remove(this._hoverTimer);
            this._hoverTimer = 0;
        }
        this._hover?.destroy();
        this._hover = null;
    }

    // Large preview next to the tab, after a short delay.
    _hoverShow(g, btn) {
        this._hoverHide();
        this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            this._hoverTimer = 0;
            const win = btn._win;
            if (!btn.get_stage() || !win)
                return GLib.SOURCE_REMOVE;
            const thumb = this._thumb(win, HOVER_W);
            if (!thumb)
                return GLib.SOURCE_REMOVE;
            const pop = new St.Bin({style_class: 'reiter-hover', child: thumb});
            Main.uiGroup.add_child(pop);
            const [pw, ph] = pop.get_size();
            const [bx, by] = btn.get_transformed_position();
            const [bw, bh] = btn.get_transformed_size();
            const work = win.get_work_area_current_monitor();
            let x, y;
            const side = this._c(g).side;
            if (side === 'top') {
                x = bx;
                y = this._bars.get(g).get_transformed_position()[1] - ph - 4;
                if (y < work.y)
                    y = by + bh + 4;
            } else {
                x = side === 'left' ? bx + bw + 6 : bx - pw - 6;
                y = by;
            }
            pop.set_position(Math.max(work.x, Math.min(x, work.x + work.width - pw)),
                Math.max(work.y, Math.min(y, work.y + work.height - ph)));
            this._hover = pop;
            return GLib.SOURCE_REMOVE;
        });
    }

    _fillBar(g, bar) {
        this._hoverHide();
        g._snaps = [];
        if (!g._snapTimer) {
            g._snapTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                g._snaps.forEach(b => this._snapshot(b));
                return GLib.SOURCE_CONTINUE;
            });
        }
        const tracker = Shell.WindowTracker.get_default();
        const c = this._c(g);
        const top = c.side === 'top';
        const mode = this._mode(g);
        const disp = this._dispW(g);
        // Pinned tabs come first (stable sort, without a change event).
        g.members.sort((a, b) => this._isPinned(b) - this._isPinned(a));
        bar.destroy_all_children();
        bar.orientation = top ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL;
        // Width of a preview card; if the cards do not fit in the bar, they shrink (down to 64 px).
        let cardW = top ? c.thumbW : disp - 12;
        let thumbW = cardW - 8;
        if (mode === 'preview' && bar.width > 0 && bar.height > 0) {
            const n = g.members.length;
            if (top) {
                const fit = Math.floor((bar.width - 120) / n) - 8;
                cardW = Math.max(64, Math.min(cardW, fit));
                thumbW = cardW - 8;
            } else {
                // Card height = preview (3:5) + title row (~36)
                const fit = Math.floor(((bar.height - 80) / n - 44) / THUMB_RATIO);
                thumbW = Math.max(56, Math.min(thumbW, fit));
            }
        }
        // Tabs live in a scrollable list: with more tabs than space they scroll instead of overflowing the bar.
        const list = new St.BoxLayout({
            orientation: top ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
            x_expand: true, y_expand: true,
            style: 'spacing: 2px;',
        });
        g._list = list;
        const scroll = new St.ScrollView({
            x_expand: true, y_expand: true,
            hscrollbar_policy: top ? St.PolicyType.EXTERNAL : St.PolicyType.NEVER,
            vscrollbar_policy: top ? St.PolicyType.NEVER : St.PolicyType.EXTERNAL,
            overlay_scrollbars: true,
        });
        scroll.add_child(list);
        if (top) {
            // Mouse wheel scrolls the horizontal list
            scroll.connect('scroll-event', (_a, ev) => {
                const adj = scroll.hadjustment ?? scroll.get_hadjustment?.();
                const d = ev.get_scroll_direction();
                const step = 60;
                if (d === Clutter.ScrollDirection.UP || d === Clutter.ScrollDirection.LEFT)
                    adj.value -= step;
                else if (d === Clutter.ScrollDirection.DOWN || d === Clutter.ScrollDirection.RIGHT)
                    adj.value += step;
                else
                    return Clutter.EVENT_PROPAGATE;
                return Clutter.EVENT_STOP;
            });
        }
        // Window buttons of the group (the app's own buttons inside the window cannot be removed).
        const close = this._winButton('window-close-symbolic', _('Close group'), () => this._closeGroup(g), 'close');
        const buttons = !top && (c.compact || mode === 'icon') ? [close] : [
            this._winButton('window-minimize-symbolic', _('Minimize'), () => this._minimizeGroup(g)),
            this._winButton(g.maximized ? 'window-restore-symbolic' : 'window-maximize-symbolic',
                g.maximized ? _('Restore') : _('Maximize'), () => this._toggleMax(g)),
            close,
        ];
        // On the side they sit in the top outer corner, like window decoration.
        if (!top) {
            const box = new St.BoxLayout({
                orientation: mode === 'icon' ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
                x_align: mode === 'icon' ? Clutter.ActorAlign.CENTER
                    : c.side === 'left' ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
                style: 'spacing: 2px; margin-bottom: 4px;',
            });
            // Slightly tighter on the outer right so the gap to the edge looks the same as on the left.
            if (c.side === 'right')
                close.style = 'margin-right: 0;';
            buttons.forEach(b => box.add_child(b));
            bar.add_child(box);
        }
        // Group name: a row above the tabs on the side, before the tab list on top.
        const nameLabel = g._name && (top || mode !== 'icon') ? new St.Label({
            text: g._name, style: top ? 'font-weight: bold; max-width: 140px; margin: 0 8px 0 4px;'
                : 'font-weight: bold; margin: 0 4px 4px 4px;',
            y_align: top ? (mode === 'preview' ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER)
                : Clutter.ActorAlign.START,
        }) : null;
        nameLabel?.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        if (nameLabel)
            bar.add_child(nameLabel);
        for (const w of g.members) {
            const active = w === g.active;
            const row = new St.BoxLayout({style_class: 'reiter-tab-box', x_align: Clutter.ActorAlign.CENTER,
                x_expand: mode === 'icon'});
            const icon = tracker.get_window_app(w)?.create_icon_texture(16);
            if (icon) {
                icon.y_align = Clutter.ActorAlign.CENTER;
                row.add_child(icon);
            }
            // Attention dot next to the icon; it pulses (brightness and size) until the tab becomes active.
            if (g._attn?.has(w)) {
                const dot = new St.Widget({
                    style: 'width: 9px; height: 9px; border-radius: 5px; background-color: #e5484d; ' +
                        'box-shadow: 0 0 6px rgba(229, 72, 77, 0.9); margin: 0 2px 0 3px;',
                    y_align: Clutter.ActorAlign.CENTER,
                    pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
                });
                if (mode === 'icon' && icon) {
                    // No room beside the icon: overlay the dot on its upper right corner.
                    const holder = new St.Widget({width: 16, height: 16, y_align: Clutter.ActorAlign.CENTER});
                    row.remove_child(icon);
                    holder.add_child(icon);
                    dot.set_style('width: 8px; height: 8px; border-radius: 4px; background-color: #e5484d; ' +
                        'box-shadow: 0 0 4px rgba(229, 72, 77, 0.9); margin: 0;');
                    dot.set_position(9, -2);
                    holder.add_child(dot);
                    row.add_child(holder);
                } else {
                    row.add_child(dot);
                }
                const tl = new Clutter.Timeline({duration: 1300, repeat_count: -1, actor: dot});
                tl.connect('new-frame', (_t, ms) => {
                    const ph = 0.5 - 0.5 * Math.cos(2 * Math.PI * ms / 1300);
                    dot.opacity = Math.round(255 - 175 * ph);
                    dot.set_scale(1 - 0.4 * ph, 1 - 0.4 * ph);
                });
                dot.connect('destroy', () => tl.stop());
                tl.start();
            }
            // On top (without preview): always the icon, the title only on the active tab. On the side or with preview, titles everywhere.
            const pinned = this._isPinned(w);
            if (pinned && !active && mode !== 'icon') {
                row.x_align = Clutter.ActorAlign.START;
                row.x_expand = true;
            }
            if (mode === 'preview' || (mode === 'text' && (!pinned || active) && (!top || active))) {
                const maxW = mode === 'preview' ? cardW - 40 : top ? 240 : disp - 56;
                row.add_child(new St.Label({
                    style_class: 'reiter-title',
                    style: `max-width: ${maxW}px;`,
                    text: w.get_title() ?? '',
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.START,
                }));
                row.x_align = Clutter.ActorAlign.FILL;
                row.x_expand = true;
            }
            let content = row;
            if (mode === 'preview') {
                content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'reiter-card', width: cardW});
                const thumb = this._thumb(w, thumbW, g);
                if (thumb) {
                    thumb.x_align = Clutter.ActorAlign.CENTER;
                    content.add_child(thumb);
                }
                content.add_child(row);
            }
            const btn = new St.Button({
                style_class: 'reiter-tab' + (active ? ' active' : '') + (mode === 'preview' ? ' card' : ''),
                child: content,
                x_expand: !top,
                x_align: top ? Clutter.ActorAlign.START : Clutter.ActorAlign.FILL,
                can_focus: true,
                style: top && pinned && !active && mode === 'text' ? 'width: 26px; min-width: 26px; padding: 0;' : null,
            });
            btn._win = w;
            // Only focus: _onFocus selects the tab. Doing both at once makes them work against each other.
            btn.connect('clicked', () => Main.activateWindow(w));
            if (c.hover && mode !== 'preview' && !active) {
                btn.connect('notify::hover', () => {
                    if (btn.hover && !g._press)
                        this._hoverShow(g, btn);
                    else
                        this._hoverHide();
                });
            }
            list.add_child(btn);
            // Thin separator after the last pinned tab
            const next = g.members[g.members.indexOf(w) + 1];
            if (this._isPinned(w) && next && !this._isPinned(next)) {
                list.add_child(new St.Widget({
                    style: 'background-color: rgba(128, 128, 128, 0.45);' + (top
                        ? ' width: 1px; margin: 6px 3px;'
                        : ' height: 1px; margin: 3px 6px;'),
                }));
            }
        }
        bar.add_child(scroll);

        if (top) {
            for (const b of buttons) {
                b.y_align = mode === 'preview' ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
                bar.add_child(b);
            }
        }
    }

    _dissolve(g) {
        this._hoverHide();
        g._hbind?.unbind();
        g._handle?.destroy();
        for (const [obj, id] of g._ids ?? [])
            obj.disconnect(id);
        g._bind?.unbind();
        g._bind2?.unbind();
        g._cbinds?.forEach(b => b.unbind());
        g._fade?.stop();
        if (g._colorTimer)
            GLib.source_remove(g._colorTimer);
        if (g._thumbTimer)
            GLib.source_remove(g._thumbTimer);
        if (g._compactTimer)
            GLib.source_remove(g._compactTimer);
        if (g._snapTimer)
            GLib.source_remove(g._snapTimer);
        g._corners?.forEach(c => c.destroy());
        for (const w of g.members)
            w.get_compositor_private()?.show();
        g._fill?.destroy();
        this._bars.get(g)?.destroy();
        this._bars.delete(g);
        this._groups.delete(g);
        this._updateButtonLayout();
    }

    // The apps' header bars would show their own minimize/maximize buttons next to the group buttons.
    // libadwaita/GTK read the layout live from the settings: while groups exist, it omits these
    // two buttons; the original is also stored in the extension settings in case the shell crashes.
    _updateButtonLayout() {
        const own = this._settings;
        if (this._groups.size > 0 && !this._layoutSaved) {
            const layout = this._wm.get_string('button-layout');
            own.set_string('saved-button-layout', layout);
            this._layoutSaved = true;
            const strip = side => side.split(',').filter(t => t !== 'minimize' && t !== 'maximize').join(',');
            this._wm.set_string('button-layout', layout.split(':').map(strip).join(':'));
        } else if (this._groups.size === 0 && this._layoutSaved) {
            this._restoreButtonLayout();
        }
    }

    _restoreButtonLayout() {
        const own = this._settings;
        const saved = own.get_string('saved-button-layout');
        if (saved)
            this._wm.set_string('button-layout', saved);
        own.set_string('saved-button-layout', '');
        this._layoutSaved = false;
    }

}
