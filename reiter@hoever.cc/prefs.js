// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ReiterPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Reiter', icon_name: 'view-dual-symbolic'});
        window.add(page);

        const rules = new Adw.PreferencesGroup({
            title: _('Group automatically'),
            description: _('Each rule is a list of window classes (WM_CLASS or app ID), separated by commas. ' +
                'When a window from the list opens, it joins the group of the others.'),
        });
        page.add(rules);

        const rows = [];
        const save = () => settings.set_strv('rules',
            rows.map(r => r.get_text().trim()).filter(t => t.length > 0));

        const addRow = text => {
            const row = new Adw.EntryRow({title: _('Window classes')});
            row.set_text(text);
            row.connect('changed', save);
            const del = new Gtk.Button({
                icon_name: 'edit-delete-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: _('Remove rule'),
            });
            del.connect('clicked', () => {
                rows.splice(rows.indexOf(row), 1);
                rules.remove(row);
                save();
            });
            row.add_suffix(del);
            rows.push(row);
            rules.add(row);
        };

        for (const line of settings.get_strv('rules'))
            addRow(line);

        const add = new Gtk.Button({
            label: _('Add rule'),
            halign: Gtk.Align.START,
            margin_top: 6,
        });
        add.connect('clicked', () => addRow(''));
        const addGroup = new Adw.PreferencesGroup();
        addGroup.add(add);
        page.add(addGroup);

        const keys = new Adw.PreferencesGroup({title: _('Keyboard shortcuts')});
        const key = new Adw.EntryRow({title: _('Group focused window (e.g. <Super>g)')});
        key.set_text(settings.get_strv('group-with-previous')[0] ?? '');
        key.connect('changed', () => {
            const t = key.get_text().trim();
            settings.set_strv('group-with-previous', t ? [t] : []);
        });
        keys.add(key);
        page.add(keys);
    }
}
